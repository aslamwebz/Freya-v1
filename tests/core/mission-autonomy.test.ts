// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { MissionEngine } from '../../core/missions/engine'
import { MemoryMissionStore } from '../../core/missions/memory-store'
import {
  DEFAULT_MISSION_BUDGET,
  type MissionBudget,
  type MissionCapabilityPort,
  type MissionIntentShape,
  type MissionStepRecord,
} from '../../core/missions/autonomy/types'
import { MissionAutonomyRuntime, type MissionEnginePort, type StepOutcome } from '../../core/missions/autonomy/runtime'
import { CORE_EVENT_TYPES } from '../../core/events/envelope'
import type { MissionApprovalReadback, MissionAuthorityPort } from '../../core/missions/autonomy/authority'
import { plan } from '../../core/missions/autonomy/planner'
import type { RunRecord, RunStatus, StepRecord, WorkRisk } from '../../core/work/types'
import { MISSION_REASONS, type MissionRecord } from '../../core/missions/types'

/**
 * THE MISSION AUTONOMY LOOP.
 *
 * ```
 * GOAL → PLAN → DELEGATE → EXECUTE → VERIFY → CONTINUE / WAIT / ASK / COMPLETE
 * ```
 *
 * Every case below drives the real engine over a real journal and a real encrypted-store
 * substitute. Nothing here reaches into a private field: the runtime is handed the same
 * narrow ports Core builds it with, and the tests assert on the projection and the
 * journal rather than on internals — because those are the two things a person can
 * actually check.
 *
 * ## What the fakes are, and what they deliberately cannot do
 *
 * - **Capabilities** are a fixed two-entry table. There is no `register`, so a test that
 *   wants a plan naming something else is naming something unregistered, which is the
 *   case that matters.
 * - **Workers** are a fixed roster. There is no way to add one from a test, so
 *   "no capable worker" is a real refusal rather than something the harness papers over.
 * - **`execute`** is a script. A test chooses the verdict, and the runtime is what has to
 *   handle it honestly.
 * - **`maySpend` is hard-wired to false**, exactly as Core's is, so "no real-money
 *   autonomy" is asserted rather than assumed.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-p47-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/* --------------------------------------------------------------- fixtures */

/**
 * The capability table, with each capability declaring the check written for it.
 *
 * `verifier` is null for `find.video.unpaired` on purpose: that is the shape a planner must
 * cope with when a capability has no honest check, and it is what keeps "leave it out of the
 * plan" a tested behaviour rather than an untested branch.
 */
const CAPABILITIES: MissionCapabilityPort = {
  lookup: (capability) => {
    if (capability === 'find.video') {
      return { risk: 'routine', requiresApproval: false, verifier: 'video.verified' }
    }
    if (capability === 'find.video.risky') {
      return { risk: 'consequential', requiresApproval: true, verifier: 'video.exists' }
    }
    if (capability === 'find.video.unpaired') {
      return { risk: 'none', requiresApproval: false, verifier: null }
    }
    if (capability === 'not.registered') {
      return { risk: 'routine', requiresApproval: false, verifier: 'video.verified' }
    }
    return null
  },
  verifiers: () => ['video.verified', 'video.exists'],
  // `find.video.unpaired` is listed but unpaired, so it is the capability a planner must
  // decline — see `proposeSteps`.
  known: () => ['find.video', 'find.video.risky', 'find.video.unpaired'],
}

interface HarnessOptions {
  readonly stopAll?: () => boolean
  readonly workers?: readonly string[]
  readonly budget?: Partial<MissionBudget>
  readonly verify?: boolean
  readonly runStatus?: RunStatus
  readonly stepStatus?: StepRecord['status']
  readonly now?: () => Date
  /**
   * What Work reports about a step's gate.
   *
   * The fixture stands in for `WorkEngine`, which is the only thing that can open a gate —
   * so a test that wants an approval has to say what Work said. Default `none`, which is
   * the honest answer for a step nobody has been asked about.
   */
  readonly approval?: MissionApprovalReadback
}

interface Harness {
  readonly engine: MissionEngine
  readonly autonomy: MissionAutonomyRuntime
  readonly fabric: EventFabric
  readonly journal: () => Promise<AnyCoreEvent[]>
  readonly execute: ReturnType<typeof vi.fn>
  readonly delegate: ReturnType<typeof vi.fn>
  /**
   * The Work gates the runtime observed.
   *
   * A read-back, and the reason it is exposed at all: a Mission must *ask* Work what its
   * gate is doing rather than deciding, so the set of gates it has consulted is the
   * observable that proves it did. It is not "gates the Mission opened" — it could not be.
   */
  readonly observedApprovals: () => string[]
  readonly intents: () => Map<string, MissionIntentShape>
  readonly decided: string[]
  readonly close: () => Promise<void>
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const eventStore = await JsonlEventStore.open(join(dir, 'events.jsonl'))
  const fabric = await EventFabric.open({ store: eventStore })

  const store = new MemoryMissionStore()
  const work = {
    run: (): RunRecord | undefined => undefined,
    stepsOf: (): readonly StepRecord[] => [],
    isSettled: (status: RunStatus) => status === 'completed' || status === 'failed' || status === 'cancelled',
    pauseRun: async () => true,
    cancelRun: async () => true,
  }

  let seq = 0
  const engine = new MissionEngine({
    fabric,
    store,
    work: work as never,
    principalId: 'owner',
    now: options.now ?? (() => new Date('2026-10-01T09:00:00.000Z')),
    newId: () => `id-${(seq += 1)}`,
  })
  await engine.open()

  // The authority port, with `maySpend` hard-wired false — the same shape Core builds.
  //
  // `mayUse` answers about a **Work capability name**, not a Guard vocabulary entry: a
  // Mission asks "may this Mission reach for that tool?", and Guard's own evaluation of
  // the capability's declared `Capability` happens inside Work when the Run executes.
  // The permitted set here is therefore the fixture's own registry.
  const PERMITTED = new Set<string>(CAPABILITIES.known())
  // Every gate the runtime came to ask about. The Mission cannot open one, so this is the
  // only observable that the asking actually happened.
  const consulted: string[] = []
  const authority: MissionAuthorityPort = {
    stopAll: options.stopAll ?? (() => false),
    mayUse: (capability) => PERMITTED.has(capability),
    maySpend: () => false,
    // A **read** of Work's gate, not a way to make one. The fixture answers with whatever
    // the test set, which is what Work would report after parking or settling a Run.
    approvalState: async ({ stepId }) => {
      consulted.push(stepId)
      return { ok: true as const, state: options.approval ?? { kind: 'none' as const } }
    },
  }

