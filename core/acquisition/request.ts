/**
 * STAGE ONE — A CAPABILITY GAP, AND AN ACQUISITION REQUEST.
 *
 * Two constructors, and the second is the one that matters.
 *
 * ## A gap names a need; it does not name a permission
 *
 * `CapabilityGap.wanted` is a bounded code-owned slug describing the *shape* of what is
 * missing — `csv-export`, `archive-reader` — and is checked against `isAcquisitionSlug`, not
 * against the capability registry. That is the whole defence against the most plausible
 * laundering route in this phase: if a gap could say `work.run.manage`, something downstream
 * would eventually go looking for a grant to match it, and a system that can *name* the
 * thing it wants is one refactor from holding it.
 *
 * ## A request starts untrusted and inactive, with no way to say otherwise
 *
 * `GENERATED_TRUST_CLASS` and `GENERATED_ACTIVATION` are **not parameters**. They are
 * constants assigned inside `createAcquisitionRequest`, so there is no call shape — typed or
 * untyped — that produces a request carrying anything else. A payload that adds a `trustClass`
 * or an `activation` field is refused by the exact-key rule rather than having its value
 * replaced.
 *
 * ## The two refusals that happen at construction, not at activation
 *
 * - **A protected target** is refused here. Waiting until activation would mean the build
 *   had already run against Freya's own authority or source tree, and refusing afterwards
 *   would be refusing the *record* of something that already happened.
 * - **A forbidden requirement** is refused here, for the same reason: a build that was going
 *   to ask for `security.policy.write` should never have been described.
 */

import { findSecretShape } from '../brain/admission'
import type { Confidence } from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import {
  ACQUISITION_LIMITS,
  ACQUISITION_RETENTION,
  GENERATED_ACTIVATION,
  GENERATED_TRUST_CLASS,
  instantMs,
  isAcquisitionRef,
  isAcquisitionSlug,
  isBoundedAcquisitionText,
  isForbiddenAcquisitionFieldName,
  isForbiddenRequirement,
  isGapKind,
  isProtectedTarget,
  REQUEST_LIFECYCLE_REASON_BY_STATUS,
  REQUEST_TRANSITIONS,
  type AcquisitionRequest,
  type ActivationState,
  type CapabilityGap,
  type GapKind,
  type RequestLifecycleReason,
  type RequestStatus,
} from './types'

export type AcquisitionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/* -------------------------------------------------------------------- gap */

export const GAP_INPUT_KEYS: readonly string[] = [
  'gapId',
  'kind',
  'wanted',
  'symptom',
  'occurrences',
  'evidenceRefs',
  'tags',
  'detectedBy',
  'detectedAt',
]

export const GAP_KEYS: readonly string[] = [...GAP_INPUT_KEYS, 'expiresAt', 'status', 'closedAt', 'closureReason']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Refuse-not-ignore, before the exact-key check, as everywhere else in Core. */
function forbiddenFieldNames(input: unknown, depth = 0, nodes = { seen: 0 }): readonly string[] {
  if (depth > 3 || nodes.seen > 1_024) return []
  nodes.seen += 1
  if (typeof input !== 'object' || input === null) return []
  const found: string[] = []
  for (const [name, member] of Object.entries(input as Record<string, unknown>)) {
    if (isForbiddenAcquisitionFieldName(name)) found.push(name)
    if (typeof member === 'object' && member !== null) {
      found.push(...forbiddenFieldNames(member, depth + 1, nodes))
    }
  }
  return found
}

/**
 * Construct a capability gap.
 *
 * Refuses rather than repairs. An `occurrences` count is bounded and non-negative, and a
 * `symptom` carrying secret-shaped text fails whole rather than being stored and redacted
 * later.
 */
