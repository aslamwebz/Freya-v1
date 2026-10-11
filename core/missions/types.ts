/**
 * THE MISSION DOMAIN.
 *
 * A Mission is the answer to one question:
 *
 * > **What are we actually trying to accomplish?**
 *
 * It is deliberately *not* an answer to "what did we try?", which is what a Run
 * answers. Collapsing the two is the single mistake this file exists to prevent,
 * because the collapse produces two lies:
 *
 * - A failed Run would fail the Mission, when the honest position is that one
 *   execution attempt failed and another may succeed.
 * - A successful Run would complete the Mission, when a successful attempt is not
 *   the same fact as an achieved outcome.
 *
 * So:
 *
 * ```
 *   Mission   the outcome, held across restarts
 *    └ Run     one execution attempt toward it        (Phase 6 owns this)
 *       └ Step └ Action └ Observation └ Verification (Phase 6 owns these)
 * ```
 *
 * ## Mission content is private, and that is a structural property
 *
 * The things people put in a Mission are the most private text Freya will ever
 * hold: "find me another job", "help me handle my house move", "get Freya to
 * €2,000 MRR". Two consequences follow, and both are load-bearing:
 *
 * 1. **Mission content never enters the event journal.** The journal holds ids,
 *    statuses, counts, timestamps and closed codes. There is no slot for a title,
 *    an intent or a success criterion, and the validators *reject an unexpected
 *    field* rather than ignoring it.
 * 2. **Mission content lives in its own encrypted store, under its own key.** It
 *    does not reuse the conversation key, the Brain key or any research secret,
 *    and there is no master root — a Mission is about the user's plans, which is
 *    not the same class of data as anything else Freya stores.
 *
 * ## No progress percentage
 *
 * There is no `percent` field anywhere in this file. A Mission has no denominator:
 * a Run can be decomposed again, so "3 of 5 steps done" is a fact about a plan and
 * not about an outcome. Anything that printed 72% next to the word Mission would be
 * inventing arithmetic. §9 of the Phase 7 brief asks for derived counts, and that
 * is what this file provides.
 */

import type { PrincipalId } from '../../shared/contracts/identity'
import type { WorkRisk } from '../work/types'
import type { MissionExecutionPlan } from './execution-plan'
import type { ChatMissionBinding, MissionBrowserEvidence, MissionResearchEvidence } from './chat-types'
import type {
  MissionApprovalReference,
  MissionBlockerCode,
  MissionBlockerRecord,
  MissionBudget,
  MissionBudgetRemaining,
  MissionContinuationDecision,
  MissionCorrectionRecord,
  MissionDecision,
  MissionEvidenceCounts,
  MissionEvidenceRecord,
  MissionIntentShape,
  MissionPlanRecord,
  MissionPriority,
  MissionProgressView,
  MissionSpend,
  MissionStepCounts,
  MissionStepView,
  MissionWakeKind,
  MissionWakeRecord,
} from './autonomy/types'
import type { MissionReason } from './reasons'
export { MISSION_REASONS } from './reasons'
export type { MissionReason } from './reasons'


/* ---------------------------------------------------------------- statuses */

/**
 * The twelve states a Mission can be in.
 *
 * Phase 7 shipped six and they are all still here. Phase 47 adds the six that an
 * *autonomous* Mission needs and a passive lifecycle does not, because each names
 * something a person would otherwise have to infer from a combination:
 *
 * | status | what it means that `active` could not |
 * | --- | --- |
 * | `ready` | the goal is understood and nothing is in flight |
 * | `planning` | a bounded plan is being built |
 * | `waiting` | stopped, with a durable instant at which it is re-decided |
 * | `blocked` | stopped, and something specific is in the way |
 * | `approval-required` | stopped, and a person must decide before anything else happens |
 * | `verifying` | a completion check is running; the outcome is not yet a fact |
 *
 * `stopped` replaces Phase 7's `paused`. It is **not** terminal, and that is the
 * deliberate choice: STOP ALL is a latched gate the owner may reopen, so a Mission
 * stopped by it must be resumable. What is forbidden is that *anything else* can
 * move it — the only outgoing edge from `stopped` is `ready`, and reaching `ready`
 * is the owner's explicit resume, never a timer and never a capability.
 */
export const MISSION_STATUSES = [
  'draft',
  'ready',
  'planning',
  'active',
  'waiting',
  'blocked',
  'approval-required',
  'verifying',
  'stopped',
  'completed',
  'failed',
  'cancelled',
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value)
}

/**
 * The three states nothing rewrites.
 *
 * `stopped` is deliberately absent: it is a latch, not a settlement, and an owner
 * who resumes STOP ALL must find their Missions where they left them. Every other
 * non-terminal status can be resumed, but only through a transition that names what
 * changed — which is the difference between a Mission a person can pick back up and
 * one that quietly restarted itself.
 */
export const MISSION_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type MissionTerminalStatus = (typeof MISSION_TERMINAL_STATUSES)[number]

export function isTerminalMissionStatus(status: MissionStatus): status is MissionTerminalStatus {
  return MISSION_TERMINAL_STATUSES.includes(status as MissionTerminalStatus)
}

/** Whether a Mission may still move under its own autonomy, right now. */
export function isLiveMissionStatus(status: MissionStatus): boolean {
  return status === 'ready' || status === 'planning' || status === 'active'
}

