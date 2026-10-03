/**
 * The Unified Conscious Context.
 *
 * A barrel, like every other domain's, so that Core and the tests reach for one
 * module path rather than the files inside it.
 *
 * ## What this directory does **not** have is the interesting part
 *
 * No store, no engine, no state slice, no events, no command, no cache and no
 * table. Nothing here writes anything, anywhere, ever. The snapshot is a pure
 * function of projections other subsystems already own, which is what lets it be
 * *the same mind* rather than a twelfth opinion about it — and which is why it
 * cannot go stale relative to the state it claims to describe, because it holds no
 * state of its own to go stale.
 *
 * ## What is here
 *
 * - `projection.ts` — the derivation. Pure, deterministic, bounded.
 * - `types.ts` — the ceilings, the closed source set, and the total orders.
 * - `ports.ts` — the narrow input contracts for the domains `PLAN.md` §6 requires
 *   but which have not landed (Phase 21 Life, Phase 22 Self/World).
 * - `adapters/` — today's producers for those ports.
 *
 * ## The dependency note, in one line
 *
 * This is integration-ready preparation, not a finished Phase 20. It is rebased
 * onto merged Phase 21 and Phase 22 before anyone calls it final; until then it
 * reports `life` as a stated absence rather than inventing one. See
 * `docs/PHASE-20.md`.
 */

export {
  projectConsciousContext,
  consciousContextLimits,
  ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
  NO_CONSCIOUS_CONTEXT_REASON,
} from './projection'
export type { ConsciousInput } from './projection'
export {
  CONSCIOUS_CONTEXT_LIMITS,
  CONSCIOUS_SOURCES,
  FRESHNESS_RANK,
  weakestFreshness,
  weakestOf,
  sectionStateFor,
  byInstant,
  byInstantThenId,
  newestFirstByInstant,
  newestOf,
} from './types'
export type { ConsciousSourceDomain } from './types'
export {
  CONSCIOUS_PORT_AUTHORITIES,
  narrowSelfCapabilityState,
} from './ports'
export type {
  ConsciousContinuityItemReading,
  ConsciousContinuityReading,
  ConsciousLifeEntryReading,
  ConsciousLifeReading,
  ConsciousPortAuthority,
  ConsciousPortReadings,
  ConsciousPortTrust,
  ConsciousSelfCapabilityReading,
  ConsciousSelfCapabilityState,
  ConsciousSelfReading,
  ConsciousWorldConflictReading,
  ConsciousWorldReading,
} from './ports'
export {
  continuityFromBrain,
  selfFromBrain,
  worldFromBrain,
} from './adapters/brain'
export {
  CONSCIOUS_CONTEXT_SCHEMA_VERSION,
  CONSCIOUS_UNCERTAINTY_CODES,
} from '../protocol/consciousness'
export type {
  ConsciousActionScope,
  ConsciousAgentView,
  ConsciousAgentsView,
  ConsciousApprovalView,
  ConsciousAttentionDecisionView,
  ConsciousAttentionView,
  ConsciousBasis,
  ConsciousChangeView,
  ConsciousContextProjection,
  ConsciousContinuityItemView,
  ConsciousContinuityView,
  ConsciousFreshness,
  ConsciousInboxItemView,
  ConsciousLifeEntryView,
  ConsciousLifeView,
  ConsciousLimitsView,
  ConsciousNextActionView,
  ConsciousNextActionsView,
  ConsciousPostureView,
  ConsciousPracticeView,
  ConsciousSectionMeta,
  ConsciousSectionState,
  ConsciousSelfView,
  ConsciousSkillView,
  ConsciousSourceAttribution,
  ConsciousStopAllView,
  ConsciousUncertaintiesView,
  ConsciousUncertaintyCode,
  ConsciousUncertaintyItemView,
  ConsciousWaitingView,
  ConsciousWorldView,
} from '../protocol/consciousness'
