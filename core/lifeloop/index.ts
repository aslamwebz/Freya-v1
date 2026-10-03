/**
 * The Continuous Life Loop (Phase 23) — domain and runtime.
 *
 * `wake` -> deterministic pre-cognition filter -> understand -> decide ->
 * bounded act -> verify -> continue, with the loop's own state machine holding
 * all of it to a bound.
 *
 * Everything below `./ports` is pure. There is no clock read, no journal write, no
 * provider call, no capability and no network in those modules, and nothing in them
 * can acquire any of those: the types they hold have no field that could carry one.
 * That is not a stylistic preference — it is what makes the loop's central claim
 * checkable. "An idle Freya makes no paid call" is only believable if the code that
 * decides whether to spend has no way to spend.
 *
 * `./ports` and `./runtime` are the wiring, and they are the only two files that
 * touch anything. The runtime holds no authority of its own: every route to a model
 * goes through `LifeLoopPorts.requestCognition`, which Core fills with the
 * Governor, the Gateway and an owner-created grant — machinery that already existed
 * and that the loop cannot reach around. And the runtime schedules nothing. It is
 * driven by an authoritative event, by the host's existing bounded tick, and by its
 * own `open()`; there is no timer anywhere in this module, which is what the
 * structural assertion scans for.
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
  reduceLifeLoopEntry,
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
export {
  LIFE_LOOP_VERIFICATION_KINDS,
  type LifeLoopCognitionOutcome,
  type LifeLoopCognitionRequest,
  type LifeLoopEscalation,
  type LifeLoopPayload,
  type LifeLoopPorts,
  type LifeLoopVerificationKind,
  type LifeLoopVerificationOutcome,
  type LifeLoopVerificationRequest,
  type LifeLoopWakeRequest,
} from './ports'
export {
  LifeLoopRuntime,
  type LifeLoopRuntimeOptions,
  type LifeLoopSnapshot,
  type LifeLoopWakeOutcome,
} from './runtime'
export { projectLifeLoop, type LifeLoopProjectionInput } from './projection'