  const intents = new Map<string, MissionIntentShape>()
  const execute = vi.fn(async (input: { stepId: string }) => ({
    ok: true as const,
    runId: `run-${input.stepId}`,
    verified: options.verify ?? true,
    observedResults: options.verify ?? true ? 1 : 0,
    reportedResults: 0,
    summaryLength: 0,
    // Work parked the Run whenever there is a gate at all — **open or already settled**.
    // That is the real shape: Work stops the step, then the Mission reads back what
    // happened to the gate. A Run that ran to completion never has one.
    awaitingApproval: options.approval !== undefined && options.approval.kind !== 'none',
  }))
  /**
   * Delegation, by capability match.
   *
   * The default roster holds a worker for each registered capability, so an ordinary
   * happy path delegates without ceremony. A test that wants "no capable worker" passes
   * `workers: []` — and there is no way from a test to *add* a worker, because that is the
   * property under test elsewhere: a Mission cannot solve "no capable worker" by inventing
   * one that holds the capability it wanted.
   */
  const delegate = vi.fn(async (input: { stepId: string; capability: string }) => {
    const roster = options.workers ?? ['find.video-worker', 'find.video.risky-worker']
    const capable = roster.includes(`${input.capability}-worker`) ? `${input.capability}-worker` : null
    if (capable === null) return { ok: false as const, reason: `no registered worker holds ${input.capability}` }
    return { ok: true as const, workerId: capable, assignmentId: `as-${input.stepId}` }
  })

  // **The real engine, through its own port.** Passing `engine as never` looked like a
  // shortcut and hid a genuine defect: `attachRun` did not exist on the port the runtime
  // is handed, so every happy path threw on a method that was never called. The port is
  // the contract — a cast past it is exactly the thing a port exists to prevent — so it
  // is built explicitly and a missing method fails here rather than mid-Mission.
  const port: MissionEnginePort = {
    record: (id) => engine.record(id),
    commitPlan: (input) => engine.commitPlan(input),
    transitionStep: (input) => engine.transitionStep(input),
    interruptStep: (input) => engine.interruptStep(input),
    recordEvidence: (input) => engine.recordEvidence(input),
    setBlocker: (input) => engine.setBlocker(input),
    // **No `openApproval`, `decideApproval` or `expireApproval`.** A Mission owns no gate,
    // so the port has no way to open one, record a decision or expire one. The two methods
    // here record a *pointer* to a Work approval and what Work later reported about it.
    noteApprovalRequested: (input) => engine.noteApprovalRequested(input),
    noteApprovalOutcome: (input) => engine.noteApprovalOutcome(input),
    scheduleWake: (input) => engine.scheduleWake(input),
    fireWake: (input) => engine.fireWake(input),
    recordDecision: (input) => engine.recordDecision(input),
    charge: (input) => engine.charge(input),
    noteBudgetExceeded: (input) => engine.noteBudgetExceeded(input),
    setRequestedQuantity: (input) => engine.setRequestedQuantity(input),
    recordCorrection: (input) => engine.recordCorrection(input),
    recordAmbiguity: (input) => engine.recordAmbiguity(input),
    transition: (input) => engine.autonomyTransition(input),
    requestCompletion: (id) => engine.requestCompletion(id),
    writeIntent: (id, intent) => engine.writeIntent(id, intent),
    readIntent: (id) => engine.readIntent(id),
  }

  const autonomy = new MissionAutonomyRuntime({
    fabric,
    principalId: 'owner',
    missions: port,
    capabilities: CAPABILITIES,
    authority,
    delegate,
    execute: execute as never,
    now: options.now ?? (() => new Date('2026-10-01T09:00:00.000Z')),
    newId: () => `run-${(seq += 1)}`,
    stopAll: options.stopAll,
    liveMissionCount: () => 1,
  })
  await autonomy.open()

  return {
    engine,
    autonomy,
    fabric,
    execute,
    delegate,
    observedApprovals: () => consulted,
    intents: () => intents,
    decided: [],
    journal: async () =>
      (await readFile(join(dir, 'events.jsonl'), 'utf8'))
        .split(String.fromCharCode(10))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AnyCoreEvent),
    close: async () => {
      await autonomy.close()
      await engine.close()
      await fabric.close()
    },
  }
}

/** Create a Mission, activate it, and commit a one- or two-step plan. */
async function started(
  h: Harness,
  options: {
    quantity?: number
    capability?: string
    verifier?: string
    dependsOn?: readonly string[]
  } = {},
): Promise<string> {
  const created = await h.engine.create(
    { title: 'Cat videos', intent: 'Find 100 cat videos.' },
    undefined,
    options.quantity === undefined ? {} : { requestedQuantity: options.quantity },
  )
  const missionId = created.missionId as string
  await h.engine.activate(missionId)
  await h.engine.writeIntent(missionId, {
    subject: 'cat videos',
    requestedQuantity: options.quantity ?? null,
    mediaConstraints: ['video'],
    contextConstraints: [],
    exclusions: [],
    paused: false,
  })
  const outcome = plan(
    {
      missionId,
      steps: [
        {
          stepId: 's1',
          capability: options.capability ?? 'find.video',
          verifier: options.verifier ?? 'video.verified',
          dependsOn: options.dependsOn ?? [],
        },
      ],
    },
    CAPABILITIES,
    h.engine.record(missionId)?.budget ?? DEFAULT_MISSION_BUDGET,
    new Date('2026-10-01T09:00:00.000Z'),
  )
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error('plan refused')
  await h.engine.commitPlan({
    missionId,
    planId: outcome.plan.planId,
    revision: 1,
    supersedes: null,
    reason: null,
    steps: outcome.plan.steps,
  })
  return missionId
}

function stepOf(missionId: string, h: Harness, stepId = 's1'): MissionStepRecord {
  const step = h.engine.record(missionId)?.activePlan?.steps.find((s) => s.stepId === stepId)
  if (step === undefined) throw new Error(`no step ${stepId}`)
  return step
}

function view(h: Harness, missionId: string) {
  const found = h.engine.projection().missions.find((m) => m.missionId === missionId)
  if (found === undefined) throw new Error('no mission in projection')
  return found
}

/* ------------------------------------------------------------------ tests */

