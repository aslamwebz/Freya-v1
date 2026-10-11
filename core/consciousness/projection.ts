/**
 * THE CONSCIOUS CONTEXT PROJECTION — Core's one coherent account of itself.
 *
 * A pure function over projections Core has already built. It stores nothing,
 * journals nothing, subscribes to nothing and calls no model. Everything it says
 * is a function of state another subsystem owns, which is the only way a twelfth
 * view of the same situation can be guaranteed to agree with the other eleven.
 *
 * ## The one rule that shapes the whole file
 *
 * **A field exists here only if it is safe to hand to anything that can see a
 * window.** There is no second channel, no owner-only variant and no "but this
 * one is fine because" — so the test for every field is whether a private copy
 * of it could leak into a screenshot, a log line, or a future surface that
 * renders the whole object.
 *
 * That is why ids appear where a person would want a title, why a measurement
 * (`subjectLength`, `textLength`, `summaryLength`) appears where a person would
 * want the words, and why `CoreActivityEvent.text` is dropped even though it is
 * Core-authored and already crosses elsewhere. A weaker rule — "don't cross
 * *private* content" — would have kept all three, and would have left an
 * invariant that can only be checked case by case. This one can be checked by
 * reading the type.
 *
 * ## Why every omission is listed here
 *
 * Because a reader who cannot see what was deliberately left out will assume it
 * was an oversight and add it back. The full list:
 *
 * - memory `content` and memory `subject` → `subjectLength`
 * - Mission `title`, `intent`, `successCriteria` → the Mission's id and status
 * - Context item `content`, `label`, `uri` → the scope's kind and id
 * - relationship item `text`, `tags`, `admissionReason` → counts by status
 * - Attention event `text` → `textLength`
 * - Workforce message `body` → counts, and `detailAvailable`
 * - Work approval `justification`, `proposal`, `reason` → capability and risk
 * - run and task `label`/`title` → the run's and task's id
 * - Relay `connectors`, `pendingApprovals`, `recentActions` → the row exists in
 *   `provenance`, and no content from it is read
 * - `CoreActivityEvent.text` → the closed `kind`, sequence, instant and tone
 * - Skill `summary` and every contract entry → `summaryLength` and counts
 * - any credential, connector payload, raw prompt, model request or response
 *
 * ## Determinism
 *
 * No clock read, no randomness, no module state. `now` is an argument, so the
 * same durable state and the same instant give the same snapshot — which is what
 * makes replay and restart reproduce it rather than merely resemble it.
 *
 * Every list is sorted by a key that cannot tie (`byInstantThenId`, or an
 * explicit rank), because a comparator that returns `0` for two distinct records
 * leaves the order to the sort implementation, and that is how two runs over one
 * journal end up disagreeing.
 *
 * ## STOP ALL
 *
 * `nextActions` is empty while STOP ALL is active, and says why. Those actions
 * are derivations of what Core's Mission and Workforce projections advertise, and
 * advertising an intention while the owner has said stop would be a snapshot
 * describing something Freya is not permitted to do. Reading stays available:
 * reading is not acting, and somebody asking "what does it know" during an
 * incident is exactly who needs the answer.
 *
 * ## Self, World, Continuity and Life arrive through ports
 *
 * This file does not import `BrainProjection` to build those sections, and it does
 * not import a Life projection either — neither Phase 22's Self/World nor Phase
 * 21's Life exists on this baseline. It reads four narrow readings declared in
 * `ports.ts`, so the producers can change without a derivation rule moving.
 *
 * The Brain is still read directly, for the one thing only it can answer: whether
 * the Brain itself is readable, which is a `provenance` fact rather than a
 * section. That keeps a single authority per fact — the world section and the
 * `memory.conflict` uncertainties both come from the `world` port, never from the
 * Brain and the port disagreeing with each other.
 */

import { buildFocus, buildPosture, buildSelf } from './projection/self-focus'
import { buildContinuity, buildLife, buildWorld } from './projection/world-life'
import { buildAttention, buildWaiting } from './projection/attention-work'
import { buildAgents, buildPractice } from './projection/agents-practice'
import { buildProvenance, readSources } from './projection/sources'
import { buildNextActions, buildRecentChanges, buildUncertainties } from './projection/continuity-evidence'
import type { CoreActivityEvent } from '../protocol/activity'
import type { AttentionProjection } from '../protocol/attention'
import type { BrainProjection } from '../brain/brain'
import type {
  ConsciousContextProjection,
  ConsciousLimitsView,
} from '../protocol/consciousness'
import type { ContextProjectionView } from '../protocol/context'
import type { CoreStatus } from '../../shared/contracts/projections/core'
import type { MissionProjection } from '../missions/types'
import type { OfficePresenceRequest, OfficeProjection } from '../office/types'
import type { PersonalityProjection } from '../protocol/personality'
import type { RelayProjection } from '../protocol/relay'
import type { SkillProjection } from '../protocol/skills'
import type { StopAllState } from '../state'
import type { WorkProjection } from '../work/projection'
import type { WorkforceProjection } from '../workforce/types'
import type {
  ConsciousContinuityReading,
  ConsciousLifeReading,
  ConsciousSelfReading,
  ConsciousWorldReading,
} from './ports'
import { CONSCIOUS_CONTEXT_LIMITS } from './types'
import { CONSCIOUS_CONTEXT_SCHEMA_VERSION } from '../protocol/consciousness'