export function createCapabilityGap(input: unknown): AcquisitionResult<CapabilityGap> {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a capability gap input must be an object' }
  }
  const forbidden = forbiddenFieldNames(input)
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `the gap carries field(s) a need may not hold: [${forbidden.join(', ')}]`,
    }
  }
  if (!hasExactKeys(input, GAP_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...GAP_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `capability gap keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }
  if (!isBoundedAcquisitionText(input.gapId, ACQUISITION_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'gapId must be a non-empty bounded string' }
  }
  if (!isGapKind(input.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'kind is not in the closed gap vocabulary' }
  }
  if (!isAcquisitionSlug(input.wanted) || String(input.wanted).length > ACQUISITION_LIMITS.maxWantedChars) {
    return {
      ok: false,
      code: 'invalid-slug',
      reason: 'wanted must be a bounded code-owned slug describing the shape of what is missing',
    }
  }
  if (!isBoundedAcquisitionText(input.symptom, ACQUISITION_LIMITS.maxSymptomChars)) {
    return { ok: false, code: 'invalid-text', reason: 'symptom must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.symptom)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'invalid-text',
      reason: `the symptom is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  if (
    typeof input.occurrences !== 'number' ||
    !Number.isInteger(input.occurrences) ||
    input.occurrences < 1 ||
    input.occurrences > 1_000_000
  ) {
    return {
      ok: false,
      code: 'invalid-id',
      reason: 'occurrences must be a positive whole number: a count of what was seen, never a score',
    }
  }
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length > ACQUISITION_LIMITS.maxEvidenceRefs ||
    !input.evidenceRefs.every((ref) => isAcquisitionRef(ref))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'evidenceRefs must be bounded opaque ids: a gap rests on something that was observed',
    }
  }
  if (input.evidenceRefs.length === 0) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'a capability gap must name at least one evidence reference; nothing else is a gap',
    }
  }
  if (
    !Array.isArray(input.tags) ||
    input.tags.length > ACQUISITION_LIMITS.maxTagsPerRecord ||
    !input.tags.every((tag) => isAcquisitionRef(tag) && tag.length <= ACQUISITION_LIMITS.maxTagChars)
  ) {
    return { ok: false, code: 'invalid-tags', reason: 'tags must be bounded code-owned labels' }
  }
  if (input.detectedBy !== 'core' && input.detectedBy !== 'owner') {
    return { ok: false, code: 'invalid-kind', reason: 'detectedBy must be core or owner' }
  }
  const detected = instantMs(input.detectedAt)
  if (detected === null) {
    return { ok: false, code: 'invalid-instant', reason: 'detectedAt must parse as an instant' }
  }
  // The deadline is *derived*, never accepted: a caller that could name its own expiry
  // could name none, and "no deadline" is the only value that helps the thing being
  // bounded. Clamped above the code ceiling as well, so a stored gap cannot outlive the
  // retention table even if a record is hand-edited.
  const expiresAt = new Date(detected + ACQUISITION_RETENTION.maxGapLifetimeMs).toISOString()

  return {
    ok: true,
    value: Object.freeze({
      gapId: input.gapId as string,
      kind: input.kind as GapKind,
      wanted: input.wanted as string,
      symptom: input.symptom as string,
      occurrences: input.occurrences,
      evidenceRefs: Object.freeze([...(input.evidenceRefs as readonly string[])]),
      tags: Object.freeze([...(input.tags as readonly string[])]),
      detectedBy: input.detectedBy,
      detectedAt: input.detectedAt as string,
      expiresAt,
      status: 'open' as const,
      closedAt: null,
      closureReason: null,
    }),
  }
}

/** Close a gap. A gap cannot simply stop being a gap: a closed label is required. */
export function closeCapabilityGap(
  gap: CapabilityGap,
  decision: { now: string; reason: Exclude<CapabilityGap['closureReason'], null> },
): AcquisitionResult<CapabilityGap> {
  if (gap.status !== 'open') {
    return { ok: false, code: 'illegal-transition', reason: `only an open gap can be closed, not ${gap.status}` }
  }
  const now = instantMs(decision.now)
  if (now === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the closure instant must parse as an instant' }
  }
  const detected = instantMs(gap.detectedAt)
  if (detected === null) {
    return { ok: false, code: 'invalid-record', reason: 'the stored gap carries an unreadable detection instant' }
  }
  // A gap cannot be closed *before* it was seen, and it cannot be closed after the retention
  // bound retires it — those are different events and collapsing them would let an expiry be
  // reported as an owner decision.
  if (now < detected) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'a gap cannot be closed before it was detected',
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...gap,
      status: 'closed' as const,
      closedAt: decision.now,
      closureReason: decision.reason,
    }),
  }
}

