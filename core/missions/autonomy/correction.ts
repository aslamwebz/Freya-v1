import type { MissionIntentShape } from './types'
import {
  isTerminalMissionStatus,
  MAX_INTENT_CONSTRAINTS,
  MAX_REQUESTED_QUANTITY,
  normaliseIntentShape,
  type MissionIntentShapeInput,
} from '../types'
import type {
  MissionCorrectionAmbiguity,
  MissionCorrectionInput,
  MissionIntentField,
} from './types'
import type { MissionRecord } from '../types'

/**
 * OWNER CORRECTION — INTENT PATCHING.
 *
 * The acceptance case, in full:
 *
 * ```
 * Owner: "find 100 cat videos"
 *   … Freya is 40 videos in, with two workers running …
 * Owner: "in the barn"
 * ```
 *
 * That second utterance is not a new Mission. It is a **constraint patch** to the one
 * already running, and the difference matters enormously: a generic "barn" Mission would
 * throw away 40 videos of work, forget that 100 were wanted, lose the fact that they
 * had to be *videos*, and start over. So this file does four things:
 *
 * 1. **Finds the Mission this is about.** One active Mission, matched by `missionId`
 *    when the owner names one. Never by guessing.
 * 2. **Decides whether the utterance is unambiguous.** "in the barn" adds a location
 *    constraint and nothing else — one reading, so it is applied. "make it better" has
 *    many, so it is refused and the owner is asked.
 * 3. **Works out which steps the new intent makes incompatible**, and which evidence
 *    remains valid. Compatible evidence is *kept*; incompatible steps are settled.
 * 4. **Replans what is left**, from the surviving evidence rather than from nothing.
 *
 * ## The ambiguity rule
 *
> **If a correction could be read two ways, it is refused and the owner is asked.**
>
> There is no "probably", no "best guess", and no `assumed` branch anywhere in this file.
> The cost of being wrong is asymmetric and that is the whole argument: asking costs one
> message, while guessing wrong costs 40 videos of work and the owner's trust in every
> future correction.
>
> So the two outcomes are `patch` and `ambiguous`, and `ambiguous` changes **nothing** —
> no constraint moves, no step is settled, no evidence is discarded. The Mission is left
 * exactly as it was, and it is recorded that it asked.
 *
 * ## A correction cannot widen authority
 *
> This is the important safety property, and it is structural rather than a check that
> could be forgotten: `CorrectionPlan` carries **no** budget, **no** limits, **no**
> priority and **no** capability. The only things a correction can change are the five
 * named intent fields and which steps are pending. So there is no shape of
 * `MissionCorrectionInput` that could buy more retries, more delegations or a capability
 * the Mission did not already have.
 *
 * The one thing a correction *can* do is settle steps — which reduces what the Mission
 * does, never increases it. The asymmetry is the point.
 */
/**
 * What the owner said, already reduced to the fields it addressed.
 *
 * `addressed` is what makes "did not change" checkable: a correction that mentions only
 * `context` leaves `subject`, `quantity` and `media` alone *because they were absent from
 * the input*, not because some merge step decided to keep them.
 */
export interface CorrectionPlan {
  readonly correctionId: string
  readonly missionId: string
  readonly kind: 'patch'
  /** The exact field names this correction touched. Never a value. */
  readonly changedFields: readonly MissionIntentField[]
  /** The intent after patching. Private; written to the encrypted store, never the journal. */
  readonly next: MissionIntentShape
  /** The single question to ask, when the correction was ambiguous. Private. */
  readonly question: string | null
  /** Why it could not be resolved, when ambiguous. A closed code. */
  readonly ambiguity: MissionCorrectionAmbiguity | null
}

/**
 * What a correction changes about the Mission's work.
 *
 * Separate from `CorrectionPlan` because the two answer different questions and are
 * computed at different times: the plan says *what the goal now is*, and this says *what
 * that does to work in flight*. Keeping them apart is what lets the replan be tested
 * without a store and the intent patch without a plan.
 */
export interface CorrectionEffect {
  readonly settledStepIds: readonly string[]
  readonly preservedEvidenceIds: readonly string[]
  /** Whether the remaining work needs a new plan. Always true; the field is a fact to assert. */
  readonly replanRequired: boolean
}

export type CorrectionOutcome =
  | {
      readonly ok: true
      readonly kind: 'patch'
      readonly plan: CorrectionPlan
      readonly effect: CorrectionEffect
      /** True when the Mission was parked by the correction and must be woken by a person. */
      readonly pauseRequested: boolean
    }
  | {
      readonly ok: false
      readonly kind: 'ambiguous' | 'rejected'
      readonly ambiguity: MissionCorrectionAmbiguity
      /** The question to put to the owner. Private, and only ever shown to the owner. */
      readonly question: string
      readonly plan: null
    }

