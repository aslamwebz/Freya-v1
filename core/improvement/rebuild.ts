import { validateDecisionGate, validateImprovementGate } from './gates'
import {
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_RETENTION,
  instantMs,
  isBoundedImprovementText,
  isForbiddenImprovement,
  isImprovementClosedReason,
  isImprovementKind,
  isImprovementRef,
  isImprovementSlug,
  isImprovementStatus,
  isProtectedImprovementSurface,
  type ImprovementClosedReason,
  type ImprovementGateRecord,
  type ImprovementProposal,
  type ImprovementStatus,
  type MergeDecision,
} from './types'

/**
 * THE REBUILD VALIDATORS — what a stored record must still satisfy to be believed.
 *
 * A row that parsed is only proven to be the row that was written, not that it is well formed.
 * These re-run every invariant a record would face at construction, which is what lets a store
 * hand back a state indistinguishable from one built in memory.
 *
 * Three rules they enforce that construction alone could not:
 *
 * - **Derived fields are recomputed, not trusted.** A stored `expiresAt` is checked against
 *   `createdAt + maxProposalLifetimeMs`, so a hand-edited row cannot buy a proposal a longer life
 *   than the retention table allows. The deadline is the one field in this domain that is
 *   entirely code-owned, so it is the one field a reader re-derives.
 * - **Internal agreement is checked.** A `merged` proposal must carry a merge instant, a merge
 *   deadline and a revision to restore; a terminal one must carry a closure instant and a reason
 *   its status permits; a live one must carry none of those.
 * - **Forbidden content is re-checked.** The requirements and targets a row carries are run
 *   against the forbidden and protected tables again, independently of construction, because the
 *   derived gates read exactly those fields.
 */

const PROPOSAL_KEYS = [
  'proposalId',
  'kind',
  'subject',
  'symptom',
  'occurrences',
  'evidenceRefs',
  'changes',
  'requirements',
  'targets',
  'rollbackSteps',
  'costCeiling',
  'costSpent',
  'tags',
  'confidence',
  'status',
  'createdAt',
  'expiresAt',
  'mergedAt',
  'mergedExpiresAt',
  'restoresRevision',
  'closedAt',
  'closedReason',
] as const

export type Rebuild<T> = { ok: true; value: T } | { ok: false; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeySet(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key)
}