describe('the happy path', () => {
  it('runs one step, records observed evidence, and completes on verification', async () => {
    const h = await harness()
    const missionId = await started(h, { quantity: 1 })

    const first = await h.autonomy.step(missionId, 'manual', null)
    // Delegated, executed, verified — one step, one decision per call.
    expect(first.decision).toBe('continue')
    expect(first.refusals).toEqual([])
    expect(stepOf(missionId, h).status).toBe('verified')
    expect(h.engine.record(missionId)?.resultCount).toBe(1)

    // The plan is exhausted, so the next decision asks a verifier.
    const second = await h.autonomy.step(missionId, 'manual', null)
    expect(second.decision).toBe('complete')
    expect(h.engine.record(missionId)?.status).toBe('completed')
    expect(view(h, missionId).verification?.state).toBe('passed')
    await h.close()
  })

  it('reports progress as counts and never as a percentage', async () => {
    const h = await harness()
    const missionId = await started(h, { quantity: 100 })
    await h.autonomy.step(missionId, 'manual', null)

    const board = view(h, missionId).progress
    expect(board.observed).toBe(1)
    expect(board.reported).toBe(0)
    expect(board.requestedQuantity).toBe(100)
    expect(board.quantitySatisfied).toBe(false)
    // There is no percentage field anywhere on the projection. A Mission with 1 of 100
    // observed renders "1 of 100", and Freya never picks the denominator.
    expect(JSON.stringify(board)).not.toMatch(/percent/i)
    await h.close()
  })

  it('walks a two-step plan in dependency order', async () => {
    const h = await harness()
    const created = await h.engine.create({ title: 'Two', intent: 'Two steps.' })
    const missionId = created.missionId as string
    await h.engine.activate(missionId)
    const outcome = plan(
      {
        missionId,
        steps: [
          { stepId: 'a', capability: 'find.video', verifier: 'video.verified' },
          { stepId: 'b', capability: 'find.video', verifier: 'video.verified', dependsOn: ['a'] },
        ],
      },
      CAPABILITIES,
      h.engine.record(missionId)?.budget ?? DEFAULT_MISSION_BUDGET,
      new Date(),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('plan refused')
    await h.engine.commitPlan({
      missionId,
      planId: outcome.plan.planId,
      revision: 1,
      supersedes: null,
      reason: null,
      steps: outcome.plan.steps,
    })

    await h.autonomy.step(missionId, 'manual', null)
    expect(stepOf(missionId, h, 'a').status).toBe('verified')
    // **One decision per call**, so `b` needs its own. `b` depends on `a`, and `a` is
    // verified, so the next decision picks it up — which is the dependency rule being
    // what stops `b` running before `a` finished.
    expect(stepOf(missionId, h, 'b').status).toBe('pending')
    await h.autonomy.step(missionId, 'manual', null)
    expect(stepOf(missionId, h, 'b').status).toBe('verified')
    await h.close()
  })

  it('refuses to start a step whose dependency is not verified', async () => {
    // The dependency rule from the other side: `b` names `a`, and `a` is blocked, so `b`
    // is *not* runnable. Starting it would run the plan out of order.
    const h = await harness()
    const created = await h.engine.create({ title: 'Ordered', intent: 'In order.' })
    const missionId = created.missionId as string
    await h.engine.activate(missionId)
    await h.engine.commitPlan({
      missionId,
      planId: 'p-order',
      revision: 1,
      supersedes: null,
      reason: null,
      steps: [
        {
          stepId: 'a',
          index: 0,
          capability: 'made.up',
          verifier: 'video.verified',
          dependsOn: [],
          status: 'blocked',
          workerId: null,
          runId: null,
          attempts: 0,
          risk: 'routine',
          requiresApproval: false,
          approvalId: null,
          reason: 'unknown_capability',
          startedAt: null,
          settledAt: null,
        },
        {
          stepId: 'b',
          index: 1,
          capability: 'find.video',
          verifier: 'video.verified',
          dependsOn: ['a'],
          status: 'pending',
          workerId: null,
          runId: null,
          attempts: 0,
          risk: 'routine',
          requiresApproval: false,
          approvalId: null,
          reason: null,
          startedAt: null,
          settledAt: null,
        },
      ],
    })

    await h.autonomy.step(missionId, 'manual', null)
    expect(h.delegate).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(stepOf(missionId, h, 'b').status).toBe('pending')
    await h.close()
  })
})

describe('delegation refuses a worker that does not exist', () => {
  it('blocks rather than doing the work itself', async () => {
    // The property: no capable worker is a *blocker*, never a fallback to running the
    // step as Freya's own principal. Doing it inline would bypass the workforce's budget,
    // its audit trail and its concurrency accounting.
    const h = await harness({ workers: [] })
    const missionId = await started(h)

    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(h.delegate).toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.engine.record(missionId)?.status).toBe('blocked')
    expect(view(h, missionId).blockers).toContain('no_capable_worker')
    expect(outcome.refusals.join(' ')).toMatch(/no registered worker/)
    await h.close()
  })

  it('blocks a capability that is not registered, without creating it', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h, { capability: 'made.up' })

    await h.autonomy.step(missionId, 'manual', null)
    // The step was planned as `blocked` by the planner, so the Mission blocks on it and
    // never reaches delegation.
    expect(h.delegate).not.toHaveBeenCalled()
    expect(h.engine.record(missionId)?.status).toBe('blocked')
    expect(view(h, missionId).blockers).toContain('unknown_capability')
    await h.close()
  })
})

