/**
 * RELATIONSHIP INTELLIGENCE II (Phase 27).
 *
 * Everything here is pure except the two stores in `core/vault/repositories`, which are
 * the only modules in this phase that touch a database. The domain itself does no I/O,
 * reads no clock, uses no randomness and calls no model — `observedAt` is always an
 * explicit argument, which is what makes the anti-dependence guarantee testable.
 *
 * ## The one-sentence contract
 *
 * Freya's understanding of this relationship can deepen with time and can never deepen
 * into a claim about closeness, obligation, guilt or Freya's own feelings. The
 * mechanisms are in `safeguards.ts`; the load-bearing one is that
 * `RELATIONAL_CLAIM_RANKS` has three rungs, the top of which is `recorded-history`,
 * and no rung named for any of those things exists to promote into.
 */

export * from './types'
export {
  createRelationshipLedgerEntry,
  rebuildRelationshipEntry,
  admitRelationshipEntry,
  rejectRelationshipEntry,
  supersedeRelationshipEntry,
  retractRelationshipEntry,
  expireRelationshipEntry,
  ENTRY_INPUT_KEYS,
  ENTRY_KEYS,
  type RelationshipEntryResult,
} from './ledger'
export {
  applyStatedBoundary,
  allClaimCeilings,
  absencePolicy,
  boundaryRankFromKey,
  ceilingAfterBoundaries,
  findDependenceMarkers,
  findIntimacyField,
  isDependenceSafeText,
  isRelationshipClaim,
  relationshipClaimCeiling,
  TOP_RELATIONAL_CLAIM_RANK,
  type BoundaryApplication,
} from './safeguards'
export {
  RELATIONSHIP_DERIVATION_SCHEMA_VERSION,
  admittedEntries,
  conflictedKeys,
  deriveContactRhythm,
  deriveFamiliarity,
  deriveRelationship,
  emptyRelationshipDerivation,
} from './familiarity'
export {
  RELATIONSHIP_RECORD_VERSION,
  applyEntry,
  emptyRelationshipState,
  validateRecord,
  type RelationshipRecord,
} from './fold'
export {
  RelationshipStoreError,
  type RelationshipFaultCode,
  type RelationshipHealth,
  type RelationshipPersistenceMode,
  type RelationshipStore,
} from './store'
export {
  projectRelationship,
  projectRelationshipEntries,
  projectRelationshipEntryDetail,
  projectEntry,
  type RelationshipProjectionInput,
} from './projection'
export {
  RelationshipEngine,
  type RelationshipEngineOptions,
  type RelationshipStatementInput,
} from './engine'
