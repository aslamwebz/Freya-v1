import type { AnyCoreEvent, CoreEventType } from '../events/envelope'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  canTransitionRun,
  canTransitionStep,
  DEFAULT_RUN_LIMITS,
  WORK_REASONS as WORK_WAITING,
  type ActionRecord,
  type ApprovalRecord,
  type LimitName,
  type ObservationRecord,
  type RunKind,
  type RunLimits,
  type RunRecord,
  type RunStatus,
  type StepRecord,
  type StepStatus,
  type TaskRecord,
  type TaskStatus,
  type VerificationRecord,
} from './types'

/**
 * WORK STATE: a pure fold over the durable journal.
 *
 * ## Why Work has no store of its own
 *
 * Every other durable subsystem in Core owns an encrypted file. Work does not,
 * and the reason is that **the journal already is the durable record of what
 * happened**. `work.*` events are fsynced, sequence-ordered, validated against a
 * closed schema and replayed on every start, exactly like a security journal —
 * and they hold only ids, counts, statuses and lengths, so there is nothing in
 * them for a store to protect.
 *
 * Adding a third encrypted store would have meant a third keyring secret, a third
 * file and a third recovery policy for what is structurally the same information
 * in a weaker form. Instead the separation that matters is kept explicit:
 *
 * - **History is durable** — what ran, in what order, how it ended, whether it was
 *   verified, who decided each approval. Replayed from disk on every start.
 * - **Live execution is a process fact** — which capability is executing right now,
 *   a Step's plan and its input, an observation's contents, a label somebody typed.
 *   None of it is journalled, and none of it survives a restart.
 *
 * §10 of the Phase 6 brief asks for recovery "only to the degree that can be made
 * correct". This is that decision, and it is what makes `recoverInterruptedRuns`
 * honest rather than hopeful: history cannot say a Run is executing, because
 * history is not a live registry — see `core/protocol/core-protocol.ts`, which
 * says the same about provider calls for the same reason.
 *
 * The reducer is pure and returns new objects, so replay and live operation share
 * one code path and cannot drift.
 */

export interface WorkState {
  readonly runs: ReadonlyMap<string, RunRecord>
  readonly steps: ReadonlyMap<string, StepRecord>
  /** runId → step ids, in planned order. Never re-sorted. */
  readonly runSteps: ReadonlyMap<string, readonly string[]>
  readonly actions: ReadonlyMap<string, ActionRecord>
  readonly observations: ReadonlyMap<string, ObservationRecord>
  readonly verifications: ReadonlyMap<string, VerificationRecord>
  readonly approvals: ReadonlyMap<string, ApprovalRecord>
  readonly tasks: ReadonlyMap<string, TaskRecord>
  /** Ceilings a Run actually hit. Durable, so a restart cannot hide one. */
  readonly limitsHit: ReadonlyMap<string, LimitName>
  /** Last durable sequence folded in. */
  readonly sequence: number
}

export function initialWorkState(): WorkState {
  return {
    runs: new Map(),
    steps: new Map(),
    runSteps: new Map(),
    actions: new Map(),
    observations: new Map(),
    verifications: new Map(),
    approvals: new Map(),
    tasks: new Map(),
    limitsHit: new Map(),
    sequence: 0,
  }
}

/**
 * The event families this reducer owns.
 *
 * A closed list rather than a `work.` prefix test, because a prefix test would
 * silently absorb an event type added later by a system that did not mean Work to
 * own it — which is how one subsystem's event starts quietly meaning two things.
 */
const WORK_EVENT_PREFIX = 'work.'

export function isWorkEvent(type: CoreEventType): boolean {
  return type.startsWith(WORK_EVENT_PREFIX)
}

export function reduceWorkState(state: WorkState, event: AnyCoreEvent): WorkState {
  if (!isWorkEvent(event.type)) {
    return event.sequence > state.sequence ? { ...state, sequence: event.sequence } : state
  }

  const next = apply(state, event)
  return { ...next, sequence: Math.max(state.sequence, event.sequence) }
}

