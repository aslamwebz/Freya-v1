/**
 * THE LEARNING DOMAIN — Phase 28.
 *
 * Everything here is pure except the two stores in `core/vault/repositories`, which are the
 * only modules in this phase that touch a database. The domain itself does no I/O, reads
 * no clock, uses no randomness and calls no model — `now` is always an explicit argument,
 * which is what makes the support arithmetic testable.
 *
 * ## The pipeline
 *
 * ```
 *   VerifiedOutcome  →  LearningExperience  →  KnowledgeRecord  →  ProcedureProposal
 * ```
 *
 * The ladder **narrows** as it climbs. A check passed is a fact (`observed`, `medium`). What
 * it establishes is a bounded lesson. What that suggests is a claim — and a claim
 * generalises beyond the checks behind it, so it is capped at `medium` for every source
 * class and is never `verified`. The proposal at the end is inert data with three fields
 * stating its own inertness.
 *
 * ## The one-sentence contract
 *
 * Learning is evidence, not authority. Nothing in this module grants a capability, a
 * permission or an activation; a procedure proposal is a sketch for `core/skills`, which
 * admits it as a `candidate` and applies its own gates. See `safeguards.ts`.
 */

export * from './types'
export {
  createVerifiedOutcome,
  rebuildVerifiedOutcome,
  sourceOfOutcome,
  OUTCOME_INPUT_KEYS,
  OUTCOME_KEYS,
  OUTCOME_SOURCE_BY_DOMAIN,
  type OutcomeResult,
} from './outcome'
export {
  admitKnowledgeRecord,
  admitLearningExperience,
  checkScopeLimits,
  createKnowledgeRecord,
  createLearningExperience,
  expireKnowledgeRecord,
  expireLearningExperience,
  rejectKnowledgeRecord,
  rejectLearningExperience,
  retractKnowledgeRecord,
  retractLearningExperience,
  outcomeIsCurrent,
  supersedeKnowledgeRecord,
  supersedeLearningExperience,
  wholeDays,
  EXPERIENCE_INPUT_KEYS,
  EXPERIENCE_KEYS,
  KNOWLEDGE_INPUT_KEYS,
  KNOWLEDGE_KEYS,
  type LearningResult,
} from './experience'
export {
  rebuildKnowledgeRecord,
  rebuildLearningExperience,
} from './rebuild'
export {
  LEARNING_RECORD_VERSION,
  applyRecord,
  emptyLearningState,
  recordKey,
  validateRecord,
  type LearningRecord,
} from './fold'
export {
  LEARNING_DERIVATION_SCHEMA_VERSION,
  admittedExperiences,
  admittedKnowledge,
  conflictedClaims,
  decideSupport,
  deriveLearning,
  deriveProposals,
  emptyLearningDerivation,
  lowestConfidence,
  strongestScope,
} from './derive'
export {
  LEARNING_GRANTS_NOTHING,
  PROPOSAL_SOURCES,
  admitToSkills,
  assertProposalIsInert,
  isAdmissibleProposalName,
  isProposalSource,
  type SkillAdmissionPacket,
} from './safeguards'
export {
  LearningStoreError,
  type LearningFaultCode,
  type LearningHealth,
  type LearningPersistenceMode,
  type LearningStore,
  type LearningWrite,
} from './store'
export {
  exportLearning,
  projectLearning,
  projectLearningClaim,
  projectLearningRecords,
  type LearningProjectionInput,
} from './projection'
export {
  LearningEngine,
  type ExperienceInput,
  type KnowledgeInput,
  type LearningEngineOptions,
  type VerifiedOutcomeInput,
} from './engine'