/**
 * Retire a gap whose deadline has passed.
 *
 * The closure reason is named here rather than passed, and it is a distinct member of
 * `GAP_CLOSURE_REASONS` rather than one of the owner's three: a stale gap is not "the owner
 * decided", and reusing an owner's label would put a decision nobody made into the ledger.
 * Refused before the deadline, because expiry that can be triggered early is expiry that can
 * be triggered by whoever is being expired.
 */
export function expireCapabilityGap(
  gap: CapabilityGap,
  decision: { now: string },
): AcquisitionResult<CapabilityGap> {
  if (gap.status !== 'open') {
    return { ok: false, code: 'illegal-transition', reason: `only an open gap can expire, not ${gap.status}` }
  }
  const now = instantMs(decision.now)
  if (now === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the expiry instant must parse as an instant' }
  }
  const deadline = instantMs(gap.expiresAt)
  if (deadline === null) {
    return { ok: false, code: 'invalid-record', reason: 'the stored gap carries an unreadable deadline' }
  }
  if (now < deadline) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `this gap is not stale until ${gap.expiresAt}`,
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...gap,
      status: 'closed' as const,
      closedAt: decision.now,
      closureReason: 'aged-out-past-retention' as const,
    }),
  }
}

/* --------------------------------------------------------------- request */

export const REQUEST_INPUT_KEYS: readonly string[] = [
  'requestId',
  'gapId',
  'subject',
  'intent',
  'requirements',
  'targets',
  'steps',
  'costCeiling',
  'tags',
  'confidence',
  'createdAt',
]

export const REQUEST_KEYS: readonly string[] = [
  ...REQUEST_INPUT_KEYS,
  'costSpent',
  'trustClass',
  'activation',
  'status',
  'expiresAt',
  'activationExpiresAt',
  'lifecycleAt',
  'lifecycleReason',
]

/**
 * Construct an acquisition request.
 *
 * The trust class and the activation state are **assigned here**, from constants, and are
 * absent from `REQUEST_INPUT_KEYS`. That is the mechanism behind "generated capabilities
 * start untrusted and inactive": there is no parameter to pass, so there is nothing to pass.
 *
 * A request naming a protected target or a forbidden requirement is refused now, before any
 * build has run.
 */
