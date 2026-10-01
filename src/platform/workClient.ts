import type { CoreCommandName, WorkCommandOutcome } from '../../core/protocol/core-protocol'
import { ABSENT_WORK_PROJECTION, type WorkProjection } from '../../core/work/projection'
import type { TaskStatus } from '../../core/work/types'
import { hostBridge } from './host'

/**
 * The renderer's view of Work.
 *
 * A mirror, in the same sense `brainClient` and `conversationClient` are: every
 * field arrived over IPC from Core and the renderer cannot write one. There is no
 * renderer-side copy of what Freya is doing, because a local list built from local
 * edits would be a second source of truth about execution — and the one everybody
 * would trust more than the journal.
 *
 * ## What a window may and may not ask for
 *
 * `createTask` takes a title. It does **not** take a status, a source or a
 * priority, because those are decisions about whether work matters and only Core
 * and the owner make them.
 *
 * `createRun` takes a *plan*: a list of steps, each naming a capability, a
 * verifier, a label and its input. It does **not** take a verdict, an outcome, a
 * principal, a risk class or a ceiling that could exceed Core's own — none of those
 * are fields to send, and the bridge refuses a plan that arrives with anything
 * else attached. The plan is a request to execute, not a claim about what happened.
 *
 * `decide` takes a decision and nothing else. There is no `decidedBy`, because a
 * window that could name its own approver could approve its own request; Core
 * assigns the identity from the principal that reached the command.
 */

export interface WorkMirror {
  readonly projection: WorkProjection | null
  subscribe(listener: (projection: WorkProjection | null) => void): () => void
  attach(): Promise<() => void>

  createTask(title: string): Promise<WorkCommandOutcome>
  updateTask(taskId: string, status: TaskStatus): Promise<WorkCommandOutcome>

  /** Plan a run. It is created `queued`; nothing executes until `start`. */
  createRun(input: {
    steps: readonly {
      key: string
      label: string
      capability: string
      verifier: string
      input?: Record<string, unknown>
      requiresApproval?: boolean
    }[]
    taskId?: string
    limits?: Record<string, number>
  }): Promise<WorkCommandOutcome>

  startRun(runId: string): Promise<WorkCommandOutcome>
  pauseRun(runId: string): Promise<WorkCommandOutcome>
  resumeRun(runId: string): Promise<WorkCommandOutcome>
  /** Scoped: stops one run. Does not latch STOP ALL. */
  cancelRun(runId: string, reason?: string): Promise<WorkCommandOutcome>

  decide(
    approvalId: string,
    decision: 'approved' | 'denied',
    reason?: string,
  ): Promise<WorkCommandOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the Brain mirror's absent state. */
const ABSENT: WorkProjection = ABSENT_WORK_PROJECTION

let shared: WorkMirror | null = null
let attachPromise: Promise<WorkMirror> | null = null

export function workMirror(): WorkMirror {
  shared ??= createWorkMirror()
  return shared
}

export function ensureWorkAttached(): Promise<WorkMirror> {
  attachPromise ??= workMirror().attach().then(() => workMirror())
  return attachPromise
}

export function resetWorkMirror(): void {
  shared = null
  attachPromise = null
}

export function createWorkMirror(): WorkMirror {
  const listeners = new Set<(projection: WorkProjection | null) => void>()
  let current: WorkProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: WorkProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Submit one Work command and return Core's own outcome.
   *
   * A Core that cannot be reached resolves with a refusal rather than rejecting,
   * because a window reloading mid-call should produce a sentence on screen and not
   * an unhandled rejection in somebody's console. `ok: false` travels with it, so a
   * refusal can never be mistaken for success by a caller that reads the flag.
   */
  const submit = async (command: CoreCommandName, payload?: unknown): Promise<WorkCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      return { operation: 'unavailable', ok: false, reason: 'the Core bridge is not available in this window' }
    }
    let result
    try {
      result = await bridge.coreSubmit(command, payload)
    } catch (error) {
      return {
        operation: 'unreachable',
        ok: false,
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    return (result.work as WorkCommandOutcome | undefined) ?? {
      operation: 'unknown',
      ok: false,
      reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no Work result',
    }
  }

  return {
    get projection() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    createTask: (title) => submit('work.task.create', { title }),

    updateTask: (taskId, status) => submit('work.task.update', { taskId, status }),

    createRun: (input) =>
      submit('work.run.create', {
        steps: input.steps.map((step) => ({
          key: step.key,
          label: step.label,
          capability: step.capability,
          verifier: step.verifier,
          ...(step.input === undefined ? {} : { input: step.input }),
          ...(step.requiresApproval === true ? { requiresApproval: true } : {}),
        })),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      }),

    startRun: (runId) => submit('work.run.start', { runId }),

    pauseRun: (runId) => submit('work.run.pause', { runId }),

    resumeRun: (runId) => submit('work.run.resume', { runId }),

    cancelRun: (runId, reason) =>
      submit('work.run.cancel', reason === undefined ? { runId } : { runId, reason }),

    decide: (approvalId, decision, reason) =>
      submit('work.approval.decide', {
        approvalId,
        decision,
        ...(reason === undefined ? {} : { reason }),
      }),

    async attach(): Promise<() => void> {
      disposeBridge?.()
      const bridge = hostBridge()
      if (!bridge) {
        publish(ABSENT)
        return () => {}
      }
      disposeBridge = bridge.onCoreWork((projection) => publish(projection))
      // Backstop for a push that raced the subscription, same as for status,
      // conversation and Brain.
      try {
        publish((await bridge.coreWork()) ?? ABSENT)
      } catch {
        publish(ABSENT)
      }
      return disposeBridge
    },

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}

/**
 * Whether Freya's execution history will still be here after a restart.
 *
 * Deliberately narrow, and it is always true when the engine exists at all: Work
 * keeps its history in the event journal rather than in a store of its own, so
 * there is no "ephemeral Work" state to report. The function exists so a board can
 * ask the question rather than assume it, and so that the day a store arrives with
 * a key that can be missing, the answer has somewhere to come from.
 */
export function isWorkDurable(projection: WorkProjection | null): boolean {
  return projection !== null && projection.health === 'ready'
}