/**
 * The Skill domain (Phase 17).
 *
 * Everything here is pure or narrowly ported: closed vocabularies, deterministic
 * identity and content hashing, an admission door that refuses rather than repairs, a
 * deterministic outcome evaluator that cannot be moved by model text, a code-owned
 * promotion table, a deterministic ranking, a bounded improvement lane with a closed
 * protected-domain list, an execution seam that only ever plans inside an authorised
 * Mission/Run/Step, a journal-derived fold, and the projection that turns those values
 * into the read-only vocabulary a window may hold.
 *
 * The engine is the only impure piece, and it is impure in exactly two ways: it
 * appends to the injected journal, and it commits bodies to the injected persistence
 * runtime. It cannot reach a provider, mint a capability, clear a stop, widen a
 * permission, or touch Freya's source — none of those exists on any type it holds, and
 * no module under `core/skills/` imports a gateway, an authority object or `node:fs`
 * outside `persistence/`.
 */

export * from './types'
export {
  SKILL_CRYPTO_DOMAIN,
  deriveSkillId,
  skillContentHash,
} from './identity'
export {
  OWNER_SUBMITTABLE_EVIDENCE_KINDS,
  deterministicInput,
  evaluateOutcome,
  type SkillDeterministicInput,
  tallyEvidence,
  type EvaluationTally,
} from './evaluation'
export {
  PROMOTION_REASONS,
  SKILL_PROMOTION_THRESHOLDS,
  currentVersionEvaluations,
  decidePromotion,
  deriveVerificationState,
  isEvidenceCurrent,
  summariseEvidence,
  type PromotionDecision,
  type PromotionEvidenceSummary,
  type PromotionReason,
} from './promotion'
export {
  selectSkills,
  type SkillSelection,
  type SkillSelectionCandidate,
  type SkillSelectionRequest,
} from './selection'
export {
  InertSkillArtifactSink,
  assertMutableTarget,
  normaliseArtifactRef,
  planRevision,
  promoteIntoRuntime,
  wouldRaiseTrustClass,
  type RevisionPlan,
  type RevisionRequest,
  type SkillArtifactCandidate,
  type SkillArtifactDecision,
  type SkillArtifactSink,
  type TargetVerdict,
} from './improvement'
export {
  ClosedSkillExecutionPort,
  planSkillExecution,
  type PlanSkillExecutionInput,
  type PlannedSkillStep,
  type SkillExecutionOutcome,
  type SkillExecutionPort,
  type SkillExecutionRequest,
  type SkillRunPlan,
} from './execution'
export {
  admitSkill,
  parseEvaluationRequest,
  type AdmissionOutcome,
  type AdmissionRecord,
  type AdmissionRequest,
  type EvaluationParseOutcome,
  type EvaluationRequest,
  type ParsedEvaluation,
} from './admission'
export {
  executableSkills,
  findSkill,
  findSkillByName,
  initialSkillState,
  reduceSkillState,
  summariseSkillCounts,
  targetIsProtected,
  type SkillCounts,
  type SkillFoldRecord,
  type SkillProposalRecord,
  type SkillState,
  type SkillVersionMetadata,
} from './state'
export {
  ABSENT_SKILL_PROJECTION,
  NO_SKILL_DOMAIN_REASON,
  projectSkills,
  skillDetailView,
  type SkillProjectionInput,
} from './projection'
export {
  SkillEngine,
  type SkillEngineOptions,
  type SkillOwnerScope,
} from './engine'
export {
  SKILL_SNAPSHOT_VERSION,
  type SkillPersistenceHealth,
  type SkillPersistencePort,
  type SkillSnapshot,
  type SkillSnapshotLoad,
} from './persistence/port'
export {
  SKILL_PERSISTENCE_ERROR_CODES,
  SkillPersistenceError,
  isSkillPersistenceError,
  type SkillPersistenceErrorCode,
} from './persistence/errors'
export {
  EncryptedSkillStore,
  SKILL_CRYPTO_DOMAIN as SKILL_STORE_CRYPTO_DOMAIN,
  skillRecordAad,
  skillStoreBinding,
} from './persistence/encrypted-store'
export { EphemeralSkillStore } from './persistence/ephemeral-store'
export { openSkillPersistence } from './persistence/open'
export {
  decodeSkillRecord,
  decodeSkillSnapshot,
  encodeSkillSnapshot,
  emptySkillSnapshot,
} from './persistence/snapshot'