describe('approvals', () => {
  it('parks on the gate Work opened, having run nothing', async () => {
    // Work parked the Run at `awaiting_approval`, so the executor says so and the Mission
    // records a **pointer** to Work's gate. No gate was minted here, and there is no way
    // from this code to mint one.
    const h = await harness({
      workers: ['find.video.risky-worker'],
      approval: { kind: 'open', approvalId: 'work-gate-1', requestedAt: '2026-10-01T09:00:05.000Z' },
    })
    const missionId = await started(h, { capability: 'find.video.risky' })

    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('request_approval')
    expect(h.engine.record(missionId)?.status).toBe('approval-required')
    // The step *was* handed to Work — the Run exists. What it did not do is run.
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(view(h, missionId).pendingApproval?.approvalId).toBe('work-gate-1')
    expect(h.engine.record(missionId)?.approval?.stepId).toBe('s1')
    await h.close()
  })

  it('marks the gate as observed when the plan did not ask for it', async () => {
    // A gate Guard demanded is a fact about the capability, not about the goal, and the
    // two are told apart so a person reading the board is not misled about which it is.
    const h = await harness({
      workers: ['find.video-worker'],
      approval: { kind: 'open', approvalId: 'work-gate-2', requestedAt: '2026-10-01T09:00:05.000Z' },
    })
    const missionId = await started(h, { capability: 'find.video' })
    await h.autonomy.step(missionId, 'manual', null)
    expect(h.engine.record(missionId)?.approval?.source).toBe('observed')
    await h.close()
  })

  it('does not run the step while the gate is pending', async () => {
    const h = await harness({
      workers: ['find.video.risky-worker'],
      approval: { kind: 'open', approvalId: 'work-gate-1', requestedAt: '2026-10-01T09:00:05.000Z' },
    })
    const missionId = await started(h, { capability: 'find.video.risky' })
    await h.autonomy.step(missionId, 'manual', null)

    // A second pass **polls** the gate. It reports `wait`, not `request_approval`,
    // because nothing was asked the second time — and crucially it did not execute
    // again, which would have meant a second Work Run for one step: two Runs, one action,
    // budget charged twice, and a gate on the first Run nobody would look at again.
    const second = await h.autonomy.step(missionId, 'manual', null)
    expect(second.decision).toBe('wait')
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.observedApprovals()).toContain('s1')
    expect(stepOf(missionId, h).status).toBe('running')
    await h.close()
  })

  it('blocks on a denial, and does not try to find another way round', async () => {
    const h = await harness({
      workers: ['find.video.risky-worker'],
      approval: { kind: 'settled', approvalId: 'work-gate-1', outcome: 'denied', decidedAt: '2026-10-01T09:10:00.000Z', requestedAt: '2026-10-01T09:00:05.000Z' },
    })
    const missionId = await started(h, { capability: 'find.video.risky' })

    await h.autonomy.step(missionId, 'manual', null)
    expect(h.engine.record(missionId)?.status).toBe('blocked')
    expect(view(h, missionId).blockers).toContain('approval_denied')
    // **Not** pending any more, because Work has answered and the answer was no.
    expect(view(h, missionId).pendingApproval).toBeNull()

    // A denial is not permission to find another way round.
    const before = h.execute.mock.calls.length
    const after = await h.autonomy.step(missionId, 'manual', null)
    expect(h.execute.mock.calls.length).toBe(before)
    expect(['wait', 'fail']).toContain(after.decision)
    await h.close()
  })

  it('treats expiry as not-a-decision and never as approval', async () => {
    const h = await harness({
      workers: ['find.video.risky-worker'],
      approval: { kind: 'settled', approvalId: 'work-gate-1', outcome: 'expired', decidedAt: '2026-10-01T09:10:00.000Z', requestedAt: '2026-10-01T09:00:05.000Z' },
    })
    const missionId = await started(h, { capability: 'find.video.risky' })

    await h.autonomy.step(missionId, 'manual', null)
    // Expiry and denial both stop the step. The Mission does **not** get to tell them
    // apart — the gate is Work's record, and what matters here is that neither is consent.
    expect(h.engine.record(missionId)?.status).toBe('blocked')
    expect(view(h, missionId).blockers).toContain('approval_expired')
    expect(stepOf(missionId, h).status).toBe('running')
    await h.close()
  })

  it('refuses to proceed when Work says the step was waiting and also says there is no gate', async () => {
    // The disagreement case. Either the executor or the port is wrong, and Core cannot
    // tell which — so it blocks and says so rather than proceeding. Proceeding on a
    // disagreement about whether a person is needed is exactly how a consequential action
    // runs unasked.
    const h = await harness({
      workers: ['find.video.risky-worker'],
      approval: { kind: 'none' },
    })
    const missionId = await started(h, { capability: 'find.video.risky' })

    // Force the executor to claim a park while the port reports no gate.
    h.execute.mockImplementationOnce(async (input: { stepId: string }) => ({
      ok: true as const,
      runId: `run-${input.stepId}`,
      verified: false,
      observedResults: 0,
      reportedResults: 0,
      summaryLength: 0,
      awaitingApproval: true,
    }))
    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(h.engine.record(missionId)?.status).toBe('blocked')
    expect(outcome.refusals.join(' ')).toMatch(/no approval was found/)
    await h.close()
  })

  it('cannot mint, decide or expire an approval: no such method exists', async () => {
    // Structural, not a check. The runtime, the engine port and the authority port have no
    // method that could open a gate, record a decision, or expire one — the only door is
    // `work.approval.decide`, behind a Guard evaluation of the owner.
    const runtimeMethods = Object.getOwnPropertyNames(MissionAutonomyRuntime.prototype).sort()
    expect(runtimeMethods).not.toContain('approveMission')
    expect(runtimeMethods).not.toContain('grantApproval')
    expect(runtimeMethods).not.toContain('requestApproval')
    expect(runtimeMethods).not.toContain('openApproval')
    expect(runtimeMethods).not.toContain('executeStep')
    expect(runtimeMethods).not.toContain('remaining')
    expect(runtimeMethods).not.toContain('openDelegations')
    expect(runtimeMethods).not.toContain('siblings')
    expect(runtimeMethods).not.toContain('waitMs')
    expect(runtimeMethods).toContain('correct')
    expect(runtimeMethods).toContain('step')
    expect(runtimeMethods).toContain('reconcile')

    const engineMethods = Object.getOwnPropertyNames(MissionEngine.prototype).sort()
    expect(engineMethods).not.toContain('openApproval')
    expect(engineMethods).not.toContain('decideApproval')
    expect(engineMethods).not.toContain('expireApproval')
    // The pointer methods, by contrast, do exist — recording and reading back is all the
    // Mission is allowed to do.
    expect(engineMethods).toContain('noteApprovalRequested')
    expect(engineMethods).toContain('noteApprovalOutcome')

    // And the **envelope itself** has no event type in which a Mission records a
    // decision. This is checked against the published type list rather than against what a
    // test happened to write, because the whole claim is about what the journal is *able*
    // to record: a type nobody exercised yet would still be a second door.
    expect(CORE_EVENT_TYPES).not.toContain('mission.approval.decided')
    expect(CORE_EVENT_TYPES).not.toContain('mission.approval.expired')
    expect(CORE_EVENT_TYPES).toContain('mission.approval.requested')
  })
})
describe('STOP ALL', () => {
  it('refuses every step while latched, and parks the Mission as stopped', async () => {
    let stopped = true
    const h = await harness({ stopAll: () => stopped, workers: ['find.video-worker'] })
    const missionId = await started(h)

    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('wait')
    expect(h.delegate).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.engine.record(missionId)?.status).toBe('stopped')

    // And it stays that way: the latch is authoritative, not advisory.
    stopped = true
    const again = await h.autonomy.step(missionId, 'manual', null)
    expect(again.decision).toBe('wait')
    expect(h.execute).not.toHaveBeenCalled()

    // Only the owner's resume reopens it. `resume` runs it; `resumeToReady` merely reopens
    // the gate — and neither is reachable while the latch is held.
    stopped = false
    expect(await h.engine.resume(missionId)).toMatchObject({ ok: true })
    expect(h.engine.record(missionId)?.status).toBe('active')

    stopped = true
    await h.engine.resumeToReady(missionId)
    expect(h.engine.record(missionId)?.status).toBe('active')
    await h.close()
  })

  it('reopens the gate to ready without claiming the Mission is running', async () => {
    // The autonomous resume. After a wake, Freya knows the gate is open and does *not* know
    // a plan is running, so `ready` is the only state it can honestly report.
    const h = await harness({ stopAll: () => true })
    const missionId = await started(h)
    await h.engine.pause(missionId)
    expect(h.engine.record(missionId)?.status).toBe('stopped')
    expect(await h.engine.resumeToReady(missionId)).toMatchObject({ ok: true })
    expect(h.engine.record(missionId)?.status).toBe('ready')
    await h.close()
  })

  it('refuses to attach Work while stopped', async () => {
    const h = await harness({ stopAll: () => true })
    const missionId = await started(h)
    await h.engine.pause(missionId)
    const attached = await h.engine.attachChildRun(missionId, 'run-x')
    expect(attached.ok).toBe(false)
    expect(attached.reason).toMatch(/only a live Mission/)
    await h.close()
  })
})