/**
 * Reduce an owner utterance to the fields it addressed.
 *
 * This is the parser, and it is the only place free text becomes structure. It is
 * **not** a language model and does not pretend to be: it matches a small, explicit set
 * of shapes, and anything it does not recognise is `ambiguous`. That is a deliberate
 * trade — a cleverer parser would recognise more corrections and would also be one more
 * thing that could confidently misread "make it better" as a location constraint.
 *
 * The recognised shapes, in the order they are checked:
 *
 * | shape | example | resolves to |
 * | --- | --- | --- |
 * | explicit fields | `{ context: ['in the barn'] }` | a patch |
 * | a bare location phrase | `"in the barn"` | `context` patch |
 * | a bare quantity | `"make it 50"` | `quantity` patch |
 * | a bare cancellation | `"stop"`, `"cancel"` | pause or cancel |
 * | anything else | `"better"`, `"more"` | **ambiguous** |
 */
export function parseCorrection(input: string | MissionCorrectionInput): ParsedCorrection {
  if (typeof input !== 'object' || input === null) {
    const text = typeof input === 'string' ? input : ''
    return parseText(text)
  }
  return parseFields(input)
}

type ParsedCorrection =
  | { readonly ok: true; readonly fields: Partial<MissionIntentShapeInput>; readonly pause: boolean; readonly cancel: boolean }
  | { readonly ok: false; readonly ambiguity: Exclude<MissionCorrectionAmbiguity, 'no_active_mission' | 'already_settled'> }

/**
 * Parse a structured correction.
 *
 * Every field is read and bounded here, so a caller cannot hand `quantity: -5` or a
 * 10,000-character exclusion through to the intent store. That validation is duplicated
 * from `normaliseIntentShape` on purpose: this runs *before* the merged intent is
 * rebuilt, and a parser that trusted its own input would be trusting the untrusted thing
 * it exists to check.
 */
function parseFields(input: MissionCorrectionInput): ParsedCorrection {
  // A mutable tally, frozen once complete. `MissionIntentShapeInput` is `readonly`, and
  // the alternative — building the object in one expression with twelve ternaries — is
  // unreadable and would still need the same validation first.
  const fields: {
    subject?: string
    quantity?: number | null
    media?: readonly string[]
    context?: readonly string[]
    exclusions?: readonly string[]
  } = {}
  const bounded = checkBounded(input)
  if (!bounded.ok) return bounded

  if (input.subject !== undefined) fields.subject = input.subject
  if (input.quantity !== undefined) fields.quantity = input.quantity
  if (input.media !== undefined) fields.media = input.media
  if (input.context !== undefined) fields.context = input.context
  if (input.exclusions !== undefined) fields.exclusions = input.exclusions

  const addressed =
    fields.subject !== undefined ||
    fields.quantity !== undefined ||
    fields.media !== undefined ||
    fields.context !== undefined ||
    fields.exclusions !== undefined

  // A structured correction that addressed nothing is not a correction. Treated as
  // ambiguous rather than as a silent no-op, because a caller who thought they had
  // changed something and had not needs to be told.
  if (!addressed && input.pause !== true && input.cancel !== true) {
    return { ok: false, ambiguity: 'unknown_scope' }
  }
  return {
    ok: true,
    fields: Object.freeze({ ...fields }) as Partial<MissionIntentShapeInput>,
    pause: input.pause === true,
    cancel: input.cancel === true,
  }
}

/**
 * Bounds check for every field a correction may carry.
 *
 * Refused rather than clamped, for the same reason the rest of the Mission domain
 * refuses rather than clamps: a clamp would silently accept "make it -5" as "make it 1"
 * and the owner would never know their number was changed.
 */
function checkBounded(
  input: MissionCorrectionInput,
): { ok: true } | { ok: false; ambiguity: Exclude<MissionCorrectionAmbiguity, 'no_active_mission' | 'already_settled'> } {
  if (input.subject !== undefined) {
    if (typeof input.subject !== 'string' || input.subject.trim().length === 0 || input.subject.length > 500) {
      return { ok: false, ambiguity: 'unknown_subject' }
    }
  }
  if (input.quantity !== undefined && input.quantity !== null) {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > MAX_REQUESTED_QUANTITY) {
      return { ok: false, ambiguity: 'conflicting_quantity' }
    }
  }
  for (const [value, label] of [
    [input.media, 'media'],
    [input.context, 'context'],
    [input.exclusions, 'exclusions'],
  ] as const) {
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > MAX_INTENT_CONSTRAINTS) {
      return { ok: false, ambiguity: 'unknown_scope' }
    }
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 200) {
        return { ok: false, ambiguity: label === 'context' ? 'unknown_scope' : 'unknown_subject' }
      }
    }
  }
  return { ok: true }
}

