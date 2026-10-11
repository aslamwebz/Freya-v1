import type { AttentionProjection } from '../../protocol/attention'
import type { ConsciousApprovalView, ConsciousAttentionView, ConsciousWaitingView } from '../../protocol/consciousness'
import type { OfficePresenceRequest } from '../../office/types'
import type { WorkProjection } from '../../work/projection'
import type { WorkforceProjection } from '../../workforce/types'
import { CONSCIOUS_CONTEXT_LIMITS, byInstant } from '../types'
import { absentMeta } from './metadata'
import { byInstantThenIdOnRun } from './self-focus'

export interface WaitingInput {
  readonly work: WorkProjection | null
  readonly workforce: WorkforceProjection | null
  readonly presenceRequests: readonly OfficePresenceRequest[]
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
export function buildAttention(attention: AttentionProjection | null, now: Date): ConsciousAttentionView {
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
export function buildWaiting(input: WaitingInput, now: Date): ConsciousWaitingView {
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

export function byInstantThenIdOnTask(a: { updatedAt: string; taskId: string }, b: { updatedAt: string; taskId: string }): number {
  const order = byInstant(a.updatedAt, b.updatedAt)
  return order !== 0 ? order : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}
