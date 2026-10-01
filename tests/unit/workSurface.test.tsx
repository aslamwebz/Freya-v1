// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { WorkSurface } from '../../src/ui/surfaces/WorkSurface'
import { resetWorkMirror } from '../../src/platform/workClient'
import { ABSENT_WORK_PROJECTION, type WorkProjection } from '../../core/work/projection'
import type { WorkCommandOutcome } from '../../core/protocol/core-protocol'

/**
 * The Work board.
 *
 * The properties worth a test here are about *authority*, because that is what a
 * board is most likely to erode:
 *
 *   - Every value shown is Core's. The window cannot assert that a step verified,
 *     cannot say who decided an approval, and cannot mark a run done.
 *   - A refusal reads as a refusal, with Core's own words, rather than as a
 *     failure the window invented.
 *   - An approval is rendered with enough to decide it — the capability, the
 *     effect, and why it needs a person — and nothing that would let the window
 *     decide it on Core's behalf.
 */

let coreSubmit: ReturnType<typeof vi.fn>
let current: WorkProjection

const LIMITS = {
  maxSteps: 64,
  maxActions: 128,
  maxDurationMs: 900_000,
  maxAttemptsPerStep: 3,
}

function base(over: Partial<WorkProjection> = {}): WorkProjection {
  return {
    ...ABSENT_WORK_PROJECTION,
    health: 'ready',
    reason: null,
    detailAvailable: true,
    runsRetained: 0,
    runsTotal: 0,
    runsHidden: 0,
    capabilities: ['test.record', 'test.consequential'],
    verifiers: ['test.record.matches', 'test.change.applied'],
    limits: LIMITS,
    ...over,
    counts: {
      runs: 0,
      queued: 0,
      running: 0,
      waiting: 0,
      awaitingApproval: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pendingApprovals: 0,
      tasks: 0,
      liveCapabilities: 0,
      ...over.counts,
    },
  }
}

function step(over: Partial<WorkProjection['runs'][number]['steps'][number]> = {}) {
  return {
    stepId: 'step-1',
    key: 'record',
    index: 0,
    status: 'verified' as const,
    attempts: 1,
    capability: 'test.record',
    verifier: 'test.record.matches',
    startedAt: '2026-04-01T09:00:00.000Z',
    settledAt: '2026-04-01T09:00:01.000Z',
    reason: null,
    label: 'Record the first note',
    approvalId: null,
    ...over,
  }
}

function run(over: Partial<WorkProjection['runs'][number]> = {}) {
  return {
    runId: 'run-1',
    kind: 'deterministic' as const,
    status: 'completed' as const,
    createdAt: '2026-04-01T09:00:00.000Z',
    startedAt: '2026-04-01T09:00:00.000Z',
    completedAt: '2026-04-01T09:00:02.000Z',
    cancelledAt: null,
    failure: null,
    waitingOn: null,
    taskId: null,
    parentKind: null,
    parentId: null,
    limitHit: null,
    steps: [step()],
    actions: [],
    observations: [],
    verifications: [],
    live: false,
    progress: {
      stepsTotal: 1,
      verified: 1,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      remaining: 0,
      actions: 1,
      attempts: 1,
      percent: 100,
      summary: '1 of 1 steps verified',
    },
    ...over,
  }
}

function outcome(over: Partial<WorkCommandOutcome> = {}): WorkCommandOutcome {
  return { operation: 'run-started', ok: true, runId: 'run-1', ...over }
}

/**
 * A bridge whose push and whose read always agree.
 *
 * The mirror subscribes and then reads, so a bridge that pushed one value and
 * returned another would leave the board showing whichever the read happened to
 * be. Keeping them in step makes a failure mean something.
 */
/**
 * Push a projection.
 *
 * With `deliver: false` the value is only made readable — which is what a Core
 * that has not pushed yet looks like. The mirror attaches by subscribing and then
 * reading, so this is the case where the surface must say "I don't know" rather
 * than render an empty board that reads like "there is no work".
 */
