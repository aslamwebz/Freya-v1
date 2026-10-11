import type { AttentionProjection } from '../../protocol/attention'
import type { ConsciousContextProjection, ConsciousPostureView, ConsciousSelfView } from '../../protocol/consciousness'
import type { ContextProjectionView } from '../../protocol/context'
import type { MissionProjection } from '../../missions/types'
import type { PersonalityProjection } from '../../protocol/personality'
import type { WorkProjection } from '../../work/projection'
import type { WorkforceProjection } from '../../workforce/types'
import type { ConsciousSelfReading } from '../ports'
import { byInstant } from '../types'
import { absentMeta, degradedMeta } from './metadata'

export interface FocusInput {
  readonly work: WorkProjection | null
  readonly mission: MissionProjection | null
  readonly workforce: WorkforceProjection | null
  readonly context: ContextProjectionView | null
}

/* ------------------------------------------------------------------ self */

/**
 * What Freya says she is.
 *
 * Read through the `self` port rather than from a domain projection. On this
 * baseline the Brain is the authority behind that port (see `adapters/brain.ts`),
 * and the Brain is where the seeded identity actually lives rather than
 * `FREYA_IDENTITY` — it is the thing a consumer would have to reconcile against.
 * Both are Core-authored and immutable; a change in either is a change in Freya's
 * self-account and should be visible here.
 *
 * When Phase 22 lands it supplies this port instead and nothing below changes. The
 * statements are Core's own fixed strings either way: nothing the owner said can
 * get here, because nothing the owner said is in an `IdentityRoot` or a
 * `SelfDefinition`.
 */
export function buildSelf(self: ConsciousSelfReading | null): ConsciousSelfView {
  if (self === null) {
    return {
      ...absentMeta(null),
      name: null,
      role: null,
      purpose: null,
      claimCount: 0,
      capabilities: [],
      limitations: [],
      complete: false,
    }
  }
  if (self.health !== 'ready') {
    // `degradedMeta`, not `absentMeta`: the producer is named in the note, so a
    // person is told the self-account exists and could not be read, rather than
    // that Freya has no account of herself.
    return {
      ...degradedMeta(self.reason ?? 'the self-account could not be read'),
      name: null,
      role: null,
      purpose: null,
      claimCount: 0,
      capabilities: [],
      limitations: [],
      complete: false,
    }
  }
  return {
    state: 'available',
    note: null,
    name: self.name,
    role: self.role,
    purpose: self.purpose,
    claimCount: self.claimCount,
    // Already narrowed at the port, so this is a copy and not a second guard: the
    // one place a widened producer is caught is the adapter that reads it.
    capabilities: self.capabilities.map((capability) => ({
      capability: capability.capability,
      state: capability.state,
      cannot: [...capability.cannot],
    })),
    limitations: self.limitations.map((limitation) => ({
      limitationId: limitation.limitationId,
      statement: limitation.statement,
    })),
    // `complete: false` with `state: 'available'` is a real reading, not a
    // contradiction: Core knows what it can do and does not yet know that it knows
    // all of it, and collapsing the two would make an unfinished
    // self-account indistinguishable from a complete one.
    complete: self.complete,
  }
}

/* --------------------------------------------------------------- posture */

/**
 * How she is holding herself with this person.
 *
 * The interpretation is Personality's, lifted not recomputed: this phase does not
 * have a second rule for what `continuity` means, because two rules for one word
 * is how a person ends up contradicted by two parts of the same product.
 */
