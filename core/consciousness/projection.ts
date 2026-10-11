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

import { ABSENT, absentMeta, degradedMeta } from './projection/metadata'
import { buildFocus, buildPosture, buildSelf, byInstantThenIdOnRun } from './projection/self-focus'
import type { CoreActivityEvent } from '../protocol/activity'
import type { AttentionProjection } from '../protocol/attention'
import type { BrainProjection } from '../brain/brain'
import type {
  ConsciousAgentView,
  ConsciousAgentsView,
  ConsciousApprovalView,
  ConsciousAttentionView,
  ConsciousBasis,
  ConsciousContextProjection,
  ConsciousContinuityItemView,
  ConsciousContinuityView,
  ConsciousFreshness,
  ConsciousLifeEntryView,
  ConsciousLifeView,
  ConsciousLimitsView,
  ConsciousNextActionView,
  ConsciousNextActionsView,
  ConsciousPracticeView,
  ConsciousSkillView,
  ConsciousSourceAttribution,
  ConsciousUncertaintyCode,
  ConsciousUncertaintyItemView,
  ConsciousUncertaintiesView,
  ConsciousWaitingView,
  ConsciousWorldView,
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
import { CONSCIOUS_CONTEXT_LIMITS, byInstant, newestFirstByInstant, weakestOf } from './types'
import { CONSCIOUS_CONTEXT_SCHEMA_VERSION, CONSCIOUS_UNCERTAINTY_CODES } from '../protocol/consciousness'

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



/**
 * Why `life` reads as absent on a build with no Phase 21.
 *
 * Named rather than generic, because a person told "this Core has not built this
 * subsystem" cannot act on it, while a person told Life has not been built knows
 * exactly which phase is outstanding. The generic note is still the fallback for
 * every other port.
 */
const LIFE_ABSENT = 'Phase 21 Life is not present in this Core, so what happened in her life is not known here'



/** True once Core is far enough along to be describing a situation at all. */
function coreIsUp(input: ConsciousInput): boolean {
  return input.status !== null && input.status.lifecycle !== 'booting'
}

/* ----------------------------------------------------------- provenance */

interface SourceReading {
  readonly domain: string
  readonly basis: ConsciousBasis
  readonly freshness: ConsciousFreshness
  readonly sequence: number | null
  readonly detailAvailable: boolean | null
  readonly durable: boolean | null
  readonly note: string | null
}

function source(domain: string, reading: Omit<SourceReading, 'domain'>): SourceReading {
  return { domain, ...reading }
}

/**
 * Read every source's trustworthiness, in one place.
 *
 * The rules are deliberately boring and individually arguable, which is the
 * point: an arguable rule written down can be disagreed with, and a rule
 * scattered through nine builders cannot be found at all.
 *
 * The order of the three tests is the order of the question:
 *
 * 1. **Is it there?** No → `'absent'`. Not zeroed, not empty: stated.
 * 2. **Can it be read?** No → `'unknown'`. Distinct from absent, because
 *    "Freya cannot remember" and "we cannot ask her" are different facts.
 * 3. **Did it lose anything?** Yes → `'stale'`. A restart that dropped run
 *    labels has not made the runs untrue, it has made them less legible, and a
 *    surface that cannot tell those apart will render a shorter list as though
 *    less had happened.
 */
function readSources(input: ConsciousInput): SourceReading[] {
  const readings: SourceReading[] = []

  /* -- core ------------------------------------------------------------- */
  const status = input.status
  if (status === null || status.lifecycle === 'booting') {
    readings.push(
      source('core', {
        basis: 'authoritative',
        freshness: 'absent',
        sequence: status?.eventSequence ?? null,
        detailAvailable: null,
        durable: null,
        note: 'Core has not finished starting',
      }),
    )
  } else if (status.lifecycle === 'degraded') {
    readings.push(
      source('core', {
        basis: 'authoritative',
        freshness: 'unknown',
        sequence: status.eventSequence,
        detailAvailable: true,
        durable: true,
        note: 'Core is running degraded',
      }),
    )
  } else {
    readings.push(
      source('core', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: status.eventSequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- brain ------------------------------------------------------------ */
  // The Brain's own readability, and nothing else. The self, world and continuity
  // sections read their ports, so when Phase 22 takes them over this row keeps
  // describing exactly the one thing only the Brain can answer.
  const brain = input.brain
  if (brain === null) {
    readings.push(source('brain', unreadable(null, null, null)))
  } else if (brain.health !== 'healthy') {
    readings.push(
      source('brain', {
        basis: 'authoritative',
        freshness: 'unknown',
        sequence: brain.sequence,
        detailAvailable: false,
        durable: brain.durable,
        note: brain.reason ?? 'the Brain could not be read',
      }),
    )
  } else if (!brain.durable) {
    readings.push(
      source('brain', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: brain.sequence,
        detailAvailable: false,
        durable: false,
        note: 'what Freya has learned is held in memory only: a restart will not keep it',
      }),
    )
  } else {
    readings.push(
      source('brain', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: brain.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- life ------------------------------------------------------------- */
  // A `PLAN.md` §6 requirement that Phase 21 has not satisfied yet, so on this
  // baseline it is a permanent stated absence rather than a row that appears
  // later. Two things follow, and both are deliberate:
  //
  // 1. The health line says `degraded` and names `life`, because a snapshot missing
  //    a whole domain must not present itself as a complete account.
  // 2. `null` and an unreadable-but-present Life stay distinguishable: `absent`
  //    means Phase 21 has not landed, `unknown` would mean it landed and could not
  //    be read. Collapsing them would tell a person Freya has no life history when
  //    the truth is that nobody has built the subsystem yet.
  const life = input.life
  if (life === null) {
    readings.push(
      source('life', {
        basis: 'authoritative',
        freshness: 'absent',
        sequence: null,
        detailAvailable: null,
        durable: null,
        note: LIFE_ABSENT,
      }),
    )
  } else if (life.health === 'unavailable') {
    readings.push(
      source('life', {
        basis: 'authoritative',
        freshness: 'unknown',
        sequence: life.sequence,
        detailAvailable: false,
        durable: life.durable,
        note: life.reason ?? 'Life is present but could not be read',
      }),
    )
  } else if (!life.durable) {
    readings.push(
      source('life', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: life.sequence,
        detailAvailable: false,
        durable: false,
        note: 'the life history is held in memory only: a restart will not keep it',
      }),
    )
  } else {
    readings.push(
      source('life', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: life.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- self ------------------------------------------------------------- */
  // Phase 22's self model, as its own row. It was folded into the `brain` row
  // while the Brain answered this port; now that the world domain owns the
  // answer, the row is the self model's own trust reading.
  const self = input.self
  if (self === null) {
    readings.push(source('self', unreadable(null, null, null)))
  } else if (self.health !== 'ready') {
    readings.push(
      source('self', {
        basis: 'authoritative',
        freshness: 'unknown',
        sequence: self.sequence,
        detailAvailable: false,
        durable: self.durable,
        note: self.reason ?? 'the self model is present but could not be read',
      }),
    )
  } else if (self.durable === false) {
    readings.push(
      source('self', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: self.sequence,
        detailAvailable: false,
        durable: false,
        note: 'the self model is held in memory only: a restart will not keep it',
      }),
    )
  } else {
    readings.push(
      source('self', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: self.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- world ------------------------------------------------------------ */
  // Phase 22's world summary, as its own row, for the same reason.
  const world = input.world
  if (world === null) {
    readings.push(source('world', unreadable(null, null, null)))
  } else if (world.health !== 'ready') {
    readings.push(
      source('world', {
        basis: 'authoritative',
        freshness: 'unknown',
        sequence: world.sequence,
        detailAvailable: false,
        durable: world.durable,
        note: world.reason ?? 'the world model is present but could not be read',
      }),
    )
  } else if (world.durable === false) {
    readings.push(
      source('world', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: world.sequence,
        detailAvailable: false,
        durable: false,
        note: 'the world model is held in memory only: a restart will not keep it',
      }),
    )
  } else {
    readings.push(
      source('world', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: world.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- work ------------------------------------------------------------- */
  const work = input.work
  if (work === null || work.health === 'unavailable') {
    readings.push(source('work', unreadable(work?.sequence ?? null, null, null, work?.reason ?? null)))
  } else if (!work.detailAvailable) {
    readings.push(
      source('work', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: work.sequence,
        detailAvailable: false,
        durable: true,
        note: 'run labels and observation detail do not survive a restart; the journal does',
      }),
    )
  } else {
    readings.push(
      source('work', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: work.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- mission ---------------------------------------------------------- */
  const mission = input.mission
  if (mission === null || mission.persistence.mode === 'unavailable') {
    readings.push(
      source('mission', unreadable(mission?.sequence ?? null, null, false, mission?.persistence.reason ?? null)),
    )
  } else if (!mission.persistence.durable) {
    readings.push(
      source('mission', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: mission.sequence,
        detailAvailable: false,
        durable: false,
        note: 'Mission content is held in memory only: a restart will not keep it',
      }),
    )
  } else {
    readings.push(
      source('mission', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: mission.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- workforce -------------------------------------------------------- */
  const workforce = input.workforce
  if (workforce === null || workforce.health === 'unavailable') {
    readings.push(
      source('workforce', unreadable(workforce?.sequence ?? null, null, null, workforce?.reason ?? null)),
    )
  } else if (!workforce.detailAvailable) {
    readings.push(
      source('workforce', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: workforce.sequence,
        detailAvailable: false,
        durable: true,
        note: 'message bodies do not survive a restart; their metadata does',
      }),
    )
  } else {
    readings.push(
      source('workforce', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: workforce.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- skills ----------------------------------------------------------- */
  const skills = input.skills
  if (skills === null || skills.health === 'unavailable') {
    readings.push(source('skills', unreadable(skills?.sequence ?? null, null, null, skills?.reason ?? null)))
  } else if (!skills.persistence.durable) {
    readings.push(
      source('skills', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: skills.sequence,
        detailAvailable: false,
        durable: false,
        note: 'procedure bodies are held in memory only: a restart will not keep them',
      }),
    )
  } else {
    readings.push(
      source('skills', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: skills.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- personality ------------------------------------------------------ */
  const personality = input.personality
  if (personality === null || personality.health === 'unavailable') {
    readings.push(
      source('personality', unreadable(personality?.sequence ?? null, null, null, personality?.reason ?? null)),
    )
  } else if (!personality.persistence.durable) {
    readings.push(
      source('personality', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: personality.sequence,
        detailAvailable: false,
        durable: false,
        note: personality.persistence.reason ?? 'the relationship record is held in memory only',
      }),
    )
  } else {
    readings.push(
      source('personality', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: personality.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- attention -------------------------------------------------------- */
  const attention = input.attention
  if (attention === null || attention.health === 'unavailable') {
    readings.push(
      source('attention', unreadable(attention?.sequence ?? null, null, null, attention?.reason ?? null)),
    )
  } else {
    readings.push(
      source('attention', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: attention.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- context ---------------------------------------------------------- */
  const context = input.context
  if (context === null || context.limits.maxItems === 0) {
    readings.push(source('context', unreadable(context?.sequence ?? null, null, null, null)))
  } else if (!context.persistence.durable) {
    readings.push(
      source('context', {
        basis: 'authoritative',
        freshness: 'stale',
        sequence: context.sequence,
        detailAvailable: false,
        durable: false,
        note: context.persistence.reason ?? 'held context is not durable: a restart will not keep it',
      }),
    )
  } else {
    readings.push(
      source('context', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: context.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- office ----------------------------------------------------------- */
  // `derived`, not `authoritative`: the Office is itself a pure function of Work,
  // Workforce and CoreStatus inside Core, so a snapshot that lifted it as
  // authoritative would be claiming a second-order reading is a first-order fact.
  const office = input.office
  if (office === null || office.health === 'unavailable') {
    readings.push(source('office', unreadable(office?.sequence ?? null, null, null, office?.reason ?? null)))
  } else {
    readings.push(
      source('office', {
        basis: 'derived',
        freshness: 'fresh',
        sequence: office.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  /* -- relay ------------------------------------------------------------ */
  // Counted and never read. A connector payload, an approval's target and a
  // result snippet are all things this projection declines to carry, and Relay
  // still earns a row: "there is a Relay and it is healthy" is a fact about
  // Freya's situation that a consumer is entitled to, and stating its presence
  // is what stops the absence of Relay being read as the absence of connectors.
  const relay = input.relay
  if (relay === null || relay.health === 'unavailable') {
    readings.push(source('relay', unreadable(relay?.sequence ?? null, null, null, relay?.reason ?? null)))
  } else {
    readings.push(
      source('relay', {
        basis: 'authoritative',
        freshness: 'fresh',
        sequence: relay.sequence,
        detailAvailable: true,
        durable: true,
        note: null,
      }),
    )
  }

  return readings
}

function unreadable(
  sequence: number | null,
  detailAvailable: boolean | null,
  durable: boolean | null,
  reason: string | null = null,
): Omit<SourceReading, 'domain'> {
  return {
    basis: 'authoritative',
    freshness: 'absent',
    sequence,
    detailAvailable,
    durable,
    note: reason ?? ABSENT,
  }
}

/** Build the per-source table, and the total the snapshot claims to rest on. */
function buildProvenance(
  readings: readonly SourceReading[],
  now: Date,
): { readonly provenance: ConsciousContextProjection['provenance']; readonly freshness: ConsciousFreshness } {
  const capped = readings.slice(0, CONSCIOUS_CONTEXT_LIMITS.maxSources)
  const sources: ConsciousSourceAttribution[] = capped.map((reading) => ({
    domain: reading.domain,
    basis: reading.basis,
    freshness: reading.freshness,
    sequence: reading.sequence,
    detailAvailable: reading.detailAvailable,
    durable: reading.durable,
    note: reading.note,
  }))

  const freshness = weakestOf(capped.map((reading) => reading.freshness))
  const durableSequence = capped.reduce(
    (highest, reading) => (reading.sequence !== null && reading.sequence > highest ? reading.sequence : highest),
    0,
  )

  return {
    freshness,
    provenance: {
      // Always `'derived'`: this whole object is computed here, and saying so at
      // the top is what stops a consumer reading eleven authoritative sources
      // and concluding the summary is authoritative too.
      basis: 'derived',
      freshness,
      durableSequence,
      asOf: now.toISOString(),
      sources,
    },
  }
}






/* ------------------------------------------------------------- attention */

/**
 * What arrived and what Core decided.
 *
 * Inbox entries are the `AttentionProjection`'s own metadata views, capped and
 * newest-first. Their `text` was never on the type in the first place, so there
 * is nothing here to strip — which is the point of building this section from
 * the projection rather than from the engine's inbox.
 */
function buildAttention(attention: AttentionProjection | null, now: Date): ConsciousAttentionView {
  if (attention === null || attention.health === 'unavailable') {
    return {
      ...absentMeta(attention?.reason ?? null),
      focus: null,
      counts: null,
      lastDecision: null,
      directive: null,
      inbox: [],
      schedulesDue: 0,
      schedulesPending: 0,
    }
  }

  const pending = attention.schedules.filter((schedule) => schedule.status === 'pending')
  const nowMs = now.getTime()
  // A derivation, not a firing: how many schedules *could* fire, computed here.
  // `attention.tick` remains the only thing that actually fires one, and it lives
  // in Core, not in a window.
  const due = pending.filter((schedule) => {
    const dueMs = Date.parse(schedule.dueAt)
    return !Number.isNaN(dueMs) && dueMs <= nowMs
  })

  const decision = attention.lastDecision
  const directive = attention.directive

  return {
    state: 'available',
    note: null,
    focus: attention.focus,
    counts: attention.counts,
    lastDecision:
      decision === null
        ? null
        : {
            decisionId: decision.decisionId,
            source: decision.source,
            kind: decision.kind,
            outcome: decision.outcome,
            importance: decision.importance,
            urgency: decision.urgency,
            reason: decision.reason,
            cueCode: decision.cueCode,
            decidedAt: decision.decidedAt,
          },
    // Only an expressive directive is forwarded, for the same reason
    // `projectAttention` refuses a `do-nothing`: a renderer that drew one would
    // be drawing a gesture that was never chosen.
    directive:
      directive === null
        ? null
        : { kind: directive.kind, outcome: directive.outcome, cueCode: directive.cueCode },
    inbox: [...attention.inbox]
      .sort((a, b) => {
        const order = byInstant(a.observedAt, b.observedAt)
        return order !== 0 ? order : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
      })
      .slice(Math.max(0, attention.inbox.length - CONSCIOUS_CONTEXT_LIMITS.maxAttentionInboxItems))
      .reverse()
      .map((item) => ({
        eventId: item.eventId,
        source: item.source,
        kind: item.kind,
        goalRef: item.goalRef,
        severityHint: item.severityHint,
        textLength: item.textLength,
        observedAt: item.observedAt,
        dueAt: item.dueAt,
        outcome: item.outcome,
      })),
    schedulesDue: due.length,
    schedulesPending: pending.length,
  }
}

/* --------------------------------------------------------------- waiting */

/**
 * What is waiting on a person.
 *
 * The two excluded fields — an approval's `justification` and its `proposal` —
 * are the only place in Core where the *reason* for an action is written in
 * plain language, and they are excluded precisely because this projection is
 * visible wherever a window is. Someone deciding an approval reads the Work
 * board, where the Guard's own fields are; a snapshot is not that place, and a
 * snapshot is exactly the kind of thing that gets rendered as a tooltip over
 * everything else in a window.
 *
 * `requestedAgoMs` is a duration, derived from `now`, so a surface can say
 * "waiting two minutes" without doing date arithmetic against a Core clock it
 * does not have.
 */
function buildWaiting(input: ConsciousInput, now: Date): ConsciousWaitingView {
  const work = input.work
  const workforce = input.workforce

  if (work === null || work.health === 'unavailable') {
    return {
      ...absentMeta(work?.reason ?? null),
      approvals: [],
      pendingApprovals: 0,
      waitingRuns: [],
      blockedTasks: [],
      blockedAgents: [],
      unfulfilledPresenceRequests: [],
    }
  }

  const nowMs = now.getTime()
  const pendingApprovals = work.approvals
    .filter((approval) => approval.status === 'pending')
    .sort((a, b) => {
      const order = byInstant(a.requestedAt, b.requestedAt)
      return order !== 0
        ? order
        : a.approvalId < b.approvalId
          ? -1
          : a.approvalId > b.approvalId
            ? 1
            : 0
    })
  const oldestPending = Math.max(0, pendingApprovals.length - CONSCIOUS_CONTEXT_LIMITS.maxApprovalItems)
  const approvals: ConsciousApprovalView[] = pendingApprovals
    .slice(oldestPending)
    .reverse()
    .map((approval) => {
      const requestedMs = Date.parse(approval.requestedAt)
      return {
        approvalId: approval.approvalId,
        runId: approval.runId,
        capability: approval.capability,
        requiredCapability: approval.requiredCapability,
        risk: approval.risk,
        status: approval.status,
        requestedAt: approval.requestedAt,
        requestedAgoMs: Number.isNaN(requestedMs) ? null : Math.max(0, nowMs - requestedMs),
      }
    })

  const waitingRuns = [...work.runs]
    .filter((run) => run.status === 'waiting' || run.status === 'awaiting_approval')
    .sort(byInstantThenIdOnRun)
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxWaitItems)
    .map((run) => ({
      runId: run.runId,
      status: run.status,
      // Deliberately *not* `run.waitingOn`, which is a step label and therefore
      // owner-shaped text. The instant the run was created is Core's own and says
      // how long this has been going without saying what it is about.
      waitingSince: run.createdAt,
    }))

  const blockedTasks = [...work.tasks]
    .filter((task) => task.status === 'blocked')
    .sort(byInstantThenIdOnTask)
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxWaitItems)
    .map((task) => ({ taskId: task.taskId, status: task.status, updatedAt: task.updatedAt }))

  const workers = workforce === null || workforce.health === 'unavailable' ? [] : workforce.workers
  const blockedAgents = [...workers]
    .filter((worker) => worker.status === 'blocked')
    .sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0))
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxWaitItems)
    .map((worker) => ({ workerId: worker.workerId, status: worker.status }))

  return {
    state: 'available',
    note: null,
    approvals,
    pendingApprovals: work.counts.pendingApprovals,
    waitingRuns,
    blockedTasks,
    blockedAgents,
    unfulfilledPresenceRequests: [...input.presenceRequests]
      .filter((request) => !request.fulfilled)
      .sort((a, b) => {
        const order = byInstant(a.requestedAt, b.requestedAt)
        return order !== 0 ? order : a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0
      })
      .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxWaitItems)
      .map((request) => ({ workerId: request.workerId, requestedAt: request.requestedAt })),
  }
}

function byInstantThenIdOnTask(a: { updatedAt: string; taskId: string }, b: { updatedAt: string; taskId: string }): number {
  const order = byInstant(a.updatedAt, b.updatedAt)
  return order !== 0 ? order : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

/* ---------------------------------------------------------------- agents */

/**
 * The current agents and what they are carrying.
 *
 * Worker names are Core-normalised at admission (`maxNameChars`) and are already
 * projected verbatim by `workforce()`, so they are not a new disclosure. Message
 * bodies are not here, and `detailAvailable` says whether they exist anywhere —
 * a mailbox that renders empty after a restart otherwise reads as "nobody has
 * said anything", which is false.
 */
function buildAgents(workforce: WorkforceProjection | null): ConsciousAgentsView {
  if (workforce === null || workforce.health === 'unavailable') {
    return {
      ...absentMeta(workforce?.reason ?? null),
      workers: [],
      counts: null,
      detailAvailable: null,
      assignmentsRetained: 0,
      assignmentsTotal: 0,
      assignmentsHidden: 0,
    }
  }

  const workers: ConsciousAgentView[] = [...workforce.workers]
    .sort(byInstantThenIdOnWorker)
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxAgents)
    .map((worker) => ({
      workerId: worker.workerId,
      name: worker.name,
      specialisation: worker.specialisation,
      status: worker.status,
      teams: [...worker.teams],
      capabilities: [...worker.capabilities],
      openAssignments: worker.assignments.filter((assignment) => assignment.status === 'open').length,
      refusedClaims: worker.refusedClaims,
      limitsHit: [...worker.limitsHit],
      remaining: {
        assignments: worker.remaining.assignments,
        cognitionCalls: worker.remaining.cognitionCalls,
        cognitionTokens: worker.remaining.cognitionTokens,
      },
      assignments: worker.assignments
        .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxWaitItems)
        .map((assignment) => ({
          assignmentId: assignment.assignmentId,
          status: assignment.status,
          createdAt: assignment.createdAt,
          deadlineAt: assignment.deadlineAt,
          missionId: assignment.missionId,
          capabilities: [...assignment.capabilities],
          expired: assignment.expired,
        })),
    }))

  return {
    state: 'available',
    note: null,
    workers,
    counts: workforce.counts,
    detailAvailable: workforce.detailAvailable,
    assignmentsRetained: workforce.assignmentsRetained,
    assignmentsTotal: workforce.assignmentsTotal,
    assignmentsHidden: workforce.assignmentsHidden,
  }
}

function byInstantThenIdOnWorker(a: { createdAt: string; workerId: string }, b: { createdAt: string; workerId: string }): number {
  const order = byInstant(a.createdAt, b.createdAt)
  return order !== 0 ? order : a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0
}

/* -------------------------------------------------------------- practice */

/**
 * What Freya has learned to do.
 *
 * Metadata lifted from the Skills projection, capped. The owner's own description
 * of a procedure is on `SkillDetailView`, one skill at a time, on request — so a
 * snapshot that carried `summary` would be a standing channel for every
 * procedure's prose at once, which is the opposite of the deal Skills made.
 */
function buildPractice(skills: SkillProjection | null): ConsciousPracticeView {
  if (skills === null || skills.health === 'unavailable') {
    return {
      ...absentMeta(skills?.reason ?? null),
      skills: [],
      counts: null,
      thresholds: null,
      durable: null,
      listed: 0,
      omitted: 0,
    }
  }

  const listed: ConsciousSkillView[] = [...skills.skills]
    .sort(byInstantThenIdOnSkill)
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxSkills)
    .map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      kind: skill.kind,
      status: skill.status,
      version: skill.version,
      verification: skill.verification,
      trustClass: skill.trustClass,
      establishedCount: skill.establishedCount,
      contradictedCount: skill.contradictedCount,
      inconclusiveCount: skill.inconclusiveCount,
      executionsPlanned: skill.executionsPlanned,
      stepCount: skill.stepCount,
      requiredCapabilityCount: skill.requiredCapabilityCount,
      summaryLength: skill.summaryLength,
    }))

  return {
    state: 'available',
    note: null,
    skills: listed,
    counts: skills.counts,
    thresholds: skills.thresholds,
    durable: skills.persistence.durable,
    listed: listed.length,
    omitted: Math.max(0, skills.counts.retained - listed.length),
  }
}

function byInstantThenIdOnSkill(a: { admittedAt: string; skillId: string }, b: { admittedAt: string; skillId: string }): number {
  const order = byInstant(a.admittedAt, b.admittedAt)
  return order !== 0 ? order : a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0
}

/* ----------------------------------------------------------------- world */

/**
 * The world as Core holds it: counts, not names.
 *
 * Read through the `world` port. The Brain is today's authority behind it, and
 * Phase 22's World projection becomes the authority when it lands — in both cases
 * the producer publishes counts and no names, and this section does not widen that.
 */
function buildWorld(world: ConsciousWorldReading | null): ConsciousWorldView {
  if (world === null) {
    return {
      ...absentMeta(null),
      entities: null,
      relations: null,
      observations: null,
      memories: null,
      admitted: null,
      conflicted: null,
      rejected: null,
      withdrawn: null,
      experiences: null,
      conflicts: [],
      durable: null,
    }
  }
  if (world.health !== 'ready') {
    return {
      ...degradedMeta(world.reason ?? 'the world model could not be read'),
      entities: null,
      relations: null,
      observations: null,
      memories: null,
      admitted: null,
      conflicted: null,
      rejected: null,
      withdrawn: null,
      experiences: null,
      conflicts: [],
      durable: world.durable,
    }
  }
  return {
    state: 'available',
    note: null,
    entities: world.entities,
    relations: world.relations,
    observations: world.observations,
    memories: world.memories,
    admitted: world.admitted,
    conflicted: world.conflicted,
    rejected: world.rejected,
    withdrawn: world.withdrawn,
    experiences: world.experiences,
    conflicts: world.conflicts
      .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxConflictItems)
      .map((conflict) => ({
        memoryId: conflict.memoryId,
        conflictsWith: [...conflict.conflictsWith],
        detail: conflict.detail,
      })),
    durable: world.durable,
  }
}

/* ------------------------------------------------------------------ life */

/**
 * What happened in Freya's life.
 *
 * ## Why this section exists while being empty
 *
 * `PLAN.md` §6 makes Phase 21 Life a required contributor to this projection, and
 * Phase 21 has not landed. The section is here in the shape Phase 21 will fill, and
 * it says `absent` with a note naming Phase 21.
 *
 * The alternative — leaving the section out until the producer exists — was
 * rejected because it produces a snapshot that is *silently* incomplete. A missing
 * section reads as a domain with nothing in it; a stated absence reads as a domain
 * that was never built, and only one of those is true.
 *
 * Nothing here is defaulted. There is no `entries: 0` fallback dressed as a
 * reading: a fabricated life history is the single worst thing this projection
 * could emit, because it would be indistinguishable from a real one to every
 * consumer downstream.
 *
 * ### Integration point (Phase 21)
 *
 * Phase 21 writes `core/consciousness/adapters/life.ts` and passes its reading as
 * `life`. This function, the `life` provenance row above and the protocol shape
 * are already correct for that, so the integration is additive — and the moment it
 * lands, `life` stops being the reason this build reports `health: 'degraded'`.
 */
function buildLife(life: ConsciousLifeReading | null): ConsciousLifeView {
  if (life === null) {
    return {
      ...absentMeta(LIFE_ABSENT),
      entries: null,
      admitted: null,
      recalled: null,
      durable: null,
      recent: [],
      listed: 0,
      omitted: 0,
    }
  }
  if (life.health !== 'ready') {
    return {
      ...degradedMeta(life.reason ?? 'the life history could not be read'),
      entries: null,
      admitted: null,
      recalled: null,
      durable: life.durable,
      recent: [],
      listed: 0,
      omitted: 0,
    }
  }

  // Newest first, with an unknown instant last, capped *after* ordering so what
  // survives is the most recent rather than whichever slice happened to land in the
  // window. The comparator lives in `types.ts` rather than inline here, because
  // "newest first" is a rule that has to be auditable in one place and it is
  // exactly the rule that is easy to get subtly wrong - see the note there on why
  // neither negating `byInstant` nor sorting-then-reversing is correct.
  const listed = [...life.recent]
    .sort((a, b) => newestFirstByInstant({ at: a.at, id: a.entryId }, { at: b.at, id: b.entryId }))
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxLifeEntries)

  return {
    state: 'available',
    note: null,
    entries: life.entries,
    admitted: life.admitted,
    recalled: life.recalled,
    durable: life.durable,
    recent: listed.map((entry): ConsciousLifeEntryView => ({
      entryId: entry.entryId,
      kind: entry.kind,
      at: entry.at,
      textLength: entry.textLength,
      confidence: entry.confidence,
    })),
    listed: listed.length,
    omitted: Math.max(0, life.recent.length - listed.length),
  }
}

/* ------------------------------------------------------------ continuity */

/**
 * Recently admitted memories.
 *
 * `subjectLength` in place of `subject`, computed by the adapter that reads the
 * producer and not here. `subject` is not merely private — it is the field a
 * person would most want to read, which is exactly why a snapshot is the wrong
 * place for it. Recalling it is a deliberate act through the owning domain, on the
 * owner's authority, and that asymmetry is preserved.
 */
function buildContinuity(continuity: ConsciousContinuityReading | null): ConsciousContinuityView {
  if (continuity === null) {
    return {
      ...absentMeta(null),
      items: [],
      listed: 0,
      omitted: 0,
      durable: null,
    }
  }
  if (continuity.health !== 'ready') {
    return {
      ...degradedMeta(continuity.reason ?? 'the continuity record could not be read'),
      items: [],
      listed: 0,
      omitted: 0,
      durable: continuity.durable,
    }
  }

  const items: ConsciousContinuityItemView[] = continuity.items
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxContinuityItems)
    .map((entry) => ({
      memoryId: entry.memoryId,
      kind: entry.kind,
      source: entry.source,
      confidence: entry.confidence,
      status: entry.status,
      subjectLength: entry.subjectLength,
      admittedAt: entry.admittedAt,
    }))

  return {
    state: 'available',
    note: null,
    items,
    listed: items.length,
    omitted: Math.max(0, (continuity.admittedTotal ?? items.length) - items.length),
    durable: continuity.durable,
  }
}
/* --------------------------------------------------------- recent changes */

/**
 * What changed recently.
 *
 * The feed is newest-last, so the list is reversed to newest-first and then
 * capped — capped *after* reversing, so what survives is the newest rather than
 * whichever slice happened to land in the window.
 *
 * The event's sentence is dropped. `describeActivity` writes it, it is
 * content-free by construction, and it is the only free-text field left in the
 * whole projection; keeping it would trade an exhaustively checkable invariant
 * for one more sentence.
 */
function buildRecentChanges(input: ConsciousInput): ConsciousContextProjection['recentChanges'] {
  // An empty feed is a claim about a journal, so it is only made when there is a
  // journal to have read. Before Core starts there is nothing to be absent *from*,
  // and a section claiming `'available'` with no rows would be the one place in
  // this snapshot that renders ignorance as completeness.
  if (!coreIsUp(input)) {
    return { ...absentMeta(null), items: [], listed: 0, omitted: 0 }
  }
  const activity = input.activity
  // Sorted by durable sequence rather than by position in the feed. The feed is
  // documented as newest-last, but a snapshot whose order depends on an input
  // array's order is a snapshot two code paths could disagree about, and sequence
  // is the one key the journal guarantees to be monotonic.
  const items = [...activity]
    .sort((a, b) => (a.sequence === b.sequence ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.sequence - b.sequence))
    .slice(Math.max(0, activity.length - CONSCIOUS_CONTEXT_LIMITS.maxRecentChanges))
    .reverse()
    .map((row) => ({ id: row.id, kind: row.kind, sequence: row.sequence, at: row.at, tone: row.tone }))
  return {
    state: 'available',
    note: null,
    items,
    listed: items.length,
    omitted: Math.max(0, activity.length - items.length),
  }
}

/* ------------------------------------------------------------ uncertainty */

/**
 * Rank an uncertainty code by its position in the declared order.
 *
 * The declaration order *is* the priority — memory before mission before work
 * before agent before procedure before cognition before journal — so the cap
 * drops the least consequential rows rather than whichever ones sorted last by
 * accident. Declared position is a fixed, reviewable fact, unlike a score that
 * would drift the first time somebody reordered the list.
 */
const UNCERTAINTY_RANK: Readonly<Record<ConsciousUncertaintyCode, number>> = Object.freeze(
  Object.fromEntries(
    CONSCIOUS_UNCERTAINTY_CODES.map((code, index) => [code, index]),
  ) as Record<ConsciousUncertaintyCode, number>,
)

/**
 * Everything Core could not settle.
 *
 * A closed code, a subject kind and a subject id. Never a sentence about the
 * owner's situation: a paragraph explaining what Freya is unsure about would be
 * an inference wearing the same clothes as a fact, and `uncertainty` sits right
 * next to sections that are authoritative, where that disguise works best.
 *
 * `subjectId` is `null` where the uncertainty is about the Core as a whole —
 * which is exactly the cases worth noticing, because they have no owner to chase.
 */
function buildUncertainties(input: ConsciousInput): ConsciousUncertaintiesView {
  // "Nothing is uncertain" is only a claim worth making about a Core that is up.
  if (!coreIsUp(input)) {
    return { ...absentMeta(null), items: [], listed: 0, omitted: 0 }
  }
  const items: ConsciousUncertaintyItemView[] = []
  const add = (
    code: ConsciousUncertaintyCode,
    subjectKind: string,
    subjectId: string | null,
    since: string | null = null,
  ): void => {
    items.push({ code, subjectKind, subjectId, since })
  }

  // Read through the `world` port, the same place the `world` section reads them
  // from. Reading the Brain here as well would be two authorities for one fact, and
  // the two could disagree the moment Phase 22 takes the port over.
  const world = input.world
  if (world !== null && world.health === 'ready') {
    for (const conflict of world.conflicts) {
      add('memory.conflict', 'memory', conflict.memoryId)
    }
  }

  const mission = input.mission
  if (mission !== null && mission.persistence.mode !== 'unavailable') {
    for (const entry of mission.missions) {
      const verification = entry.verification
      if (verification !== null) {
        if (verification.state === 'not_established') {
          add('mission.verification-unestablished', 'mission', entry.missionId, entry.createdAt)
        }
        if (verification.state === 'timeout') {
          add('mission.verification-timeout', 'mission', entry.missionId, entry.createdAt)
        }
      }
      if (entry.needsAttention) {
        add('mission.needs-attention', 'mission', entry.missionId, entry.createdAt)
      }
    }
  }

  const work = input.work
  if (work !== null && work.health !== 'unavailable') {
    for (const run of work.runs) {
      if (run.limitHit !== null) {
        add('work.limit-hit', 'run', run.runId, run.createdAt)
      }
    }
  }

  const workforce = input.workforce
  if (workforce !== null && workforce.health !== 'unavailable') {
    for (const worker of workforce.workers) {
      // One row per worker rather than per limit: the names themselves are on
      // `agents[].limitsHit`, and a composite `workerId/limit` string here would
      // be an id this projection had invented.
      if (worker.limitsHit.length > 0) {
        add('agent.limit-hit', 'worker', worker.workerId, worker.createdAt)
      }
      if (worker.refusedClaims > 0) {
        add('agent.refused-claim', 'worker', worker.workerId, worker.createdAt)
      }
    }
  }

  const skills = input.skills
  if (skills !== null && skills.health !== 'unavailable') {
    for (const skill of skills.skills) {
      if (skill.contradictedCount > 0) {
        add('practice.contradicted', 'skill', skill.skillId, skill.admittedAt)
      }
    }
    for (const proposal of skills.proposals) {
      if (proposal.status === 'open') {
        add('practice.proposal-open', 'proposal', proposal.proposalId, proposal.createdAt)
      }
    }
    for (const rejection of skills.rejectedAdmissions) {
      add('practice.admission-refused', 'admission', rejection.targetRef)
    }
    for (const refusal of skills.runtimePromotionRefusals) {
      add('practice.promotion-refused', 'artifact', refusal.artifactId)
    }
  }

  const status = input.status
  if (status !== null) {
    if (status.durableUsage.unknownUsageCalls > 0) {
      add('cognition.usage-unknown', 'core', null, status.coreStartedAt)
    }
    if (status.governor.status !== 'ready') {
      add('cognition.governor-closed', 'core', null, status.coreStartedAt)
    }
    if (status.integrity.integrity !== 'ok') {
      add('journal.integrity', 'journal', null, status.coreStartedAt)
    }
  }
  if (input.pendingRequests.length > 0) {
    add('cognition.request-pending', 'core', null, null)
  }
  // One row per fault, not one per fault string: the strings are Core's own
  // sentences and a snapshot is not the place to reprint them. Which faults exist
  // is on `CoreStatus.faults`, for a reader who wants them.
  if (input.faults.length > 0) {
    add('core.fault', 'core', null, null)
  }

  const attention = input.attention
  if (attention !== null && attention.health !== 'unavailable' && attention.counts.budgetExceeded > 0) {
    add('attention.budget-exceeded', 'attention', null, null)
  }

  for (const request of input.presenceRequests) {
    if (!request.fulfilled) {
      add('presence.unfulfilled', 'worker', request.workerId, request.requestedAt)
    }
  }

  const ordered = [...items].sort((a, b) => {
    const byCode = UNCERTAINTY_RANK[a.code] - UNCERTAINTY_RANK[b.code]
    if (byCode !== 0) return byCode
    const byKind = a.subjectKind < b.subjectKind ? -1 : a.subjectKind > b.subjectKind ? 1 : 0
    if (byKind !== 0) return byKind
    const left = a.subjectId ?? ''
    const right = b.subjectId ?? ''
    return left < right ? -1 : left > right ? 1 : 0
  })
  const listed = ordered.slice(0, CONSCIOUS_CONTEXT_LIMITS.maxUncertainties)

  return {
    state: 'available',
    note: null,
    items: listed,
    listed: listed.length,
    omitted: Math.max(0, ordered.length - listed.length),
  }
}

/* ----------------------------------------------------------- next actions */

/**
 * What Freya intends to do next, where that is already derivable.
 *
 * Collected from the `availableActions` Mission and Workforce projections
 * already publish — the same arrays the Work board offers. There is no
 * `'consciousness'` scope and no invented verb, because the moment this phase
 * could name an action Core does not have, the "derived from authoritative
 * state" claim would stop being true.
 *
 * Empty under STOP ALL, with the count of what was withheld. A withheld count is
 * the honest half: without it, "she intends nothing" and "she is not permitted
 * to intend anything" are the same snapshot, and only one of them is true.
 */
function buildNextActions(input: ConsciousInput): ConsciousNextActionsView {
  if (!coreIsUp(input)) {
    return { ...absentMeta(null), items: [], listed: 0, omitted: 0 }
  }
  const offered: ConsciousNextActionView[] = []

  const mission = input.mission
  if (mission !== null && mission.persistence.mode !== 'unavailable') {
    for (const entry of mission.missions) {
      if (entry.status === 'completed' || entry.status === 'cancelled' || entry.status === 'failed') continue
      for (const action of entry.availableActions) {
        offered.push({ scope: 'mission', subjectId: entry.missionId, action })
      }
    }
  }

  const workforce = input.workforce
  if (workforce !== null && workforce.health !== 'unavailable') {
    for (const worker of workforce.workers) {
      if (worker.status === 'retired') continue
      for (const action of worker.availableActions) {
        offered.push({ scope: 'agent', subjectId: worker.workerId, action })
      }
    }
  }

  const ordered = [...offered].sort(
    (a, b) =>
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
      (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0) ||
      (a.action < b.action ? -1 : a.action > b.action ? 1 : 0),
  )

  if (input.stopAll.active) {
    return {
      state: 'available',
      note: `STOP ALL is active: ${ordered.length} offered action(s) are withheld while the owner has said stop`,
      items: [],
      listed: 0,
      omitted: ordered.length,
    }
  }

  const listed = ordered.slice(0, CONSCIOUS_CONTEXT_LIMITS.maxNextActions)
  return {
    state: 'available',
    note: null,
    items: listed,
    listed: listed.length,
    omitted: Math.max(0, ordered.length - listed.length),
  }
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
