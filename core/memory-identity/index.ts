/**
 * THE UNIFIED MEMORY / IDENTITY SUBSYSTEM — BARREL.
 *
 * Everything an integration needs, and nothing it does not. In particular this
 * barrel does **not** re-export the Brain, the persistence ports, or any store: an
 * integration is handed a `MemoryIdentity` and the narrow seams in `types.ts`, and
 * learns nothing about how any of it is stored. That is the same discipline the
 * context and personality ports keep, and it is what stops this directory from
 * becoming a second place that knows how memory is kept.
 */

export { MemoryIdentity, type MemoryIdentityOptions } from './subsystem'

export {
  compilePromptBlock,
  provenanceLine,
  runOwnerRequest,
  view,
} from './ownership'

export {
  overallReadiness,
  readinessOf,
} from './readiness'

export {
  MEMORY_BUNDLE_KIND,
  MEMORY_BUNDLE_VERSION,
  deriveBundleKey,
  exportMemoryBundle,
  importMemoryBundle,
  type MemoryBundleBody,
  type MemoryBundleEnvelope,
  type MemoryBundleKdf,
  type MemoryBundleMemory,
  type MemoryBundleOwnership,
  type MemoryExportManifest,
  type MemoryExportResult,
  type MemoryImportReport,
  type MemoryImportResult,
} from './portability'

export {
  IMPORT_CONFIDENCE_CEILING,
  IMPORT_EPICEMIC_CEILING,
  IMPORT_SOURCE,
  downgradeImported,
  findAuthorityClaim,
  findAuthorityKey,
  findIdentityKey,
  findSecretShapeIn,
  type AuthorityFinding,
  type Downgrade,
} from './policy'

export {
  MEMORY_IDENTITY_DOMAINS,
  MEMORY_IDENTITY_LIMITS,
  MEMORY_IDENTITY_REFUSAL_CODES,
  MEMORY_IDENTITY_REFUSAL_REASONS,
  MEMORY_IDENTITY_SCHEMA_VERSION,
  OWNER_CHANNEL,
  OWNER_MEMORY_ACTIONS,
  isRefusalCode,
  refuse,
  type DomainDurabilityPort,
  type DomainReadiness,
  type MemoryIdentityDomain,
  type MemoryIdentityDomainPorts,
  type MemoryIdentityMemoryView,
  type MemoryIdentityProjection,
  type MemoryIdentityRefusal,
  type MemoryIdentityRefusalCode,
  type OwnerChannel,
  type OwnerMemoryAction,
  type OwnerMemoryRequest,
  type OwnerMemoryResult,
  type PromptInjection,
  type PromptInjectionItem,
  type PromptInjectionRequest,
} from './types'
