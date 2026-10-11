import type { ConsciousAgentView, ConsciousAgentsView, ConsciousPracticeView, ConsciousSkillView } from '../../protocol/consciousness'
import type { SkillProjection } from '../../protocol/skills'
import type { WorkforceProjection } from '../../workforce/types'
import { CONSCIOUS_CONTEXT_LIMITS, byInstant } from '../types'
import { absentMeta } from './metadata'

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
export function buildAgents(workforce: WorkforceProjection | null): ConsciousAgentsView {
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

/* -------------------------------------------------------------- practice */

/**
 * What Freya has learned to do.
 *
 * Metadata lifted from the Skills projection, capped. The owner's own description
 * of a procedure is on `SkillDetailView`, one skill at a time, on request — so a
 * snapshot that carried `summary` would be a standing channel for every
 * procedure's prose at once, which is the opposite of the deal Skills made.
 */
export function buildPractice(skills: SkillProjection | null): ConsciousPracticeView {
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

export function byInstantThenIdOnWorker(a: { createdAt: string; workerId: string }, b: { createdAt: string; workerId: string }): number {
  const order = byInstant(a.createdAt, b.createdAt)
  return order !== 0 ? order : a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0
}

export function byInstantThenIdOnSkill(a: { admittedAt: string; skillId: string }, b: { admittedAt: string; skillId: string }): number {
  const order = byInstant(a.admittedAt, b.admittedAt)
  return order !== 0 ? order : a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0
}
