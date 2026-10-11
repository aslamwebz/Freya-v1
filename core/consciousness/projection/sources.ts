import type { AttentionProjection } from '../../protocol/attention'
import type { BrainProjection } from '../../brain/brain'
import type { ConsciousBasis, ConsciousContextProjection, ConsciousFreshness, ConsciousSourceAttribution } from '../../protocol/consciousness'
import type { ContextProjectionView } from '../../protocol/context'
import type { CoreStatus } from '../../../shared/contracts/projections/core'
import type { MissionProjection } from '../../missions/types'
import type { OfficeProjection } from '../../office/types'
import type { PersonalityProjection } from '../../protocol/personality'
import type { RelayProjection } from '../../protocol/relay'
import type { SkillProjection } from '../../protocol/skills'
import type { WorkProjection } from '../../work/projection'
import type { WorkforceProjection } from '../../workforce/types'
import type { ConsciousLifeReading, ConsciousSelfReading, ConsciousWorldReading } from '../ports'
import { CONSCIOUS_CONTEXT_LIMITS, weakestOf } from '../types'
import { ABSENT } from './metadata'
import { LIFE_ABSENT } from './world-life'

export interface SourceInput {
  readonly status: CoreStatus | null
  readonly brain: BrainProjection | null
  readonly self: ConsciousSelfReading | null
  readonly world: ConsciousWorldReading | null
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

export function source(domain: string, reading: Omit<SourceReading, 'domain'>): SourceReading {
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
export function readSources(input: SourceInput): SourceReading[] {
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

export function unreadable(
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
export function buildProvenance(
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
