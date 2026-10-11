import type { CoreActivityEvent } from '../../protocol/activity'
import type { AttentionProjection } from '../../protocol/attention'
import type { ConsciousContextProjection, ConsciousNextActionView, ConsciousNextActionsView, ConsciousUncertaintyCode, ConsciousUncertaintyItemView, ConsciousUncertaintiesView } from '../../protocol/consciousness'
import type { CoreStatus } from '../../../shared/contracts/projections/core'
import type { MissionProjection } from '../../missions/types'
import type { OfficePresenceRequest } from '../../office/types'
import type { SkillProjection } from '../../protocol/skills'
import type { StopAllState } from '../../state'
import type { WorkProjection } from '../../work/projection'
import type { WorkforceProjection } from '../../workforce/types'
import type { ConsciousWorldReading } from '../ports'
import { CONSCIOUS_CONTEXT_LIMITS } from '../types'
import { CONSCIOUS_UNCERTAINTY_CODES } from '../../protocol/consciousness'
import { absentMeta } from './metadata'

export interface ContinuityEvidenceInput {
  readonly status: CoreStatus | null
  readonly stopAll: StopAllState
  readonly world: ConsciousWorldReading | null
  readonly mission: MissionProjection | null
  readonly work: WorkProjection | null
  readonly workforce: WorkforceProjection | null
  readonly skills: SkillProjection | null
  readonly attention: AttentionProjection | null
  readonly activity: readonly CoreActivityEvent[]
  readonly pendingRequests: readonly string[]
  readonly faults: readonly string[]
  readonly presenceRequests: readonly OfficePresenceRequest[]
}

/** True once Core is far enough along to be describing a situation at all. */
function coreIsUp(input: ContinuityEvidenceInput): boolean {
  return input.status !== null && input.status.lifecycle !== 'booting'
}

const UNCERTAINTY_RANK: Readonly<Record<ConsciousUncertaintyCode, number>> = Object.freeze(
  Object.fromEntries(
    CONSCIOUS_UNCERTAINTY_CODES.map((code, index) => [code, index]),
  ) as Record<ConsciousUncertaintyCode, number>,
)

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
export function buildRecentChanges(input: ContinuityEvidenceInput): ConsciousContextProjection['recentChanges'] {
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
export function buildUncertainties(input: ContinuityEvidenceInput): ConsciousUncertaintiesView {
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
export function buildNextActions(input: ContinuityEvidenceInput): ConsciousNextActionsView {
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
