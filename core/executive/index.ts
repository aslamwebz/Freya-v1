/**
 * The Executive Intelligence domain (Phase 24).
 *
 * Everything here is pure or narrowly ported: closed vocabularies, deterministic
 * prioritization, planning under uncertainty, bounded coordination, and the
 * projection that turns those domain values into the read-only vocabulary a
 * window may hold. No I/O beyond the injected context, no clock reads except
 * through an injected `now`, no randomness, no model, no authority.
 *
 * The core invariant:
 *
 * > **Planning is not authority. Coordination is not sovereignty. Confidence is not permission.**
 *
 * Every component is designed so that no field can become authority. There is
 * no `grant`, no `capability`, no `budget`, no `approval` and no `bypass`
 * anywhere in this vocabulary. A priority assessment cannot mint a capability.
 * A plan cannot widen a budget. A coordination decision cannot skip an
 * approval. Authority lives in Guard, Governor, STOP ALL, approvals and
 * budgets — and Phase 24 never touches any of them.
 */

export * from './types'
export {
  OWNER_INTENTS,
  isOwnerIntent,
  computeUrgency,
  computeDependencyRank,
  computeScore,
  scoreToTier,
  collectSignals,
  determineReason,
  assessItem,
  determineBlocker,
  createBoundedAction,
  prioritize,
  type WorkItemKind,
  type OwnerIntent,
  type WorkItemMetadata,
  type PrioritizerContext,
} from './prioritizer'
export {
  detectEvidenceState,
  detectConflictedEvidence,
  conservativeInterpretation,
  createAssumption,
  createAssumptionsForGaps,
  createPlannedStep,
  markReversibility,
  planForGoal,
  produceBoundedActions,
  plan,
  type PlanGoal,
  type PlannerContext,
} from './planner'
export {
  isWorkerEligible,
  sortWorkersByPreference,
  shouldPreempt,
  computeBackoff,
  isRetryCeilingExceeded,
  coordinateItem,
  coordinate,
  isWaitDeadlineExpired,
  escalate,
  type WorkerInfo,
  type CoordinationItem,
  type CoordinatorContext,
  type CoordinationResult,
} from './coordinator'
export {
  projectExecutiveState,
  createExecutiveItem,
  isConfidenceHonest,
  boundList,
  boundString,
  type ProjectionContext,
} from './projection'