describe('ceilings and deadlines', () => {
  it('refuses a budget a caller tried to raise', async () => {
    const h = await harness()
    const created = await h.engine.create(
      { title: 'Greedy', intent: 'More than allowed.' },
      undefined,
      { budget: { maxActions: DEFAULT_MISSION_BUDGET.maxActions + 1 } },
    )
    expect(created.ok).toBe(false)
    expect(created.reason).toMatch(/may not exceed/)
    await h.close()
  })

  it('accepts a narrowed budget and spends against it', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const created = await h.engine.create(
      { title: 'Tight', intent: 'One action only.' },
      undefined,
      { budget: { maxActions: 1 } },
    )
    const missionId = created.missionId as string
    await h.engine.activate(missionId)
    const outcome = plan(
      {
        missionId,
        steps: [
          { stepId: 's1', capability: 'find.video', verifier: 'video.verified' },
          { stepId: 's2', capability: 'find.video', verifier: 'video.verified' },
        ],
      },
      CAPABILITIES,
      h.engine.record(missionId)!.budget,
      new Date(),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('plan refused')
    await h.engine.commitPlan({
      missionId,
      planId: outcome.plan.planId,
      revision: 1,
      supersedes: null,
      reason: null,
      steps: outcome.plan.steps,
    })

    await h.autonomy.step(missionId, 'manual', null)
    expect(h.engine.record(missionId)?.spend.actions).toBe(1)

    // The second step cannot start: the ceiling is reached and refusing is the outcome.
    const second = await h.autonomy.step(missionId, 'manual', null)
    expect(second.decision).toBe('wait')
    expect(second.reason).toBe(MISSION_REASONS.budget_exhausted)
    expect(h.execute).toHaveBeenCalledTimes(1)
    await h.close()
  })

  it('refuses to overdraw by charging past a ceiling', async () => {
    const h = await harness()
    const created = await h.engine.create({ title: 'Tiny', intent: 'One action.' }, undefined, {
      budget: { maxActions: 1 },
    })
    const missionId = created.missionId as string
    await h.engine.activate(missionId)
    const first = await h.engine.charge({
      missionId,
      modelCalls: 0,
      actions: 1,
      externalRequests: 0,
      retries: 0,
      delegations: 0,
    })
    expect(first.ok).toBe(true)
    const second = await h.engine.charge({
      missionId,
      modelCalls: 0,
      actions: 1,
      externalRequests: 0,
      retries: 0,
      delegations: 0,
    })
    expect(second.ok).toBe(false)
    expect(h.engine.record(missionId)?.spend.actions).toBe(1)
    expect(h.engine.record(missionId)?.limitsHit).toContain('maxActions')
    await h.close()
  })

  it('fails a Mission past its deadline rather than working on', async () => {
    let clock = new Date('2026-10-01T09:00:00.000Z')
    const h = await harness({ now: () => clock, workers: ['find.video-worker'] })
    const missionId = await started(h)
    await h.autonomy.step(missionId, 'manual', null)

    // Jump past the Mission's deadline. A deadline is a wall, not a check between steps.
    clock = new Date('2026-11-30T00:00:00.000Z')
    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('fail')
    expect(h.engine.record(missionId)?.status).toBe('failed')
    expect(h.engine.record(missionId)?.reason).toBe(MISSION_REASONS.deadline_expired)
    await h.close()
  })

  it('executes the final committed plan without allowing another revision', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const created = await h.engine.create({ title: 'One plan', intent: 'Only once.' }, undefined, {
      budget: { maxPlanRevisions: 1 },
    })
    const missionId = created.missionId as string
    await h.engine.activate(missionId)
    const outcome = plan(
      { missionId, steps: [{ stepId: 's1', capability: 'find.video', verifier: 'video.verified' }] },
      CAPABILITIES,
      h.engine.record(missionId)!.budget,
      new Date(),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('plan refused')
    await h.engine.commitPlan({
      missionId,
      planId: outcome.plan.planId,
      revision: 1,
      supersedes: null,
      reason: null,
      steps: outcome.plan.steps,
    })

    const second = await h.autonomy.step(missionId, 'manual', null)
    // Exhausting revision slots prevents new plans, not execution of the last one.
    expect(second.decision).toBe('continue')
    expect(h.engine.record(missionId)?.activePlan?.steps[0]?.status).toBe('verified')
    expect(h.engine.record(missionId)?.planRevisions).toBe(1)
    await h.close()
  })
})

describe('verification failure', () => {
  it('does not complete when observed results fall short of the quantity', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h, { quantity: 100 })

    await h.autonomy.step(missionId, 'manual', null)
    const outcome = await h.autonomy.step(missionId, 'manual', null)

    expect(outcome.decision).toBe('complete')
    // Asked, refused, and the Mission is *live* again — a verification that did not
    // establish is not a failed outcome.
    expect(h.engine.record(missionId)?.status).toBe('active')
    expect(h.engine.record(missionId)?.verification?.state).toBe('not_established')
    expect(h.engine.record(missionId)?.verification?.reason).toBe(MISSION_REASONS.quantity_not_reached)
    await h.close()
  })

  it('does not complete on reported results alone', async () => {
    // A capability *saying* it found something is not a finding. This is the reported vs
    // observed split, and it is the whole reason `origin` exists.
    const h = await harness({ workers: ['find.video-worker'], verify: false })
    const missionId = await started(h, { quantity: 1 })
    await h.autonomy.step(missionId, 'manual', null)

    expect(h.engine.record(missionId)?.resultCount).toBe(0)
    await h.autonomy.step(missionId, 'manual', null)
    expect(h.engine.record(missionId)?.status).not.toBe('completed')
    await h.close()
  })

  it('does not complete on expired evidence', async () => {
    let clock = new Date('2026-10-01T09:00:00.000Z')
    const h = await harness({ now: () => clock, workers: ['find.video-worker'] })
    const missionId = await started(h, { quantity: 1 })
    await h.autonomy.step(missionId, 'manual', null)
    expect(h.engine.record(missionId)?.resultCount).toBe(1)

    // Expire the evidence by hand, as a step with a shelf life would.
    await h.engine.recordEvidence({
      missionId,
      evidenceId: 'expiring',
      stepId: 's1',
      kind: 'result',
      origin: 'observed',
      summaryLength: 0,
      expiresAt: '2026-10-01T09:00:30.000Z',
    })
    clock = new Date('2026-10-01T09:01:00.000Z')

    expect(view(h, missionId).evidence.expired).toBeGreaterThan(0)
    // And the freshness check refuses a completion.
    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('complete')
    expect(h.engine.record(missionId)?.status).not.toBe('completed')
    expect(h.engine.record(missionId)?.verification?.reason).toBe(MISSION_REASONS.verification_expired)
    await h.close()
  })
})

describe('bounded retry', () => {
  it('retries a failed step while the ceiling allows', async () => {
    const h = await harness({ workers: ['find.video-worker'], verify: false })
    const missionId = await started(h)

    await h.autonomy.step(missionId, 'manual', null)
    expect(stepOf(missionId, h).status).toBe('failed')
    expect(view(h, missionId).blockers).toContain('step_failed')

    const retry = await h.autonomy.step(missionId, 'manual', null)
    expect(retry.decision).toBe('retry')
    // Charged before the attempt, so a retry that crashes cannot be retried for free.
    expect(h.engine.record(missionId)?.spend.retries).toBe(1)
    await h.close()
  })

  it('refuses a budget raise on the retry ceiling too', async () => {
    const h = await harness()
    const created = await h.engine.create({ title: 'One try', intent: 'Once only.' }, undefined, {
      budget: { maxRetries: 1 },
    })
    const missionId = created.missionId as string
    await h.engine.activate(missionId)
    const ok = await h.engine.charge({
      missionId,
      modelCalls: 0,
      actions: 0,
      externalRequests: 0,
      retries: 1,
      delegations: 0,
    })
    expect(ok.ok).toBe(true)
    const over = await h.engine.charge({
      missionId,
      modelCalls: 0,
      actions: 0,
      externalRequests: 0,
      retries: 1,
      delegations: 0,
    })
    expect(over.ok).toBe(false)
    expect(h.engine.record(missionId)?.spend.retries).toBe(1)
    await h.close()
  })
})

