/**
 * The Autonomous Enterprise / Webzone slice (Phase 33) — self-contained domain.
 *
 * **Not wired into Core.** See `./README.md`. There is no import from Phase 24, 31 or
 * 32 anywhere below, because none of them is on this branch, and no composition-root
 * change. What is here is the part of Phase 33 that can be built and proved without
 * them: the contracts, the event-sourced state, the gate rules, and the refusals.
 *
 * The structure follows the Continuous Life Loop because its shape is the right one:
 *
 *   - `./types` — closed vocabularies, frozen ceilings, the absolute deny list. Data.
 *   - `./ports` — the entire integration surface. The omissions are the design: there
 *     is no cognition port, no authority port, no payment port and no timer.
 *   - pure modules — no clock, no journal, no network, no port access. `./assertions`
 *     scans their source to keep it that way.
 *   - `./runtime` — the only file that touches a port. Schedules nothing.
 *   - `./assertions` — structural audits. Not used by production code.
 *
 * The central claim is that Freya operating a business cannot widen its own authority
 * or spend real money. That claim is only worth something if the code which *decides*
 * those questions has no way to perform the actions it is deciding about — so the pure
 * modules have no route to a model, a payment, a capability or a clock, and the audits
 * fail the build if one grows one.
 */

export * from './types'
export {
  ENVIRONMENT_TRANSITIONS,
  TASK_TRANSITIONS,
  MISSION_TRANSITIONS,
  WEBZONE_TRANSITIONS,
  APPROVAL_TRANSITIONS,
  APPROVAL_PENDING_LIMITS,
  environmentTransition,
  taskTransition,
  missionTransition,
  webzoneTransition,
  approvalTransition,
  auditTransitionTables,
  type Transition,
  type TransitionDecision,
  type TransitionRefusal,
} from './machine'
export {
  ENTERPRISE_BOUNDARY_NAMES,
  BOUNDARY_GATE,
  effectiveForbiddenActions,
  normaliseBoundaries,
  domainAllowed,
  isForbiddenAction,
  checkCountBoundaries,
  checkDurationBoundary,
  checkPayloadBoundary,
  checkDomainBoundary,
  checkForbiddenAction,
  consequenceOf,
  approvalRequiredFor,
  forbiddenActionCount,
  asForbiddenAction,
  type CountContext,
  type EnterpriseBoundaries,
  type BoundaryDecision,
  type BoundaryNormalisation,
  type EnterpriseBoundaryName,
} from './boundaries'
export {
  MAX_SPENDING_LIMIT_MINOR,
  isCurrency,
  isMinorAmount,
  readSpendingLimits,
  emptyLedger,
  accumulateSpend,
  spentOnDay,
  dayKeyOf,
  checkSpendingGate,
  checkAllSpendingGates,
  spendingGateKinds,
  type SpendingDecision,
  type SpendingLedger,
  type SpendingLimitsReading,
  type MAX_SPENDING_LIMIT_MINOR as MaxSpendingLimitMinor,
} from './spending'
export {
  readApprovalRequest,
  approvalCovers,
  checkApprovalGate,
  isExpired,
  countPendingApprovals,
  mayRequestApproval,
  approvalDecisionIsOwners,
  mayTransitionApproval,
  type ApprovalGateDecision,
  type ApprovalGateInput,
  type ApprovalRecord,
  type ApprovalRequestReading,
  type ApprovalSubject,
  type PendingApprovalCount,
} from './approvals'
export {
  EVIDENCE_SOURCES_THAT_COUNT,
  evidenceIsAdmissible,
  evidenceSupportsPass,
  claimIsUnreliable,
  verifyExternalAction,
  mayBeConsideredComplete,
  deadlineHasExpired,
  verificationOutcomes,
  verificationReasonWithinBounds,
  type VerificationDecision,
  type VerificationRecord,
} from './verification'
export {
  assessReversibility,
  checkRollbackGate,
  deriveRollbackOutcome,
  environmentMayContinue,
  mayAttemptRollbackFor,
  rollbackOutcomes,
  maxRollbackDurationMs,
  type ReversibilityAssessment,
  type ReversibilityCode,
  type RollbackDecision,
  type RollbackGateInput,
  type RollbackOutcomeInput,
  type RollbackRecord,
} from './rollback'
export {
  readCatalogItem,
  readCustomer,
  mayAddCatalogItem,
  mayAddCustomer,
  mayTouchCustomer,
  customerValueIsClean,
  hasLongDigitRun,
  catalogItemStates,
  customerStates,
  CATALOG_KINDS_BY_ENVIRONMENT,
  type CatalogItem,
  type CustomerRecord,
  type Reading,
} from './catalog'
export {
  validateWake,
  authorizeEnterpriseAction,
  actionDigest,
  mayChangeEnvironmentState,
  mayChangeTaskState,
  mayChangeOperationState,
  readWorkflow,
  nextWorkflowStep,
  workflowFitsBoundaries,
  stepConsequence,
  wakeSources,
  wakeKinds,
  type AuthorizationContext,
  type AuthorizationDecision,
  type BoundedWorkflow,
  type EnterpriseActionRequest,
  type EnterpriseWake,
  type GateEnvironmentView,
  type WakeDecision,
  type WorkflowReading,
  type WorkflowStep,
} from './orchestration'
export {
  initialEnterpriseState,
  reduceEnterpriseState,
  reduceEnterpriseEntry,
  inspectEnterprisePayload,
  countsFor,
  enterpriseVocabularies,
  dayKeyOf as foldDayKeyOf,
  type CatalogItemState as FoldedCatalogItemState,
  type CustomerState as FoldedCustomerState,
  type EnterpriseRefusal,
  type EnterpriseState,
  type EnvironmentRecord,
  type FoldAnomaly,
  type FoldAnomalyCode,
  type FoldResult,
  type MissionRecord,
  type OperationRecord,
  type TaskRecord,
} from './state'
export {
  projectEnterpriseState,
  deriveProgress,
  deriveUncertainty,
  deriveBlockedReason,
  deriveNextBoundedAction,
  type ActionSummary,
  type BoundedAction,
  type EnterpriseProjectionInput,
  type EnterpriseStateProjection,
  type EnvironmentSummary,
} from './projection'
export {
  stripComments,
  findTimerUsageInSource,
  findUnboundedLoopInSource,
  findImpurityInSource,
  findForbiddenVocabularyInSource,
  findCognitionEventsInVocabulary,
  auditEventVocabulary,
  auditRefusalVocabulary,
  auditAuthorityTables,
  auditBoundaryNormalisation,
  auditEnterpriseTables,
  analyseZeroHiddenSpend,
  type InferenceViolation,
  type InferenceViolationCode,
  type ZeroHiddenSpendInput,
} from './assertions'
export {
  createEnterpriseRuntime,
  type EnterpriseActionOutcome,
  type EnterpriseRuntime,
  type EnterpriseRuntimeOptions,
  type RollbackRequest,
} from './runtime'
export type {
  EnterpriseActionRecord,
  EnterpriseApprovalDecision,
  EnterpriseApprovalRequest,
  EnterpriseEffectOutcome,
  EnterpriseEffectRequest,
  EnterprisePayload,
  EnterprisePorts,
  EnterpriseRefusalRecord,
  EvidenceInput,
  RollbackInput,
  SpendingGateInput,
  VerificationInput,
} from './ports'