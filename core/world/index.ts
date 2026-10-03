/**
 * THE SELF & WORLD MODEL — Phase 22's public surface inside Core.
 *
 * Re-exported so `core/index.ts` and a test need one import, and so the file
 * layout of this domain is discoverable from its entry point.
 *
 * Nothing here is a renderer surface. The renderer-facing views live in
 * `core/protocol/world.ts`, and they are read-only by construction.
 */

export {
  DEFERRED_WORLD_ENTITY_KINDS,
  NAMED_WORLD_ENTITY_KINDS,
  REFERENCE_WORLD_ENTITY_KINDS,
  WORLD_ADMISSION_CHANNELS,
  WORLD_CLAIM_KINDS,
  WORLD_EDGE_ORIGINS,
  WORLD_ENTITY_KINDS,
  WORLD_EVIDENCE_KINDS,
  WORLD_FRESHNESS,
  WORLD_LIMITS,
  WORLD_OWNER_ENTITY_ID,
  WORLD_REFUSAL_CODES,
  WORLD_REFUSAL_REASONS,
  WORLD_RELATION_SPECS,
  WORLD_RELATION_TYPES,
  WORLD_SCHEMA_VERSION,
  WORLD_SELF_ENTITY_ID,
  WORLD_SELF_ENTITY_NAME,
  isAnyWorldEntityKind,
  isDeferredWorldEntityKind,
  isNamedWorldEntityKind,
  isReferenceWorldEntityKind,
  isWorldAdmissionChannel,
  isWorldEntityKind,
  isWorldEvidenceKind,
  isWorldFreshness,
  isWorldRelationType,
  worldClaimKindFor,
  worldLimits,
  worldRelationSpec,
  type AnyWorldEntityKind,
  type NamedWorldEntityKind,
  type ReferenceWorldEntityKind,
  type WorldAdmissionChannel,
  type WorldClaimKind,
  type WorldEdgeOrigin,
  type WorldEndpointClaim,
  type WorldEntityClaim,
  type WorldEntityKind,
  type WorldEvidenceKind,
  type WorldEvidenceRecord,
  type WorldEvidenceRequest,
  type WorldFreshness,
  type WorldLimits,
  type WorldReferenceDomain,
  type WorldRefusalCode,
  type WorldRelationClaim,
  type WorldRelationType,
  type WorldRelationSpec,
} from './types'

export {
  WORLD_CRYPTO_DOMAIN,
  deriveEdgeId,
  deriveEntityId,
  deriveReferenceId,
  domainEdgeId,
  evidenceEdgeId,
  evidenceIdCounter,
  isReservedWorldName,
  isWorldEdgeId,
  isWorldEntityId,
  isWorldEvidenceId,
  looksLikeCapability,
  nextEvidenceId,
  normaliseWorldName,
} from './identity'

export {
  buildEvidenceRecord,
  rejectForbiddenWorldKeys,
  worldRefusal,
  WORLD_FORBIDDEN_REQUEST_KEYS,
  type WorldAdmissionContext,
  type WorldEvidenceResult,
  type WorldRefusal,
} from './evidence'

export {
  edgeFreshness,
  findWorldConflicts,
  isValidWorldInstant,
  isWorldProjectionVisible,
  nodeFreshness,
  type WorldConflict,
} from './relations'

export { foldWorld, type WorldFoldResult } from './fold'

export {
  emptyWorldState,
  orderedWorldEdges,
  orderedWorldNodes,
  orderedWorldRecords,
  singletonNodes,
  type WorldAttributeKey,
  type WorldEdge,
  type WorldEntityNode,
  type WorldReferenceRecord,
  type WorldReferenceState,
  type WorldState,
} from './state'

export {
  buildWorldSelfModel,
  emptyWorldSelfSource,
  type WorldBelief,
  type WorldCapabilityDescriptor,
  type WorldIdentityDescriptor,
  type WorldLimitationDescriptor,
  type WorldModelDescriptor,
  type WorldSelfCompartment,
  type WorldSelfModel,
  type WorldSelfSource,
  type WorldSkillDescriptor,
  type WorldUncertainty,
  type WorldWorkerClaimDescriptor,
} from './self'

export {
  projectConflict,
  projectWorldEdge,
  projectWorldEntityDetail,
  projectWorldEntityList,
  projectWorldGraph,
  projectWorldNode,
  projectWorldSelf,
  projectWorldSummary,
  type WorldEntityListOptions,
  type WorldGraphOptions,
} from './projection'

export {
  WorldEngine,
  type WorldAdmissionOutcome,
  type WorldAdmissionRequest,
  type WorldEngineOptions,
  type WorldOpenOutcome,
} from './engine'

/**
 * Persistence: the *port*, the codec and the explicitly ephemeral store.
 *
 * The durable implementation is not here and is not reachable from this domain. It
 * lives in `core/vault/repositories/world-store.ts` and implements the port below on
 * the one canonical encrypted database, which keeps the dependency one-directional:
 * the Vault knows about the world's contract, and the world knows nothing about the
 * Vault. There is no bespoke encrypted world file, no second database, no plaintext
 * fallback and no dual write.
 */
export {
  WORLD_SNAPSHOT_VERSION,
  type WorldPersistenceHealth,
  type WorldPersistencePort,
  type WorldSnapshot,
  type WorldSnapshotLoad,
} from './persistence/port'
export { EphemeralWorldStore, NO_WORLD_KEY_REASON } from './persistence/ephemeral-store'
export { WorldPersistenceError, isWorldPersistenceError } from './persistence/errors'
export {
  MAX_WORLD_RECORD_BYTES,
  MAX_WORLD_SNAPSHOT_BYTES,
  decodeWorldEvidenceRecord,
  decodeWorldSnapshot,
  encodeWorldSnapshot,
} from './persistence/snapshot'