/**
 * Everything the projection reads.
 *
 * Every member is nullable, and `null` is treated exactly like a projection
 * whose `health` is `'unavailable'`. That is not only for the Core that has not
 * started: it is what makes the degradation path testable without building a
 * Core out of eleven subsystems and taking one away.
 *
 * ## Why four of these are ports
 *
 * `self`, `world`, `continuity` and `life` are narrow readings rather than
 * subsystem projections, because `PLAN.md` §6 makes Phase 21 (Life) and Phase 22
 * (Self/World) required contributors and neither has landed. See `ports.ts` for
 * why a port is the right answer and what each producing phase must supply.
 *
 * `life` is `null` on this baseline and always will be until Phase 21 writes its
 * adapter. That is a stated absence, not an oversight, and it is the reason this
 * build's snapshots report `health: 'degraded'`.
 */
export interface ConsciousInput {
  readonly status: CoreStatus | null
  readonly stopAll: StopAllState
  /**
   * Read only for the Brain's own readability, which is a `provenance` fact.
   *
   * The self, world and continuity *sections* come from the ports below, so that
   * Phase 22 can take them over without this file changing.
   */
  readonly brain: BrainProjection | null
  readonly self: ConsciousSelfReading | null
  readonly world: ConsciousWorldReading | null
  readonly continuity: ConsciousContinuityReading | null
  readonly life: ConsciousLifeReading | null
  readonly work: WorkProjection | null
  readonly mission: MissionProjection | null
  readonly workforce: WorkforceProjection | null
  readonly skills: SkillProjection | null
  readonly personality: PersonalityProjection | null
  readonly attention: AttentionProjection | null
  readonly context: ContextProjectionView | null
  readonly office: OfficeProjection | null
  readonly relay: RelayProjection | null
  readonly activity: readonly CoreActivityEvent[]
  /** The Office's folded requests: the only presence state that is durable. */
  readonly presenceRequests: readonly OfficePresenceRequest[]
  /** Provider calls the journal says started and never settled. */
  readonly pendingRequests: readonly string[]
  readonly faults: readonly string[]
}






/* ------------------------------------------------------------ whole thing */

/** The ceilings published on the snapshot. */
export function consciousContextLimits(): ConsciousLimitsView {
  return { ...CONSCIOUS_CONTEXT_LIMITS }
}

/**
 * Build the snapshot.
 *
 * Pure: no clock read, no randomness, no module state. `now` is the only
 * temporal input, and it is the caller's, so replay and restart reproduce this
 * exactly rather than approximately.
 *
 * `health` is the weakest thing it found. `'ready'` means every contributing
 * source could be read; `'degraded'` means some could not and `reason` names
 * them; `'unavailable'` means there is nothing here at all — a Core that has not
 * started. A partially-known picture that reported itself complete is the one
 * failure this projection exists to prevent, so the health line is derived and
 * never asserted.
 */
export function projectConsciousContext(
  input: ConsciousInput,
  now: Date,
): ConsciousContextProjection {
  const readings = readSources(input)
  const { provenance, freshness } = buildProvenance(readings, now)

  const self = buildSelf(input.self)
  const posture = buildPosture(input.personality)
  const focus = buildFocus({ work: input.work, mission: input.mission, workforce: input.workforce, context: input.context }, input.attention)
  const attention = buildAttention(input.attention, now)
  const waiting = buildWaiting(input, now)
  const agents = buildAgents(input.workforce)
  const practice = buildPractice(input.skills)
  const world = buildWorld(input.world)
  const life = buildLife(input.life)
  const continuity = buildContinuity(input.continuity)
  const recentChanges = buildRecentChanges(input)
  const uncertainty = buildUncertainties(input)
  const nextActions = buildNextActions(input)

  const unavailable = input.status === null || input.status.lifecycle === 'booting'
  const missing = readings.filter((reading) => reading.freshness === 'absent').map((reading) => reading.domain)

  let health: ConsciousContextProjection['health'] = 'ready'
  let reason: string | null = null
  if (unavailable) {
    health = 'unavailable'
    reason = 'Core has not reported a conscious context: nothing is known about her situation, and none is simulated'
  } else if (freshness !== 'fresh' || missing.length > 0) {
    health = 'degraded'
    reason =
      missing.length > 0
        ? `this snapshot is incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not available in this Core, so the rest is not a full account`
        : `this snapshot is only as fresh as its weakest source (${freshness})`
  }

  // `freshness` and the absent list are already folded into `reason` above.
  return {
    schemaVersion: CONSCIOUS_CONTEXT_SCHEMA_VERSION,
    health,
    reason,
    stopAll: {
      active: input.stopAll.active,
      activatedAt: input.stopAll.activatedAt,
      activatedBy: input.stopAll.activatedBy,
    },
    self,
    posture,
    focus,
    attention,
    waiting,
    agents,
    practice,
    world,
    life,
    continuity,
    recentChanges,
    uncertainty,
    nextActions,
    provenance,
    limits: consciousContextLimits(),
  }
}

export { ABSENT_CONSCIOUS_CONTEXT_PROJECTION, NO_CONSCIOUS_CONTEXT_REASON } from '../protocol/consciousness'