/**
 * Whether a Mission is parked and needs a person, a clock or an event.
 *
 * Derived from the table rather than restated, so a new status cannot be added
 * without deciding whether it parks a Mission. The projection uses it to answer
 * "is anything happening right now" without inventing a progress number.
 */
export function isParkedMissionStatus(status: MissionStatus): boolean {
  return status === 'waiting' || status === 'blocked' || status === 'approval-required'
}

/**
 * The Mission state machine.
 *
 * The single definition. The engine, the reducer and the journal validator all read
 * it, so "what transitions exist" is one answer rather than three that can disagree
 * — and a disagreement there is exactly how a replayed journal could produce a state
 * the live engine would refuse to reach.
 *
 * Four properties are load-bearing, and each of them closes a way an autonomous
 * Mission could lie:
 *
 * - **Nothing reaches `completed` except from `verifying`.** Completion is a
 *   verifier's verdict, so the Mission must be in the state that means "a
 *   verification is running" first. There is no `active → completed` edge for a
 *   capable step to reach, and the reducer independently refuses a completion with
 *   no passed verification behind it.
 * - **Nothing leaves `approval-required` except to a parked or live state.** An
 *   approval gate cannot be closed by the thing that opened it, and expiry lands in
 *   `blocked` rather than anywhere it could be mistaken for consent.
 * - **`draft → completed` is not permitted, and neither is `ready → completed`.** A
 *   goal must be *running* before it can be *checking*, so completion is only reachable
 *   from `verifying`. "Understood but not yet running" is expressible as `ready`, which
 *   is what that state is for.
 * - **A terminal status has no outgoing edge.** There is no resurrection of any
 *   kind. Retrying is a *new* Mission, or another step before settlement.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = Object.freeze({
  // `draft → active` is kept, not replaced. `mission.activate` is an existing owner
  // command whose meaning has not changed, and widening a state machine must not
  // silently break every surface that calls it. `ready` is the state an *autonomous*
  // Mission passes through on its way to running, and `draft → ready` is there for it.
  draft: Object.freeze(['ready', 'active', 'cancelled'] as const),
  ready: Object.freeze(['planning', 'active', 'blocked', 'stopped', 'cancelled', 'failed'] as const),
  planning: Object.freeze(['active', 'waiting', 'blocked', 'stopped', 'cancelled', 'failed'] as const),
  // **No `completed`.** It is reachable only from `verifying`, so a Mission can never be
  // one edge away from claiming an outcome it has not checked. The `active → verifying`
  // edge above is the one that has to be taken first, and it is a *visible* state change
  // rather than a silent one.
  active: Object.freeze([
    'waiting',
    'blocked',
    'approval-required',
    'verifying',
    'planning',
    'ready',
    'stopped',
    'failed',
    'cancelled',
  ] as const),
  waiting: Object.freeze([
    'active',
    'blocked',
    'approval-required',
    'verifying',
    'planning',
    'stopped',
    'cancelled',
    'failed',
  ] as const),
  blocked: Object.freeze([
    'ready',
    'planning',
    'active',
    'waiting',
    'stopped',
    'cancelled',
    'failed',
  ] as const),
  'approval-required': Object.freeze([
    'active',
    'waiting',
    'blocked',
    'stopped',
    'cancelled',
    'failed',
  ] as const),
  verifying: Object.freeze([
    'completed',
    'active',
    'waiting',
    'blocked',
    'planning',
    'stopped',
    'cancelled',
    'failed',
  ] as const),
  // `ready` is the *autonomous* resume — "the gate is open again, planning is next".
  // `active` is the *owner's* — an owner who pressed Resume wants it running, and a resume
  // that left the Mission waiting for somebody else to start it would not be carrying on.
  stopped: Object.freeze(['ready', 'active', 'cancelled', 'failed'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
})

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to)
}

/**
 * Statuses that existed on disk before Phase 47, and what they mean now.
 *
 * `paused` became `stopped`. The rename is not cosmetic: a Mission in `paused` could
 * be resumed by anyone holding `mission.manage`, whereas `stopped` says the gate is
 * latched and only the owner's resume reopens it.
 *
 * Reading old aliases rather than refusing old journals is the deliberate choice, and
 * it lives here — in the domain — so the fold, the validator and any future reader
 * resolve it identically instead of each growing their own copy. A Mission somebody
 * created on an earlier build is real work; discarding it because a vocabulary was
 * widened would be worse than the rename.
 */
const LEGACY_STATUS_ALIASES: Readonly<Record<string, MissionStatus>> = Object.freeze({ paused: 'stopped' })

/**
 * Read a Mission status from an untrusted value, following the legacy alias.
 *
 * Returns null for anything the domain does not have, which is what makes a
 * hand-edited status line refused rather than folded.
 */
export function readMissionStatus(value: unknown): MissionStatus | null {
  if (typeof value !== 'string') return null
  if (isMissionStatus(value)) return value
  return Object.hasOwn(LEGACY_STATUS_ALIASES, value) ? LEGACY_STATUS_ALIASES[value] ?? null : null
}

/* ------------------------------------------------------------------ limits */

