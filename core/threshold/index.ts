/**
 * Mature Freya Threshold (Phase 39) — domain and runtime.
 *
 * Measurable proof of maturity across 14 dimensions with **no authority
 * widening**.
 *
 * The whole lane hangs off one sentence:
 *
 * > Phase 39 is a threshold to prove — not a license to widen authority.
 * > Maturity is measured across 14 dimensions with verifiable evidence. Every
 * > criterion is testable, auditable, and fail-closed. No authority widening,
 * > no hidden inference, no real-money autonomy, no self-modification of trusted
 * > runtime code.
 */

export * from './types'
export {
  THRESHOLD_GUARD_CAPABILITY,
  THRESHOLD_GATE_CHECKS,
  blockerForRefusal,
  evaluateThresholdGate,
  type ThresholdAuthorityFacts,
  type ThresholdGateAllowance,
  type ThresholdGateCheck,
  type ThresholdGateDenial,
  type ThresholdGateOutcome,
} from './authority'
export {
  NO_REAL_MONEY_STATEMENT,
  REFUSAL_REASONS,
  classifyThresholdClaim,
  forbiddenKeysIn,
  refusalSubject,
  type ThresholdClaimScan,
} from './prohibition'
export { defaultThresholdLimits, narrowThresholdLimits, narrowedLimitNames } from './limits'
export {
  allThresholdTransitions,
  auditThresholdTable,
  thresholdSignalReason,
  signalsFrom,
  transition,
} from './machine'
export {
  FOLD_CONTEXT_CLOSED,
  initialThresholdState,
  reduceThresholdEntry,
  reduceThresholdEntryOnly,
  reduceThresholdState,
  type ThresholdAssessmentRecord,
  type ThresholdEvidenceRecord,
  type ThresholdFailClosedRecord,
  type ThresholdRollbackRecord,
  type ThresholdFoldAnomaly,
  type ThresholdFoldAnomalyCode,
  type ThresholdFoldContext,
  type ThresholdFoldResult,
  type ThresholdJournalEntry,
  type ThresholdRefusal,
} from './state'
export {
  analyseThresholdAssertions,
  passingThresholdAssertions,
  scanThresholdSource,
  type ThresholdAssertionInput,
  type ThresholdAssertionReport,
  type ThresholdViolation,
  type ThresholdViolationCode,
} from './assertions'
export {
  thresholdWakeDedupeKey,
  orderThresholdWakes,
  validateThresholdWake,
  wakeRefusalReason,
  type ThresholdWakeContext,
  type ThresholdWakeValidationOutcome,
} from './wake'
export type { ThresholdPayload, ThresholdPorts } from './ports'
export {
  ThresholdRuntime,
  type ThresholdOutcome,
  type ThresholdRuntimeOptions,
  type ThresholdSnapshot,
  type ThresholdStatus,
  type ThresholdWakeOutcome,
} from './runtime'
export {
  THRESHOLD_SCHEMA_VERSION,
  NO_REAL_MONEY,
  PROJECTED_THRESHOLD_ACTION_KINDS,
  PROJECTED_THRESHOLD_KIND_ORDER,
  projectThresholdState,
  type ThresholdCountersView,
  type ThresholdAssessmentView,
  type ThresholdEvidenceView,
  type ThresholdFailClosedView,
  type ThresholdRollbackView,
  type ThresholdRedTeamView,
  type ThresholdSummaryView,
  type ThresholdProjection,
  type ThresholdProjectionInput,
} from './projection'
