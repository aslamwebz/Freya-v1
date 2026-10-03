import { validateDecisionGate, validateGateVerdict } from './gates'
import {
  ACQUISITION_RETENTION,
  GENERATED_TRUST_CLASS,
  instantMs,
  isAcquisitionRef,
  isAcquisitionSlug,
  isBoundedAcquisitionText,
  isGapClosureReason,
  isForbiddenRequirement,
  isGapKind,
  isProtectedTarget,
  isRequestLifecycleConsistent,
  isRequestStatus,
  isTrustClass,
  type ActivationDecision,
  type AcquisitionRequest,
  type ActivationState,
  type CapabilityGap,
  type GateVerdictRecord,
} from './types'

/**
 * THE REBUILD VALIDATORS — what a stored record must still satisfy to be believed.
 *
 * A row that parsed is only proven to be the row that was written, not that it is well formed.
 * These functions re-run every invariant a record would face at construction, and they are the
 * reason a store can hand back a state that is indistinguishable from one built in memory.
 *
 * Two rules they enforce that construction alone could not:
 *
 * - **Derived fields are recomputed, not trusted.** A stored `expiresAt` is checked against
 *   `createdAt + ACQUISITION_RETENTION.maxRequestLifetimeMs`, so a hand-edited row cannot buy a
 *   request a longer life than the retention table allows. The deadline is the one field in this
 *   domain that is entirely code-owned, so it is the one field a reader re-derives.
 * - **Internal agreement is checked.** `trustClass` must be the generated class, `activation`
 *   must match the status it mirrors, a terminal request must carry a lifecycle instant and a
 *   reason that its status permits, and an active request must carry an activation deadline
 *   while no other status may. A record that disagrees with itself is refused rather than
 *   repaired, because a repaired record is a record that says something nobody wrote.
 */

const GAP_KEYS = [
  'gapId',
  'kind',
  'wanted',
  'symptom',
  'occurrences',
  'evidenceRefs',
  'tags',
  'detectedBy',
  'detectedAt',
  'expiresAt',
  'status',
  'closedAt',
  'closureReason',
] as const

const REQUEST_KEYS = [
  'requestId',
  'gapId',
  'subject',
  'intent',
  'requirements',
  'targets',
  'steps',
  'costCeiling',
  'costSpent',
  'tags',
  'confidence',
  'trustClass',
  'activation',
  'status',
  'createdAt',
  'expiresAt',
  'activationExpiresAt',
  'lifecycleAt',
  'lifecycleReason',
] as const

export type Rebuild<T> = { ok: true; value: T } | { ok: false; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeySet(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key)
}

/** A stored capability gap, believed only if every construction rule still holds. */
export function rebuildCapabilityGap(value: unknown): Rebuild<CapabilityGap> {
  if (!isPlainObject(value)) return { ok: false, reason: 'a stored capability gap is not an object' }
  if (!hasExactKeySet(value, GAP_KEYS)) {
    return { ok: false, reason: 'a stored capability gap does not carry exactly the domain fields' }
  }
  if (!isBoundedAcquisitionText(value.gapId, 128)) return { ok: false, reason: 'a stored gap has an unreadable id' }
  if (!isGapKind(value.kind)) return { ok: false, reason: 'a stored gap names an unknown kind' }
  if (!isAcquisitionSlug(value.wanted)) return { ok: false, reason: 'a stored gap names an unusable slug' }
  if (!isBoundedAcquisitionText(value.symptom, 600)) return { ok: false, reason: 'a stored gap has unreadable text' }
  if (!Number.isInteger(value.occurrences) || (value.occurrences as number) < 1) {
    return { ok: false, reason: 'a stored gap carries an unreadable occurrence count' }
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 || !value.evidenceRefs.every(isAcquisitionRef)) {
    return { ok: false, reason: 'a stored gap rests on nothing it can name' }
  }
  if (value.detectedBy !== 'core' && value.detectedBy !== 'owner') {
    return { ok: false, reason: 'a stored gap names an unknown detector' }
  }
  const detected = instantMs(value.detectedAt)
  if (detected === null) return { ok: false, reason: 'a stored gap has an unreadable detection instant' }
  const deadline = instantMs(value.expiresAt)
  if (deadline === null) return { ok: false, reason: 'a stored gap has an unreadable deadline' }
  if (deadline !== detected + ACQUISITION_RETENTION.maxGapLifetimeMs) {
    return { ok: false, reason: 'a stored gap carries a deadline the retention table does not grant' }
  }
  if (value.status !== 'open' && value.status !== 'closed') {
    return { ok: false, reason: 'a stored gap names an unknown status' }
  }
  if (value.status === 'open') {
    if (value.closedAt !== null || value.closureReason !== null) {
      return { ok: false, reason: 'a stored open gap carries a closure' }
    }
  } else {
    if (instantMs(value.closedAt) === null) {
      return { ok: false, reason: 'a stored closed gap has no closure instant' }
    }
    if (!isGapClosureReason(value.closureReason)) {
      return { ok: false, reason: 'a stored closed gap names an unknown closure reason' }
    }
  }
  return { ok: true, value: value as unknown as CapabilityGap }
}