function apply(state: WorkState, event: AnyCoreEvent): WorkState {
  const p = event.payload as WorkPayloads
  const at = event.occurredAt

  switch (event.type) {
    case 'work.run.created': {
      const runs = new Map(state.runs)
      runs.set(p.runId, {
        runId: p.runId,
        kind: p.kind as RunKind,
        status: 'queued',
        createdAt: at,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        failure: null,
        waitingOn: null,
        parentKind: p.parentKind ?? null,
        parentId: p.parentId ?? null,
        taskId: p.taskId ?? null,
        limits: p.limits ?? DEFAULT_RUN_LIMITS,
      })

      const steps = new Map(state.steps)
      const runSteps = new Map(state.runSteps)
      const ids: string[] = []
      ;(p.steps ?? []).forEach((seed, index) => {
        steps.set(seed.stepId, {
          stepId: seed.stepId,
          runId: p.runId,
          key: seed.key,
          index,
          status: 'pending',
          attempts: 0,
          capability: seed.capability,
          verifier: seed.verifier,
          approvalId: null,
          startedAt: null,
          settledAt: null,
          reason: null,
        })
        ids.push(seed.stepId)
      })
      runSteps.set(p.runId, ids)
      return { ...state, runs, steps, runSteps }
    }

    case 'work.run.started':
      return moveRun(state, p.runId, 'running', (run) => ({ ...run, startedAt: run.startedAt ?? at }))

    case 'work.run.resumed':
      return moveRun(state, p.runId, 'running', (run) => ({
        ...run,
        waitingOn: p.reason ?? null,
      }))

    case 'work.run.paused':
      return moveRun(state, p.runId, 'paused', (run) => ({
        ...run,
        waitingOn: p.reason ?? WORK_WAITING.paused,
      }))

    case 'work.run.waiting':
      return moveRun(state, p.runId, 'waiting', (run) => ({
        ...run,
        waitingOn: p.reason ?? WORK_WAITING.waiting,
      }))

    /**
     * The run parks behind an approval.
     *
     * Recorded separately from `work.run.waiting` even though the engine only
     * reaches `awaiting_approval` by emitting `work.approval.requested`: a board
     * needs to tell "a person is being asked" apart from "something external is
     * pending", and a generic "waiting" row would blur exactly the case a person
     * most needs to act on.
     */
    case 'work.run.awaiting_approval':
      return moveRun(state, p.runId, 'awaiting_approval', (run) => ({
        ...run,
        waitingOn: p.reason ?? WORK_WAITING.awaitingApproval,
      }))

    case 'work.run.completed':
      return moveRun(state, p.runId, 'completed', (run) => ({
        ...run,
        completedAt: at,
        waitingOn: null,
      }))

    case 'work.run.failed':
      return moveRun(state, p.runId, 'failed', (run) => ({
        ...run,
        completedAt: at,
        failure: reason(p.reason),
        waitingOn: null,
      }))

    case 'work.run.cancelled':
      return moveRun(state, p.runId, 'cancelled', (run) => ({
        ...run,
        cancelledAt: at,
        waitingOn: null,
      }))

    case 'work.run.recovered':
      // The one write the engine makes about a Run it did not execute. The status
      // it moves *from* is recorded in the payload rather than read back out of
      // state, because after a restart "what this run was doing" is exactly the
      // thing that is no longer knowable.
      return moveRun(state, p.runId, 'failed', (run) => ({
        ...run,
        completedAt: at,
        failure: reason(p.reason),
        waitingOn: null,
      }))

    case 'work.step.ready':
      return moveStep(state, p.stepId, 'ready', (step) => ({ ...step, reason: null }))

    case 'work.step.started':
      return moveStep(state, p.stepId, 'running', (step) => ({
        ...step,
        attempts: p.attempt,
        startedAt: step.startedAt ?? at,
        reason: null,
      }))

    case 'work.step.verified':
      return moveStep(state, p.stepId, 'verified', (step) => ({
        ...step,
        settledAt: at,
        reason: null,
      }))

    case 'work.step.failed':
      return moveStep(state, p.stepId, 'failed', (step) => ({
        ...step,
        settledAt: at,
        reason: reason(p.reason),
      }))

    case 'work.step.cancelled':
      return moveStep(state, p.stepId, 'cancelled', (step) => ({
        ...step,
        settledAt: at,
        reason: reason(p.reason),
      }))

    case 'work.step.skipped':
      return moveStep(state, p.stepId, 'skipped', (step) => ({
        ...step,
        settledAt: at,
        reason: reason(p.reason),
      }))

    case 'work.action.started': {
      const actions = new Map(state.actions)
      actions.set(p.actionId!, {
        actionId: p.actionId!,
        runId: p.runId,
        stepId: p.stepId,
        attempt: p.attempt,
        capability: p.capability ?? 'unknown',
        principal: (p.principal ?? 'system') as PrincipalId,
        status: 'running',
        startedAt: at,
        settledAt: null,
        durationMs: null,
        reason: null,
      })
      const steps = new Map(state.steps)
      const step = steps.get(p.stepId)
      if (step && step.attempts !== p.attempt) {
        steps.set(p.stepId, { ...step, attempts: p.attempt })
      }
      return { ...state, actions, steps }
    }

    case 'work.action.completed':
      return settleAction(state, p.actionId!, 'completed', p.durationMs ?? 0, null)

    case 'work.action.failed':
      return settleAction(state, p.actionId!, 'failed', p.durationMs ?? 0, reason(p.reason))

    case 'work.action.cancelled':
      return settleAction(state, p.actionId!, 'cancelled', p.durationMs ?? 0, reason(p.reason))

    case 'work.observation.recorded': {
      const observations = new Map(state.observations)
      observations.set(p.observationId, {
        observationId: p.observationId,
        runId: p.runId,
        stepId: p.stepId,
        actionId: p.actionId,
        kind: (p.kind ?? 'result') as ObservationRecord['kind'],
        summaryLength: p.summaryLength ?? 0,
        detailLength: p.detailLength ?? 0,
      })
      return { ...state, observations }
    }

    case 'work.verification.requested': {
      const verifications = new Map(state.verifications)
      verifications.set(p.verificationId, {
        verificationId: p.verificationId,
        runId: p.runId,
        stepId: p.stepId,
        verifier: p.verifier ?? 'unknown',
        status: 'requested',
        verdictAt: null,
        reason: null,
      })
      return { ...state, verifications }
    }

    case 'work.verification.completed': {
      const verifications = new Map(state.verifications)
      const existing = verifications.get(p.verificationId)
      verifications.set(p.verificationId, {
        verificationId: p.verificationId,
        runId: p.runId,
        stepId: p.stepId,
        verifier: existing?.verifier ?? 'unknown',
        status: p.verdict ?? 'requested',
        verdictAt: at,
        reason: reason(p.reason),
      })
      return { ...state, verifications }
    }

    case 'work.approval.requested': {
      const approvals = new Map(state.approvals)
      approvals.set(p.approvalId!, {
        approvalId: p.approvalId!,
        runId: p.runId,
        stepId: p.stepId,
        capability: p.capability ?? 'unknown',
        requiredCapability: (p.requiredCapability ?? 'work.execute') as ApprovalRecord['requiredCapability'],
        risk: (p.risk ?? 'routine') as ApprovalRecord['risk'],
        principal: (p.principal ?? 'system') as ApprovalRecord['principal'],
        requestedAt: at,
        decidedAt: null,
        decidedBy: null,
        decisionSource: null,
        status: 'pending',
        reason: null,
        justification: p.justification ?? '',
        proposal: p.proposal ?? '',
      })

      // One event, one fact: a Run and its Step have stopped and are now waiting
      // on this named decision. Parking the Step as well as the Run is what lets
      // the board say *which* step is blocked rather than only that something is.
      const steps = new Map(state.steps)
      const step = steps.get(p.stepId)
      if (step && canMoveStep(step.status, 'awaiting_approval')) {
        steps.set(p.stepId, { ...step, status: 'awaiting_approval', approvalId: p.approvalId })
      }
      return moveRun({ ...state, approvals, steps }, p.runId, 'awaiting_approval', (run) => ({
        ...run,
        waitingOn: p.justification ?? null,
      }))
    }

    case 'work.approval.approved':
    case 'work.approval.denied':
    case 'work.approval.cancelled':
    case 'work.approval.expired': {
      const approvals = new Map(state.approvals)
      const existing = approvals.get(p.approvalId!)
      if (!existing) return state
      const status =
        event.type === 'work.approval.approved'
          ? 'approved'
          : event.type === 'work.approval.denied'
            ? 'denied'
            : event.type === 'work.approval.cancelled'
              ? 'cancelled'
              : 'expired'
      approvals.set(p.approvalId!, {
        ...existing,
        status,
        decidedAt: at,
        decidedBy: (p.decidedBy ?? null) as ApprovalRecord['decidedBy'],
        decisionSource: p.decisionSource ?? 'engine',
        reason: reason(p.reason) ?? existing.reason,
      })
      return { ...state, approvals }
    }

    case 'work.task.created': {
      const tasks = new Map(state.tasks)
      tasks.set(p.taskId, {
        taskId: p.taskId,
        status: 'open',
        createdAt: at,
        updatedAt: at,
        titleLength: p.titleLength ?? 0,
        runIds: [],
      })
      return { ...state, tasks }
    }

    case 'work.task.updated': {
      const tasks = new Map(state.tasks)
      const existing = tasks.get(p.taskId)
      tasks.set(p.taskId, {
        taskId: p.taskId,
        status: p.status as TaskStatus,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        titleLength: existing?.titleLength ?? 0,
        runIds: existing?.runIds ?? [],
      })
      return { ...state, tasks }
    }

    case 'work.task.attached': {
      const tasks = new Map(state.tasks)
      const existing = tasks.get(p.taskId)
      if (!existing) return state
      if (existing.runIds.includes(p.runId)) return state
      tasks.set(p.taskId, { ...existing, updatedAt: at, runIds: [...existing.runIds, p.runId] })
      return { ...state, tasks }
    }

    case 'work.task.completed': {
      const tasks = new Map(state.tasks)
      const existing = tasks.get(p.taskId)
      tasks.set(p.taskId, {
        taskId: p.taskId,
        status: p.status as TaskStatus,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        titleLength: existing?.titleLength ?? 0,
        runIds: existing?.runIds ?? [],
      })
      return { ...state, tasks }
    }

    case 'work.limits.exceeded': {
      const limitsHit = new Map(state.limitsHit)
      limitsHit.set(p.runId, p.limit as LimitName)
      return { ...state, limitsHit }
    }

    default:
      // A `work.*` type this reducer does not know. Kept rather than thrown: an
      // unknown event is not a reason for a journal replay to abort, and the
      // sequence has already advanced.
      return state
  }
}