export function createAcquisitionRequest(input: unknown): AcquisitionResult<AcquisitionRequest> {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'an acquisition request input must be an object' }
  }
  const forbidden = forbiddenFieldNames(input)
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `the request carries field(s) a build may not hold: [${forbidden.join(', ')}]`,
    }
  }
  if (!hasExactKeys(input, REQUEST_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...REQUEST_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `acquisition request keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }
  if (!isBoundedAcquisitionText(input.requestId, ACQUISITION_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'requestId must be a non-empty bounded string' }
  }
  if (!isBoundedAcquisitionText(input.gapId, ACQUISITION_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'gapId must be a non-empty bounded string' }
  }
  if (!isAcquisitionSlug(input.subject)) {
    return {
      ok: false,
      code: 'invalid-slug',
      reason: 'subject must be a bounded code-owned slug: a description of what is built, not a grant',
    }
  }
  if (!isBoundedAcquisitionText(input.intent, ACQUISITION_LIMITS.maxSymptomChars)) {
    return { ok: false, code: 'invalid-text', reason: 'intent must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.intent)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'invalid-text',
      reason: `the intent is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  if (
    !Array.isArray(input.requirements) ||
    input.requirements.length > ACQUISITION_LIMITS.maxRequirements ||
    !input.requirements.every((item) => isAcquisitionRef(item))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'requirements must be bounded opaque ids: what the built thing will ask for, never what it holds',
    }
  }
  const forbiddenRequirement = (input.requirements as readonly string[]).find((item) =>
    isForbiddenRequirement(item),
  )
  if (forbiddenRequirement !== undefined) {
    return {
      ok: false,
      code: 'forbidden-requirement',
      reason: `an acquisition may never require ${forbiddenRequirement}; a build that needs it is not a build`,
    }
  }
  if (
    !Array.isArray(input.targets) ||
    input.targets.length > ACQUISITION_LIMITS.maxRequirements ||
    !input.targets.every((item) => isAcquisitionRef(item))
  ) {
    return { ok: false, code: 'invalid-tags', reason: 'targets must be bounded opaque labels' }
  }
  const protectedTarget = (input.targets as readonly string[]).find((item) => isProtectedTarget(item))
  if (protectedTarget !== undefined) {
    return {
      ok: false,
      code: 'protected-target',
      reason: `an acquisition may never target ${protectedTarget}; refusing now rather than after the build has run`,
    }
  }
  if (
    !Array.isArray(input.steps) ||
    input.steps.length === 0 ||
    input.steps.length > ACQUISITION_LIMITS.maxSteps ||
    !input.steps.every((step) => isBoundedAcquisitionText(step, ACQUISITION_LIMITS.maxReasonChars))
  ) {
    return {
      ok: false,
      code: 'invalid-text',
      reason: `steps must be between 1 and ${ACQUISITION_LIMITS.maxSteps} bounded descriptions`,
    }
  }
  if (
    typeof input.costCeiling !== 'number' ||
    !Number.isInteger(input.costCeiling) ||
    input.costCeiling < 1 ||
    input.costCeiling > ACQUISITION_LIMITS.maxCostUnits
  ) {
    return {
      ok: false,
      code: 'invalid-id',
      reason: `costCeiling must be a whole number of code-owned cost units between 1 and ${ACQUISITION_LIMITS.maxCostUnits}`,
    }
  }
  // The plan is the floor of the spend, not a decoration on it: one unit per step, and a
  // ceiling below the plan is a request that cannot be built as described. Refused here rather
  // than discovered at `markBuilt`, so the caller hears it while the words are still theirs.
  if (input.costCeiling < (input.steps as readonly string[]).length) {
    return {
      ok: false,
      code: 'budget-exhausted',
      reason: `a plan of ${(input.steps as readonly string[]).length} step(s) cannot be built under a ceiling of ${input.costCeiling} unit(s)`,
    }
  }
  if (
    !Array.isArray(input.tags) ||
    input.tags.length > ACQUISITION_LIMITS.maxTagsPerRecord ||
    !input.tags.every((tag) => isAcquisitionRef(tag) && tag.length <= ACQUISITION_LIMITS.maxTagChars)
  ) {
    return { ok: false, code: 'invalid-tags', reason: 'tags must be bounded code-owned labels' }
  }
  if (input.confidence !== 'unknown' && input.confidence !== 'low' && input.confidence !== 'medium') {
    return {
      ok: false,
      code: 'invalid-confidence',
      reason: 'confidence must be unknown, low or medium: nothing built here is ever high or verified',
    }
  }
  const created = instantMs(input.createdAt)
  if (created === null) {
    return { ok: false, code: 'invalid-instant', reason: 'createdAt must parse as an instant' }
  }
  const expiresAt = new Date(created + ACQUISITION_RETENTION.maxRequestLifetimeMs).toISOString()

  return {
    ok: true,
    value: Object.freeze({
      requestId: input.requestId as string,
      gapId: input.gapId as string,
      subject: input.subject as string,
      intent: input.intent as string,
      requirements: Object.freeze([...(input.requirements as readonly string[])]),
      targets: Object.freeze([...(input.targets as readonly string[])]),
      steps: Object.freeze([...(input.steps as readonly string[])]),
      costCeiling: input.costCeiling,
      costSpent: 0,
      tags: Object.freeze([...(input.tags as readonly string[])]),
      confidence: input.confidence as Confidence,
      // Assigned, never taken from the payload.
      trustClass: GENERATED_TRUST_CLASS,
      activation: GENERATED_ACTIVATION,
      status: 'proposed' as RequestStatus,
      createdAt: input.createdAt as string,
      expiresAt,
      activationExpiresAt: null,
      lifecycleAt: null,
      lifecycleReason: null,
    }),
  }
}