/** A stored acquisition request, believed only if every construction rule still holds. */
export function rebuildAcquisitionRequest(value: unknown): Rebuild<AcquisitionRequest> {
  if (!isPlainObject(value)) return { ok: false, reason: 'a stored acquisition request is not an object' }
  if (!hasExactKeySet(value, REQUEST_KEYS)) {
    return { ok: false, reason: 'a stored acquisition request does not carry exactly the domain fields' }
  }
  if (!isBoundedAcquisitionText(value.requestId, 128)) return { ok: false, reason: 'a stored request has an unreadable id' }
  if (!isBoundedAcquisitionText(value.gapId, 128)) return { ok: false, reason: 'a stored request names no readable gap' }
  if (!isAcquisitionSlug(value.subject)) return { ok: false, reason: 'a stored request names an unusable subject' }
  if (!isBoundedAcquisitionText(value.intent, 600)) return { ok: false, reason: 'a stored request has unreadable text' }
  if (!Array.isArray(value.requirements) || !value.requirements.every(isAcquisitionRef)) {
    return { ok: false, reason: 'a stored request carries unreadable requirements' }
  }
  // Re-checked here, independently of construction. Construction already refuses these, so a row
  // carrying one means the record was hand-edited or written by something that skipped the
  // constructor — and the derived `no-capability-widening` gate reads exactly this field, so a
  // stored row must not be able to widen what the request requires.
  const forbidden = (value.requirements as readonly string[]).find(isForbiddenRequirement)
  if (forbidden !== undefined) {
    return { ok: false, reason: `a stored request requires the forbidden ${forbidden}` }
  }
  if (!Array.isArray(value.targets) || !value.targets.every(isAcquisitionRef)) {
    return { ok: false, reason: 'a stored request carries unreadable targets' }
  }
  if (value.targets.some((target) => isProtectedTarget(target))) {
    return { ok: false, reason: 'a stored request names a protected target' }
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    return { ok: false, reason: 'a stored request describes no steps' }
  }
  if (!Number.isInteger(value.costCeiling) || (value.costCeiling as number) < 1) {
    return { ok: false, reason: 'a stored request carries an unreadable cost ceiling' }
  }
  if (
    !Number.isInteger(value.costSpent) ||
    (value.costSpent as number) < 0 ||
    (value.costSpent as number) > (value.costCeiling as number)
  ) {
    return { ok: false, reason: 'a stored request reports spend the ceiling does not permit' }
  }
  if (value.confidence !== 'unknown' && value.confidence !== 'low' && value.confidence !== 'medium') {
    return { ok: false, reason: 'a stored request claims a confidence no generated artifact may hold' }
  }
  if (!isTrustClass(value.trustClass) || value.trustClass !== GENERATED_TRUST_CLASS) {
    return { ok: false, reason: 'a stored request claims a trust class a generated artifact may not hold' }
  }
  if (!isRequestStatus(value.status)) return { ok: false, reason: 'a stored request names an unknown status' }
  const status = value.status
  const created = instantMs(value.createdAt)
  if (created === null) return { ok: false, reason: 'a stored request has an unreadable creation instant' }
  const deadline = instantMs(value.expiresAt)
  if (deadline === null) return { ok: false, reason: 'a stored request has an unreadable deadline' }
  if (deadline !== created + ACQUISITION_RETENTION.maxRequestLifetimeMs) {
    return { ok: false, reason: 'a stored request carries a deadline the retention table does not grant' }
  }
  if (!isActivationStateValue(value.activation)) {
    return { ok: false, reason: 'a stored request carries an unreadable activation state' }
  }
  const activation: ActivationState = value.activation
  const expected: Record<string, readonly ActivationState[]> = {
    proposed: ['inactive'],
    building: ['inactive'],
    built: ['inactive'],
    verifying: ['inactive'],
    verified: ['inactive'],
    'activation-requested': ['activation-requested'],
    active: ['active'],
    rejected: ['inactive', 'revoked'],
    expired: ['inactive', 'revoked'],
  }
  if (!(expected[status] ?? []).includes(activation)) {
    return { ok: false, reason: `a stored ${status} request carries activation ${activation}` }
  }
  if (!isRequestLifecycleConsistent(status, value.lifecycleAt as string | null, value.lifecycleReason as never)) {
    return { ok: false, reason: 'a stored request carries a lifecycle reason its status does not permit' }
  }
  if (value.lifecycleAt !== null && instantMs(value.lifecycleAt) === null) {
    return { ok: false, reason: 'a stored request carries an unreadable lifecycle instant' }
  }
  const activationExpiresAt = value.activationExpiresAt as string | null
  if (status === 'active') {
    if (activationExpiresAt === null || instantMs(activationExpiresAt) === null) {
      return { ok: false, reason: 'a stored active request carries no activation deadline' }
    }
    // The activation deadline is code-owned from the moment of approval, so it can never sit
    // further out than the request's own creation plus one activation lifetime. A row that
    // claims a standing approval beyond that is a row nobody could have written.
    const at = instantMs(activationExpiresAt)
    if (at === null || at > created + ACQUISITION_RETENTION.maxRequestLifetimeMs + ACQUISITION_RETENTION.maxActiveLifetimeMs) {
      return { ok: false, reason: 'a stored activation outlives the retention table' }
    }
  } else if (activationExpiresAt !== null) {
    return { ok: false, reason: 'a stored request that is not active carries an activation deadline' }
  }
  return { ok: true, value: value as unknown as AcquisitionRequest }
}