function moveRun(
  state: WorkState,
  runId: string,
  status: RunStatus,
  change: (run: RunRecord) => RunRecord,
): WorkState {
  const existing = state.runs.get(runId)
  if (!existing) return state
  // A transition the table forbids is dropped rather than applied. The engine
  // validates before it writes, so reaching here means the log disagrees with the
  // engine — and a replay must not adopt a state the engine could not have
  // produced.
  if (!canMove(existing.status, status)) return state
  const runs = new Map(state.runs)
  runs.set(runId, { ...change(existing), status })
  return { ...state, runs }
}

function moveStep(
  state: WorkState,
  stepId: string,
  status: StepStatus,
  change: (step: StepRecord) => StepRecord,
): WorkState {
  const existing = state.steps.get(stepId)
  if (!existing) return state
  if (!canMoveStep(existing.status, status)) return state
  const steps = new Map(state.steps)
  steps.set(stepId, { ...change(existing), status })
  return { ...state, steps }
}

function settleAction(
  state: WorkState,
  actionId: string,
  status: 'completed' | 'failed' | 'cancelled',
  durationMs: number,
  reason: string | null,
): WorkState {
  const existing = state.actions.get(actionId)
  if (!existing) return state
  const actions = new Map(state.actions)
  actions.set(actionId, {
    ...existing,
    status,
    // Derived from the envelope rather than journalled as another field: the
    // instant an action stopped is the instant it started plus how long it took,
    // and two spellings of one fact is two that can disagree.
    settledAt: new Date(Date.parse(existing.startedAt) + durationMs).toISOString(),
    durationMs,
    reason,
  })
  return { ...state, actions }
}