/**
 * The gap lookup a request construction depends on.
 *
 * Passed in rather than imported, because this module is otherwise pure and this is the one
 * place it needs to know something: a request is only valid against a gap that exists. A
 * missing entry is a refusal (`no-such-gap`), never a silent synthetic gap.
 */
export type GapLookup = (gapId: string) => CapabilityGap | undefined

/**
 * Construct an acquisition request against a **stored** gap.
 *
 * Two arguments where the rest of Core takes one, and the extra one is the boundary: the
 * first half of the signature builds the record from the caller's words, and the second half
 * is what the caller cannot supply. Without it a request could name a gap that never
 * happened, which would make "detect gap → propose" two independent claims rather than a
 * chain.
 */
export function createAcquisitionRequestForGap(
  input: unknown,
  gapOf: GapLookup,
): AcquisitionResult<AcquisitionRequest> {
  const result = createAcquisitionRequest(input)
  if (!result.ok) return result
  const created = instantMs(result.value.createdAt)
  const gap = gapOf(result.value.gapId)
  const detected = gap === undefined ? null : instantMs(gap.detectedAt)
  const closed = gap !== undefined && gap.status !== 'open'
  const stale = created !== null && detected !== null && created < detected
  if (gap === undefined || closed || stale) {
    return {
      ok: false,
      code: 'no-such-gap',
      reason:
        gap === undefined
          ? 'a request must name a gap Core actually detected'
          : closed
            ? 'that gap is closed, so it needs no acquisition'
            : 'a request cannot predate the gap it answers',
    }
  }
  return result
}

/* ------------------------------------------------------------- lifecycle */

function checkInstant(now: string): AcquisitionResult<true> {
  if (new Date(now).toString() === 'Invalid Date') {
    return { ok: false, code: 'invalid-instant', reason: 'the decision instant must parse as an instant' }
  }
  return { ok: true, value: true }
}

/** Advance a request, checking the closed transition table. */
export function advanceAcquisitionRequest(
  request: AcquisitionRequest,
  decision: { now: string; to: RequestStatus },
): AcquisitionResult<AcquisitionRequest> {
  const instant = checkInstant(decision.now)
  if (!instant.ok) return instant
  if (request.status === decision.to) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `the request is already ${decision.to}`,
    }
  }
  if (!canAdvance(request, decision.to)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `a ${request.status} request cannot become ${decision.to}`,
    }
  }
  if (decision.to === 'verified' && request.activation !== 'inactive') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'only an inactive request can be verified',
    }
  }
  // A request past its absolute deadline may not be advanced at all. Not only the last two
  // stages: an expired request that could still be *built* would be a build whose evidence
  // expired before it started, and `expireStaleAcquisitionRequest` is the only route out of a
  // stale request — which is the point of having the deadline at all.
  const stale = requestStaleness(request, decision.now)
  if (stale !== null) return stale
  return {
    ok: true,
    value: Object.freeze({
      ...request,
      status: decision.to,
      // Entering `activation-requested` also moves the *activation* state, and it is
      // assigned from the closed table rather than from a parameter: a request can only
      // hold the activation state that matches its own status.
      activation: decision.to === 'activation-requested' ? ('activation-requested' as const) : request.activation,
      lifecycleAt: null,
      lifecycleReason: null,
    }),
  }
}