function isActivationStateValue(value: unknown): value is ActivationState {
  return (
    value === 'inactive' || value === 'activation-requested' || value === 'active' || value === 'revoked'
  )
}

/**
 * A stored gate ledger.
 *
 * Bounded, ordered, and every entry re-validated through `validateGateVerdict` — including the
 * rule that a ledger may not hold a derived gate. A ledger that grew past the bound is refused
 * rather than truncated: quietly keeping the newest 64 verdicts would drop the very record of
 * who approved something.
 */
export function rebuildGateLedger(value: unknown): Rebuild<readonly GateVerdictRecord[]> {
  if (!Array.isArray(value)) return { ok: false, reason: 'a stored gate ledger is not a list' }
  if (value.length > 64) return { ok: false, reason: 'a stored gate ledger exceeds the per-request bound' }
  const verdicts: GateVerdictRecord[] = []
  for (const entry of value) {
    const rebuilt = validateGateVerdict(entry)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    verdicts.push(rebuilt.verdict)
  }
  return { ok: true, value: Object.freeze(verdicts) }
}

/**
 * A stored activation decision.
 *
 * `approved` is re-derived rather than believed: it must equal "no gate is unsatisfied", and
 * `ownerApproved` must equal "the newest owner verdict passed". A stored decision claiming an
 * approval its own gate list contradicts is the one row a reader would most want to believe and
 * most need checked.
 */
export function rebuildActivationDecision(value: unknown, request: AcquisitionRequest): Rebuild<ActivationDecision> {
  if (!isPlainObject(value)) return { ok: false, reason: 'a stored activation decision is not an object' }
  const expected = ['requestId', 'approved', 'gates', 'unsatisfied', 'decidedAt', 'ownerApproved', 'precedence']
  if (!hasExactKeySet(value, expected)) {
    return { ok: false, reason: 'a stored activation decision does not carry exactly the decision fields' }
  }
  if (value.requestId !== request.requestId) {
    return { ok: false, reason: 'a stored activation decision names another request' }
  }
  if (instantMs(value.decidedAt) === null) {
    return { ok: false, reason: 'a stored activation decision has an unreadable instant' }
  }
  if (!Array.isArray(value.gates) || value.gates.length !== 7) {
    return { ok: false, reason: 'a stored activation decision does not carry every gate' }
  }
  const unsatisfied: string[] = []
  for (const gate of value.gates) {
    const rebuilt = validateDecisionGate(gate)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    if (rebuilt.verdict.verdict !== 'passed') unsatisfied.push(rebuilt.verdict.kind)
  }
  if (JSON.stringify([...unsatisfied].sort()) !== JSON.stringify([...(value.unsatisfied as string[])].sort())) {
    return { ok: false, reason: 'a stored activation decision disagrees with its own gate list' }
  }
  if (typeof value.approved !== 'boolean' || value.approved !== (unsatisfied.length === 0)) {
    return { ok: false, reason: 'a stored activation decision claims an approval its gates do not support' }
  }
  if (typeof value.ownerApproved !== 'boolean') {
    return { ok: false, reason: 'a stored activation decision carries an unreadable owner approval' }
  }
  return { ok: true, value: value as unknown as ActivationDecision }
}