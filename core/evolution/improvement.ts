import {
  IMPROVEMENT_KINDS,
  IMPROVEMENT_STATES,
  IMPROVEMENT_TRANSITIONS,
  EVOLUTION_LIMITS,
  canTransitionImprovement,
  instantMs,
  isBoundedEvolutionText,
  isImprovementKind,
  isImprovementState,
  isEvolutionRef,
  type ImprovementKind,
  type ImprovementRecord,
  type ImprovementState,
} from './types'

/**
 * Planning / Reasoning / Learning improvement: the lifecycle.
 *
 * Evidence-driven improvement of planning, reasoning, and learning. The
 * lifecycle is a closed table, and every transition is checked against it.
 *
 * ## Nothing is applied by anything here
 *
 * An improvement is a *description* of a change. It does not execute, does not
 * apply, does not merge. The `applied` state means "the owner has applied it
 * outside this subsystem" — it is a record of a fact, not a cause.
 *
 * ## A change starts proposed
 *
 * `state` is assigned inside the constructor, absent from the input keys, so
 * there is no call shape that produces an improvement arriving `staged` or
 * `applied`.
 *
 * ## Rollback is a first-class state
 *
 * `applied → failed` is the only edge out of `applied`, because a landed change
 * that cannot be undone is a change that happened. The rollback path is
 * explicit: an applied improvement that degrades is rolled back to `failed`
 * with a reason, and a new improvement is proposed to replace it.
 */

export type ImprovementResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export const IMPROVEMENT_INPUT_KEYS: readonly string[] = [
  'improvementId',
  'kind',
  'description',
  'evidenceIds',
  'createdAt',
]

export const IMPROVEMENT_KEYS: readonly string[] = [
  ...IMPROVEMENT_INPUT_KEYS,
  'state',
  'appliedAt',
]

/**
 * Construct an improvement record.
 *
 * Refuses rather than repairs. The improvement starts `proposed`, carries at
 * least one evidence reference, and its description is bounded text.
 */
export function createImprovementRecord(input: unknown): ImprovementResult<ImprovementRecord> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'not-an-object', reason: 'an improvement record must be an object' }
  }
  const value = input as Record<string, unknown>
  if (!hasExactKeys(value, IMPROVEMENT_INPUT_KEYS)) {
    const actual = Object.keys(value).sort()
    const expected = [...IMPROVEMENT_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `improvement keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }
  if (!isEvolutionRef(value.improvementId)) {
    return { ok: false, code: 'invalid-id', reason: 'improvementId must be a bounded opaque id' }
  }
  if (!isImprovementKind(value.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'kind is not in the closed improvement vocabulary' }
  }
  if (!isBoundedEvolutionText(value.description, EVOLUTION_LIMITS.maxDescriptionChars)) {
    return { ok: false, code: 'invalid-description', reason: 'description must be a non-empty bounded string' }
  }
  if (
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length === 0 ||
    value.evidenceIds.length > EVOLUTION_LIMITS.maxEvidencePerImprovement ||
    !value.evidenceIds.every((ref) => isEvolutionRef(ref))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'evidenceIds must be between 1 and maxEvidencePerImprovement bounded opaque ids',
    }
  }
  const createdAt = instantMs(value.createdAt)
  if (createdAt === null) {
    return { ok: false, code: 'invalid-instant', reason: 'createdAt must parse as an instant' }
  }

  return {
    ok: true,
    value: Object.freeze({
      improvementId: value.improvementId as string,
      kind: value.kind as ImprovementKind,
      // Assigned, never taken from the payload.
      state: 'proposed' as ImprovementState,
      evidenceIds: Object.freeze([...(value.evidenceIds as readonly string[])]),
      description: value.description as string,
      createdAt: value.createdAt as string,
      appliedAt: null,
    }),
  }
}

/**
 * Advance an improvement, checking the closed transition table.
 *
 * Two rules beyond the table:
 * - a stale improvement may not be advanced at any stage;
 * - only an `applied` improvement may carry an applied instant.
 */
export function advanceImprovement(
  improvement: ImprovementRecord,
  decision: { now: string; to: ImprovementState },
): ImprovementResult<ImprovementRecord> {
  const at = instantMs(decision.now)
  if (at === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the decision instant must parse as an instant' }
  }
  if (improvement.state === decision.to) {
    return { ok: false, code: 'illegal-transition', reason: `the improvement is already ${decision.to}` }
  }
  if (!canTransitionImprovement(improvement.state, decision.to)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `a ${improvement.state} improvement cannot become ${decision.to}`,
    }
  }
  if (decision.to === 'applied') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'an improvement is applied through applyImprovement, which records the applied instant',
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...improvement,
      state: decision.to,
    }),
  }
}

/**
 * Apply an improvement.
 *
 * The only route to `applied`, and it records the applied instant. An
 * improvement can only be applied from `staged`, and only after the owner has
 * approved it — the approval is checked by the runtime, not here.
 */
export function applyImprovement(
  improvement: ImprovementRecord,
  decision: { now: string },
): ImprovementResult<ImprovementRecord> {
  const at = instantMs(decision.now)
  if (at === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the application instant must parse as an instant' }
  }
  if (improvement.state !== 'staged') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `only a staged improvement can be applied, and this one is ${improvement.state}`,
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...improvement,
      state: 'applied',
      appliedAt: decision.now,
    }),
  }
}

/**
 * Roll an improvement back.
 *
 * Reachable from `staged` and `applied`, because a rollback that cannot undo a
 * landed change is a promise rather than a mechanism. The improvement moves to
 * `failed` with the rollback recorded, and a new improvement is proposed to
 * replace it.
 */
export function rollBackImprovement(
  improvement: ImprovementRecord,
  decision: { now: string; reason: string },
): ImprovementResult<ImprovementRecord> {
  const at = instantMs(decision.now)
  if (at === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the rollback instant must parse as an instant' }
  }
  if (!isBoundedEvolutionText(decision.reason, EVOLUTION_LIMITS.maxReasonChars)) {
    return { ok: false, code: 'invalid-reason', reason: 'a rollback must carry a bounded non-empty reason' }
  }
  if (improvement.state !== 'staged' && improvement.state !== 'applied') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `a ${improvement.state} improvement cannot be rolled back`,
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...improvement,
      state: 'failed',
      appliedAt: null,
    }),
  }
}

/**
 * The progress of an improvement, as a number in [0, 1].
 *
 * A fact about the lifecycle table, not a score. `proposed` is 0, `applied`
 * is 1, and the states in between are evenly spaced.
 */
export function improvementProgress(improvement: ImprovementRecord): number {
  const order: Readonly<Record<ImprovementState, number>> = Object.freeze({
    proposed: 0,
    evaluating: 0.25,
    approved: 0.5,
    staged: 0.75,
    applied: 1,
    failed: 0,
  })
  return order[improvement.state]
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key)
}

export { IMPROVEMENT_KINDS, IMPROVEMENT_STATES, IMPROVEMENT_TRANSITIONS, isImprovementState }