function canAdvance(request: AcquisitionRequest, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[request.status].includes(to)
}

/**
 * Whether a request has outlived its deadline, as a refusal rather than a boolean.
 *
 * Returned in the refusal shape so the caller reports the *same* thing whether it was
 * refused by the transition table or by the clock, and so the deadline is checked in exactly
 * one place.
 */
function requestStaleness(
  request: AcquisitionRequest,
  now: string,
): AcquisitionResult<AcquisitionRequest> | null {
  const at = instantMs(now)
  const deadline = instantMs(request.expiresAt)
  if (at === null || deadline === null) return null
  if (at <= deadline) return null
  return {
    ok: false,
    code: 'illegal-transition',
    reason: `this request expired at ${request.expiresAt}; a stale request is closed, not advanced`,
  }
}

/** Whether a request is past its absolute deadline at this instant. A fact, not a decision. */
export function isStaleAcquisitionRequest(request: AcquisitionRequest, now: string): boolean {
  const at = instantMs(now)
  const deadline = instantMs(request.expiresAt)
  if (at === null || deadline === null) return false
  return at > deadline
}

/** Whether an activation has outlived its own, shorter deadline at this instant. */
export function isStaleActivation(request: AcquisitionRequest, now: string): boolean {
  if (request.activationExpiresAt === null) return false
  const at = instantMs(now)
  const deadline = instantMs(request.activationExpiresAt)
  if (at === null || deadline === null) return false
  return at >= deadline
}

/** Terminate a request, with the reason that matches the terminal status. */
export function endAcquisitionRequest(
  request: AcquisitionRequest,
  decision: { now: string; to: 'rejected' | 'expired'; reason: RequestLifecycleReason },
): AcquisitionResult<AcquisitionRequest> {
  const instant = checkInstant(decision.now)
  if (!instant.ok) return instant
  if (!REQUEST_TRANSITIONS[request.status].includes(decision.to)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `a ${request.status} request cannot become ${decision.to}`,
    }
  }
  if (!REQUEST_LIFECYCLE_REASON_BY_STATUS[decision.to].includes(decision.reason)) {
    return {
      ok: false,
      code: 'illegal-lifecycle-reason',
      reason: `a ${decision.to} request cannot carry the reason ${decision.reason}`,
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...request,
      status: decision.to,
      // A terminal request is inactive whatever it was. `active -> revoked` is the only way
      // an activation ever leaves `active`, and it lands here, so a terminated request can
      // never be left holding an activation state.
      activation: decision.reason === 'owner-revoked-this-activation' ? ('revoked' as const) : ('inactive' as const),
      activationExpiresAt: null,
      lifecycleAt: decision.now,
      lifecycleReason: decision.reason,
    }),
  }
}

/**
 * Close a request that outlived its deadline.
 *
 * Refused before the deadline, and refused for an `active` request, which has its own and
 * different deadline. Keeping the two apart is the point: "the proposal went stale" and "the
 * thing you approved stopped standing" are different facts and get different lifecycle
 * reasons.
 */
export function expireStaleAcquisitionRequest(
  request: AcquisitionRequest,
  decision: { now: string },
): AcquisitionResult<AcquisitionRequest> {
  const instant = checkInstant(decision.now)
  if (!instant.ok) return instant
  if (request.status === 'active') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'an active request expires through its activation deadline, not its own',
    }
  }
  const stale = requestStaleness(request, decision.now)
  if (stale !== null) {
    return endAcquisitionRequest(request, {
      now: decision.now,
      to: 'expired',
      reason: 'stale-request-expired',
    })
  }
  return {
    ok: false,
    code: 'illegal-transition',
    reason: `this request is not stale until ${request.expiresAt}`,
  }
}

/**
 * Close an activation whose own deadline has passed.
 *
 * `retention-bound-reached` rather than `stale-request-expired`, because the request itself
 * may well be fresh — it is the *approval* that has aged, which is a different thing and is
 * recorded as one. The request becomes terminal, so re-activating needs a new request.
 */
