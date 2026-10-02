/**
 * The Personality & Relationship domain (Phase 11 Slice A).
 *
 * Everything here is pure: closed vocabularies, bounded tables, frozen
 * identity/temperament data, exact-key admission for relationship records,
 * deterministic interpretation, catalogue-only expression planning, metadata
 * cue ledger, offline evaluation, and — the seam outward — the projection that
 * turns those domain values into the read-only vocabulary a window may hold.
 * No I/O, no clock reads, no randomness, no model. Host wiring (Mind splicing,
 * persistence) is a later slice and enters through these functions, never
 * around them.
 */

export * from './types'
export {
  FREYA_TEMPERAMENT,
  IDENTITY_CUES,
  identityCueText,
  identityCueLines,
  temperamentCueIds,
  levelFor,
} from './temperament'
export {
  RELATIONSHIP_INPUT_KEYS,
  RELATIONSHIP_ITEM_KEYS,
  createRelationshipCandidate,
  admitRelationshipItem,
  rejectRelationshipItem,
  retireRelationshipItem,
  supersedeRelationshipItem,
  eligibleCueCandidates,
  relationshipConfidenceCeiling,
  type RelationshipResult,
} from './relationship'
export {
  readOwnerDirectives,
  ownerDirectiveKeys,
  ownerDirectiveCueKind,
  isKnownOwnerDirectiveKey,
  outboundRelationshipKey,
  PRIVATE_SHORTHAND_KEY,
  type OwnerDirectiveOutcome,
  type OwnerDirectiveMatch,
  type OwnerWithdrawalMatch,
} from './directives'
export {
  SOCIAL_WINDOWS,
  INTERACTION_FACT_KEYS,
  validateInteractionFact,
  interpretSocialContext,
  type InteractionFactResult,
  type SocialInterpretationInput,
} from './interpretation'
export {
  PLAN_PRECEDENCE_SENTENCE,
  EXPRESSION_BLOCK_MARKER,
  buildExpressionPlan,
  serializeExpressionPlan,
  expressionBlock,
  type ExpressionPlanInput,
} from './expression'
export {
  REPETITION_BOUNDS,
  DEFAULT_REPETITION_POLICY,
  normalizeRepetitionPolicy,
  cueHash,
  emptyCueLedger,
  restoreCueLedger,
  recordCueUse,
  isCueEligible,
  selectCues,
  type RepetitionPolicy,
  type CueSelection,
} from './repetition'
export {
  FORBIDDEN_FIELD_NAMES,
  FORBIDDEN_MENTAL_STATE_NAMES,
  findForbiddenFieldNames,
  runPersonalityEval,
  type PersonalityEvalCheck,
  type PersonalityEvalReport,
} from './evaluate'
export { projectPersonality, UNKNOWN_PERSISTENCE_REASON, type PersonalityProjectionInput } from './projection'
export {
  PersonalityIntegration,
  type PersonalityIntegrationOptions,
  type PersonalityLifecycleEvent,
  type PersonalityPersistenceSeam,
  type PersonalityRetentionReport,
} from './integration'
