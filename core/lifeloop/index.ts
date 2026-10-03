/**
 * The Continuous Life Loop (Phase 23) — domain.
 *
 * `wake` -> deterministic pre-cognition filter -> understand -> decide ->
 * bounded act -> verify -> continue, with the loop's own state machine holding
 * all of it to a bound.
 *
 * Every piece here is pure. There is no clock read, no journal write, no provider
 * call, no capability and no network in this module, and nothing in it can
 * acquire any of those: the types it holds have no field that could carry one.
 * That is not a stylistic preference — it is what makes the loop's central claim
 * checkable. "An idle Freya makes no paid call" is only believable if the code
 * that decides whether to spend has no way to spend.
 *
 * The wiring to Attention, Cognition, Work, the Guard, the Governor and the
 * journal lives in Core, not here, and adding it is the only step of Phase 23
 * that has to wait for the rest of the system.
 */

export * from './types'
export {
  validateWake,
  wakeDedupeKey,
  wakeRefusalReason,
  orderWakes,
  readWakePayload,
  justifiesCognition,
  type WakeValidationInput,
} from './wake'
export {
  evaluatePreCognition,
  preCognitionDenialReason,
  type LifeLoopProgress,
  type PreCognitionAuthority,
  type PreCognitionInput,
} from './prefilter'
export {
  escalationRank,
  resolveEscalation,
  type EscalationResolution,
  type EscalationResolutionReason,
} from './decide'
export {
  transition,
  interrupt,
  allOrdinaryTransitions,
  allInterruptions,
  continuationSignalReason,
  interruptionReason,
  interruptionNotApplicableReason,
  interruptionDeadlineType,
  INTERRUPTION_DEADLINE,
  requiresDeadline,
} from './machine'
export {
  DEADLINE_DEFAULT_MS,
  narrowLifeLoopLimits,
  resolveDeadline,
  remainingMs,
  isExpired,
  enforceDeadline,
  defaultRetryCeiling,
  narrowRetryCeiling,
  retryCeilingReached,
  backoffDelayMs,
  nextRetry,
  deadlineOutcomeReason,
} from './deadlines'
export {
  initialLifeLoopState,
  reduceLifeLoopState,
  reduceLifeLoopWake,
  projectLifeLoopStatus,
  retryCeilingFor,
  type FoldAnomaly,
  type FoldAnomalyCode,
  type FoldResult,
  type LifeLoopJournalEntry,
  type LifeLoopState,
} from './state'
export {
  recoverLifeLoop,
  residualWaitMs,
  describeRecovery,
  type RecoveryInput,
} from './recovery'
export {
  analyseZeroIdleInference,
  findTimerUsageInSource,
  findUnboundedLoopInSource,
  auditContinuationTable,
  type InferenceViolation,
  type InferenceViolationCode,
  type ZeroIdleInferenceInput,
  type ZeroIdleInferenceReport,
} from './assertions'