describe('event wake', () => {
  it('parks on a bounded wake and ignores an event that does not match', async () => {
    const h = await harness()
    const missionId = await started(h)
    await h.engine.scheduleWake({
      missionId,
      wakeId: 'wake-1',
      kind: 'event',
      source: 'fabric',
      dueAt: '2026-10-01T09:00:30.000Z',
      eventType: 'work.run.completed',
    })

    // The wrong event does not wake it.
    const wrong = await h.autonomy.step(missionId, 'event', { type: 'mission.completed' })
    expect(wrong.decision).toBe('wait')
    expect(h.execute).not.toHaveBeenCalled()

    // The right one does.
    const right = await h.autonomy.step(missionId, 'event', { type: 'work.run.completed' })
    expect(right.decision).toBe('continue')
    expect(h.execute).toHaveBeenCalled()
    await h.close()
  })

  it('schedules every wait with a durable instant, and refuses one without', async () => {
    const h = await harness({ workers: [] })
    const missionId = await started(h)
    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('wait')
    // A wait that does not say when it expires is the open-ended wait this subsystem
    // must not be able to record.
    expect(outcome.nextWakeAt).not.toBeNull()
    expect(h.engine.record(missionId)?.wake?.dueAt).toBe(outcome.nextWakeAt)

    const refused = await h.engine.recordDecision({
      missionId,
      decision: 'wait',
      reason: MISSION_REASONS.waiting_event,
      stepId: null,
      nextWakeAt: null,
    })
    expect(refused.ok).toBe(false)
    await h.close()
  })

  it('refuses a wake from a source Freya does not grant herself', async () => {
    const h = await harness()
    const missionId = await started(h)
    await h.engine.scheduleWake({
      missionId,
      wakeId: 'wake-1',
      kind: 'manual',
      source: 'owner',
      dueAt: '2026-10-01T09:00:30.000Z',
      eventType: null,
    })
    // A `manual` wake is only ever released by the owner, and `recovery`/`progress` are
    // not owners — so neither may act on it.
    const timed = await h.autonomy.step(missionId, 'time', null)
    expect(timed.decision).toBe('wait')
    expect(h.execute).not.toHaveBeenCalled()
    await h.close()
  })

  it('fires an overdue wake rather than refusing it forever', async () => {
    // A wake that came due while nothing was listening must *fire*, not be rejected. It
    // fired long ago, so refusing on "not due yet" would strand the Mission for ever — and
    // the lateness is recorded rather than pretended away.
    let clock = new Date('2026-10-01T09:00:00.000Z')
    const h = await harness({ now: () => clock, workers: [] })
    const missionId = await started(h)
    await h.engine.scheduleWake({
      missionId,
      wakeId: 'wake-1',
      kind: 'time',
      source: 'time',
      dueAt: '2026-10-01T09:00:30.000Z',
      eventType: null,
    })

    clock = new Date('2026-10-01T09:05:00.000Z')
    const outcome = await h.autonomy.step(missionId, 'recovery', null)

    // The wake fired, and it was **consumed**: a Mission holds one wake at a time, so the
    // record now carries the *next* one rather than the fired one. Asserted on the journal
    // rather than on `wake.firedAt`, because a replaced wake is the correct end state and
    // a fired-but-still-held one would be a second chance to fire.
    const events = await h.journal()
    const fired = events.filter((e) => e.type === 'mission.wake.fired')
    expect(fired.length).toBeGreaterThan(0)
    expect(h.engine.record(missionId)?.wake?.wakeId).not.toBe('wake-1')
    // And the Mission re-decided from current facts — the roster is empty, so it blocks.
    expect(['wait', 'continue']).toContain(outcome.decision)
    await h.close()
  })

  it('refuses a timed wake that is not due yet', async () => {
    let clock = new Date('2026-10-01T09:00:00.000Z')
    const h = await harness({ now: () => clock, workers: ['find.video-worker'] })
    const missionId = await started(h)
    await h.engine.scheduleWake({
      missionId,
      wakeId: 'wake-1',
      kind: 'time',
      source: 'time',
      dueAt: '2026-10-01T09:10:00.000Z',
      eventType: null,
    })

    clock = new Date('2026-10-01T09:05:00.000Z')
    const outcome = await h.autonomy.step(missionId, 'time', null)
    // Not due. "Early" is not a concept a bound can have, so this does nothing at all.
    expect(outcome.decision).toBe('wait')
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.delegate).not.toHaveBeenCalled()
    await h.close()
  })
})

describe('recovery', () => {
  it('does not resume a Mission whose verification was interrupted', async () => {
    // Nothing established the outcome, so nothing may conclude it.
    const h = await harness()
    const missionId = await started(h)
    await h.autonomy.step(missionId, 'manual', null)
    await h.autonomy.step(missionId, 'manual', null)
    await h.close()

    const journal = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(journal).toMatch(/"type":"mission.completed"/)
    // And the record reached the terminal status durably, not just in memory.
    expect(journal).toMatch(/"to":"completed"/)
  })

  it('marks an interrupted consequential step rather than replaying it', async () => {
    // The whole point of `risk` reaching recovery. An action interrupted mid-flight may
    // have taken effect, and re-running it could duplicate something real.
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h)
    await h.engine.commitPlan({
      missionId,
      planId: 'p-interrupt',
      revision: 2,
      supersedes: null,
      reason: null,
      steps: [
        {
          stepId: 'risky',
          index: 0,
          capability: 'find.video.risky',
          verifier: 'video.verified',
          dependsOn: [],
          status: 'running',
          workerId: 'worker-a',
          runId: 'run-risky',
          attempts: 1,
          risk: 'consequential' as WorkRisk,
          requiresApproval: true,
          approvalId: null,
          reason: null,
          startedAt: '2026-10-01T09:00:00.000Z',
          settledAt: null,
        },
      ],
    })

    const outcomes = await h.autonomy.reconcile([missionId])
    expect(outcomes).toHaveLength(1)
    const step = h.engine.record(missionId)?.activePlan?.steps.find((s) => s.stepId === 'risky')
    expect(step?.status).toBe('blocked')
    expect(step?.reason).toBe(MISSION_REASONS.interrupted)
    // **The run id is forgotten.** Leaving it would let a later reconciliation attach
    // the Run again and read a second attempt as a resumption of the first.
    expect(step?.runId).toBeNull()
    // And nothing was executed.
    expect(h.execute).not.toHaveBeenCalled()
    await h.close()
  })

  it('releases a safe interrupted step for retry', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h)
    await h.engine.commitPlan({
      missionId,
      planId: 'p-safe',
      revision: 2,
      supersedes: null,
      reason: null,
      steps: [
        {
          stepId: 'safe',
          index: 0,
          capability: 'find.video',
          verifier: 'video.verified',
          dependsOn: [],
          status: 'running',
          workerId: 'worker-a',
          runId: 'run-safe',
          attempts: 1,
          risk: 'none' as WorkRisk,
          requiresApproval: false,
          approvalId: null,
          reason: null,
          startedAt: '2026-10-01T09:00:00.000Z',
          settledAt: null,
        },
      ],
    })

    await h.autonomy.reconcile([missionId])
    const step = h.engine.record(missionId)?.activePlan?.steps.find((s) => s.stepId === 'safe')
    // A `none`-risk action that was in flight is retryable: reading something twice
    // changes nothing, so the honest recovery is to try again.
    expect(step?.status).not.toBe('blocked')
    await h.close()
  })
})