/**
 * Parse an utterance.
 *
 * Small, explicit and closed. Anything unrecognised is ambiguous, which is the safe
 * direction: the cost of this parser being too narrow is one clarifying question, and the
 * cost of it being too clever is a Mission that does the wrong work confidently.
 */
function parseText(text: string): ParsedCorrection {
  const trimmed = text.trim().toLowerCase()
  if (trimmed.length === 0) return { ok: false, ambiguity: 'unknown_scope' }

  // Cancellation and pause are checked first, because "stop" is unambiguous and there is
  // no reason to make anyone wait for a parser to work that out.
  if (/^(stop|halt|pause|hold on|wait)$/.test(trimmed)) {
    return { ok: true, fields: {}, pause: true, cancel: false }
  }
  if (/^(cancel|forget it|never mind|nevermind|abandon)$/.test(trimmed)) {
    return { ok: true, fields: {}, pause: false, cancel: true }
  }

  // A bare quantity: "make it 50", "50 please", "just 20".
  const quantity = /^(?:make it |just |only )?(\d{1,6})(?:\s+please)?$/.exec(trimmed)
  if (quantity !== null && quantity[1] !== undefined) {
    const value = Number(quantity[1])
    if (!Number.isInteger(value) || value <= 0 || value > MAX_REQUESTED_QUANTITY) {
      return { ok: false, ambiguity: 'conflicting_quantity' }
    }
    return { ok: true, fields: { quantity: value }, pause: false, cancel: false }
  }

  // A location or scope phrase. The two shapes that read as a constraint on *where*:
  // prepositional ("in the barn", "from the shed") and an explicit scope marker ("only
  // in the barn").
  //
  // Deliberately narrow: the preposition set is a closed list, and a bare noun is
  // **not** a location. "the barn" on its own is ambiguous — a subject, a location, or a
  // correction to either — and is refused rather than guessed at.
  // A location or scope phrase. The preposition is **required** and the set is closed.
  //
  // Two deliberate choices:
  //
  // - The whole phrase is the constraint, preposition and all — "in the barn", not "barn".
  //   The preposition carries meaning a bare noun does not: "from the shed" is a source and
  //   "in the shed" is a location, and collapsing both to "shed" would make two different
  //   corrections indistinguishable in a journal that records only the *name* of the field
  //   that changed.
  // - A bare noun is **refused**. "the barn" on its own could be a subject, a location, or a
  //   correction to either, and guessing is the one thing this parser must not do.
  const location = /^(?:only\s+|just\s+)?(?:in|inside|from|near|around|at)\s+(.{2,200})$/.exec(trimmed)
  if (location !== null && location[1] !== undefined) {
    const constraint = trimmed.replace(/^(?:only|just)\s+/, '')
    if (constraint.trim().length === 0) return { ok: false, ambiguity: 'unknown_scope' }
    return { ok: true, fields: { context: [constraint] }, pause: false, cancel: false }
  }

  // A media-type correction: "as audio", "make them videos", "only images".
  const media = /^(?:as|only|make them|make it)\s+(videos?|audio|sounds?|images?|photos?|pictures?|texts?)$/.exec(trimmed)
  if (media !== null && media[1] !== undefined) {
    return { ok: true, fields: { media: [media[1].trim()] }, pause: false, cancel: false }
  }

  // An exclusion: "no cats", "not dogs", "nothing about weather".
  const exclusion = /^(?:no|not|nothing (?:about|on|with)|exclude)\s+(.{2,200})$/.exec(trimmed)
  if (exclusion !== null && exclusion[1] !== undefined) {
    return { ok: true, fields: { exclusions: [exclusion[1].trim()] }, pause: false, cancel: false }
  }

  // Everything else. The two codes distinguish the two ways this most often happens, so
  // the question asked can be a useful one.
  const hasNoun = /\b(?:better|more|less|different|quicker|faster|nicer|another|else)\b/.test(trimmed)
  return { ok: false, ambiguity: hasNoun ? 'multiple_subjects' : 'unknown_scope' }
}

