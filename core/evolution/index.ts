/**
 * THE COGNITIVE EVOLUTION DOMAIN — Phase 38.
 *
 * Everything here is pure except the store in `core/vault/repositories`, which is the only module
 * in this phase that touches a database. The domain itself does no I/O, reads no clock, uses no
 * randomness and calls no model — `now` is always an explicit argument to every constructor and
 * every decision, which is what makes the lifecycle and the gate conjunction testable.
 *
 * ## The pipeline
 *
 * ```
 *   Wake → Evidence → Improvement → DriftCheck → Gate → Apply → Verify
 * ```
 *
 * ## The contracts
 *
 * 1. **Nothing is applied by anything here.** An improvement is a description of a change. It
 *    does not execute, does not apply, does not merge. The `applied` state means "the owner has
 *    applied it outside this subsystem".
 * 2. **A change starts proposed.** `state` is a constant assigned inside the constructor and is
 *    absent from the input keys, so no call shape produces an improvement arriving `staged` or
 *    `applied`.
 * 3. **Rollback is a first-class state.** `applied → failed` is the only edge out of `applied`,
 *    because a landed change that cannot be undone is a change that happened.
 * 4. **No authority widening, ever.** The drift detector compares the proposed envelope against
 *    the current one and refuses any widening.
 * 5. **No self-modification.** Trusted runtime code is never self-modified. A self-modification
 *    attempt is refused and journaled.
 * 6. **No hidden inference.** No model call without a wake. No continuous polling. No background
 *    reasoning. No unrestricted loops.
 */

export * from './types'
export {
  EVIDENCE_INPUT_KEYS,
  EVIDENCE_KEYS,
  EVIDENCE_RETENTION,
  EVIDENCE_SOURCE_CEILING,
  createEvidenceRecord,
  isEvidenceSufficient,
  verifyEvidence,
  type EvidenceVerification,
} from './evidence'
export {
  IMPROVEMENT_INPUT_KEYS,
  IMPROVEMENT_KEYS,
  advanceImprovement,
  applyImprovement,
  createImprovementRecord,
  improvementProgress,
  rollBackImprovement,
} from './improvement'
export {
  createDriftCheckRecord,
  detectAuthorityDrift,
  isProtectedInvariantViolation,
  isSelfModificationAttempt,
} from './drift'
export {
  EVOLUTION_GATE_CHECKS,
  EVOLUTION_GATE_ALLOWED_REASON,
  EVOLUTION_GUARD_CAPABILITY,
  blockerForRefusal,
  evaluateEvolutionGate,
  type EvolutionAuthorityFacts,
  type EvolutionGateOutcome,
} from './authority'
export {
  EVOLUTION_SIGNALS,
  canTransitionEvolution,
  isTerminalEvolutionState,
  transition,
  type EvolutionSignal,
  type EvolutionTransitionResult,
} from './machine'
export {
  FOLD_CONTEXT_CLOSED,
  initialEvolutionState,
  reduceEvolutionEntry,
  reduceEvolutionEntryOnly,
  reduceEvolutionState,
  type EvolutionFoldAnomaly,
  type EvolutionFoldContext,
  type EvolutionFoldResult,
  type EvolutionFoldedState,
  type EvolutionJournalEntry,
} from './state'
export {
  PASSING_ASSERTIONS,
  analyseEvolutionAssertions,
  type EvolutionAssertionInput,
  type EvolutionAssertionReport,
  type EvolutionAssertionViolation,
} from './assertions'
export {
  projectEvolution,
  type EvolutionEvidenceView,
  type EvolutionImprovementView,
  type EvolutionNextActionView,
  type EvolutionProjection,
  type EvolutionProjectionInput,
} from './projection'
export {
  defaultEvolutionLimits,
  narrowEvolutionLimits,
  narrowedLimitNames,
} from './limits'
export {
  classifyEvolutionClaim,
  forbiddenKeysIn,
  NO_REAL_MONEY_STATEMENT,
  REFUSAL_REASONS,
} from './prohibition'
export {
  EVOLUTION_WAKE_REFUSAL_REASONS,
  evolutionWakeDedupeKey,
  orderEvolutionWakes,
  validateEvolutionWake,
  wakeRefusalReason,
  type EvolutionWakeContext,
  type EvolutionWakeValidationOutcome,
} from './wake'
export {
  EvolutionRuntime,
  type EvolutionRuntimeOptions,
  type EvolutionSnapshot,
  type EvolutionStatus,
  type EvolutionWakeOutcome,
  type EvolutionOutcome,
} from './runtime'
export * from './strategy'
export * from './store'