export function expireStaleActivation(
  request: AcquisitionRequest,
  decision: { now: string },
): AcquisitionResult<AcquisitionRequest> {
  if (request.status !== 'active') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `only an active request has an activation deadline, and this one is ${request.status}`,
    }
  }
  if (!isStaleActivation(request, decision.now)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `this activation stands until ${request.activationExpiresAt}`,
    }
  }
  return endAcquisitionRequest(request, {
    now: decision.now,
    to: 'expired',
    reason: 'retention-bound-reached',
  })
}

/**
 * Grant an activation, after every gate has passed.
 *
 * Three things are assigned here rather than passed, and each is the boundary:
 *
 * - `activation` becomes `'active'` because this function is the only route to it;
 * - `status` becomes `'active'`, so the activation state can never disagree with the status
 *   it is supposed to mirror;
 * - `activationExpiresAt` is resolved **from the code-owned retention table**, so an
 *   approval cannot be made permanent by naming its own end date — and so it cannot be
 *   permanent by omitting one.
 *
 * There is no `grantsCapability` parameter, no capability, no scope and no registry. An
 * activation here means "the owner approved this request", and nothing more; what an
 * approved capability may actually *do* is decided by whatever runtime holds it, under its
 * own authority, and this domain has no path to that runtime.
 */
export function activateAcquisitionRequest(
  request: AcquisitionRequest,
  decision: { now: string },
): AcquisitionResult<AcquisitionRequest> {
  const instant = checkInstant(decision.now)
  if (!instant.ok) return instant
  if (request.status !== 'activation-requested') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `only an activation-requested request can be activated, and this one is ${request.status}`,
    }
  }
  if (request.activation !== 'activation-requested') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'the activation state and the request status disagree; refusing rather than repairing',
    }
  }
  const stale = requestStaleness(request, decision.now)
  if (stale !== null) return stale
  const at = instantMs(decision.now)
  if (at === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the activation instant must parse as an instant' }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...request,
      status: 'active' as RequestStatus,
      activation: 'active' as ActivationState,
      activationExpiresAt: new Date(at + ACQUISITION_RETENTION.maxActiveLifetimeMs).toISOString(),
      lifecycleAt: null,
      lifecycleReason: null,
    }),
  }
}

/**
 * Charge cost against a request.
 *
 * Four properties, and all of them are the anti-hidden-loop mechanism:
 *
 * - the charge is **refused at the ceiling** rather than allowed to overshoot and be noticed
 *   later, so a loop that keeps going simply stops;
 * - a terminal request cannot be charged at all, so a spent proposal cannot keep billing
 *   after it was rejected;
 * - there is no `spendForever`, no retry budget and no background flag anywhere in this
 *   domain. A caller that wants more units must come back and ask for a higher ceiling, which
 *   is a decision someone can see;
 * - the units are code-owned and mean nothing to any provider, so "the ceiling" cannot be
 *   read as permission to spend money.
 */
export function chargeAcquisitionCost(
  request: AcquisitionRequest,
  units: number,
): AcquisitionResult<AcquisitionRequest> {
  if (!Number.isInteger(units) || units < 1 || units > ACQUISITION_LIMITS.maxCostUnits) {
    return {
      ok: false,
      code: 'invalid-id',
      reason: 'cost units must be a positive whole number within the domain bound',
    }
  }
  if (request.status === 'rejected' || request.status === 'expired') {
    return {
      ok: false,
      code: 'already-terminal',
      reason: `a ${request.status} request cannot be charged; the build it paid for is over`,
    }
  }
  const spent = request.costSpent + units
  if (spent > request.costCeiling) {
    return {
      ok: false,
      code: 'budget-exhausted',
      reason: `charging ${units} unit(s) would exceed the ceiling of ${request.costCeiling}; the request stops here`,
    }
  }
  return { ok: true, value: Object.freeze({ ...request, costSpent: spent }) }
}