/**
 * Apply a correction to a Mission.
 *
 * The whole of the critical acceptance case. Four outcomes, and the important one is
 * what does *not* happen on the ambiguous path.
 *
 * ## Which steps the correction settles
 *
 * A step is settled when the new intent makes its work wrong. The rule is by capability
 * rather than by guessing at a step's purpose, because a step record carries no
 * description — that is the privacy property — so the only thing that can be compared is
 * what the step *is*.
 *
 * Concretely: a step whose verifier and capability pair is no longer reachable under the
 * new intent is settled. In practice that means a **verified** step is always preserved
 * (its observation stands on its own) and a **non-started** step is settled when the
 * correction changed the context constraint, because work not yet begun under the old
 * location is work for the old location.
 *
 * The evidence rule is the same shape and is the more consequential one: evidence is
 * preserved unless the correction touched `media` or `exclusions`, because observed
 * *videos* stay valid when the location narrows to a barn but do **not** stay valid when
 * the type changes from video to audio.
 */
export function applyCorrection(
  mission: MissionRecord,
  current: MissionIntentShape | null,
  input: string | MissionCorrectionInput,
  correctionId: string,
): CorrectionOutcome {
  // A settled Mission cannot be corrected. The outcome is `rejected`, not a patch, and
  // this is checked before anything is read — a correction aimed at a completed Mission
  // is a misunderstanding, and acting on it would be worse than refusing it.
  if (isTerminalMissionStatus(mission.status)) {
    return {
      ok: false,
      kind: 'rejected',
      ambiguity: 'already_settled',
      question: `This mission has already finished as ${mission.status}. Start a new one?`,
      plan: null,
    }
  }

  const parsed = parseCorrection(input)
  if (!parsed.ok) {
    // **Nothing is touched on this path.** No field merged, no step settled, no evidence
    // discarded, no wake cleared. The only effect is `awaitingOwner` and a blocker, both
    // written by the caller from this return value.
    return {
      ok: false,
      kind: 'ambiguous',
      ambiguity: parsed.ambiguity,
      question: questionFor(parsed.ambiguity),
      plan: null,
    }
  }

  if (current === null) {
    // No structured intent means no named field for a correction to address, so even a
    // well-formed correction has nowhere to go. Ambiguous rather than patch: this is a
    // case where the Mission's own state does not support the correction.
    return {
      ok: false,
      kind: 'ambiguous',
      ambiguity: 'unknown_scope',
      question: 'This mission was set up without a structured goal, so I cannot tell what to change. What should it look for?',
      plan: null,
    }
  }

  if (parsed.cancel) {
    // Cancellation is handled by the caller as a Mission transition. Returning it here as
    // a plan would mean the correction path could settle a Mission, and only the owner's
    // explicit command should.
    return {
      ok: true,
      kind: 'patch',
      plan: {
        correctionId,
        missionId: mission.missionId,
        kind: 'patch',
        changedFields: [],
        next: current,
        question: null,
        ambiguity: null,
      },
      effect: { settledStepIds: [], preservedEvidenceIds: mission.evidence.map((e) => e.evidenceId), replanRequired: false },
      pauseRequested: false,
    }
  }

  const merged: MissionIntentShapeInput = {
    subject: parsed.fields.subject ?? current.subject,
    quantity: parsed.fields.quantity ?? current.requestedQuantity,
    media: parsed.fields.media ?? current.mediaConstraints,
    context: parsed.fields.context ?? current.contextConstraints,
    exclusions: parsed.fields.exclusions ?? current.exclusions,
    paused: parsed.pause ? true : current.paused,
  }

  // Re-validated as a whole, not just field by field. This catches a merge that produced
  // an over-long subject or too many constraints, which per-field checks would each have
  // passed.
  const normalised = normaliseIntentShape(merged)
  if (!normalised.ok) {
    return {
      ok: false,
      kind: 'ambiguous',
      ambiguity: normalised.reason.includes('quantity') ? 'conflicting_quantity' : 'unknown_scope',
      question: normalised.reason,
      plan: null,
    }
  }

  // Which fields actually moved. Compared by value, not by "was it present in the input",
  // so saying "in the barn" twice does not claim a change the second time.
  const changedFields: MissionIntentField[] = []
  if (normalised.value.subject !== current.subject) changedFields.push('subject')
  if (normalised.value.requestedQuantity !== current.requestedQuantity) changedFields.push('quantity')
  if (!sameList(normalised.value.mediaConstraints, current.mediaConstraints)) changedFields.push('media')
  if (!sameList(normalised.value.contextConstraints, current.contextConstraints)) changedFields.push('context')
  if (!sameList(normalised.value.exclusions, current.exclusions)) changedFields.push('exclusions')

  const effect = effectOf(mission, changedFields)

  return {
    ok: true,
    kind: 'patch',
    plan: {
      correctionId,
      missionId: mission.missionId,
      kind: 'patch',
      changedFields,
      next: normalised.value,
      question: null,
      ambiguity: null,
    },
    effect,
    // A correction that says "stop" parks the Mission. It does **not** cancel it, and it
    // does not end it: the owner asked for a pause, and only `cancel` is an ending.
    pauseRequested: parsed.pause,
  }
}