/** A stored proposal, believed only if every construction rule still holds. */
export function rebuildImprovementProposal(value: unknown): Rebuild<ImprovementProposal> {
  if (!isPlainObject(value)) return { ok: false, reason: 'a stored improvement proposal is not an object' }
  if (!hasExactKeySet(value, PROPOSAL_KEYS)) {
    return { ok: false, reason: 'a stored improvement proposal does not carry exactly the domain fields' }
  }
  if (!isBoundedImprovementText(value.proposalId, IMPROVEMENT_LIMITS.maxIdChars)) {
    return { ok: false, reason: 'a stored proposal has an unreadable id' }
  }
  if (!isImprovementKind(value.kind)) return { ok: false, reason: 'a stored proposal names an unknown kind' }
  if (!isImprovementSlug(value.subject)) return { ok: false, reason: 'a stored proposal names an unusable slug' }
  if (!isBoundedImprovementText(value.symptom, IMPROVEMENT_LIMITS.maxSummaryChars)) {
    return { ok: false, reason: 'a stored proposal has unreadable text' }
  }
  if (!Number.isInteger(value.occurrences) || (value.occurrences as number) < 1) {
    return { ok: false, reason: 'a stored proposal carries an unreadable occurrence count' }
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length === 0 ||
    !value.evidenceRefs.every(isImprovementRef)
  ) {
    return { ok: false, reason: 'a stored proposal rests on nothing it can name' }
  }
  if (!Array.isArray(value.changes) || value.changes.length === 0) {
    return { ok: false, reason: 'a stored proposal describes no change' }
  }
  if (!Array.isArray(value.rollbackSteps) || value.rollbackSteps.length === 0) {
    return { ok: false, reason: 'a stored proposal declares no rollback step' }
  }
  if (!Array.isArray(value.requirements) || !value.requirements.every(isImprovementRef)) {
    return { ok: false, reason: 'a stored proposal carries unreadable requirements' }
  }
  const forbidden = (value.requirements as readonly string[]).find(isForbiddenImprovement)
  if (forbidden !== undefined) {
    return { ok: false, reason: `a stored proposal requires the forbidden ${forbidden}` }
  }
  if (!Array.isArray(value.targets) || !value.targets.every(isImprovementRef)) {
    return { ok: false, reason: 'a stored proposal carries unreadable targets' }
  }
  if ((value.targets as readonly string[]).some(isProtectedImprovementSurface)) {
    return { ok: false, reason: 'a stored proposal names a protected surface' }
  }
  if (!Number.isInteger(value.costCeiling) || (value.costCeiling as number) < 1) {
    return { ok: false, reason: 'a stored proposal carries an unreadable cost ceiling' }
  }
  if (
    !Number.isInteger(value.costSpent) ||
    (value.costSpent as number) < 0 ||
    (value.costSpent as number) > (value.costCeiling as number)
  ) {
    return { ok: false, reason: 'a stored proposal reports spend the ceiling does not permit' }
  }
  if (value.confidence !== 'unknown' && value.confidence !== 'low' && value.confidence !== 'medium') {
    return { ok: false, reason: 'a stored proposal claims a confidence none of these may hold' }
  }
  if (!isImprovementStatus(value.status)) {
    return { ok: false, reason: 'a stored proposal names an unknown status' }
  }
  const status = value.status as ImprovementStatus
  const created = instantMs(value.createdAt)
  if (created === null) return { ok: false, reason: 'a stored proposal has an unreadable creation instant' }
  const deadline = instantMs(value.expiresAt)
  if (deadline === null) return { ok: false, reason: 'a stored proposal has an unreadable deadline' }
  if (deadline !== created + IMPROVEMENT_RETENTION.maxProposalLifetimeMs) {
    return { ok: false, reason: 'a stored proposal carries a deadline the retention table does not grant' }
  }
  // Merge fields: only a merged proposal may carry them, and it must carry all of them.
  const mergedAt = value.mergedAt as string | null
  const mergedExpiresAt = value.mergedExpiresAt as string | null
  const restores = value.restoresRevision as string | null
  if (status === 'merged') {
    if (mergedAt === null || instantMs(mergedAt) === null) {
      return { ok: false, reason: 'a stored merged proposal carries no merge instant' }
    }
    if (mergedExpiresAt === null || instantMs(mergedExpiresAt) === null) {
      return { ok: false, reason: 'a stored merged proposal carries no merge deadline' }
    }
    if (!isImprovementRef(restores)) {
      return { ok: false, reason: 'a stored merged proposal names no revision a rollback would restore' }
    }
    const at = instantMs(mergedAt) as number
    const until = instantMs(mergedExpiresAt) as number
    if (until !== at + IMPROVEMENT_RETENTION.maxMergedLifetimeMs) {
      return { ok: false, reason: 'a stored merge carries a deadline the retention table does not grant' }
    }
  } else if (mergedAt !== null || mergedExpiresAt !== null) {
    return { ok: false, reason: 'a stored proposal that is not merged carries a merge instant' }
  }
  if (status !== 'merged' && restores !== null) {
    // The revision to restore is recorded at staging and belongs to a change that exists. On any
    // other status it is a rollback target with nothing to roll back, which is the exact shape a
    // hand-edited row would take to make a terminal proposal look reversible.
    return { ok: false, reason: 'a stored proposal that is not merged names a revision to restore' }
  }
  // Closure: only a terminal status may carry one, and only a reason its status permits.
  const closedAt = value.closedAt as string | null
  const closedReason = value.closedReason as ImprovementClosedReason | null
  const terminal = status === 'rejected' || status === 'expired' || status === 'rolled-back'
  if (!terminal) {
    if (closedAt !== null || closedReason !== null) {
      return { ok: false, reason: 'a stored live proposal carries a closure' }
    }
  } else {
    if (closedAt === null || instantMs(closedAt) === null) {
      return { ok: false, reason: 'a stored closed proposal has no closure instant' }
    }
    if (!isImprovementClosedReason(closedReason)) {
      return { ok: false, reason: 'a stored closed proposal names an unknown closure reason' }
    }
    if (status === 'rolled-back') {
      if (closedReason !== 'rollback-completed') {
        return { ok: false, reason: 'a rolled-back proposal must say the rollback completed' }
      }
      if (!isImprovementRef(restores)) {
        return { ok: false, reason: 'a rolled-back proposal names no revision it restored' }
      }
    }
  }
  return { ok: true, value: value as unknown as ImprovementProposal }
}

