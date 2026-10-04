/**
 * Sovereign Intelligence (Phase 37) — domain and runtime.
 *
 * Provider-independent, optionally offline reasoning with portable encrypted
 * identity/data — no authority widening, no hidden inference.
 */

export * from './types'
export {
  SOVEREIGNTY_GUARD_CAPABILITY,
  SOVEREIGNTY_GATE_CHECKS,
  blockerForRefusal,
  evaluateSovereigntyGate,
  type SovereigntyAuthorityFacts,
  type SovereigntyGateAllowance,
  type SovereigntyGateCheck,
  type SovereigntyGateDenial,
  type SovereigntyGateOutcome,
} from './authority'
export {
  NO_REAL_MONEY_STATEMENT,
  REFUSAL_REASONS,
  classifySovereigntyClaim,
  forbiddenKeysIn,
  refusalSubject,
  type SovereigntyClaimScan,
} from './prohibition'
export { defaultSovereigntyLimits, narrowSovereigntyLimits, narrowedLimitNames } from './limits'
export {
  allSovereigntyTransitions,
  auditSovereigntyTable,
  sovereigntySignalReason,
  signalsFrom,
  transition,
} from './machine'
export {
  FOLD_CONTEXT_CLOSED,
  initialSovereigntyState,
  reduceSovereigntyEntry,
  reduceSovereigntyEntryOnly,
  reduceSovereigntyState,
  type SovereigntyFoldedState,
  type SovereigntyFoldAnomaly,
  type SovereigntyFoldAnomalyCode,
  type SovereigntyFoldContext,
  type SovereigntyFoldResult,
  type SovereigntyJournalEntry,
  type SovereigntyOfflineSessionRecord,
  type SovereigntyPortableDataRecord,
  type SovereigntyProviderRecord,
  type SovereigntyRefusal,
  type SovereigntyRoutingRecord,
} from './state'
export {
  analyseSovereigntyAssertions,
  passingSovereigntyAssertions,
  scanSovereigntySource,
  type SovereigntyAssertionInput,
  type SovereigntyAssertionReport,
  type SovereigntyViolation,
  type SovereigntyViolationCode,
} from './assertions'
export {
  sovereigntyWakeDedupeKey,
  orderSovereigntyWakes,
  validateSovereigntyWake,
  wakeRefusalReason,
  type SovereigntyWakeContext,
  type SovereigntyWakeValidationOutcome,
} from './wake'
export type { SovereigntyPayload, SovereigntyPorts } from './ports'
export {
  SovereigntyRuntime,
  type SovereigntyOutcome,
  type SovereigntyRuntimeOptions,
  type SovereigntySnapshot,
  type SovereigntyStatus,
  type SovereigntyWakeOutcome,
} from './runtime'
export {
  SOVEREIGNTY_SCHEMA_VERSION,
  NO_REAL_MONEY,
  PROJECTED_SOVEREIGNTY_ACTION_KINDS,
  PROJECTED_SOVEREIGNTY_KIND_ORDER,
  projectSovereigntyState,
  type SovereigntyCountersView,
  type SovereigntyOfflineSessionView,
  type SovereigntyPortableDataView,
  type SovereigntyProjection,
  type SovereigntyProjectionInput,
  type SovereigntyProviderView,
  type SovereigntyRedTeamView,
  type SovereigntyRoutingView,
  type SovereigntySummaryView,
} from './projection'
