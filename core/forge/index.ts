/**
 * THE FORGE DOMAIN — Phase 48.
 *
 * Freya's Skills and Forge activation, in one directory. Everything here is pure
 * or narrowly ported, with exactly two impure edges — the journal and the body
 * store — and both of them are injected.
 *
 * ## The architecture, in one paragraph
 *
 * A **package** is a versioned, hashed, immutable manifest whose program is a
 * straight-line list of pure operations from a closed table. Generation produces a
 * `candidate` with **zero authority**; a fixed pipeline
 * (`manifest → dependencies → integrity → security → tests → capabilities →
 * approval`) decides what is `verified`; `install` writes metadata and *never*
 * enables; `enable` is a separate explicit act that needs an approval where the
 * package declares authority or came from outside; and `run` executes the program
 * in an interpreter with input, output, operation, deadline and cancellation
 * bounds and a deterministic result envelope.
 *
 * ## Why the runtime is not a code sandbox
 *
 * Because this architecture cannot provide one, and saying so is the only honest
 * option. `node:vm` is documented as not a security mechanism; worker threads and
 * subprocesses share the host filesystem, environment and keyring. So the
 * executable surface is a **declarative interpreter** rather than JavaScript:
 * no shell, no filesystem, no keyring or Vault, no environment secrets, no network,
 * and no evaluator to escape from. The cost — a Forge package cannot be an
 * arbitrary plugin — is projected on every read as `runtimeNotice` and written down
 * in `docs/PHASE-48.md`.
 *
 * ## What this domain cannot do
 *
 * It cannot grant a capability: installation and enablement take no capability
 * field, the declared list is a declaration, and every run re-checks it against
 * what the acting principal already holds. It cannot skip a stage: no stage reads
 * an assertion, so `verified: true` in a payload is not a thing that exists. It
 * cannot write to protected Core: there is no path from a manifest to a filesystem
 * write, and `scanForgeCandidate` refuses a candidate that names one. And it cannot
 * enable anything on restart — `open()` adopts bodies, marks interrupted runs and
 * does nothing else.
 */

export {
  DENIED_ACCESS,
  FORGE_ACCESS_FIELDS,
  FORGE_ACCESS_LEVELS,
  FORGE_APPROVAL_STATES,
  FORGE_FIELD_TYPES,
  FORGE_FORBIDDEN_CAPABILITIES,
  FORGE_KIND_FORBIDDEN_OPS,
  FORGE_LIMITS,
  FORGE_NON_RUNNABLE_STATUSES,
  FORGE_OPS,
  FORGE_ORIGINS,
  FORGE_REFUSAL_CODES,
  FORGE_RUNTIME_KINDS,
  FORGE_RUN_FAILURE_CODES,
  FORGE_RUN_STATES,
  FORGE_SECURITY_FINDINGS,
  FORGE_SIGNATURE_STATES,
  FORGE_STATUSES,
  FORGE_TRANSITIONS,
  FORGE_VALIDATION_STAGES,
  canTransitionForge,
  canonicalForgeJson,
  canonicalForgeManifest,
  forgePackageId,
  isForgeAccessLevel,
  isForgeFieldType,
  isForgeOp,
  isForgeOrigin,
  isForgeRefusalCode,
  isForgePackageDefect,
  isForgeRuntimeKind,
  isForgeStatus,
  isForbiddenForgeCapability,
  normaliseForgeName,
  sanitiseForgeText,
} from './types'
export { FORGE_PACKAGE_DEFECT_CODES } from './types'
export type {
  ForgeAccessDeclaration,
  ForgeAccessField,
  ForgeAccessLevel,
  ForgeAggregate,
  ForgeApproval,
  ForgeApprovalState,
  ForgeDependency,
  ForgeFieldSpec,
  ForgeFieldType,
  ForgeManifest,
  ForgeOrigin,
  ForgeOp,
  ForgePredicate,
  ForgeProgram,
  ForgeProvenance,
  ForgeRefusalCode,
  ForgeRunFailureCode,
  ForgeRunMetrics,
  ForgeRunRecord,
  ForgeRunState,
  ForgeRuntimeKind,
  ForgeScalar,
  ForgeSchema,
  ForgeSecurityFinding,
  ForgeSignatureState,
  ForgeStageResult,
  ForgeStageVerdict,
  ForgeStatus,
  ForgeStep,
  ForgeStringTransform,
  ForgeTestResult,
  ForgeValidationReport,
  ForgeValidationStage,
  ForgeValue,
  ForgeView,
} from './types'

export {
  FORGE_STEP_FNS,
  FORGE_STEP_LIST_OPS,
  forgeIntegrityHash,
  manifestPackageId,
  parseForgeManifest,
} from './manifest'
export type { ForgeStep as ForgeProgramStep } from './types'

export {
  interpretForgeProgram,
  validateForgeInput,
  validateForgeOutput,
  validateForgeProgram,
} from './program'
export type { ForgeExecutionInput, ForgeExecutionOutcome } from './program'

export { scanForgeCandidate } from './security'
export type { ForgeScanFinding, ForgeScanResult } from './security'

export {
  runForgePipeline,
} from './pipeline'
export type { ForgeInstalledSummary, ForgePipelineInput, ForgeValidationEnvironment } from './pipeline'

export { detectForgeTamper, planInstall, planRollback } from './versions'
export type { ForgeVersionSummary, RollbackPlan, VersionPlan } from './versions'

export { discoverForgePackages } from './discovery'
export type { ForgeSearchHit, ForgeSearchQuery, ForgeSearchRecord, ForgeSearchReport } from './discovery'

export {
  findForgePackage,
  findForgePackageByName,
  findForgeVersion,
  initialForgeState,
  isForgeEvent,
  reduceForgeState,
  summariseForgeCounts,
  versionSummaryOf,
} from './state'
export type { ForgeRecord, ForgeRunSummary, ForgeState, ForgeVersionState } from './state'

export { forgeDetailView, projectForge, stageViews } from './projection'
export type { ForgeProjectionInput } from './projection'

export {
  ClosedForgeCapabilityPort,
  ForgeEngine,
} from './engine'
export type {
  ForgeBodyStore,
  ForgeCapabilityPort,
  ForgeEngineOptions,
  ForgeGenerateRequest,
  ForgeImportEnvelope,
  ForgeOwnerScope,
  ForgeRunRequest,
  ForgeSearchOutcome,
  ForgeStoredPackage,
} from './engine'

export {
  FORGE_SCHEMA_VERSION,
  FORGE_RUNTIME_NOTICE,
} from '../protocol/forge'
