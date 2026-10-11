import type { MissionReason, MissionRecord } from '../types'
import type { MissionCorrectionAmbiguity, MissionDecision } from './types'

/** What an owner correction produced. */
/**
 * What an owner correction produced.
 *
 * `ambiguity` is the closed code *and* `question` the private sentence, and they are both
 * present on the failure paths and absent on success. Only the code reaches the journal;
 * only the question reaches a person. Keeping them in one type is what makes it obvious
 * that a caller must handle both — a caller that read `question` alone would display the
 * private text without knowing it was unresolved, and one that read `ambiguity` alone
 * would know to ask without knowing what.
 */
export interface CorrectionResult {
  readonly ok: boolean
  readonly kind: 'patch' | 'ambiguous' | 'rejected'
  readonly ambiguity: MissionCorrectionAmbiguity | null
  readonly changedFields: readonly string[]
  readonly settledSteps: number
  readonly preservedEvidence: number
  /** The question to put to the owner, or null when none was needed. */
  readonly question: string | null
  readonly paused: boolean
}



/* ------------------------------------------------------------ applied result */

/**
 * What carrying out a decision actually did.
 *
 * `decision` and `reason` are present only when the applied result **corrects** the
 * decision `decide` reached — which happens when acting on `continue` discovers that a
 * person must decide first. Omitted otherwise, so `undefined` reads as "no correction"
 * rather than as "correction to undefined".
 *
 * The distinction between what was *decided* and what *happened* is recorded in both
 * places, deliberately: the journal keeps the decision (that is the honest record of the
 * reasoning) and the outcome carries the result (that is what a caller acts on). Merging
 * them would make one of the two a lie.
 */
export interface AppliedDecision {
  readonly status: MissionRecord['status']
  readonly decision?: MissionDecision
  readonly reason?: MissionReason
  /**
   * `null` and `undefined` are different, and both occur.
   *
   * A correction that is about a *specific* step names it. A correction that is about the
   * Mission as a whole — a blocker with no step behind it, a gate Freya cannot open at all —
   * says `stepId: null`, which is a fact. And `undefined` means "no correction", which is
   * why the field is optional rather than nullable: `null` has to stay distinguishable
   * from "not stated".
   */
  readonly stepId?: string | null
}

/** An applied result that changed nothing about the decision. */
export function applied(status: MissionRecord['status']): AppliedDecision {
  return { status }
}

/**
 * An applied result that learned something new — an approval gate, discovered by trying.
 *
 * The correction is explicit rather than inferred, so a reader can see exactly why the
 * reported decision differs from the journalled one.
 */
export function asApproval(status: MissionRecord['status'], stepId: string): AppliedDecision {
  return { status, decision: 'request_approval', reason: 'approval_pending', stepId }
}

/**
 * An applied result that left the Mission **parked** rather than working.
 *
 * `decide` said `continue`; trying revealed that nothing could proceed — no capable
 * worker, a refused budget, a capability Freya may not use. The honest report is `wait`,
 * and it is also what makes the caller schedule a bounded next wake.
 *
 * That second part is the reason this exists rather than reporting `continue` and leaving
 * the status to speak for itself. A parked Mission with **no** scheduled wake is a Mission
 * that is never looked at again: nothing is due, nothing is running, and no event is
 * expected. So the reported decision and the wake scheduling have to agree, and both are
 * derived from this one value.
 */
export function asParked(status: MissionRecord['status'], reason: MissionReason, stepId: string | null): AppliedDecision {
  return { status, decision: 'wait', reason, stepId }
}

/** A refused correction, with every field a caller must handle explicitly set. */
export function rejected(ambiguity: MissionCorrectionAmbiguity, question: string): CorrectionResult {
  return {
    ok: false,
    kind: 'rejected',
    ambiguity,
    changedFields: Object.freeze([]),
    settledSteps: 0,
    preservedEvidence: 0,
    question,
    paused: false,
  }
}