export function buildPosture(personality: PersonalityProjection | null): ConsciousPostureView {
  if (personality === null) {
    return {
      ...absentMeta(null),
      continuity: null,
      formality: null,
      greetingEligible: false,
      temperament: null,
      presenceCueKind: null,
      counts: null,
      durable: null,
    }
  }
  if (personality.health === 'unavailable') {
    return {
      ...absentMeta(personality.reason ?? null),
      continuity: null,
      formality: null,
      greetingEligible: false,
      temperament: null,
      presenceCueKind: null,
      counts: null,
      durable: null,
    }
  }
  const interpretation = personality.interpretation
  const cue = personality.presenceCue
  return {
    state: 'available',
    note: null,
    continuity: interpretation?.continuity ?? null,
    formality: interpretation?.formality ?? null,
    greetingEligible: interpretation?.greetingEligible ?? false,
    temperament:
      personality.temperament === null
        ? null
        : {
            dimensions: personality.temperament.dimensions.map((entry) => ({
              dimension: entry.dimension,
              level: entry.level,
            })),
            constitutionFirst: personality.temperament.constitutionFirst,
            identitySupersedesTemperament: personality.temperament.identitySupersedesTemperament,
            cannotWeaken: [...personality.temperament.cannotWeaken],
          },
    presenceCueKind: cue?.kind ?? null,
    counts: personality.counts,
    durable: personality.persistence.durable,
  }
}

/* ----------------------------------------------------------------- focus */

/**
 * What she is on.
 *
 * The two `primary*` ids are chosen by *earliest creation* rather than by
 * whatever came last in an array, for two reasons: it is the longest-running
 * thing, which is what a person means by "what is she doing"; and it is
 * independent of arrival order, so a replay that folded the same events in a
 * different sequence still names the same run. The run's own id breaks a tie,
 * because a comparator that can return `0` leaves the choice to the sort.
 */
export function buildFocus(input: FocusInput, attention: AttentionProjection | null): ConsciousContextProjection['focus'] {
  const work = input.work
  const mission = input.mission
  const workforce = input.workforce
  const context = input.context
  // Attention's reading is reported even when Work is absent: it is still a true
  // thing to know, and dropping it would let a missing Work subsystem hide a
  // present Attention one.
  const attentionFocus = attention?.focus ?? 'unknown'

  if (work === null || work.health === 'unavailable') {
    return {
      ...absentMeta(work?.reason ?? null),
      attentionFocus,
      primaryRunId: null,
      primaryMissionId: null,
      liveRuns: 0,
      runningRuns: 0,
      waitingRuns: 0,
      activeMissions: 0,
      workingAgents: 0,
      scope: null,
    }
  }

  const liveRuns = work.runs.filter((run) => run.live)
  const primary = [...liveRuns].sort(byInstantThenIdOnRun)[0] ?? null
  const activeMissions =
    mission === null ? [] : mission.missions.filter((entry) => entry.status === 'active')
  const primaryMission = [...activeMissions].sort(byInstantThenIdOnMission)[0] ?? null
  const workers = workforce === null || workforce.health === 'unavailable' ? [] : workforce.workers

  return {
    state: 'available',
    note: null,
    attentionFocus,
    primaryRunId: primary?.runId ?? null,
    primaryMissionId: primaryMission?.missionId ?? null,
    liveRuns: liveRuns.length,
    runningRuns: work.counts.running,
    waitingRuns: work.counts.waiting,
    activeMissions: activeMissions.length,
    workingAgents: workers.filter((worker) => worker.status === 'working').length,
    scope:
      context === null || context.activeScope === null
        ? null
        : { scopeKind: context.activeScope.scopeKind, scopeId: context.activeScope.scopeId },
  }
}

export function byInstantThenIdOnRun(a: { createdAt: string; runId: string }, b: { createdAt: string; runId: string }): number {
  const order = byInstant(a.createdAt, b.createdAt)
  return order !== 0 ? order : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0
}

export function byInstantThenIdOnMission(
  a: { createdAt: string; missionId: string },
  b: { createdAt: string; missionId: string },
): number {
  const order = byInstant(a.createdAt, b.createdAt)
  return order !== 0 ? order : a.missionId < b.missionId ? -1 : a.missionId > b.missionId ? 1 : 0
}