/**
 * Which steps and evidence survive.
 *
 * Ordered and deterministic, because the counts end up in the journal and two runs over
 * the same Mission must produce the same numbers.
 *
 * The two rules, stated plainly:
 *
 * - **Verified steps are always preserved.** An observation does not stop being an
 *   observation because the search narrowed afterwards. Discarding it would be throwing
 *   away real work on the grounds that it was found in the wrong place, which is a
 *   judgement nobody asked Freya to make.
 * - **Evidence is preserved unless the *kind* of thing changed.** Moving the search to a
 *   barn does not invalidate videos found earlier; switching from video to audio does.
 *
 * Steps that have not started are settled when the context or the media constraint
 * changed, because work not yet begun was planned for the old constraint. That is the
 * one case where a correction *does* discard planned work, and it discards only work that
 * never ran.
 */
function effectOf(mission: MissionRecord, changed: readonly MissionIntentField[]): CorrectionEffect {
  const locationChanged = changed.includes('context')
  const kindChanged = changed.includes('media') || changed.includes('exclusions')
  const subjectChanged = changed.includes('subject')

  const settledStepIds: string[] = []
  for (const step of mission.activePlan?.steps ?? []) {
    // Verified work stands.
    if (step.status === 'verified') continue
    // Work in flight has an unknown effect and is never settled by a correction: that is
    // recovery's job, and it has different rules.
    if (step.status === 'running' || step.status === 'delegated') continue
    // Anything terminal that is not verified is already over and needs no settling.
    if (step.status === 'failed' || step.status === 'cancelled' || step.status === 'skipped') continue
    // A `blocked` step is **left alone**, even though it has not run.
    //
    // Blocked means something specific is in the way — an unknown capability, a step
    // interrupted with an unknown effect — and that blocker is a durable record of a
    // question somebody has to answer. Settling the step would erase it, so a correction
    // would quietly overwrite recovery's finding that something is unknown.
    if (step.status === 'blocked') continue
    // So: `pending` only. Settled when the correction changes what the step would have
    // been looking for.
    if (kindChanged || subjectChanged || locationChanged) settledStepIds.push(step.stepId)
  }

  const preservedEvidenceIds: string[] = []
  for (const item of mission.evidence) {
    // A refusal is never preserved: it recorded that something could not be done, and a
    // correction may well make it possible.
    if (item.kind === 'refusal') continue
    // Reported evidence is preserved as *evidence* but never counts as progress, so it is
    // kept for display whatever happened.
    if (item.origin === 'reported') {
      preservedEvidenceIds.push(item.evidenceId)
      continue
    }
    // Observed results survive a change of place. They do not survive a change of kind.
    if (kindChanged) continue
    preservedEvidenceIds.push(item.evidenceId)
  }

  return {
    settledStepIds,
    preservedEvidenceIds,
    // Always true, and asserted rather than computed: every patch needs the remaining
    // work re-examined, because the set of steps that survived is not the plan. A future
    // correction that provably cannot invalidate any step may relax this deliberately.
    replanRequired: true,
  }
}

/** Order-sensitive equality for a constraint list, after de-duplication. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

/**
 * The question to put to the owner.
 *
 * One per ambiguity code, and each one is a question that can be *answered* rather than
 * a complaint. "Which of these did you mean?" is a question; "I did not understand" is
 * not, and the owner cannot act on it.
 *
 * These strings are private content and never reach the journal — only the closed
 * `ambiguity` code does.
 */
function questionFor(code: Exclude<MissionCorrectionAmbiguity, 'no_active_mission' | 'already_settled'>): string {
  switch (code) {
    case 'unknown_subject':
      return 'What should I be looking for?'
    case 'conflicting_quantity':
      return 'How many do you want?'
    case 'multiple_subjects':
      return 'Did you mean to change what I am looking for, or where I am looking?'
    case 'unknown_scope':
    default:
      // A question, not a complaint. It has to be *answerable* — the owner should be able to
      // read it and know what Freya needs, which is why it does not mention parsing and
      // does not say "I did not understand".
      return 'What should I change about what I am looking for?'
  }
}