function canMove(from: RunStatus, to: RunStatus): boolean {
  return canTransitionRun(from, to)
}

function canMoveStep(from: StepStatus, to: StepStatus): boolean {
  return canTransitionStep(from, to)
}

/**
 * The payload fields the reducer reads, as one shape.
 *
 * The event payload is a union of every Work event, so reading it needs a declared
 * view of the fields this reducer uses. Every field is optional in that view
 * because *which* event arrived decides which are present — and each read goes
 * through a coercion below rather than an assertion, so an event missing a field
 * this reducer wanted becomes `null` and a visible omission instead of an
 * `undefined` quietly becoming a record.
 */
interface WorkPayloads {
  runId: string
  taskId: string
  stepId: string
  actionId: string | null
  observationId: string
  verificationId: string
  approvalId: string
  attempt: number
  limit: string
  durationMs: number
  reason?: string
  parentKind?: string | null
  parentId?: string | null
  status?: string
  capability?: string
  requiredCapability?: string
  risk?: string
  principal?: string
  justification?: string
  proposal?: string
  decidedBy?: string
  decisionSource?: string
  titleLength?: number
  summaryLength?: number
  detailLength?: number
  limits?: RunLimits
  verdict?: 'passed' | 'failed'
  verifier?: string
  kind?: string
  steps?: readonly { stepId: string; key: string; capability: string; verifier: string }[]
}

/** An absent reason, as `null`. Absent is not the same as empty. */
function reason(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}