function push(projection: WorkProjection, options: { deliver?: boolean } = {}): void {
  current = projection
  window.freyaHost!.coreWork = (async () => current) as never
  window.freyaHost!.onCoreWork = ((handler: (p: WorkProjection) => void) => {
    if (options.deliver !== false) handler(current)
    return () => {}
  }) as never
}

beforeEach(() => {
  // The mirror is a module singleton, so a test that swaps the bridge has to drop
  // the old subscription first.
  resetWorkMirror()
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: true, durableSequence: 7, work: outcome() }))
  window.freyaHost = {
    isDesktop: true,
    getRuntimeInfo: vi.fn(),
    loadWorkspace: vi.fn(),
    saveWorkspace: vi.fn(),
    onCollect: vi.fn(),
    coreSubmit: coreSubmit as never,
    coreWork: (async () => current) as never,
    onCoreWork: (() => () => {}) as never,
  } as never
  push(base())
})

afterEach(() => {
  cleanup()
  delete window.freyaHost
})

function renderSurface() {
  render(<WorkSurface />)
}

describe('the Work board reads Core', () => {
  it('says it is waiting rather than showing an empty board', () => {
    // A Core that has not pushed yet. An empty board here would read as "Freya has
    // no work", which is a different and much more misleading statement.
    push(ABSENT_WORK_PROJECTION, { deliver: false })
    renderSurface()
    expect(screen.getByText(/waiting for freya core/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing is executing/i)).not.toBeInTheDocument()
  })

  it('states the limits before anything can be planned', () => {
    renderSurface()
    expect(screen.getByText('IDLE')).toBeInTheDocument()
    expect(screen.getByText(/up to 64 steps, 128 capability calls, 15 minutes, and 3 attempts per step/i)).toBeInTheDocument()
  })

  it('reports that detail does not survive a restart, rather than showing blanks', () => {
    push(
      base({
        detailAvailable: false,
        runs: [run({ steps: [step({ label: null })] })],
        counts: { runs: 1, completed: 1 } as never,
      }),
    )
    renderSurface()
    // Structural progress survives; the label does not, and the board says so once
    // in the posture strip rather than rendering an empty field per step.
    expect(screen.getByText(/step detail is not/i)).toBeInTheDocument()
    expect(screen.getByText(/1 of 1 steps verified/i)).toBeInTheDocument()
  })

  it('shows structural progress rather than a percentage it cannot justify', () => {
    push(
      base({
        runs: [
          run({
            status: 'failed',
            completedAt: null,
            failure: 'the observation reported something else',
            percent: undefined,
            progress: {
              stepsTotal: 3,
              verified: 1,
              failed: 1,
              cancelled: 0,
              skipped: 1,
              remaining: 0,
              actions: 2,
              attempts: 2,
              percent: null,
              summary: '1 of 3 steps verified, 1 failed, 1 skipped',
            },
          } as never),
        ],
        counts: { runs: 1, failed: 1 } as never,
      }),
    )
    renderSurface()
    expect(screen.getByText(/1 of 3 steps verified, 1 failed, 1 skipped/i)).toBeInTheDocument()
    // No percentage is offered, because a run that will never progress again has
    // no honest percentage.
    expect(screen.queryByText(/% of steps verified/)).not.toBeInTheDocument()
  })

  it('shows a failed run as failed, with the reason', () => {
    push(
      base({
        runs: [
          run({
            status: 'failed',
            completedAt: null,
            failure: 'the observation reports "mismatch", which is not "something-else"',
            steps: [step({ status: 'failed', reason: 'which is not "something-else"' })],
          } as never),
        ],
        counts: { runs: 1, failed: 1 } as never,
      }),
    )
    renderSurface()
    expect(screen.getByText('failed')).toBeInTheDocument()
    // Once at the run level and once at the step, because the two are different
    // facts: the run could not finish, and this is the step that stopped it.
    expect(screen.getAllByText(/is not "something-else"/)).toHaveLength(2)
  })

  it('says an approval has not run anything yet', () => {
    push(
      base({
        runs: [
          run({
            status: 'awaiting_approval',
            completedAt: null,
            waitingOn: 'this capability is consequential and will not run without your approval',
            steps: [step({ status: 'awaiting_approval', label: 'Apply a consequential effect' })],
          } as never),
        ],
        approvals: [
          {
            approvalId: 'apr-1',
            runId: 'run-1',
            stepId: 'step-1',
            status: 'pending',
            capability: 'test.consequential',
            requiredCapability: 'work.execute',
            risk: 'consequential',
            requestedAt: '2026-04-01T09:00:00.000Z',
            decidedAt: null,
            decidedBy: null,
            decisionSource: null,
            reason: null,
            justification: 'this capability is consequential and will not run without your approval',
            proposal: 'would apply this effect: overwrite the local configuration',
          },
        ],
        counts: { runs: 1, awaitingApproval: 1, pendingApprovals: 1 } as never,
      }),
    )
    renderSurface()
    expect(screen.getByText(/nothing has run for an approval below/i)).toBeInTheDocument()
    expect(screen.getByText(/overwrite the local configuration/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument()
  })
})

describe('the Work board commands Core', () => {
  it('submits a plan rather than asserting an outcome', async () => {
    renderSurface()
    screen.getByRole('button', { name: /run until it asks/i }).click()

    await waitFor(() => expect(coreSubmit).toHaveBeenCalledTimes(2))
    const [createCall, startCall] = coreSubmit.mock.calls as unknown as [
      [string, unknown],
      [string, unknown],
    ]
    expect(createCall[0]).toBe('work.run.create')
    expect(startCall[0]).toBe('work.run.start')

    const plan = (createCall[1] as { steps: Record<string, unknown>[] }).steps
    expect(plan.map((entry) => entry.key)).toEqual(['record', 'consequential'])
    // Nothing in the plan says anything about how it ends. A window cannot carry a
    // verdict, a status or an outcome — there is no field to send.
    for (const entry of plan) {
      expect(Object.keys(entry).sort()).toEqual(['capability', 'input', 'key', 'label', 'verifier'])
    }
  })

  it('decides an approval without naming who decided it', async () => {
    push(
      base({
        approvals: [
          {
            approvalId: 'apr-1',
            runId: 'run-1',
            stepId: 'step-1',
            status: 'pending',
            capability: 'test.consequential',
            requiredCapability: 'work.execute',
            risk: 'consequential',
            requestedAt: '2026-04-01T09:00:00.000Z',
            decidedAt: null,
            decidedBy: null,
            decisionSource: null,
            reason: null,
            justification: 'consequential',
            proposal: 'would apply this effect',
          },
        ],
        counts: { pendingApprovals: 1 } as never,
      }),
    )
    renderSurface()
    screen.getByRole('button', { name: /approve/i }).click()

    await waitFor(() => expect(coreSubmit).toHaveBeenCalled())
    const [call, payload] = coreSubmit.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(call).toBe('work.approval.decide')
    expect(payload.decision).toBe('approved')
    expect(payload.approvalId).toBe('apr-1')
    // There is no `decidedBy` to send, and no principal: a window that could name
    // its own approver could approve its own request.
    expect(Object.keys(payload).sort()).toEqual(['approvalId', 'decision', 'reason'])
  })

  it('shows a refusal as a refusal, with Core\'s own words', async () => {
    coreSubmit.mockImplementation(async (command: string) =>
      command === 'work.run.start'
        ? {
            requestId: 'r1',
            ok: false,
            refusal: { reason: 'Freya is stopped' },
            work: { operation: 'run-started', ok: false, reason: 'Freya is stopped' },
          }
        : { requestId: 'r2', ok: true, work: outcome({ operation: 'run-created', runId: 'run-9' }) },
    )
    renderSurface()
    screen.getByRole('button', { name: /run until it asks/i }).click()

    const reply = await screen.findByRole('alert')
    expect(reply).toHaveTextContent('Freya is stopped')
    // And the failure is not softened into something that reads as progress.
    expect(reply).not.toHaveTextContent(/completed/i)
  })

  it('cancels one run rather than latching anything global', async () => {
    push(
      base({
        runs: [run({ status: 'running', completedAt: null })],
        counts: { runs: 1, running: 1, liveCapabilities: 1 } as never,
      }),
    )
    renderSurface()
    screen.getByRole('button', { name: /^cancel$/i }).click()

    await waitFor(() => expect(coreSubmit).toHaveBeenCalled())
    const [call] = coreSubmit.mock.calls[0] as unknown as [string]
    // `work.run.cancel` — not `security.stopAll`. Cancelling one run is a scoped
    // control, and the panic button remains a separate and much larger thing.
    expect(call).toBe('work.run.cancel')
  })

  it('never offers a control that would close a step', () => {
    push(
      base({
        runs: [run({ status: 'running', completedAt: null })],
        counts: { runs: 1, running: 1 } as never,
      }),
    )
    renderSurface()
    // A step closes on a verifier, in Core. A window with a "mark done" button would
    // make the whole verification boundary decorative.
    expect(screen.queryByRole('button', { name: /mark .*done|verify|complete/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument()
  })
})

describe('the Work board holds nothing of its own', () => {
  it('keeps no work state that a reload could lose', () => {
    push(
      base({
        runs: [run()],
        tasks: [
          {
            taskId: 'task-1',
            status: 'open',
            createdAt: '2026-04-01T09:00:00.000Z',
            updatedAt: '2026-04-01T09:00:00.000Z',
            runIds: ['run-1'],
            title: 'ship the thing',
            titleLength: 14,
          },
        ],
        counts: { runs: 1, completed: 1, tasks: 1 } as never,
      }),
    )
    renderSurface()
    expect(screen.getByText('ship the thing')).toBeInTheDocument()
    // Nothing is stored here. A reload re-reads the projection and finds the same
    // thing, because the thing is in Core and not in this window.
    expect(screen.getByText(/1 of 1 steps verified/i)).toBeInTheDocument()
  })

  it('says what Core can actually run, and lists only names', () => {
    renderSurface()
    expect(screen.getByText('test.record · test.consequential')).toBeInTheDocument()
    // Names only. A window that could reach a capability could describe its own
    // approval, which is the one thing it must not be able to do.
    expect(window.freyaHost).not.toHaveProperty('capability')
    expect(window.freyaHost).not.toHaveProperty('registry')
  })

  it('says how many runs it is not listing, rather than dropping them silently', () => {
    // A board that stopped listing runs without saying so would read as "they
    // finished and went away", which is the false impression a bounded viewer is
    // most likely to create.
    push(base({ runs: [run()], runsRetained: 1, runsTotal: 400, runsHidden: 399 }))
    renderSurface()
    expect(screen.getByText(/showing the 1 most recent of 400 runs/i)).toBeInTheDocument()
    expect(screen.getByText(/399 older runs are kept in/i)).toBeInTheDocument()
    expect(screen.getByText(/still counted, just not listed here/i)).toBeInTheDocument()
  })

  it('says nothing about retention while nothing has been dropped', () => {
    push(base({ runs: [run()], runsRetained: 1, runsTotal: 1, runsHidden: 0 }))
    renderSurface()
    expect(screen.queryByText(/most recent of/i)).not.toBeInTheDocument()
  })

  it('reports an engine that is not up rather than an empty board', () => {
    push({
      ...ABSENT_WORK_PROJECTION,
      reason: 'the Work engine is not available',
    })
    renderSurface()
    expect(screen.getByText(/the work engine is not available/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing is executing/i)).not.toBeInTheDocument()
  })
})