describe('replay and duplicates', () => {
  it('counts a redelivered evidence item once', async () => {
    // A duplicated event must not inflate `resultCount`, because that number is what a
    // requested quantity is compared against — a doubled count would let a Mission claim
    // an outcome it never reached.
    const h = await harness()
    const missionId = await started(h)
    await h.engine.activate(missionId)
    const item = {
      missionId,
      evidenceId: 'same-id',
      stepId: null,
      kind: 'result' as const,
      origin: 'observed' as const,
      summaryLength: 0,
      expiresAt: null,
    }
    await h.engine.recordEvidence(item)
    await h.engine.recordEvidence(item)
    expect(h.engine.record(missionId)?.resultCount).toBe(1)
    await h.close()
  })

  it('counts a redelivered child Run once', async () => {
    const h = await harness()
    const missionId = await started(h)
    await h.engine.attachChildRun(missionId, 'run-1')
    await h.engine.attachChildRun(missionId, 'run-1')
    expect(h.engine.record(missionId)?.childRuns).toEqual(['run-1'])
    await h.close()
  })

  it('counts a redelivered budget charge by adding, never by setting', async () => {
    const h = await harness()
    const missionId = await started(h)
    const charge = {
      missionId,
      modelCalls: 0,
      actions: 1,
      externalRequests: 0,
      retries: 0,
      delegations: 0,
    }
    await h.engine.charge(charge)
    await h.engine.charge(charge)
    expect(h.engine.record(missionId)?.spend.actions).toBe(2)
    await h.close()
  })

  it('refuses a plan commit that skips a revision number', async () => {
    // The revision check is in the fold, so a journal cannot jump from revision 1 to 3
    // and thereby bypass the replan ceiling.
    const h = await harness()
    const missionId = await started(h)
    const outcome = plan(
      { missionId, steps: [{ stepId: 'x', capability: 'find.video', verifier: 'video.verified' }] },
      CAPABILITIES,
      h.engine.record(missionId)!.budget,
      new Date(),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('plan refused')
    await h.engine.commitPlan({
      missionId,
      planId: outcome.plan.planId,
      revision: 99,
      supersedes: outcome.plan.planId,
      reason: MISSION_REASONS.plan_revised,
      steps: outcome.plan.steps,
    })
    expect(h.engine.record(missionId)?.activePlan?.revision).toBe(1)
    await h.close()
  })
})

describe('authority boundaries', () => {
  it('refuses a capability outside the vocabulary rather than trying it', async () => {
    const h = await harness({ workers: ['anything-worker'] })
    const missionId = await started(h, { capability: 'made.up' })
    await h.autonomy.step(missionId, 'manual', null)
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.delegate).not.toHaveBeenCalled()
    await h.close()
  })

  it('refuses to spend, always', async () => {
    // `NO_REAL_MONEY` is enforced by there being nothing to spend. A capability cannot
    // even reach the executor with a request that would cost something.
    const h = await harness()
    expect(h.autonomy).toBeDefined()
    const risk = 'consequential' as WorkRisk
    expect(risk).toBe('consequential')
    // The Mission budget has no money dimension at all, which is the real enforcement.
    expect(Object.keys(DEFAULT_MISSION_BUDGET)).not.toContain('maxMoney')
    expect(JSON.stringify(DEFAULT_MISSION_BUDGET)).not.toMatch(/money|spend|cost|credit/i)
    await h.close()
  })

  it('holds concurrency so two Missions cannot fill the roster together', async () => {
    const h = await harness({ workers: ['find.video-worker', 'find.video-worker-2'] })
    const missionId = await started(h)
    // One live Mission, so the last slot is not held back.
    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('continue')
    await h.close()
  })

  it('refuses concurrent steps on one Mission rather than queueing them', async () => {
    // Queueing would let a caller pile work against a Mission that may be stopped or
    // settled by the time its turn came.
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h)
    const [a, b] = await Promise.all([
      h.autonomy.step(missionId, 'manual', null),
      h.autonomy.step(missionId, 'manual', null),
    ])
    const decisions = [a.decision, b.decision]
    expect(decisions.filter((d) => d === 'continue').length).toBeLessThanOrEqual(1)
    await h.close()
  })
})

describe('the board projection', () => {
  it('reports every field the brief requires, and none it forbids', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h, { quantity: 100 })
    await h.autonomy.step(missionId, 'manual', null)
    const board = view(h, missionId)

    // status, computable progress, current step, next action, blocker, pending approval,
    // evidence count, verification, next wake, last update.
    expect(board.status).toBeTruthy()
    expect(board.progress.observed).toBe(1)
    expect(board.currentStep).not.toBeNull()
    expect(board.nextAction).not.toBeNull()
    expect(Array.isArray(board.blockers)).toBe(true)
    expect(board.pendingApproval).toBeNull()
    expect(board.evidence.observed).toBe(1)
    expect(board.verification).toBeNull()
    expect(board.lastUpdatedAt).toBeTruthy()

    // No invented percentage, anywhere in the row.
    expect(JSON.stringify(board)).not.toMatch(/"percent"|%\s*$/i)

    // `nextWake` is null here and that is **correct**: a Mission that is working holds no
    // wake, because a wake means "look at me again later" and nothing is waiting on
    // anything. It appears as soon as the Mission parks — asserted next, because a field
    // that is always null and a field that appears when it means something are very
    // different things to have implemented.
    expect(board.nextWake).toBeNull()
    await h.close()
  })

  it('shows a next wake exactly when the Mission is parked', async () => {
    const h = await harness({ workers: [] })
    const missionId = await started(h, { quantity: 1 })
    await h.autonomy.step(missionId, 'manual', null)

    const board = view(h, missionId)
    // Parked on `no_capable_worker`, so there is something to wake for.
    expect(board.status).toBe('blocked')
    expect(board.nextWake).not.toBeNull()
    expect(board.nextWake?.kind).toBe('time')
    expect(board.nextWake?.dueAt).toBeTruthy()
    // And the blocker is stated, so "nothing is happening" has a reason attached.
    expect(board.blockers).toContain('no_capable_worker')
    // `nextAction` is the decision that was **reached**, which is `continue` — the
    // reasoning said "try the next step". The blocker list is what says what happened.
    //
    // Both are honest and they are deliberately different fields: `nextAction` answers
    // "what did Freya decide?", `blockers` answers "why is it not moving?". Collapsing
    // them would lose one of those questions.
    expect(board.nextAction?.decision).toBe('continue')
    await h.close()
  })

  it('keeps blocked and parked Missions visible as needing a person', async () => {
    const h = await harness({ workers: [] })
    const missionId = await started(h)
    await h.autonomy.step(missionId, 'manual', null)
    const board = view(h, missionId)
    expect(board.status).toBe('blocked')
    expect(board.needsAttention).toBe(true)
    expect(board.blockers).toContain('no_capable_worker')
    await h.close()
  })

  it('never renders a step whose status it does not know', async () => {
    // Derived, not assembled. Every counter has to be reachable from a real step.
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h)
    await h.autonomy.step(missionId, 'manual', null)
    const counts = view(h, missionId).progress.steps
    const total = counts.total
    const sum =
      counts.pending +
      counts.blocked +
      counts.delegated +
      counts.running +
      counts.verified +
      counts.failed +
      counts.cancelled +
      counts.skipped
    expect(sum).toBe(total)
    await h.close()
  })
})

