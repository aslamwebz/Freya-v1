/**
 * Resilience & Self-Recovery (Phase 36) — domain and runtime.
 *
 * Bounded crash/data/provider failure recovery, backup restore, degraded-mode
 * honesty and repair workflows with **no authority widening**.
 *
 * The whole lane hangs off one sentence:
 *
 * > Resilience is bounded recovery, not continuous self-repair. Every recovery
 * > is authorized, auditable, and reversible. No hidden self-modification, no
 * > authority widening, no autonomous real-money actions.
 */

export * from './types'
export {
  RESILIENCE_GUARD_CAPABILITY,
  RESILIENCE_GATE_CHECKS,
  blockerForRefusal,
  evaluateResilienceGate,
  type ResilienceAuthorityFacts,
  type ResilienceGateAllowance,
  type ResilienceGateCheck,
  type ResilienceGateDenial,
  type ResilienceGateOutcome,
} from './authority'
export {
  NO_REAL_MONEY_STATEMENT,
  REFUSAL_REASONS,
  classifyResilienceClaim,
  forbiddenKeysIn,
  refusalSubject,
  type ResilienceClaimScan,
} from './prohibition'
export { defaultResilienceLimits, narrowResilienceLimits, narrowedLimitNames } from './limits'
export {
  RESILIENCE_DEADLINE_TYPES,
  backoffDelayMs,
  deadlineOutcomeReason,
  defaultRetryCeiling,
  deterministicJitterMs,
  isResilienceDeadlineExpired,
  narrowRetryCeiling,
  rebuildResilienceDeadline,
  remainingMs,
  resolveResilienceDeadline,
  retryCeilingReached,
  type ResilienceDeadline,
  type ResilienceDeadlineOutcome,
  type ResilienceDeadlineOutcomeCode,
  type ResilienceDeadlineType,
  type ResilienceRetryCeiling,
} from './deadlines'
export {
  allResilienceTransitions,
  auditResilienceTable,
  resilienceSignalReason,
  signalsFrom,
  transition,
} from './machine'
export {
  FOLD_CONTEXT_CLOSED,
  initialResilienceState,
  reduceResilienceEntry,
  reduceResilienceEntryOnly,
  reduceResilienceState,
  type ResilienceBackupRecord,
  type ResilienceDegradedModeRecord,
  type ResilienceFailureRecord,
  type ResilienceFoldAnomaly,
  type ResilienceFoldAnomalyCode,
  type ResilienceFoldContext,
  type ResilienceFoldResult,
  type ResilienceJournalEntry,
  type ResilienceRecoveryRecord,
  type ResilienceRefusal,
  type ResilienceRepairRecord,
  type ResilienceRestoreRecord,
} from './state'
export {
  CRASH_RECOVERY_ACTIONS,
  planCrashRecovery,
  type CrashRecoveryAction,
  type CrashRecoveryActionCode,
  type CrashRecoveryInput,
  type CrashRecoveryReport,
  DATA_RECOVERY_ACTIONS,
  planDataRecovery,
  type DataRecoveryAction,
  type DataRecoveryActionCode,
  type DataRecoveryInput,
  type DataRecoveryReport,
  PROVIDER_RECOVERY_ACTIONS,
  planProviderRecovery,
  type ProviderRecoveryAction,
  type ProviderRecoveryActionCode,
  type ProviderRecoveryInput,
  type ProviderRecoveryReport,
  BACKUP_RESTORE_ACTIONS,
  planBackupRestore,
  type BackupRestoreAction,
  type BackupRestoreActionCode,
  type BackupRestoreInput,
  type BackupRestoreReport,
  REPAIR_WORKFLOW_ACTIONS,
  planRepairWorkflow,
  type RepairWorkflowAction,
  type RepairWorkflowActionCode,
  type RepairWorkflowInput,
  type RepairWorkflowReport,
  DEGRADED_MODE_ACTIONS,
  planDegradedMode,
  type DegradedModeAction,
  type DegradedModeActionCode,
  type DegradedModeInput,
  type DegradedModeReport,
} from './recovery'
export {
  analyseResilienceAssertions,
  passingResilienceAssertions,
  scanResilienceSource,
  type ResilienceAssertionInput,
  type ResilienceAssertionReport,
  type ResilienceViolation,
  type ResilienceViolationCode,
} from './assertions'
export {
  resilienceWakeDedupeKey,
  orderResilienceWakes,
  validateResilienceWake,
  wakeRefusalReason,
  type ResilienceWakeContext,
  type ResilienceWakeValidationOutcome,
} from './wake'
export {
  NO_LONG_HORIZON_SEAM,
  isSeamConnected,
  mayHonourGoal,
  type LongHorizonSeam,
} from './seams'
export type { ResiliencePayload, ResiliencePorts } from './ports'
export {
  ResilienceRuntime,
  type ResilienceOutcome,
  type ResilienceRuntimeOptions,
  type ResilienceSnapshot,
  type ResilienceStatus,
  type ResilienceWakeOutcome,
} from './runtime'
export {
  RESILIENCE_SCHEMA_VERSION,
  NO_REAL_MONEY,
  PROJECTED_ACTION_KINDS,
  PROJECTED_KIND_ORDER,
  projectResilienceState,
  type ResilienceCountersView,
  type ResilienceFailureView,
  type ResilienceProjection,
  type ResilienceProjectionInput,
  type ResilienceRecoveryView,
  type ResilienceRedTeamView,
  type ResilienceRepairView,
  type ResilienceSummaryView,
} from './projection'
