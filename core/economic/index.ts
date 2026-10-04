/**
 * Economic Intelligence (Phase 32) — domain and runtime.
 *
 * Research, simulation and paper trading with **zero real capital**. The whole lane hangs
 * off one sentence:
 *
 * > Economic Intelligence is research, simulation and paper trading only.
 * > No real money, no real spending, no real financial transactions.
 *
 * Everything below `./ports` is pure. There is no clock read, no journal write, no
 * provider call, no capability, no principal and no broker anywhere in those modules, and
 * nothing in them can acquire any of those: the types they hold have no field that could
 * carry one. That is not a stylistic preference — it is what makes the lane's central
 * claim checkable. "Freya has no access to real money" is only believable if the code that
 * decides what to simulate has no way to reach any.
 *
 * `./ports`, `./seams` and `./runtime` are the wiring, and they are the only three files
 * that touch anything. The runtime holds no authority of its own: every mutating entry
 * point passes through `evaluateEconomicGate`, whose facts Core supplies from machinery
 * that already existed, and whose order puts the STOP ALL latch above every other check.
 * The runtime also schedules nothing — it is driven by an authoritative event, by the
 * host's existing bounded tick and by its own `open()`, which is what the structural
 * assertion in `assertions.ts` scans for.
 *
 * `seams.ts` is where the dependency on Phase 31 lives, and it is deliberately a single
 * inert interface. Long-horizon autonomy is being built concurrently on another branch;
 * Phase 32 depends on it and cannot wait for it, so the dependency is declared narrow,
 * default-empty and unable to drive anything until somebody supplies an implementation.
 */

export * from './types'
export {
  ECONOMIC_GUARD_CAPABILITY,
  ECONOMIC_GATE_CHECKS,
  STAGE_UNIT_COST,
  blockerForRefusal,
  evaluateEconomicGate,
  totalUnitAllowance,
  type EconomicAuthorityFacts,
  type EconomicGateAllowance,
  type EconomicGateCheck,
  type EconomicGateDenial,
  type EconomicGateOutcome,
} from './authority'
export {
  NO_REAL_MONEY_STATEMENT,
  REFUSAL_REASONS,
  classifyEconomicClaim,
  forbiddenKeysIn,
  refusalSubject,
  type EconomicClaimScan,
} from './prohibition'
export { defaultEconomicLimits, narrowEconomicLimits, narrowedLimitNames } from './limits'
export {
  ECONOMIC_DEADLINE_TYPES,
  ECONOMIC_DEADLINE_DEFAULT_MS,
  backoffDelayMs,
  deadlineOutcomeReason,
  defaultRetryCeiling,
  deterministicJitterMs,
  isEconomicDeadlineExpired,
  narrowRetryCeiling,
  rebuildEconomicDeadline,
  remainingMs,
  resolveEconomicDeadline,
  retryCeilingReached,
  unitAllowanceFor,
  type EconomicDeadline,
  type EconomicDeadlineOutcomeCode,
  type EconomicDeadlineType,
  type EconomicRetryCeiling,
} from './deadlines'
export {
  allEconomicTransitions,
  auditEconomicTable,
  economicSignalReason,
  signalsFrom,
  transition,
} from './machine'
export { economicWakePriority, experimentKindRank } from './types'
export {
  ECONOMIC_DECISIONS,
  EXPERIMENT_KIND_ORDER,
  ECONOMIC_STAGE_ORDER,
  continuationDecisionReason,
  planContinuation,
  rankExperiments,
  type ContinuationFacts,
  type ContinuationInput,
  type ContinuationPlan,
  type EconomicContinuationDecision,
} from './continuation'
export {
  admitEvidence,
  claimConfidence,
  experimentConfidence,
  isEvidenceStale,
  recordGap,
  refreshClaimEvidence,
  refreshEvidence,
  uncertaintiesFor,
  type EvidenceAdmission,
  type EvidenceObservation,
} from './evidence'
export {
  assessResearch,
  defineExperiment,
  describeResearch,
  isExperimentExpired,
  researchRefusalReason,
  type ExperimentDefinition,
  type ExperimentDraft,
  type ResearchAssessment,
} from './research'
export {
  DEFAULT_SMA_WINDOW,
  SCENARIO_PARAMETERS,
  SIMULATION_PRECISION,
  defineScenario,
  maxDrawdown,
  meanAbsoluteMove,
  round,
  runSimulation,
  scenarioRefusalReason,
  totalReturnOf,
  validateSeries,
  type ScenarioDefinition,
  type ScenarioDraft,
  type SimulationRun,
} from './simulation'
export {
  PAPER_METRIC_NAMES,
  PAPER_STARTING_CASH,
  admitPaperOrder,
  applyPaperOrder,
  computePaperMetrics,
  countClosedTrades,
  drawdownOf,
  markPaperPositions,
  orderRefusalReason,
  paperEquity,
  type PaperApplication,
  type PaperFill,
  type PaperMetricInput,
  type PaperMetricName,
  type PaperOrderAdmission,
  type PaperOrderDraft,
} from './paper'
export {
  FOLD_CONTEXT_CLOSED,
  ECONOMIC_EVENT_TYPES,
  evidenceAsOf,
  experimentBundle,
  initialEconomicState,
  reduceEconomicEntry,
  reduceEconomicState,
  retryCeilingForState,
  type EconomicExperimentRecord,
  type EconomicFoldAnomaly,
  type EconomicFoldAnomalyCode,
  type EconomicFoldContext,
  type EconomicFoldResult,
  type EconomicInterruption,
  type EconomicJournalEntry,
  type EconomicState,
} from './state'
export {
  ECONOMIC_RECOVERY_ACTIONS,
  describeEconomicRecovery,
  planEconomicRecovery,
  type EconomicRecoveryAction,
  type EconomicRecoveryActionCode,
  type EconomicRecoveryInput,
  type EconomicRecoveryReport,
} from './recovery'
export {
  analyseEconomicAssertions,
  forbiddenKeysIn as economicForbiddenKeys,
  passingEconomicAssertions,
  scanEconomicSource,
  type EconomicAssertionInput,
  type EconomicAssertionReport,
  type EconomicViolation,
  type EconomicViolationCode,
} from './assertions'
export {
  economicWakeDedupeKey,
  orderEconomicWakes,
  validateEconomicWake,
  wakeRefusalReason,
  type EconomicWakeContext,
  type EconomicWakeRequest,
} from './wake'
export {
  NO_LONG_HORIZON_SEAM,
  isSeamConnected,
  mayHonourGoal,
  type LongHorizonSeam,
} from './seams'
export type {
  EconomicPayload,
  EconomicPorts,
} from './ports'
export {
  EconomicRuntime,
  type EconomicOutcome,
  type EconomicRuntimeOptions,
  type EconomicSnapshot,
  type EconomicStatus,
  type EconomicWakeOutcome,
} from './runtime'
export {
  ECONOMIC_SCHEMA_VERSION,
  NO_REAL_MONEY,
  PROJECTED_ACTION_KINDS,
  PROJECTED_KIND_ORDER,
  projectEconomicState,
  type EconomicCountersView,
  type EconomicEvidenceView,
  type EconomicInterruptionView,
  type EconomicProjection,
  type EconomicProjectionInput,
  type EconomicRedTeamView,
  type EconomicSummaryView,
} from './projection'