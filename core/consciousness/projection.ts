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

import { absentMeta } from './projection/metadata'
import { buildFocus, buildPosture, buildSelf } from './projection/self-focus'
import { buildContinuity, buildLife, buildWorld } from './projection/world-life'
import { buildAttention, buildWaiting } from './projection/attention-work'
import { buildAgents, buildPractice } from './projection/agents-practice'
import { buildProvenance, readSources } from './projection/sources'
import type { CoreActivityEvent } from '../protocol/activity'
import type { AttentionProjection } from '../protocol/attention'
import type { BrainProjection } from '../brain/brain'
import type {
  ConsciousContextProjection,
  ConsciousLimitsView,
  ConsciousNextActionView,
  ConsciousNextActionsView,
  ConsciousUncertaintyCode,
  ConsciousUncertaintyItemView,
  ConsciousUncertaintiesView,
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








/** True once Core is far enough along to be describing a situation at all. */
function coreIsUp(input: ConsciousInput): boolean {
  return input.status !== null && input.status.lifecycle !== 'booting'
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