export interface MissionLimits {
  /** Child Runs this Mission may ever attach. */
  readonly maxChildRuns: number
  /** Child Runs allowed to be non-terminal at once. */
  readonly maxConcurrentChildRuns: number
  /**
   * Wall-clock lifetime of a Mission, from creation.
   *
   * A bound, not a check between operations. Nothing polls it: expiry is
   * reconciled at startup and whenever a Mission changes state, so an expired
   * Mission is discovered rather than watched.
   */
  readonly lifetimeMs: number
  /**
   * How long one completion verification may run before the engine stops waiting.
   *
   * Raced against the verifier rather than merely aborting it, because a verifier
   * that ignores its signal must not be able to hold a Mission open indefinitely.
   */
  readonly verificationDeadlineMs: number
  /** Missions retained in the volatile listing. */
  readonly maxRetainedMissions: number
  /** Characters in a title. */
  readonly maxTitleChars: number
  /** Characters in an intent. */
  readonly maxIntentChars: number
  /** Success criteria a Mission may hold. */
  readonly maxSuccessCriteria: number
  /** Characters in one success criterion. */
  readonly maxCriterionChars: number
}

export const DEFAULT_MISSION_LIMITS: Readonly<MissionLimits> = Object.freeze({
  maxChildRuns: 64,
  maxConcurrentChildRuns: 4,
  lifetimeMs: 30 * 24 * 60 * 60_000,
  verificationDeadlineMs: 60_000,
  maxRetainedMissions: 200,
  maxTitleChars: 160,
  maxIntentChars: 4_000,
  maxSuccessCriteria: 16,
  maxCriterionChars: 500,
})

const LIMIT_NAMES: readonly (keyof MissionLimits)[] = [
  'maxChildRuns',
  'maxConcurrentChildRuns',
  'lifetimeMs',
  'verificationDeadlineMs',
  'maxRetainedMissions',
  'maxTitleChars',
  'maxIntentChars',
  'maxSuccessCriteria',
  'maxCriterionChars',
]

/**
 * Apply a caller's *narrowed* ceilings.
 *
 * A caller may lower a ceiling and may never raise one. An unknown key, a
 * non-integer or a value above the ceiling is **refused**, not clamped — clamping
 * would silently accept a caller trying to raise a limit, and an ignored key would
 * let a future field slip past unreviewed.
 */