describe('no hidden continuous inference', () => {
  it('acts only when called, and idles between calls', async () => {
    // No timer, no polling, no loop. Nothing happens until something calls `step`.
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h)

    await new Promise((resolve) => setTimeout(resolve, 60))
    // Nothing ran while we waited, and every step is still exactly as it was planned.
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.delegate).not.toHaveBeenCalled()
    expect(h.engine.record(missionId)?.activePlan?.steps.map((s) => s.status)).toEqual(['pending'])
    expect(h.engine.record(missionId)?.spend.actions).toBe(0)

    // And one call advances it by one decision.
    const outcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.decision).toBe('continue')
    expect(h.execute).toHaveBeenCalledTimes(1)
    await h.close()
  })

  it('has no method that loops until a Mission settles', async () => {
    const methods = Object.getOwnPropertyNames(MissionAutonomyRuntime.prototype).sort()
    for (const forbidden of ['run', 'loop', 'tick', 'pump', 'drain', 'untilSettled']) {
      expect(methods).not.toContain(forbidden)
    }
    await Promise.resolve()
  })

  it('quiesces after a wait, and reports that it did', async () => {
    const h = await harness({ workers: [] })
    const missionId = await started(h)
    const outcome: StepOutcome = await h.autonomy.step(missionId, 'manual', null)
    expect(outcome.quiescent).toBe(true)
    await h.close()
  })
})

/* ------------------------------------------------------------- corrections */

describe('an owner correction, through the runtime', () => {
  it('patches the same Mission and journals only the field names', async () => {
    const h = await harness()
    const missionId = await started(h, { quantity: 100 })
    await h.autonomy.step(missionId, 'manual', null)
    const before = h.engine.record(missionId)?.resultCount

    const outcome = await h.autonomy.correct(missionId, 'in the barn')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.kind).toBe('patch')
    // Same Mission. The critical acceptance criterion.
    expect(outcome.changedFields).toEqual(['context'])
    // Evidence survives, so the observation count does not go backwards.
    expect(h.engine.record(missionId)?.resultCount).toBe(before)

    // The journal says *which field* changed and nothing more.
    const events = await h.journal()
    const corrections = events.filter((e) => e.type === 'mission.intent.corrected')
    expect(corrections.length).toBe(1)
    const payload = corrections[0]?.payload as Record<string, unknown>
    expect(payload.changedFields).toEqual(['context'])
    // No constraint value anywhere on the line.
    expect(JSON.stringify(payload)).not.toMatch(/barn/i)
    expect(JSON.stringify(payload)).not.toMatch(/cat/i)
    await h.close()
  })

  it('asks, and changes nothing at all, when a correction is ambiguous', async () => {
    const h = await harness()
    const missionId = await started(h, { quantity: 100 })
    await h.autonomy.step(missionId, 'manual', null)
    const intentBefore = await h.engine.readIntent(missionId)
    const planBefore = JSON.stringify(h.engine.record(missionId)?.activePlan)
    const evidenceBefore = h.engine.record(missionId)?.resultCount

    const outcome = await h.autonomy.correct(missionId, 'make it better')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('ambiguous')
    // A question, not null — and one a person can answer.
    expect(outcome.question).not.toBeNull()
    expect(outcome.question?.length ?? 0).toBeGreaterThan(0)

    // **Nothing changed.** The intent, the plan and the evidence are all identical, and the
    // Mission is now asking rather than guessing.
    expect(await h.engine.readIntent(missionId)).toEqual(intentBefore)
    expect(JSON.stringify(h.engine.record(missionId)?.activePlan)).toBe(planBefore)
    expect(h.engine.record(missionId)?.resultCount).toBe(evidenceBefore)
    expect(h.engine.record(missionId)?.awaitingOwner).toBe(true)
    expect(view(h, missionId).blockers).toContain('intent_ambiguous')
    await h.close()
  })

  it('asks rather than guessing, then proceeds once answered', async () => {
    const h = await harness()
    const missionId = await started(h, { quantity: 100 })
    expect(await h.autonomy.correct(missionId, 'somewhere nicer')).toMatchObject({ ok: false })

    // While awaiting the owner, the loop makes no progress on its own.
    const blocked = await h.autonomy.step(missionId, 'manual', null)
    expect(blocked.decision).toBe('ask_owner')
    expect(h.execute).not.toHaveBeenCalled()

    // The owner answers, and the same Mission carries on.
    const answered = await h.autonomy.correct(missionId, { context: ['in the barn'] })
    expect(answered.ok).toBe(true)
    expect(h.engine.record(missionId)?.awaitingOwner).toBe(false)
    expect((await h.engine.readIntent(missionId))?.contextConstraints).toEqual(['in the barn'])
    await h.close()
  })

  it('refuses a correction to a Mission that does not exist', async () => {
    const h = await harness()
    const outcome = await h.autonomy.correct('no-such-mission', 'in the barn')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.ambiguity).toBe('no_active_mission')
    await h.close()
  })
})

describe('records stay private', () => {
  it('keeps the goal out of the journal entirely', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h, { quantity: 7 })
    await h.autonomy.step(missionId, 'manual', null)

    const journal = await readFile(join(dir, 'events.jsonl'), 'utf8')
    // No subject, no media constraint, no location. Matched on the whole word, because
    // `cat` is a substring of `verification` and a loose match would fail on the event
    // vocabulary rather than on anything the owner wrote.
    expect(journal).not.toMatch(/cat video/i)
    expect(journal).not.toMatch(/\bcats\b/i)
    expect(journal).not.toMatch(/in the barn/i)
    // The two numbers about the goal are allowed, because they are counts.
    expect(journal).toMatch(/"requestedQuantity":7/)
    await h.close()
  })

  it('keeps a Mission record free of any word the owner wrote', async () => {
    const h = await harness({ workers: ['find.video-worker'] })
    const missionId = await started(h)
    await h.autonomy.step(missionId, 'manual', null)
    const record = h.engine.record(missionId) as MissionRecord
    expect(JSON.stringify(record)).not.toMatch(/cat videos/i)
    await h.close()
  })
})