/**
 * A stored gate ledger.
 *
 * Bounded, ordered, and every entry re-validated through `validateImprovementGate` — including
 * the rule that a ledger may not hold a derived gate. A ledger that grew past the bound is refused
 * rather than truncated: quietly keeping the newest 64 records would drop the very record of who
 * approved a merge.
 */
export function rebuildGateLedger(value: unknown): Rebuild<readonly ImprovementGateRecord[]> {
  if (!Array.isArray(value)) return { ok: false, reason: 'a stored gate ledger is not a list' }
  if (value.length > IMPROVEMENT_LIMITS.maxGateVerdicts) {
    return { ok: false, reason: 'a stored gate ledger exceeds the per-proposal bound' }
  }
  const records: ImprovementGateRecord[] = []
  for (const entry of value) {
    const rebuilt = validateImprovementGate(entry)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    records.push(rebuilt.record)
  }
  return { ok: true, value: Object.freeze(records) }
}

/**
 * A stored merge decision.
 *
 * `approved` is re-derived rather than believed: it must equal "no gate is unsatisfied". A stored
 * decision claiming an approval its own gate list contradicts is the one row a reader would most
 * want to believe and most need checked.
 */
export function rebuildMergeDecision(
  value: unknown,
  proposal: ImprovementProposal,
): Rebuild<MergeDecision> {
  if (!isPlainObject(value)) return { ok: false, reason: 'a stored merge decision is not an object' }
  const expected = ['proposalId', 'approved', 'gates', 'unsatisfied', 'decidedAt', 'ownerApproved', 'precedence']
  if (!hasExactKeySet(value, expected)) {
    return { ok: false, reason: 'a stored merge decision does not carry exactly the decision fields' }
  }
  if (value.proposalId !== proposal.proposalId) {
    return { ok: false, reason: 'a stored merge decision names another proposal' }
  }
  // A decision is only coherent once the change has been reviewed. Recorded earlier, it means
  // somebody evaluated a conjunction whose owner gate could not yet have been asked, which is the
  // shape a forged row takes.
  const decidable: readonly ImprovementStatus[] = ['reviewed', 'merging', 'merged', 'rejected', 'rolled-back', 'expired']
  if (!decidable.includes(proposal.status)) {
    return { ok: false, reason: `a stored merge decision names a proposal that is ${proposal.status}` }
  }
  if (instantMs(value.decidedAt) === null) {
    return { ok: false, reason: 'a stored merge decision has an unreadable instant' }
  }
  if (!Array.isArray(value.gates) || value.gates.length !== 8) {
    return { ok: false, reason: 'a stored merge decision does not carry every gate' }
  }
  const unsatisfied: string[] = []
  for (const gate of value.gates) {
    // A decision legitimately holds all eight gates, including the two computed ones and the
    // placeholders for gates nobody has answered, so it is checked with the decision validator
    // rather than the ledger one — which rightly refuses a derived gate.
    const rebuilt = validateDecisionGate(gate)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    if (rebuilt.record.verdict !== 'passed') unsatisfied.push(rebuilt.record.kind)
  }
  if (JSON.stringify([...unsatisfied].sort()) !== JSON.stringify([...(value.unsatisfied as string[])].sort())) {
    return { ok: false, reason: 'a stored merge decision disagrees with its own gate list' }
  }
  if (typeof value.approved !== 'boolean' || value.approved !== (unsatisfied.length === 0)) {
    return { ok: false, reason: 'a stored merge decision claims an approval its gates do not support' }
  }
  if (typeof value.ownerApproved !== 'boolean') {
    return { ok: false, reason: 'a stored merge decision carries an unreadable owner approval' }
  }
  const precedence = value.precedence
  if (precedence !== null && typeof precedence !== 'string') {
    return { ok: false, reason: 'a stored merge decision carries an unreadable precedence' }
  }
  return { ok: true, value: value as unknown as MergeDecision }
}