export function missionLimits(overrides: Partial<MissionLimits> = {}): Readonly<MissionLimits> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('mission limits are malformed')
  }
  const merged: Record<string, number> = { ...DEFAULT_MISSION_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!LIMIT_NAMES.includes(key as keyof MissionLimits)) throw new Error(`unknown mission limit: ${key}`)
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`mission limit ${key} is not a positive integer`)
    }
    if (value > DEFAULT_MISSION_LIMITS[key as keyof MissionLimits]) {
      throw new Error(`mission limit ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as MissionLimits)
}

/* ------------------------------------------------------ private content */

/**
 * What a Mission is *for*.
 *
 * Private, bounded, and stored encrypted under the Mission domain. It never
 * appears in an event, and a Mission is unreadable without it — which is why a
 * Mission whose content cannot be opened is reported rather than shown empty.
 *
 * `intentShape` is the machine-patchable half. `intent` is what a person reads and
 * what a correction rewrites as text; `intentShape` is the named-field version an
 * owner correction addresses field by field. Both are private, both are here, and
 * the split is what lets "in the barn" change one constraint without disturbing the
 * subject, the quantity or the media type.
 */
export interface MissionContentInput {
  readonly title: string
  readonly intent: string
  readonly successCriteria?: readonly string[]
  /** Optional structured intent. Omitted for a Mission with no countable goal. */
  readonly intentShape?: MissionIntentShapeInput | null
}

export interface MissionContent {
  readonly chatBinding?: ChatMissionBinding
  readonly researchEvidence?: Readonly<Record<string, MissionResearchEvidence>>
  /**
   * What each browser step retained, keyed by step id, for its own verifier.
   *
   * Separate from {@link MissionContent.researchEvidence} rather than merged into it: the
   * two describe different external surfaces with different evidence, and a Mission that
   * searched the web and read pages would otherwise have one list that could not say which
   * entry came from where.
   */
  readonly browserEvidence?: Readonly<Record<string, MissionBrowserEvidence>>
  /** Private execution intent/inputs, under the existing encrypted store. */
  readonly executionPlan?: MissionExecutionPlan
  readonly missionId: string
  readonly title: string
  readonly intent: string
  readonly intentShape: MissionIntentShape | null
  readonly successCriteria: readonly string[]
  readonly createdAt: string
}

export type MissionContentResult =
  | {
      readonly ok: true
      readonly value: Omit<MissionContent, 'missionId' | 'createdAt'>
    }
  | { readonly ok: false; readonly reason: string }

/** The structured intent as an owner supplies it, before it is bounded. */
export interface MissionIntentShapeInput {
  readonly subject: string
  readonly quantity?: number | null
  readonly media?: readonly string[]
  readonly context?: readonly string[]
  readonly exclusions?: readonly string[]
  readonly paused?: boolean
}

/** Characters in one intent subject, and in one constraint. */
export const MAX_INTENT_SUBJECT_CHARS = 500
export const MAX_INTENT_CONSTRAINT_CHARS = 200

/** How many entries one constraint list may hold. */
export const MAX_INTENT_CONSTRAINTS = 8

/**
 * The largest quantity a Mission may be asked for.
 *
 * A bound, and a modest one. A requested quantity is an owner telling Freya how
 * much work it should do, so an unbounded number would be an unbounded amount of
 * automatic searching; refusing it at the door is cheaper than discovering the
 * ceiling after four thousand external requests.
 */
export const MAX_REQUESTED_QUANTITY = 100_000

// Control characters are removed rather than escaped, except tab and newline.
//
// A Mission title ends up in window titles, projections and accessibility labels,
// and an escape sequence surviving into one of those is a way to make a terminal
// say something Freya did not say.
//
// Built from numeric ranges so the source file itself contains no control byte, and
// written out rather than as a negated class so the rule cannot quietly widen.
const CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
]

function stripControlCharacters(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const stripped = CONTROL_RANGES.some(([low, high]) => code >= low && code <= high)
    if (!stripped) out += character
  }
  return out
}

/**
 * Normalise and bound Mission content.
 *
 * Content is **data**. It is never evaluated, never parsed as markup and never
 * interpreted; this function only trims, strips control characters and enforces the
 * ceilings.
 */
export function normaliseMissionContent(input: MissionContentInput): MissionContentResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'mission content is malformed' }

  const title = clean(input.title, DEFAULT_MISSION_LIMITS.maxTitleChars)
  if (title === null) return { ok: false, reason: `a mission title must be 1-${DEFAULT_MISSION_LIMITS.maxTitleChars} characters` }

  const intent = clean(input.intent, DEFAULT_MISSION_LIMITS.maxIntentChars)
  if (intent === null) return { ok: false, reason: `a mission intent must be 1-${DEFAULT_MISSION_LIMITS.maxIntentChars} characters` }

  let criteria: readonly string[] = []
  if (input.successCriteria !== undefined) {
    if (!Array.isArray(input.successCriteria)) return { ok: false, reason: 'success criteria must be a list' }
    if (input.successCriteria.length > DEFAULT_MISSION_LIMITS.maxSuccessCriteria) {
      return { ok: false, reason: `a mission may hold at most ${DEFAULT_MISSION_LIMITS.maxSuccessCriteria} success criteria` }
    }
    const cleaned: string[] = []
    for (const raw of input.successCriteria) {
      const criterion = clean(raw, DEFAULT_MISSION_LIMITS.maxCriterionChars)
      if (criterion === null) {
        return { ok: false, reason: `each success criterion must be 1-${DEFAULT_MISSION_LIMITS.maxCriterionChars} characters` }
      }
      cleaned.push(criterion)
    }
    criteria = cleaned
  }

  let intentShape: MissionIntentShape | null = null
  if (input.intentShape !== undefined && input.intentShape !== null) {
    const shape = normaliseIntentShape(input.intentShape)
    if (!shape.ok) return { ok: false, reason: shape.reason }
    intentShape = shape.value
  }

  return { ok: true, value: { title, intent, intentShape, successCriteria: criteria } }
}

/**
 * Bound and normalise the structured intent **as an owner supplies it**.
 *
 * Takes `MissionIntentShapeInput` — the form with `quantity`, `media`, `context` — and
 * produces the stored `MissionIntentShape`. Only `normaliseMissionContent` calls this,
 * because creation is the only point where an intent arrives from outside.
 *
 * Same rules as every other piece of Mission content, and for the same reasons: control
 * characters are stripped rather than escaped because these strings end up in projections
 * and accessibility labels, and the lists are bounded because a constraint list is a place
 * a prompt would otherwise grow without limit.
 *
 * A quantity is refused rather than rounded. Silently turning "about a thousand" into
 * 1,000 would be the owner being told they asked for something they did not.
 *
 * There is a second entry point for the *stored* form — see
 * {@link normaliseStoredIntentShape} — and the two are separate on purpose. Running the
 * stored shape through this one would read `requestedQuantity` as an absent `quantity` and
 * `contextConstraints` as an absent `context`, silently producing an intent with no
 * quantity and no constraints. That is exactly what happened before they were split.
 */
export function normaliseIntentShape(input: MissionIntentShapeInput): MissionContentResultShape {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'a structured mission intent is malformed' }
  }
  const subject = clean(input.subject, MAX_INTENT_SUBJECT_CHARS)
  if (subject === null) {
    return { ok: false, reason: `a mission intent subject must be 1-${MAX_INTENT_SUBJECT_CHARS} characters` }
  }

  let quantity: number | null = null
  if (input.quantity !== undefined && input.quantity !== null) {
    if (typeof input.quantity !== 'number' || !Number.isInteger(input.quantity) || input.quantity <= 0) {
      return { ok: false, reason: 'a requested quantity must be a positive whole number' }
    }
    if (input.quantity > MAX_REQUESTED_QUANTITY) {
      return { ok: false, reason: `a requested quantity may not exceed ${MAX_REQUESTED_QUANTITY}` }
    }
    quantity = input.quantity
  }

  const media = constraintList(input.media, 'media constraint')
  if (!media.ok) return media
  const context = constraintList(input.context, 'context constraint')
  if (!context.ok) return context
  const exclusions = constraintList(input.exclusions, 'exclusion')
  if (!exclusions.ok) return exclusions

  if (input.paused !== undefined && typeof input.paused !== 'boolean') {
    return { ok: false, reason: 'a mission intent pause flag must be true or false' }
  }

  return {
    ok: true,
    value: {
      subject,
      requestedQuantity: quantity,
      mediaConstraints: media.value,
      contextConstraints: context.value,
      exclusions: exclusions.value,
      paused: input.paused === true,
    },
  }
}

type MissionContentResultShape =
  | { readonly ok: true; readonly value: MissionIntentShape }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate and normalise the **stored** form of the intent.
 *
 * Separate from {@link normaliseIntentShape} because the two shapes have different field
 * names — `requestedQuantity` versus `quantity`, `contextConstraints` versus `context` — and
 * running one through the other's normaliser silently drops every field it does not
 * recognise. An intent written back with no quantity and no constraints is not a validation
 * failure at all; it is a successful write of the wrong thing, which is worse.
 *
 * So: the stored shape goes through the **input** normaliser's own rules by way of a
 * rename, and is refused if any field does not read. The rename is written out rather than
 * looped over so that a field added to one shape and not the other is a type error here.
 */
export function normaliseStoredIntentShape(input: MissionIntentShape): MissionContentResultShape {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'a structured mission intent is malformed' }
  }
  return normaliseIntentShape({
    subject: input.subject,
    quantity: input.requestedQuantity,
    media: input.mediaConstraints,
    context: input.contextConstraints,
    exclusions: input.exclusions,
    paused: input.paused,
  })
}

function constraintList(
  value: readonly string[] | undefined,
  label: string,
): { ok: true; value: readonly string[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, reason: `every ${label} must be a list` }
  if (value.length > MAX_INTENT_CONSTRAINTS) {
    return { ok: false, reason: `a mission may hold at most ${MAX_INTENT_CONSTRAINTS} ${label}s` }
  }
  const out: string[] = []
  for (const raw of value) {
    const entry = clean(raw, MAX_INTENT_CONSTRAINT_CHARS)
    if (entry === null) {
      return { ok: false, reason: `each ${label} must be 1-${MAX_INTENT_CONSTRAINT_CHARS} characters` }
    }
    // Duplicates are dropped rather than preserved: "in the barn, in the barn" is
    // one constraint stated twice, and keeping both would make a constraint count
    // disagree with the number of things it names.
    if (!out.includes(entry)) out.push(entry)
  }
  return { ok: true, value: out }
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = stripControlCharacters(value).trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/* --------------------------------------------------------------- records */

/**
 * What the journal knows about one Mission.
 *
 * Durable, and metadata only. Every field is an id, a status, an instant, a count,
 * a bound or a closed code. There is deliberately **no title, no intent and no
 * success criteria here** — those live in the encrypted private store, and their
 * absence from this record is what makes a Mission journal safe to keep in a backup.
 *
 * ## Why `requestedQuantity` and `resultCount` are the only two numbers about the goal
 *
 * Both are counts, and progress has to be computable to be honest: a Mission asking
 * for 100 items can say "37 found" and nothing else. Neither is content — a number
 * reveals no more about what the owner wants than the ceiling that produced it
 * does, and refusing to store them would force the projection to *invent* a
 * percentage, which is the one thing this domain has never done.
 *
 * Everything else about the goal — the subject, the media type, the location, the
 * exclusions — is a word, and no word appears anywhere in this record.
 */
export interface MissionRecord {
  readonly missionId: string
  readonly status: MissionStatus
  readonly createdAt: string
  readonly activatedAt: string | null
  readonly pausedAt: string | null
  readonly settledAt: string | null
  /** Absolute deadline derived from `lifetimeMs` at creation. */
  readonly deadlineAt: string
  /** Child Runs attached, in attachment order. Never re-sorted. */
  readonly childRuns: readonly string[]
  readonly limits: MissionLimits
  /** The last verification request's outcome. A code, never evidence. */
  readonly verification: MissionVerificationRecord | null
  /** Closed code for why this Mission settled, or for a refused child Run. */
  readonly reason: MissionReason | null
  /** How many child Runs were refused by a ceiling. Durable, so a restart cannot hide one. */
  readonly limitsHit: readonly MissionLimitName[]

  /* -------------------------------------------------- Phase 47: autonomy */

  /** How this Mission competes for the owner's attention. Closed enum, grants nothing. */
  readonly priority: MissionPriority
  /**
   * Autonomy ceilings, frozen at creation.
   *
   * Separate from `limits` on purpose: `limits` bounds child Runs, which is a
   * Phase 7 concern, and `budget` bounds the work a Mission does *itself* —
   * model calls, actions, external requests, retries, delegations, replans. A
   * caller narrows either and may raise neither.
   */
  readonly budget: MissionBudget
  /** What the Mission has consumed. Derived by folding; never settable. */
  readonly spend: MissionSpend
  /** The plan currently in force, or null before the first one is committed. */
  readonly activePlan: MissionPlanRecord | null
  /** How many plans this Mission has ever committed. Bounds replanning durably. */
  readonly planRevisions: number
  /** Every observed or reported observation, in arrival order. Ids and counts only. */
  readonly evidence: readonly MissionEvidenceRecord[]
  /**
   * Blockers currently in the way. Cleared ones are removed, not kept with a flag.
   *
   * That choice is what makes `blockers` answerable: a board can render this list
   * directly, and a Mission cannot appear blocked by last month's problem. The history
   * of what blocked it is in the journal.
   */
  readonly blockers: readonly MissionBlockerRecord[]
  /**
   * The Work approval this Mission is parked on, or null.
   *
   * **A reference, not a gate.** This is a pointer to a `work.approval.requested` record
   * that Work's own Guard opened. Reading the outcome requires going to Work.
   *
   * There is deliberately no list here. A Mission used to keep its own approval registry
   * — a `MissionApprovalGate` per request, with its own pending/decided/expired lifecycle
   * and its own id sequence — and that was a second approval system inside Core, one that
   * nobody answered. The person answers Work's gate, on Work's surface, through
   * `work.approval.decide`, which is the only path in the codebase where an approval can
   * become `approved`.
   */
  readonly approval: MissionApprovalReference | null
  /** The next wake, or null when the Mission has no scheduled moment. */
  readonly wake: MissionWakeRecord | null
  /**
   * The requested quantity, or null when the owner named no number.
   *
   * An integer in the journal, and one of only two. See the note above.
   */
  readonly requestedQuantity: number | null
  /**
   * How many *observed* results exist, as of this fold.
   *
   * Reported results are deliberately absent: a capability saying it found twelve
   * things is not twelve things. This is the number the projection divides by
   * `requestedQuantity`, and because it counts only `observed` evidence it can
   * never report progress on a claim nobody checked.
   */
  readonly resultCount: number
  /** Every owner correction, in order. Field names and counts; never the values. */
  readonly corrections: readonly MissionCorrectionRecord[]
  /**
   * Whether the owner has latched this Mission into asking rather than doing.
   *
   * Set when a correction is ambiguous. It is **not** the same as `blocked`, and the
   * difference matters: `blocked` means something is in the way, while this means
   * Freya does not understand the goal and is waiting to be told. Nothing proceeds
   * in either state, and only a person clears this one.
   */
  readonly awaitingOwner: boolean
  /**
   * The most recent continuation decision, and nothing before it.
   *
   * One decision, not a log. The full history is in the journal
   * (`mission.continuation.decided`); what the record keeps is the latest, because
   * that is the one a board needs to answer "why is nothing happening?" — and
   * keeping a history here would mean the fold could grow without bound from events.
   *
   * Its `nextWakeAt` is the same instant as `wake.dueAt`, and the invariant that a
   * `wait` always names one is enforced in the fold.
   */
  readonly lastDecision: MissionContinuationDecision | null
  /** When the Mission last changed in any way. Lets a board prove it is current. */
  readonly lastUpdatedAt: string
}

/**
 * Which code-owned ceiling stopped something.
 *
 * Phase 7's three child-Run and lifetime bounds, plus Phase 47's nine autonomy
 * ceilings. One list rather than two because the field it populates means "a ceiling
 * was reached", and splitting it would make a board show two identical warnings for
 * one kind of event.
 *
 * The two families are still distinguishable by *which event* recorded the hit —
 * `mission.limit.exceeded` for the first three, `mission.budget.exceeded` for the rest —
 * and the validator refuses either event naming the other's names.
 */
export type MissionLimitName =
  | 'maxChildRuns'
  | 'maxConcurrentChildRuns'
  | 'lifetimeMs'
  | keyof MissionBudget

export type MissionVerificationState = 'requested' | 'passed' | 'not_established' | 'timeout' | 'cancelled'

export interface MissionVerificationRecord {
  readonly verifierId: string
  readonly state: MissionVerificationState
  readonly requestedAt: string
  readonly settledAt: string | null
  /** Closed code. Never a verifier's message, never evidence. */
  readonly reason: MissionReason | null
  /** Child Runs this request required. Ids only. */
  readonly requiredRunIds: readonly string[]
}

/* ------------------------------------------------------------ verification */

/**
 * What a Mission verifier is asked.
 *
 * Deliberately thin: ids, statuses and counts. A verifier is code owned by this
 * repository, and handing it the Mission's private text would put that text in
 * whatever the verifier does with it — including, for a future verifier, a model.
 * A verifier that needs to know *what* the Mission is should ask for that
 * deliberately through the private store, under its own capability.
 */
export interface MissionVerificationContext {
  readonly missionId: string
  readonly status: MissionStatus
  /** Child Runs the completion request required, ids only. */
  readonly requiredRunIds: readonly string[]
  /** Child Run statuses, so a verifier needs no Work access of its own. */
  readonly runStatuses: Readonly<Record<string, 'completed' | 'failed' | 'cancelled' | 'verified_steps' | 'non_terminal'>>
  /** Aggregate step status per required Run. */
  readonly runStepStatuses: Readonly<Record<string, { verified: number; total: number; failed: number; other: number }>>

  /* ------------------------------------------- Phase 47: mission-level facts */

  /**
   * Step counts by status, for the *active* plan. Counts only — a verifier learns
   * that three steps are verified without learning what any of them were.
   */
  readonly stepCounts: MissionStepCounts
  /**
   * Observed results, fresh and stale, counted separately.
   *
   * Two numbers rather than one because the difference is the whole point: an
   * outcome backed by evidence that has expired is not established, and a verifier
   * that could only see a total could not tell the two apart.
   */
  readonly observedResults: number
  readonly expiredObservedResults: number
  /** Reported results. Never counts toward an outcome; present so it can be shown. */
  readonly reportedResults: number
  /** The requested quantity, or null. A verifier compares rather than guesses. */
  readonly requestedQuantity: number | null
  /** Whether an unresolved blocker is currently applied. */
  readonly blocked: boolean
  /** Whether an approval gate is pending. */
  readonly approvalPending: boolean
  /** Whether any step was interrupted with an unknown external effect. */
  readonly uncertainEffects: number
}

/**
 * Step counts by status. The only progress shape a verifier is shown.
 *
 * Re-exported from `autonomy/types.ts`, where it is defined, so the projection and
 * the verifier read the same one rather than two that can drift.
 */
export type { MissionStepCounts } from './autonomy/types'

/**
 * A verifier's answer.
 *
 * A verdict and a closed code. **No free text, no evidence, no status of its
 * own** — the engine performs the transition, and only after reading this. A
 * verifier returning `{"status":"completed","principal":"owner"}` is data; it
 * cannot move a Mission, and there is no field here it could put that into.
 */
export interface MissionVerificationOutcome {
  readonly established: boolean
  readonly reason: MissionReason
  /** Present only when it is a fixed length, for display. Never content. */
  readonly summaryLength?: number
}

/**
 * A Mission verifier.
 *
 * Code-owned and separately registered. Neither a renderer nor a model may inject
 * one: a verifier is the thing that decides whether an outcome was achieved, and
 * an injectable verifier would be an injectable authority.
 */
export interface MissionVerifier {
  readonly id: string
  verify(context: MissionVerificationContext, signal: AbortSignal): Promise<MissionVerificationOutcome>
}

/* ------------------------------------------------------------- projection */

/** Counts of child Runs by their Work status. Factual, never a percentage. */
export interface MissionChildRunCounts {
  readonly total: number
  readonly queued: number
  readonly running: number
  readonly waiting: number
  readonly awaitingApproval: number
  readonly paused: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  /** Runs whose every step is `verified`. */
  readonly verified: number
}

/**
 * What a renderer may know about a Mission without its private content.
 *
 * `needsAttention` is derived, deterministic and honest: it means something needs
 * a person, not that a Mission is doing badly. A failed child Run sets it, because
 * an execution that failed is exactly what a person decides what to do about.
 *
 * ## The board's ten fields, and the one that is deliberately absent
 *
 * Phase 47 requires a board row to answer: status, computable progress, current
 * step, next action, blocker, pending approval, evidence count, verification, next
 * wake, last update. All ten are here.
 *
 * There is no percentage, and there never will be — see the note at the top of this
 * file. `progress` is a set of counts and a `satisfied` flag when the owner named a
 * quantity, so a board renders "37 of 100 · 3 of 6 steps verified" and never a
 * number whose denominator Freya chose.
 */
export interface MissionSummaryView {
  readonly missionId: string
  readonly status: MissionStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly reason: MissionReason | null
  readonly counts: MissionChildRunCounts
  readonly needsAttention: boolean
  /** What can be done now, derived from the status. The UI offers exactly this. */
  readonly availableActions: readonly MissionAction[]
  readonly verification: {
    readonly state: MissionVerificationState
    readonly verifierId: string
  } | null

  /* ------------------------------------------- Phase 47: board projection */

  readonly priority: MissionPriority
  /** The plan revision in force, or null before one exists. */
  readonly planRevision: number | null
  readonly progress: MissionProgressView
  /** The step the Mission is on, or null. An id and a status — never a label. */
  readonly currentStep: MissionStepView | null
  /** The last continuation decision, so a board can say *why* nothing is happening. */
  readonly nextAction: {
    readonly decision: MissionDecision
    readonly reason: MissionReason
  } | null
  /** Applied blockers, as closed codes. Empty when nothing is in the way. */
  readonly blockers: readonly MissionBlockerCode[]
  /**
   * The Work approval this Mission is parked on, if one is open.
   *
   * `approvalId` is **Work's**, so a person reading this board can go to Work's approval
   * surface and answer the same question rather than being asked a second one somewhere
   * else. The capability and risk are shown because a person deciding needs to know what
   * they are deciding about; they are read from the step, not copied into a gate of ours.
   */
  readonly pendingApproval: {
    readonly approvalId: string
    readonly stepId: string
    readonly capability: string
    readonly risk: WorkRisk
    readonly requestedAt: string
    /** Whether the plan asked for this gate or Work's Guard demanded it. */
    readonly source: 'requested' | 'observed'
  } | null
  /** Evidence, split observed from reported and fresh from expired. */
  readonly evidence: MissionEvidenceCounts
  /** The scheduled next wake: kind, instant, and the event type if it waits on one. */
  readonly nextWake: {
    readonly wakeId: string
    readonly kind: MissionWakeKind
    readonly dueAt: string
    readonly eventType: string | null
  } | null
  readonly lastUpdatedAt: string
  /** Whether Freya is waiting for the owner to explain the goal. */
  readonly awaitingOwner: boolean
  /** Remaining budget, so a board can show a Mission that is nearly out. */
  readonly budgetRemaining: MissionBudgetRemaining
}

/**
 * Progress, evidence and budget shapes.
 *
 * Defined in `autonomy/types.ts` beside the records they are derived from, and
 * re-exported here so a surface reads one import for a board row.
 */
export type {
  MissionBudgetRemaining,
  MissionEvidenceCounts,
  MissionProgressView,
  MissionStepView,
} from './autonomy/types'

/** Actions the engine can actually perform from a given status. */
/**
 * Actions the engine can actually perform from a given status.
 *
 * `decideApproval` is **not** in this list, and the omission is the architecture. An
 * approval is decided by a person through `work.approval.decide`, on Work's surface, behind
 * a Guard evaluation of the owner. A Mission action list that could name a decision would be
 * a second door into that decision — and this one would be the door with no Guard behind it.
 */
export const MISSION_ACTIONS = [
  'activate',
  'pause',
  'resume',
  'requestCompletion',
  'cancel',
  'fail',
  'correct',
  'resumeAutonomy',
  'stop',
] as const

export type MissionAction = (typeof MISSION_ACTIONS)[number]

/**
 * Every Mission, for a listing.
 *
 * `durable` says whether the private content store is encrypted. It is false on a
 * machine with no secure storage, and a Mission that is ephemeral says so rather
 * than pretending otherwise — because a Mission somebody is told is durable and
 * which is not is worse than no Mission at all.
 */
export interface MissionProjection {
  readonly persistence: {
    readonly mode: 'encrypted' | 'ephemeral' | 'unavailable'
    readonly reason: string | null
    readonly durable: boolean
  }
  readonly missions: readonly MissionSummaryView[]
  /**
   * One counter per Mission status, plus a total and an attention count.
   *
   * Spelled as an intersection rather than twelve written-out fields, so this **cannot**
   * drift from `MISSION_STATUSES`: adding a status to the domain makes this type demand
   * a counter for it, and removing one removes the key. That is the reason a hand-written
   * list of six was replaced here.
   */
  readonly counts: { readonly [K in MissionStatus]: number } & {
    readonly total: number
    readonly needsAttention: number
  }
  readonly limits: MissionLimits
  /**
   * How many Missions this projection lists, out of how many exist, and how many are
   * therefore not on screen.
   *
   * `maxRetainedMissions` bounds the *listing* and nothing else — not the journal, not
   * the in-memory fold — so a viewer that quietly stopped listing Missions would read
   * as "they were never created". These three make the gap visible instead. Same shape
   * and same reason as Work's `runsRetained` / `runsTotal` / `runsHidden`.
   */
  readonly missionsRetained: number
  readonly missionsTotal: number
  readonly missionsHidden: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/** One Mission with its private content, for the Mission that is on screen. */
export interface MissionDetail extends MissionSummaryView {
  /** Null only when the content store is unavailable or the content is gone. */
  readonly content: MissionContent | null
  readonly contentReason: string | null
}

/* -------------------------------------------------------------- outcomes */

export type MissionOperation =
  | 'read'
  | 'updated'
  | 'deleted'
  | 'status'
  | 'created'
  | 'activated'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'settled-failed'
  | 'verification-passed'
  | 'verification-not-established'
  | 'verification-in-progress'
  | 'verification-timeout'
  | 'run-attached'
  | 'run-refused'
  | 'refused'
  /* ---------------------------------------------- Phase 47: the autonomy loop */
  /** A plan was committed. Revision 1 and every revision after it. */
  | 'plan-committed'
  /** A step moved. `reason` carries the closed code for a failure or a block. */
  | 'step-transitioned'
  /** A step's action was in flight when the process stopped. */
  | 'step-interrupted'
  /** Evidence was recorded. `reason` is null; the evidence's own fields carry the meaning. */
  | 'evidence-recorded'
  /** A blocker was raised or cleared. */
  | 'blocker-changed'
  /**
   * This step is now waiting on a Work approval. A pointer, never a decision.
   *
   * There is no `approval-decided` operation and no `approval-expired` one. Both would be
   * Core recording a fact about an approval it does not own, and both are already recorded
   * once, on Work's side, after Guard has evaluated whoever answered.
   */
  | 'approval-requested'
  /** What Work reported about the gate, read back. Never inferred. */
  | 'approval-outcome'
  /** A wake was scheduled or fired. */
  | 'wake-scheduled'
  | 'wake-fired'
  /** Freya decided what to do next. */
  | 'continuation-decided'
  /** Budget was consumed or a ceiling was reached. */
  | 'budget-spent'
  | 'budget-exceeded'
  /** An owner correction was applied to this Mission. */
  | 'intent-corrected'
  /** A correction was ambiguous, so the owner was asked. Nothing changed. */
  | 'correction-ambiguous'
  /** A lifecycle edge outside the six named events. */
  | 'transitioned'

/**
 * What a Mission command produced.
 *
 * Explicit operations rather than a boolean, because "the Mission was not
 * completed" has several genuinely different meanings — refused, not established,
 * timed out, already settled — and a caller that has to inspect a reason string to
 * tell them apart is a caller that will get it wrong.
 */
export interface MissionCommandOutcome {
  readonly operation: MissionOperation
  readonly ok: boolean
  readonly reason?: string
  readonly missionId?: string
  readonly status?: MissionStatus
  readonly runId?: string
  readonly needsAttention?: boolean
}

/* ------------------------------------------------------------------ misc */

/** A Mission's owning principal, assigned by Core and never taken from a payload. */
export type MissionActor = PrincipalId

/** The durable shape the reducer folds and the journal replays. */
export interface MissionState {
  readonly missions: ReadonlyMap<string, MissionRecord>
  readonly sequence: number
}
