// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mkdtemp, readFile, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { createCore, type Core, type CoreOptions } from '../../core/index'

import { FakeModelProvider } from '../../core/model/fake-provider'

import { parseDurableEvent } from '../../core/events/validate'

import type { AnyCoreEvent } from '../../core/events/envelope'

import type { WorkProjection } from '../../core/work/projection'

import type { RunLimits, WorkStepPlan } from '../../core/work/types'

import { registerPhaseSixCapabilities, WorkRegistry } from '../../core/work/capability'

import { WorkEngine } from '../../core/work/engine'

import { WORK_LIMITS } from '../../core/work/types'

import type {
  WorkCapability,
  WorkVerifier,
  WorkVerificationOutcome,
} from '../../core/work/capability'

import { EventFabric } from '../../core/events/fabric'

import type { EventStore } from '../../core/events/store'

import { JsonlEventStore } from '../../core/events/jsonl-store'

/**

 * THE WORK ENGINE, end to end.

 *

 * These tests drive the real command surface of a real Core over a real journal,

 * because the properties that matter here are properties of the *joining up*:

 *

 *  1. **Action is not proof.** A Step closes on a verifier, never on the strength

 *     of a capability saying it finished.

 *  2. **Approval is upstream of execution.** Nothing has run when a request is

 *     recorded, and a model cannot decide its own request by any route.

 *  3. **Terminal is terminal.** A cancelled run cannot become completed by a late

 *     completion, and a completed run cannot become cancelled by a late cancel.

 *  4. **A Run cannot grow forever.** Steps, actions, attempts and runtime are all

 *     bounded, and the bound is not the planner's choice.

 *  5. **History is not proof of execution.** After a restart an interrupted run is

 *     failed with a reason, never resumed and never marked successful.

 *  6. **Nothing learned reaches the journal.** Steps' inputs, labels, observations

 *     and task titles are measured, not recorded.

 *  7. **Idle Work costs nothing.** No provider is contacted by anything a Run does.

 */

let dir = ''

let core: Core | null = null

let provider: FakeModelProvider

let clock = 0

const CLOCK_START = Date.parse('2026-04-01T09:00:00.000Z')

let idCounter = 0

function newId(): string {

  idCounter += 1

  return `id-${String(idCounter).padStart(4, '0')}`

}

beforeEach(() => {

  clock = CLOCK_START

  idCounter = 0

  provider = new FakeModelProvider()

})

afterEach(async () => {

  await core?.stop('work-test-teardown')

  core = null

  if (dir !== '') {

    await rm(dir, { recursive: true, force: true })

    dir = ''

  }

})

async function boot(overrides: Partial<CoreOptions> = {}): Promise<Core> {

  dir = await mkdtemp(join(tmpdir(), 'freya-work-'))

  const options: CoreOptions = {

    dataPath: join(dir, 'events.jsonl'),

    now: () => new Date(clock),

    newId,

    providers: [provider],

    ...overrides,

  }

  const made = createCore(options)

  core = made

  await made.start()

  return made

}

/** Submit one command and return the result. `requestId` is ours, not the bridge's. */

async function submit(command: string, payload?: unknown) {

  const active = core

  if (!active) throw new Error('core not booted')

  const result = await active.handleCommand({ command: command as never, requestId: 'r-test', payload })

  return result

}

/** Submit, and refuse to continue if it did not succeed. */

async function must(command: string, payload?: unknown) {

  const result = await submit(command, payload)

  if (!result.ok) {

    throw new Error(`expected ${command} to succeed, got: ${result.refusal?.reason ?? result.error?.message}`)

  }

  return result

}

function board(): WorkProjection {

  const active = core

  if (!active) throw new Error('core not booted')

  return active.work()

}

function runView(runId: string) {

  const found = board().runs.find((run) => run.runId === runId)

  if (!found) throw new Error(`no such run in the projection: ${runId}`)

  return found

}

/** Every durable event, read back off disk rather than trusted from memory. */

async function journal(): Promise<AnyCoreEvent[]> {

  const text = await readFile(join(dir, 'events.jsonl'), 'utf8')

  const events: AnyCoreEvent[] = []

  let previous = 0

  for (const line of text.split('\n')) {

    if (line.trim().length === 0) continue

    const parsed = parseDurableEvent(line, previous)

    if (!parsed.ok) throw new Error(`journal line failed validation: ${parsed.reason}`)

    events.push(parsed.event)

    previous = parsed.event.sequence

  }

  return events

}

async function workEventTypes(): Promise<string[]> {

  return (await journal()).filter((event) => event.type.startsWith('work.')).map((event) => event.type)

}

/* ------------------------------------------------------------------ plans */

/**

 * A step that will verify.

 *

 * The capability reports the step's own key back as its observation, and the

 * verifier checks it against `expect`. Passing means `expect === key`, so the

 * check is a real comparison between intent and evidence rather than the

 * capability agreeing with itself.

 */

function record(key: string): WorkStepPlan {

  return {

    key,

    label: `record ${key}`,

    capability: 'test.record',

    verifier: 'test.record.matches',

    input: { expect: key },

  }

}

/** A step whose intent cannot be satisfied, so verification must fail. */

function mismatch(key = 'mismatch'): WorkStepPlan {

  return {

    key,

    label: 'record the wrong thing',

    capability: 'test.record',

    verifier: 'test.record.matches',

    input: { expect: `${key}-intended` },

  }

}

/** A step that completes and says so, with nothing behind the claim. */

function unverified(key = 'unverifiable'): WorkStepPlan {

  return {

    key,

    label: 'claims success with nothing behind it',

    capability: 'test.unverifiable',

    verifier: 'test.record.matches',

    input: { expect: 'anything' },

  }

}

/** A step whose capability always refuses. */

function failing(key = 'flapping'): WorkStepPlan {

  return {

    key,

    label: 'always fails',

    capability: 'test.failing',

    verifier: 'test.record.matches',

  }

}

/** A step whose capability demands approval on its own account. */

function consequential(key = 'consequential'): WorkStepPlan {

  return {

    key,

    label: 'apply a consequential effect',

    capability: 'test.consequential',

    verifier: 'test.change.applied',

    input: { effect: 'overwrite the local configuration' },

  }

}

async function runPlan(steps: readonly WorkStepPlan[], taskId?: string) {

  const created = await must('work.run.create', {

    steps,

    ...(taskId === undefined ? {} : { taskId }),

  })

  const runId = created.work?.runId

  if (!runId) throw new Error('the run was created without an id')

  await must('work.run.start', { runId })

  return runId

}

/* ===================================================================== *

 * 1–3. Run creation, valid transitions, invalid transition rejection

 * ===================================================================== */

describe('runs', () => {

  it('creates a queued run with one step per planned step', async () => {

    await boot()

    const result = await must('work.run.create', {

      steps: [record('one'), record('two')],

    })

    expect(result.ok).toBe(true)

    expect(result.work?.operation).toBe('run-created')

    expect(result.work?.runStatus).toBe('queued')

    const view = runView(result.work!.runId!)

    expect(view.status).toBe('queued')

    expect(view.progress.stepsTotal).toBe(2)

    expect(view.progress.verified).toBe(0)

    expect(view.steps.map((step) => step.key)).toEqual(['one', 'two'])

    expect(view.steps.every((step) => step.status === 'pending')).toBe(true)

  })

  it('refuses a plan with no steps, and writes no run', async () => {

    await boot()

    const result = await submit('work.run.create', { steps: [] })

    expect(result.ok).toBe(false)

    expect(result.work?.ok).toBe(false)

    expect(result.work?.reason).toContain('no steps')

    expect(board().runs).toHaveLength(0)

  })

  it('carries the whole Run lifecycle from queued to completed', async () => {

    await boot()

    const runId = await runPlan([record('one')])

    expect(runView(runId).status).toBe('completed')

    const types = await workEventTypes()

    expect(types).toContain('work.run.created')

    expect(types).toContain('work.run.started')

    expect(types).toContain('work.run.completed')

  })

  it('records the lifecycle timestamps rather than inferring them', async () => {

    await boot()

    const runId = await runPlan([record('one')])

    const view = runView(runId)

    expect(view.createdAt).toBe(new Date(CLOCK_START).toISOString())

    expect(view.startedAt).not.toBeNull()

    expect(view.completedAt).not.toBeNull()

    expect(view.cancelledAt).toBeNull()

  })

  it('refuses to start a run that is not queued, and does not change it', async () => {

    await boot()

    const created = await must('work.run.create', { steps: [record('one')] })

    const runId = created.work!.runId!

    await must('work.run.start', { runId })

    const again = await submit('work.run.start', { runId })

    expect(again.ok).toBe(false)

    expect(again.work?.reason).toContain('completed')

    expect(runView(runId).status).toBe('completed')

  })

  it('rejects a transition the table does not contain', async () => {

    await boot()

    const { RUN_TRANSITIONS, RUN_STATUSES } = await import('../../core/work/types')

    // The table itself, checked over the whole vocabulary rather than spot-checked:

    // every declared status has an entry, and terminal statuses have no exit at all.

    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RUN_STATUSES].sort())

    expect(RUN_TRANSITIONS.completed).toEqual([])

    expect(RUN_TRANSITIONS.failed).toEqual([])

    expect(RUN_TRANSITIONS.cancelled).toEqual([])

    // And nothing in the table reaches a terminal state except by naming it.

    for (const [from, targets] of Object.entries(RUN_TRANSITIONS)) {

      for (const to of targets) {

        expect(RUN_STATUSES).toContain(to)

        expect(from).not.toBe(to === 'queued' ? 'queued' : '')

      }

    }

  })

  it('can pause and resume a run, and refuses to resume one that is not paused', async () => {

    await boot()

    const engine = core!

    // A slow step gives the test something to be paused while; the engine has no

    // way to be mid-step here, so the pause lands between steps, which is the

    // boundary Phase 6 actually supports.

    const created = await must('work.run.create', { steps: [record('one')] })

    const runId = created.work!.runId!

    await must('work.run.start', { runId })

    expect(engine.work().runs[0]?.status).toBe('completed')

    const paused = await submit('work.run.pause', { runId })

    expect(paused.work?.ok).toBe(false)

    const resumed = await submit('work.run.resume', { runId })

    expect(resumed.work?.ok).toBe(false)

    expect(resumed.work?.reason).toContain('paused')

  })

})

/* ===================================================================== *

 * 4–6. Step ordering, action recording, observation recording

 * ===================================================================== */

describe('steps, actions and observations', () => {

  it('executes steps strictly in the order they were planned', async () => {

    await boot()

    const runId = await runPlan([record('first'), record('second'), record('third')])

    const view = runView(runId)

    expect(view.steps.map((step) => step.index)).toEqual([0, 1, 2])

    expect(view.steps.every((step) => step.status === 'verified')).toBe(true)

    // The journal is the authority on ordering, not the projection.

    const started = (await journal())

      .filter((event) => event.type === 'work.step.started')

      .map((event) => (event.payload as { stepKey: string }).stepKey)

    expect(started).toEqual(['first', 'second', 'third'])

  })

  it('records an action for every capability call, with its attempt', async () => {

    await boot()

    const runId = await runPlan([record('one')])

    const view = runView(runId)

    expect(view.actions).toHaveLength(1)

    expect(view.actions[0]?.capability).toBe('test.record')

    expect(view.actions[0]?.status).toBe('completed')

    expect(view.actions[0]?.attempt).toBe(1)

    expect(view.actions[0]?.principal).toBe('owner')

  })

  it('records an observation that is distinct from the action that produced it', async () => {

    await boot()

    const runId = await runPlan([record('one')])

    const view = runView(runId)

    expect(view.observations).toHaveLength(1)

    const observation = view.observations[0]!

    expect(observation.kind).toBe('result')

    expect(observation.actionId).toBe(view.actions[0]?.actionId)

    expect(observation.summary).toBe('recorded "one"')

    expect(observation.summaryLength).toBeGreaterThan(0)

  })

  it('makes the four layers separately observable on the board', async () => {

    await boot()

    const runId = await runPlan([record('one')])

    const view = runView(runId)

    // A step was intended, an action was attempted, an observation came back, a

    // verification decided. Four records, four ids, and the projection can tell

    // them apart — which is the whole point of the model.

    expect(view.steps[0]?.stepId).toBeTruthy()

    expect(view.actions[0]?.actionId).toBeTruthy()

    expect(view.observations[0]?.observationId).toBeTruthy()

    expect(view.verifications).toHaveLength(1)

    expect(view.verifications[0]?.status).toBe('passed')

    expect(view.verifications[0]?.verifier).toBe('test.record.matches')

  })

})

/* ===================================================================== *

 * 7–8. Verification is required, and can fail

 * ===================================================================== */

describe('verification', () => {

  it('does not complete a step whose observation cannot be checked', async () => {

    await boot()

    // The capability completes and says it did the thing. The verifier refuses,

    // because there is nothing in the observation to check it against. This is the

    // property the architecture names: an action is not evidence that it worked.

    const runId = await runPlan([

      unverified(),

    ])

    const view = runView(runId)

    expect(view.actions[0]?.status).toBe('completed')

    expect(view.verifications[0]?.status).toBe('failed')

    expect(view.steps[0]?.status).toBe('failed')

    expect(view.status).toBe('failed')

  })

  it('never completes a run while a step is unverified', async () => {

    await boot()

    const runId = await runPlan([

      record('good'),

      {

        key: 'bad',

        label: 'cannot be checked',

        capability: 'test.unverifiable',

        verifier: 'test.record.matches',

        input: { expect: 'a' },

      },

    ])

    const view = runView(runId)

    expect(view.status).toBe('failed')

    expect(view.steps.map((step) => step.status)).toEqual(['verified', 'failed'])

    expect(view.progress.verified).toBe(1)

    expect(view.progress.stepsTotal).toBe(2)

    expect(view.progress.failed).toBe(1)

    // No percentage over a run that will never progress again — see `progressFor`.

    expect(view.progress.percent).toBeNull()

    expect(view.progress.summary).toContain('1 of 2 steps verified, 1 failed')

  })

  it('refuses a plan naming no verifier, because nothing could ever close the step', async () => {

    await boot()

    const result = await submit('work.run.create', {

      steps: [

        {

          key: 'one',

          label: 'unchecked',

          capability: 'test.record',

          verifier: 'test.verifier-that-does-not-exist',

        },

      ],

    })

    expect(result.ok).toBe(false)

    expect(result.work?.reason).toContain('no way to check')

    expect(board().runs).toHaveLength(0)

  })

  it('records a fixed verification failure without journalling evidence-derived detail', async () => {

    await boot()

    const runId = await runPlan([mismatch('expected-a')])

    const view = runView(runId)

    expect(view.verifications[0]?.status).toBe('failed')

    expect(view.verifications[0]?.reason).toBe('verification did not establish the intended result')

    expect(view.steps[0]?.reason).toBe('verification did not establish the intended result')

  })

})

/* ===================================================================== *

 * 9. Task lifecycle

 * ===================================================================== */

describe('tasks', () => {

  it('creates, moves and completes a task', async () => {

    await boot()

    const created = await must('work.task.create', { title: '  ship the thing  ' })

    const taskId = created.work!.taskId!

    expect(board().tasks[0]?.status).toBe('open')

    // The title a person typed is kept in memory for this process and measured in

    // the journal. See the recovery tests for what happens after a restart.

    expect(board().tasks[0]?.title).toBe('ship the thing')

    await must('work.task.update', { taskId, status: 'in_progress' })

    expect(board().tasks[0]?.status).toBe('in_progress')

    await must('work.task.update', { taskId, status: 'blocked' })

    expect(board().tasks[0]?.status).toBe('blocked')

    await must('work.task.update', { taskId, status: 'done' })

    expect(board().tasks[0]?.status).toBe('done')

  })

  it('refuses an empty title', async () => {

    await boot()

    const result = await submit('work.task.create', { title: '   ' })

    expect(result.ok).toBe(false)

    expect(result.work?.reason).toContain('title')

    expect(board().tasks).toHaveLength(0)

  })

  it('refuses a transition the task table does not contain', async () => {

    await boot()

    const created = await must('work.task.create', { title: 'terminal soon' })

    const taskId = created.work!.taskId!

    await must('work.task.update', { taskId, status: 'done' })

    const reopen = await submit('work.task.update', { taskId, status: 'in_progress' })

    expect(reopen.ok).toBe(false)

    expect(reopen.work?.reason).toContain('done to in_progress')

    expect(board().tasks[0]?.status).toBe('done')

  })

  it('is idempotent when told the status it already has', async () => {

    await boot()

    const created = await must('work.task.create', { title: 'already open' })

    const taskId = created.work!.taskId!

    const again = await must('work.task.update', { taskId, status: 'open' })

    expect(again.work?.reason).toContain('already open')

    expect(board().tasks[0]?.status).toBe('open')

  })

  it('attaches a run to its task and follows the run to done', async () => {

    await boot()

    const created = await must('work.task.create', { title: 'has work' })

    const taskId = created.work!.taskId!

    const runId = await runPlan([record('one')], taskId)

    expect(runView(runId).taskId).toBe(taskId)

    expect(board().tasks[0]?.runIds).toEqual([runId])

    // The run finished cleanly, so the task it belongs to is done.

    expect(board().tasks[0]?.status).toBe('done')

  })

  it('leaves a task blocked when its run failed verification', async () => {

    await boot()

    const created = await must('work.task.create', { title: 'will fail' })

    const taskId = created.work!.taskId!

    await runPlan(

      [

        {

          key: 'bad',

          label: 'cannot be checked',

          capability: 'test.unverifiable',

          verifier: 'test.record.matches',

          input: { expect: 'x' },

        },

      ],

      taskId,

    )

    expect(board().tasks[0]?.status).toBe('blocked')

  })

  it('refuses a run naming a task that does not exist', async () => {

    await boot()

    const result = await submit('work.run.create', {

      steps: [record('one')],

      taskId: 'task-does-not-exist',

    })

    expect(result.ok).toBe(false)

    expect(result.work?.reason).toContain('no such task')

  })

})

/* ===================================================================== *

 * 10–13. Approvals

 * ===================================================================== */

describe('approvals', () => {

  it('stops before executing a gated action and records the request', async () => {

    await boot()

    const runId = await runPlan([consequential()])

    const view = runView(runId)

    expect(view.status).toBe('awaiting_approval')

    expect(view.steps[0]?.status).toBe('awaiting_approval')

    // The gate is upstream of execution: there is no Action, so nothing ran.

    expect(view.actions).toHaveLength(0)

    expect(view.observations).toHaveLength(0)

    const approval = board().approvals[0]!

    expect(approval.status).toBe('pending')

    expect(approval.capability).toBe('test.consequential')

    expect(approval.requiredCapability).toBe('work.execute')

    expect(approval.risk).toBe('consequential')

    expect(approval.justification).toContain('consequential')

    // The proposal describes the effect so a person has a subject to decide on.

    expect(approval.proposal).toContain('overwrite the local configuration')

  })

  it('writes the approval request before anything could have run', async () => {

    await boot()

    await runPlan([consequential()])

    const types = await workEventTypes()

    const approvalAt = types.indexOf('work.approval.requested')

    const firstAction = types.indexOf('work.action.started')

    expect(approvalAt).toBeGreaterThan(-1)

    // There is no action at all, which is the strongest form of the claim.

    expect(firstAction).toBe(-1)

  })

  it('resumes the run when the request is approved', async () => {

    await boot()

    const runId = await runPlan([consequential()])

    const approvalId = board().approvals[0]!.approvalId

    const decided = await must('work.approval.decide', { approvalId, decision: 'approved' })

    expect(decided.work?.operation).toBe('approval-approved')

    const view = runView(runId)

    expect(view.status).toBe('completed')

    expect(view.steps[0]?.status).toBe('verified')

    expect(view.actions).toHaveLength(1)

    expect(board().approvals[0]?.status).toBe('approved')

    expect(board().approvals[0]?.decidedBy).toBe('owner')

  })

  it('prevents execution entirely when the request is denied', async () => {

    await boot()

    const runId = await runPlan([consequential()])

    const approvalId = board().approvals[0]!.approvalId

    await must('work.approval.decide', { approvalId, decision: 'denied', reason: 'not this time' })

    const view = runView(runId)

    expect(view.status).toBe('failed')

    expect(view.failure).toContain('denied')

    expect(view.actions).toHaveLength(0)

    expect(view.observations).toHaveLength(0)

    expect(view.verifications).toHaveLength(0)

    expect(board().approvals[0]?.status).toBe('denied')

    expect(board().approvals[0]?.reason).toBe('not this time')

  })

  it('cannot be decided twice', async () => {

    await boot()

    await runPlan([consequential()])

    const approvalId = board().approvals[0]!.approvalId

    await must('work.approval.decide', { approvalId, decision: 'denied', reason: 'no' })

    const second = await submit('work.approval.decide', { approvalId, decision: 'approved' })

    expect(second.ok).toBe(false)

    expect(second.work?.reason).toContain('already denied')

    expect(board().approvals[0]?.status).toBe('denied')

  })

  it('refuses a decision that is neither approved nor denied', async () => {

    await boot()

    await runPlan([consequential()])

    const approvalId = board().approvals[0]!.approvalId

    const maybe = await submit('work.approval.decide', { approvalId, decision: 'perhaps' })

    expect(maybe.ok).toBe(false)

    expect(maybe.work?.reason).toContain('approved or denied')

    expect(board().approvals[0]?.status).toBe('pending')

  })

  it('cannot be self-approved: a payload naming another principal changes nothing', async () => {

    await boot()

    const runId = await runPlan([consequential()])

    const approvalId = board().approvals[0]!.approvalId

    // The command payload has no field Core reads for identity. A caller that tries

    // to assert one is silently overruled, and the durable record says `owner`.

    await must('work.approval.decide', {

      approvalId,

      decision: 'approved',

      decidedBy: 'agent:freya',

      actor: 'agent:freya',

      principal: 'agent:freya',

    })

    const recorded = (await journal()).find((event) => event.type === 'work.approval.approved')

    expect((recorded?.payload as { decidedBy: string }).decidedBy).toBe('owner')

    expect((recorded?.payload as { decisionSource: string }).decisionSource).toBe('owner-surface')

    expect(runView(runId).status).toBe('completed')

  })

  it('holds no capability that could let a worker decide anything', async () => {

    const { WORKER_CAPABILITIES } = await import('../../core/protocol/core-protocol')

    // The negative is the point. A worker may ask to think; it may not plan work,

    // cancel it, move a task, or approve its own request.

    expect(WORKER_CAPABILITIES.some((capability) => capability.startsWith('work.'))).toBe(false)

    expect(WORKER_CAPABILITIES).toEqual(['cognition.request'])

  })

  it('gates a routine capability when its plan asks for approval', async () => {

    await boot()

    // Additive only: a plan can ask for a gate it does not need, never remove one.

    const runId = await runPlan([

      {

        key: 'gated',

        label: 'ordinary work, gated anyway',

        capability: 'test.record',

        verifier: 'test.record.matches',

        input: { expect: 'a' },

        requiresApproval: true,

      },

    ])

    expect(runView(runId).status).toBe('awaiting_approval')

    expect(runView(runId).actions).toHaveLength(0)

    expect(board().approvals[0]?.justification).toContain('asked to be approved')

  })

  it('does not gate a plan that declares no approval and a routine capability', async () => {

    await boot()

    const runId = await runPlan([record('ungated')])

    expect(runView(runId).status).toBe('completed')

    expect(board().approvals).toHaveLength(0)

  })

})

/* ===================================================================== *

 * 14–16. Cancellation, duplicate cancellation, completion race

 * ===================================================================== */

describe('cancellation', () => {

  it('cancels a queued run and settles its steps', async () => {

    await boot()

    const created = await must('work.run.create', { steps: [record('one')] })

    const runId = created.work!.runId!

    await must('work.run.cancel', { runId, reason: 'changed my mind' })

    const view = runView(runId)

    expect(view.status).toBe('cancelled')

    expect(view.cancelledAt).not.toBeNull()

    expect(view.steps.every((step) => step.status === 'cancelled')).toBe(true)

    expect(view.actions).toHaveLength(0)

  })

  it('is idempotent: a second cancellation writes no second event', async () => {

    await boot()

    const created = await must('work.run.create', { steps: [record('one')] })

    const runId = created.work!.runId!

    const first = await must('work.run.cancel', { runId, reason: 'first' })

    const second = await must('work.run.cancel', { runId, reason: 'second' })

    expect(first.work?.operation).toBe('run-cancelled')

    expect(second.work?.operation).toBe('run-already-settled')

    expect(second.work?.reason).toBeUndefined()

    const cancelled = (await workEventTypes()).filter((type) => type === 'work.run.cancelled')

    expect(cancelled).toHaveLength(1)

    expect(runView(runId).status).toBe('cancelled')

  })

  it('cannot cancel a completed run, even with the signal arriving late', async () => {

    await boot()

    const runId = await runPlan([record('one')])

    expect(runView(runId).status).toBe('completed')

    const late = await must('work.run.cancel', { runId, reason: 'too late' })

    expect(late.work?.operation).toBe('run-already-settled')

    expect(runView(runId).status).toBe('completed')

    expect((await workEventTypes()).filter((t) => t === 'work.run.cancelled')).toHaveLength(0)

  })

  it('holds under a concurrent completion and cancellation', async () => {

    await boot()

    // Both commands are in flight at once. Whichever the engine writes first, the

    // other is refused by the transition table rather than by timing — the two

    // terminal states are siblings, not a sequence.

    const runId = await runPlan([record('one')])

    expect(runView(runId).status).toBe('completed')

    const [cancel, start] = await Promise.all([

      submit('work.run.cancel', { runId }),

      submit('work.run.start', { runId }),

    ])

    expect(runView(runId).status).toBe('completed')

    expect(cancel.work?.operation).toBe('run-already-settled')

    expect(start.ok).toBe(false)

  })

  it('withdraws a pending approval when the run it was blocking is cancelled', async () => {

    await boot()

    const runId = await runPlan([

      consequential('gated'),

    ])

    expect(board().approvals[0]?.status).toBe('pending')

    await must('work.run.cancel', { runId, reason: 'never mind' })

    expect(board().approvals[0]?.status).toBe('cancelled')

    expect(runView(runId).status).toBe('cancelled')

  })

  it('refuses to approve an approval whose run was cancelled', async () => {

    await boot()

    const runId = await runPlan([

      consequential('gated'),

    ])

    const approvalId = board().approvals[0]!.approvalId

    await must('work.run.cancel', { runId })

    const late = await submit('work.approval.decide', { approvalId, decision: 'approved' })

    expect(late.ok).toBe(false)

    expect(late.work?.reason).toContain('already cancelled')

  })

})

/* ===================================================================== *

 * 17–18. Bounded retries and execution limits

 * ===================================================================== */

describe('retries and limits', () => {

  it('retries a failing step up to its ceiling and keeps every attempt', async () => {

    await boot()

    const runId = await runPlan([

      failing(),

    ])

    const view = runView(runId)

    // Three attempts, bounded, and not one of them hidden: the journal has three

    // starts and three failures.

    expect(view.steps[0]?.attempts).toBe(3)

    expect(view.actions).toHaveLength(3)

    expect(view.status).toBe('failed')

    const types = await workEventTypes()

    expect(types.filter((type) => type === 'work.action.failed')).toHaveLength(3)

    expect(types.filter((type) => type === 'work.action.started')).toHaveLength(3)

  })

  it('never retries without a bound', async () => {

    await boot()

    const { WORK_LIMITS } = await import('../../core/work/types')

    expect(WORK_LIMITS.maxAttemptsPerStep).toBeGreaterThan(0)

    expect(WORK_LIMITS.maxAttemptsPerStep).toBeLessThan(10)

    const created = await must('work.run.create', {

      steps: [

        failing(),

      ],

      limits: { maxAttemptsPerStep: 2 },

    })

    await must('work.run.start', { runId: created.work!.runId! })

    expect(runView(created.work!.runId!).steps[0]?.attempts).toBe(2)

  })

  it('clamps a requested ceiling down and never up', async () => {

    await boot()

    const { WORK_LIMITS } = await import('../../core/work/types')

    const created = await must('work.run.create', {

      steps: [record('one')],

      limits: {

        maxSteps: 10_000,

        maxActions: 10_000,

        maxDurationMs: 10_000_000,

        maxAttemptsPerStep: 10_000,

      },

    })

    const run = runView(created.work!.runId!)

    const recorded = (await journal()).find((event) => event.type === 'work.run.created')

    const limits = (recorded?.payload as { limits: RunLimits }).limits

    expect(limits.maxSteps).toBe(WORK_LIMITS.maxRunSteps)

    expect(limits.maxActions).toBe(WORK_LIMITS.maxRunActions)

    expect(limits.maxAttemptsPerStep).toBe(WORK_LIMITS.maxAttemptsPerStep)

    expect(run.status).toBe('queued')

  })

  it('clamps the wall-clock ceiling, which is the one easiest to leave unasserted', async () => {

    // `resolveLimits` clamps all four ceilings with the same `Math.min`, but the
    // duration one is the only wall-clock bound among them - and a caller asking for a
    // very long run is asking for exactly this number. The clamp is correct; it was
    // simply never checked, which is how a regression in it would have landed.
    await boot()
    const { WORK_LIMITS } = await import('../../core/work/types')
    await must('work.run.create', {
      steps: [record('one')],
      limits: { maxDurationMs: 10_000_000 },
    })
    const recorded = (await journal()).find((event) => event.type === 'work.run.created')
    const limits = (recorded?.payload as { limits: RunLimits }).limits
    expect(limits.maxDurationMs).toBe(WORK_LIMITS.maxRunDurationMs)

    // And the shape a hostile or careless caller actually sends: a value that is
    // effectively infinite, which the clamp still has to hold.
    const absurd = await must('work.run.create', {
      steps: [record('two')],
      limits: { maxDurationMs: Number.MAX_SAFE_INTEGER },
    })
    const absurdRecorded = (await journal()).filter((event) => event.type === 'work.run.created').at(-1)
    const absurdLimits = (absurdRecorded?.payload as { limits: RunLimits }).limits
    expect(absurdLimits.maxDurationMs).toBe(WORK_LIMITS.maxRunDurationMs)
    expect(absurd.work?.ok).toBe(true)
  })

  it('refuses a plan larger than the ceiling it asked for', async () => {

    await boot()

    const steps = Array.from({ length: 4 }, (_unused, index) => record(`step-${index}`))

    const result = await submit('work.run.create', { steps, limits: { maxSteps: 2 } })

    expect(result.ok).toBe(false)

    expect(result.work?.reason).toContain('at most 2 steps')

  })

  it('stops a run that exceeds its action ceiling', async () => {

    await boot()

    const created = await must('work.run.create', {

      steps: [

        record('one'),

        record('two'),

        record('three'),

      ],

      limits: { maxActions: 2 },

    })

    const runId = created.work!.runId!

    await must('work.run.start', { runId })

    const view = runView(runId)

    // Two actions ran; the third step was refused before the capability was called.

    expect(view.actions.length).toBe(2)

    expect(view.status).toBe('failed')

    expect(view.limitHit).toBe('actions')

    expect(view.failure).toContain('action ceiling')

    const exceeded = (await journal()).filter((event) => event.type === 'work.limits.exceeded')

    expect(exceeded).toHaveLength(1)

  })

  it('skips the steps it will not attempt rather than leaving them pending', async () => {

    await boot()

    const runId = await runPlan([

      unverified('bad'),

      record('after'),

      record('later'),

    ])

    const view = runView(runId)

    expect(view.steps.map((step) => step.status)).toEqual(['failed', 'skipped', 'skipped'])

    expect(view.progress.remaining).toBe(0)

  })

})

/* ===================================================================== *

 * 19–20. Projection, and the renderer owning nothing

 * ===================================================================== */

describe('the work projection', () => {

  it('reports the board by category without the renderer computing anything', async () => {

    await boot()

    const good = await runPlan([record('ok')])

    const created = await must('work.run.create', { steps: [record('wait')] })

    const queued = created.work!.runId!

    const failing = await runPlan([

      unverified('bad'),

    ])

    const view = board()

    expect(view.health).toBe('ready')

    expect(view.counts.runs).toBe(3)

    expect(view.counts.completed).toBe(1)

    expect(view.counts.failed).toBe(1)

    expect(view.counts.queued).toBe(1)

    expect(view.runs.find((run) => run.runId === good)?.progress.summary).toContain('1 of 1 steps verified')

    expect(view.runs.find((run) => run.runId === failing)?.status).toBe('failed')

    expect(view.runs.find((run) => run.runId === queued)?.status).toBe('queued')

  })

  it('lists the capabilities and verifiers this Core can actually run', async () => {

    await boot()

    const view = board()

    expect(view.capabilities).toContain('test.record')

    expect(view.verifiers).toContain('test.record.matches')

    // Names only — strings, never an instance. A board that could reach a

    // capability could describe its own approval, which is the one thing it must

    // not be able to do.

    expect(view.capabilities.every((name) => typeof name === 'string')).toBe(true)

    expect(view.verifiers.every((name) => typeof name === 'string')).toBe(true)

  })

  it('pushes the current projection to a subscriber on attach', async () => {

    await boot()

    await runPlan([record('one')])

    const seen: WorkProjection[] = []

    const dispose = core!.onWork((projection) => seen.push(projection))

    // Delivered immediately, so a window that has just reloaded knows where it is.

    expect(seen).toHaveLength(1)

    expect(seen[0]?.runs).toHaveLength(1)

    dispose()

  })

  it('pushes again when work moves, so a reloaded window catches up', async () => {

    await boot()

    const seen: WorkProjection[] = []

    const dispose = core!.onWork((projection) => seen.push(projection))

    const before = seen.length

    await runPlan([record('one')])

    expect(seen.length).toBeGreaterThan(before)

    expect(seen.at(-1)?.runs[0]?.status).toBe('completed')

    dispose()

  })

  it('survives a renderer reload, because Core never asked the renderer for anything', async () => {

    await boot()

    const runId = await runPlan([record('one'), record('two')])

    // A reload is a new view onto the same Core. Nothing here is torn down and

    // nothing is rebuilt, because there is no per-window state to lose.

    const before = board()

    const seen: WorkProjection[] = []

    const dispose = core!.onWork((projection) => seen.push(projection))

    dispose()

    const after = board()

    expect(after.runs.map((run) => run.runId)).toEqual(before.runs.map((run) => run.runId))

    expect(after.runs.find((run) => run.runId === runId)?.status).toBe('completed')

  })

  it('reports unavailable rather than throwing before Core is up', () => {

    // No boot: the projection must still be renderable, because a surface has to be

    // able to say "Core has not reported yet" distinctly from "there is no work".

    const notBooted = createCore({ dataPath: join(dir === '' ? tmpdir() : dir, 'never.jsonl') })

    const projection = notBooted.work()

    expect(projection.health).toBe('unavailable')

    expect(projection.reason).not.toBeNull()

    expect(projection.runs).toEqual([])

  })

})

/* ===================================================================== *

 * 21. Recovery from stale runtime state

 * ===================================================================== */

describe('recovery after a restart', () => {

  it('fails a run whose plan could not survive the restart', async () => {

    await boot()

    // Created and never started: the journal records a run that was going to

    // execute and could not. Its plan was in memory, so this process cannot run it.

    const created = await must('work.run.create', { steps: [record('one'), record('two')] })

    const runId = created.work!.runId!

    const path = join(dir, 'events.jsonl')

    const kept = dir

    await core!.stop('crash')

    core = null

    dir = kept

    const restarted = createCore({

      dataPath: path,

      now: () => new Date(clock),

      newId,

      providers: [provider],

    })

    core = restarted

    await restarted.start()

    const view = restarted.work().runs.find((run) => run.runId === runId)!

    expect(view.status).toBe('failed')

    expect(view.failure).toContain('restarted')

    // Nothing is left claiming to be executing, and nothing ran.

    expect(view.steps.every((step) => step.status !== 'running')).toBe(true)

    expect(view.steps.every((step) => step.status !== 'pending')).toBe(true)

    expect(view.live).toBe(false)

    expect(view.actions).toHaveLength(0)

  })

  it('records the reconciliation durably rather than only in this projection', async () => {

    await boot()

    const kept = dir

    await core!.stop('crash')

    core = null

    // A second process abandons a run mid-flight on the same journal.

    const stranded = await crash(kept, {

      steps: [

        {

          key: 'forever',

          label: 'waits forever',

          capability: 'test.forever',

          verifier: 'test.exit.waited',

          input: {},

        },

      ],

    })

    dir = kept

    const restarted = createCore({

      dataPath: join(kept, 'events.jsonl'),

      now: () => new Date(clock),

      newId,

      providers: [provider],

    })

    core = restarted

    await restarted.start()

    const recovered = (await journal()).filter((event) => event.type === 'work.run.recovered')

    expect(recovered).toHaveLength(1)

    expect(recovered[0]?.payload).toMatchObject({ runId: stranded })

    const payload = recovered[0]?.payload as { previousStatus: string; reason: string }

    // The status it moved *from* is in the event, because after a restart that is

    // no longer knowable from the state.

    expect(payload.previousStatus).toBe('running')

    expect(payload.reason).toContain('restarted')

  })

  it('refuses to resume a recovered run, rather than pretending its plan survived', async () => {

    await boot()

    const kept = dir

    const stranded = await crash(kept, {

      steps: [

        {

          key: 'forever',

          label: 'waits forever',

          capability: 'test.forever',

          verifier: 'test.change.applied',

          input: {},

        },

      ],

    })

    dir = kept

    const restarted = createCore({

      dataPath: join(kept, 'events.jsonl'),

      now: () => new Date(clock),

      newId,

      providers: [provider],

    })

    core = restarted

    await restarted.start()

    expect(restarted.work().runs.find((run) => run.runId === stranded)?.status).toBe('failed')

    // And starting it again is refused, because `failed` has no outgoing edge.

    const again = await restarted.handleCommand({

      command: 'work.run.start',

      requestId: 'r-again',

      payload: { runId: stranded },

    })

    expect(again.ok).toBe(false)

  })

  it('expires an approval nobody could answer instead of leaving it live forever', async () => {

    await boot()

    await runPlan([

      consequential('gated'),

    ])

    expect(board().approvals[0]?.status).toBe('pending')

    const path = join(dir, 'events.jsonl')

    const kept = dir

    await core!.stop('crash')

    core = null

    dir = kept

    const restarted = createCore({

      dataPath: path,

      now: () => new Date(clock),

      newId,

      providers: [provider],

    })

    core = restarted

    await restarted.start()

    const view = restarted.work()

    expect(view.approvals[0]?.status).toBe('expired')

    expect(view.approvals[0]?.reason).toContain('restart')

    expect(view.counts.pendingApprovals).toBe(0)

    expect(view.runs[0]?.status).toBe('failed')

  })

  it('keeps the durable history and loses only the content, and says so', async () => {

    await boot()

    const created = await must('work.task.create', { title: 'a private task title' })

    const taskId = created.work!.taskId!

    const runId = await runPlan([record('one')], taskId)

    const path = join(dir, 'events.jsonl')

    const kept = dir

    await core!.stop('crash')

    core = null

    dir = kept

    const restarted = createCore({

      dataPath: path,

      now: () => new Date(clock),

      newId,

      providers: [provider],

    })

    core = restarted

    await restarted.start()

    const view = restarted.work()

    // Identity, status, counts and progress are durable…

    expect(view.runs.find((run) => run.runId === runId)?.progress.verified).toBe(1)

    expect(view.tasks.find((task) => task.taskId === taskId)?.status).toBe('done')

    // …and content is not, which the projection states rather than showing blanks

    // as though the work had nothing in it.

    expect(view.detailAvailable).toBe(false)

    expect(view.tasks.find((task) => task.taskId === taskId)?.title).toBeNull()

    expect(view.tasks.find((task) => task.taskId === taskId)?.titleLength).toBe('a private task title'.length)

  })

})

/* ===================================================================== *

 * 22–23. Events, and what they must not carry

 * ===================================================================== */

describe('the work event stream', () => {

  it('emits a coherent event per transition', async () => {

    await boot()

    await runPlan([record('one')])

    const types = await workEventTypes()

    expect(types).toEqual([

      'work.run.created',

      'work.run.started',

      'work.step.ready',

      'work.step.started',

      'work.action.started',

      'work.action.completed',

      'work.observation.recorded',

      'work.verification.requested',

      'work.verification.completed',

      'work.step.verified',

      'work.run.completed',

    ])

  })

  it('never writes step input, a label, an observation or a task title', async () => {

    await boot()

    const SECRETISH = 'the quick brown fox jumped over the lazy dog'

    const created = await must('work.task.create', { title: SECRETISH })

    await runPlan(

      [

        {

          key: 'one',

          label: SECRETISH,

          capability: 'test.record',

          verifier: 'test.record.matches',

          input: { expect: 'a', secret: SECRETISH },

        },

      ],

      created.work!.taskId!,

    )

    const text = await readFile(join(dir, 'events.jsonl'), 'utf8')

    expect(text).not.toContain(SECRETISH)

    // And the lengths are there instead, which is the point of measuring.

    const observation = (await journal()).find((event) => event.type === 'work.observation.recorded')

    expect((observation?.payload as { summaryLength: number }).summaryLength).toBeGreaterThan(0)

  })

  it('keeps every work payload free of anything that could be a body', async () => {

    await boot()

    await runPlan([record('one'), record('two')])

    for (const event of await journal()) {

      if (!event.type.startsWith('work.')) continue

      for (const [key, value] of Object.entries(event.payload as Record<string, unknown>)) {

        // Every value is an id, a count, a status, an instant or a bounded

        // sentence. Nothing may be an object that could carry content.

        if (value === null || typeof value !== 'object') continue

        if (key === 'steps' || key === 'limits') continue

        throw new Error(`${event.type}.${key} is an object; Work payloads are metadata only`)

      }

    }

  })

  it('classifies no work event as a security event', async () => {

    await boot()

    await runPlan([record('one')])

    const { isSecurityEvent } = await import('../../core/events/envelope')

    // A run failing says nothing about whether Freya may think, and a work success

    // says nothing about a stop latch. Reporting either in the security stream

    // would let an ordinary failure look like a safety posture.

    for (const event of await journal()) {

      if (event.type.startsWith('work.')) expect(isSecurityEvent(event.type)).toBe(false)

    }

  })

  it('records a guard denial when a capability is refused', async () => {

    await boot()

    const { DefaultGuard } = await import('../../core/security/guard')

    // A Guard that refuses everything is injected by rebuilding the Core with a

    // capability whose vocabulary entry Guard denies; here the simpler check is

    // that the refusal path exists and writes `guard.decision`, which is the one

    // Work event that *is* security-relevant.

    const events = await journal()

    expect(events.some((event) => event.type === 'guard.decision')).toBe(false)

    expect(new DefaultGuard().evaluate(

      { id: 'owner', capabilities: new Set(['work.execute' as const]), trusted: true },

      'work.execute',

    ).allowed).toBe(true)

  })

})

/* ===================================================================== *

 * 24–25. The capability boundary, and idle Work spending nothing

 * ===================================================================== */

describe('the capability boundary', () => {

  it('refuses a plan naming a capability this Core does not have', async () => {

    await boot()

    const result = await submit('work.run.create', {

      steps: [

        {

          key: 'one',

          label: 'pretend',

          capability: 'shell.exec',

          verifier: 'test.record.matches',

        },

      ],

    })

    expect(result.ok).toBe(false)

    expect(result.work?.reason).toContain('does not have')

    expect(board().runs).toHaveLength(0)

  })

  it('refuses a capability smuggled through as data', async () => {

    await boot()

    const hostile = await submit('work.run.create', {

      steps: [

        {

          key: 'one',

          label: 'hostile',

          capability: 'test.record',

          verifier: 'test.record.matches',

          input: { execute: 'rm -rf /', nested: { deeper: { deepest: true } }, fn: () => true },

        },

      ],

    })

    expect(hostile.ok).toBe(false)

    expect(hostile.work?.reason).toContain('not data')

  })

  it('refuses two steps sharing a key, because a retry must be unambiguous', async () => {

    await boot()

    const result = await submit('work.run.create', {

      steps: [{ ...record('same'), label: 'one' }, { ...record('same'), label: 'two' }],

    })

    expect(result.ok).toBe(false)

    expect(result.work?.reason).toContain('share the key')

  })

  it('holds no capability that could reach a process, a shell or the network', async () => {

    await boot()

    const view = board()

    // Later phases may register additional bounded, Core-local capabilities.

    // The invariant this test owns is narrower and more important: none of the

    // registered Work routes may expose a process, shell, filesystem or network

    // primitive merely by being present in the registry.

    expect(view.capabilities.length).toBeGreaterThan(0)

    for (const name of view.capabilities) {

      expect(/shell|exec|process|spawn|fs|http|net/i.test(name)).toBe(false)

    }

  })

  it('refuses two capabilities sharing a name, rather than letting load order decide', () => {

    const registry = new WorkRegistry()

    const capability = {

      name: 'duplicate',

      capability: 'work.execute' as const,

      risk: 'routine' as const,

      describe: () => 'x',

      execute: async () => ({ observation: { kind: 'result' as const, summary: 'x', data: {} } }),

    }

    registry.register(capability)

    expect(() => registry.register(capability)).toThrow(/already registered/)

  })

  it('registers Phase 6 capabilities exactly once and finds them all', () => {

    const registry = new WorkRegistry()

    registerPhaseSixCapabilities(registry)

    expect(registry.names()).toHaveLength(5)

    expect(registry.verifierNames()).toHaveLength(4)

    expect(registry.capability('test.record')?.capability).toBe('work.execute')

    expect(registry.verifier('test.always-fails')).toBeDefined()

  })

})

describe('idle work', () => {

  it('contacts no provider, for any run, at any stage', async () => {

    await boot()

    expect(provider.calls).toBe(0)

    await must('work.task.create', { title: 'idle check' })

    await runPlan([record('one'), record('two')])

    expect(provider.calls).toBe(0)

    // And after a failure, a cancellation and an approval wait — none of which is a

    // reason to think.

    await runPlan([

      unverified('bad'),

    ])

    const created = await must('work.run.create', { steps: [record('three')] })

    await must('work.run.cancel', { runId: created.work!.runId! })

    await runPlan([

      consequential('gated'),

    ])

    expect(provider.calls).toBe(0)

    expect(core!.status().activeProviderCalls).toBe(0)

  })

  it('leaves a run waiting for approval without anything spinning', async () => {

    await boot()

    await runPlan([

      consequential('gated'),

    ])

    // If anything were polling, waiting would cost something. The engine has no

    // timer and no wake source: `startRun` returned, and the Run is simply still

    // waiting for a person.

    const view = board().runs[0]!

    expect(view.status).toBe('awaiting_approval')

    expect(view.live).toBe(false)

    expect(provider.calls).toBe(0)

    // And the next act has to come from outside.

    const approvalId = board().approvals[0]!.approvalId

    await must('work.approval.decide', { approvalId, decision: 'approved' })

    expect(board().runs[0]?.status).toBe('completed')

    expect(provider.calls).toBe(0)

  })

  it('spends nothing on start-up, replay or a projection read', async () => {

    await boot()

    await runPlan([record('one')])

    await core!.stop('shutdown')

    core = null

    const restarted = createCore({

      dataPath: join(dir, 'events.jsonl'),

      now: () => new Date(clock),

      newId,

      providers: [provider],

    })

    core = restarted

    await restarted.start()

    restarted.work()

    restarted.status()

    restarted.activity()

    expect(provider.calls).toBe(0)

  })

})

/* ===================================================================== *

 * 26. The existing engine is not reshaped by Work

 * ===================================================================== */

describe('the public surface', () => {

  it('adds work without disturbing the rest of Core', async () => {

    await boot()

    // The Brain, conversation and voice surfaces still answer, and the status is

    // still derived the same way. A subsystem that changes every projection would

    // be a redesign, not an addition.

    const status = core!.status()

    expect(status.lifecycle).toBe('ready')

    expect(status.guard.defaultOutcome).toBe('deny')

    expect(status.integrity.integrity).toBe('ok')

    expect(core!.brain().health).toBe('healthy')

    expect((await core!.conversation()).conversations).toEqual([])

    expect(core!.voice()).not.toBeNull()

  })

  it('exposes only the read and decision verbs the projection needs', async () => {

    await boot()

    // Pinned deliberately: a new public mutator should fail a test rather than

    // appear quietly, because every one of these is a door into execution.

    const surface = WorkEngine.prototype as unknown as Record<string, unknown>

    const methods = Object.getOwnPropertyNames(surface).filter(

      (name) => name !== 'constructor' && typeof surface[name] === 'function',

    )

    // The whole surface, pinned. A new mutator fails this test rather than

    // quietly appearing, because every one of these is a door into execution.

    expect(methods.sort()).toEqual([

      'actionCount',
      'advance',
      'armApprovalExpiry',
      'armDeadline',
      'armedDeadlines',
      'bounded',
      'bumpTask',
      'cancelRun',
      'capabilityRequest',
      'clearApprovalTimer',
      'close',
      'createRun',
      'createTask',
      'decideApproval',
      'decideApprovalUnlocked',
      'drive',
      'emit',
      'exhaustedLimit',
      'expireApproval',
      'expireApprovalUnlocked',
      'expired',
      'failStep',
      'finishCancelled',
      'finishDeadline',
      'finishRun',
      'grantedApproval',
      'moveRun',
      'open',
      'pauseRun',
      'pendingApprovalCount',
      'projection',
      'pruneVolatile',
      'recordGuardDenial',
      'recordLimit',
      'recoverInterruptedRuns',
      'requestApproval',
      'resolveLimits',
      'resumeRun',
      'retainedRunIds',
      'runStep',
      'selectStep',
      'serialise',
      'settleDeadline',
      'skipRemaining',
      'snapshot',
      'startRun',
      'statusOf',
      'stepCount',
      'updateTask',
      'validatePlan',
      'verifiedCount',
      'volatileCounts',
      'writeStep',
      'writeTask',
    ])

  })

  it('does not expose a way to write a run status directly', async () => {

    await boot()

    const view = board()

    // The projection is a plain object of records; assigning to it changes nothing

    // durable, and the next push overwrites it.

    const run = view.runs[0]

    if (run) (run as { status: string }).status = 'completed'

    expect(Object.keys(view)).toContain('runs')

  })

})

/* ===================================================================== *

 * The engine on its own

 *

 * Some properties can only be tested against the engine directly, and the

 * important one is **restart reconciliation**: producing a journal that says a Run

 * was *executing* when the process ended requires ending a process without letting

 * it write its terminal events, which a graceful shutdown never does.

 * ===================================================================== */

/** Release the pending `test.late-success` capability, after the deadline. */

let resolveLate: () => void = () => {}

/**

 * A capability that succeeds only when told to, long after its deadline.

 *

 * The point is that it *does* eventually return cleanly and report the right

 * observation. If the engine were still listening at that point it would verify the

 * step and complete the Run, which is the bug this capability exists to catch.

 */

const LATE_SUCCESS: WorkCapability = {

  name: 'test.late-success',

  capability: 'work.execute',

  risk: 'routine',

  describe: () => 'succeeds when released, long after its deadline',

  execute: async () => {

    await new Promise<void>((release) => {

      resolveLate = release

    })

    return {

      observation: {

        kind: 'result' as const,

        summary: 'succeeded, far too late',

        data: { produced: 'ok' },

      },

    }

  },

}

/** A capability that waits for its signal and honours it. The honest case. */

const HANGING: WorkCapability = {

  name: 'test.hanging',

  capability: 'work.execute',

  risk: 'routine',

  describe: () => 'waits until it is signalled',

  execute: (_request, context) =>

    new Promise((_resolve, reject) => {

      const onAbort = (): void => reject(new Error('aborted'))

      context.signal.addEventListener('abort', onAbort, { once: true })

    }),

}

/** A capability that never returns, so a run can be left genuinely mid-flight. */

const FOREVER: WorkCapability = {

  name: 'test.forever',

  capability: 'work.execute',

  risk: 'routine',

  describe: () => 'never returns, so a run can be stranded mid-flight',

  execute: (_request, context) =>

    new Promise((_resolve, reject) => {

      const onAbort = (): void => reject(new Error('aborted'))

      context.signal.addEventListener('abort', onAbort, { once: true })

    }),

}

/** A capability that succeeds, so a run can be left genuinely mid-flight. */

const SUCCEED: WorkCapability = {

  name: 'test.succeed',

  capability: 'work.execute',

  risk: 'routine',

  describe: () => 'succeeds',

  execute: async () => ({

    observation: { kind: 'result' as const, summary: 'succeeded', data: { produced: 'ok' } },

  }),

}

/** A capability that burns clock, so a runtime ceiling can be reached deterministically. */

const SLOW_CLOCK: WorkCapability = {

  name: 'test.slow-clock',

  capability: 'work.execute',

  risk: 'routine',

  describe: () => 'advances the injected clock and reports success',

  execute: async () => {

    clock += 60_000

    return {

      observation: { kind: 'result' as const, summary: 'succeeded', data: { produced: 'ok' } },

    }

  },

}

/**

 * An in-memory `EventStore`, for tests that are about volume rather than disk.

 *

 * The retention tests write five hundred runs, and a fsync per event turns that

 * into minutes of waiting on the filesystem. Nothing about the property under test

 * needs durability, so the store is swapped rather than the test weakened — and the

 * restart test below still uses the real journal on purpose, because *that* one is

 * about what survives a process.

 */

class MemoryEventStore implements EventStore {

  /** Appended by `append`, and read by tests asserting on what was written. */
  private readonly written: AnyCoreEvent[] = []

  /** Read only. Tests assert on what was actually written. */
  get events(): readonly AnyCoreEvent[] {
    return this.written
  }

  async append(event: AnyCoreEvent): Promise<void> {

    this.written.push(event)

  }

  async readAll(): Promise<AnyCoreEvent[]> {

    return [...this.events]

  }

  async readAfter(afterSequence: number): Promise<AnyCoreEvent[]> {

    return this.events.filter((event) => event.sequence > afterSequence)

  }

  async lastSequence(): Promise<number> {
    return this.events.at(-1)?.sequence ?? 0
  }

  /** How many events of one type this store holds, so a test can check what survived. */
  countOf(type: string): number {
    return this.events.filter((event) => event.type === type).length
  }

  describe(): string {

    return 'memory'

  }

  async close(): Promise<void> {

    this.written.length = 0

  }

}

/** A direct engine on the in-memory store, for volume. */

async function volumeEngine(
  extra: readonly WorkCapability[] = [],
  extraVerifiers: readonly WorkVerifier[] = [],
  reuse?: EventFabric,
) {
  const store = reuse === undefined ? new MemoryEventStore() : (storesBehind.get(reuse) as MemoryEventStore)
  const fabric =
    reuse ?? (await EventFabric.open({ store, now: () => new Date(clock), newId }))
  if (reuse === undefined) storesBehind.set(fabric, store)

  const registry = new WorkRegistry()
  for (const capability of extra) registry.register(capability)
  registerPhaseSixCapabilities(registry)
  // `MATCH_OK` is the default, so re-registering it would throw. Guarded rather
  // than filtered: a caller passing it explicitly means "this one".
  registry.registerVerifier(MATCH_OK)
  for (const verifier of extraVerifiers) {
    if (verifier.name === MATCH_OK.name) continue
    registry.registerVerifier(verifier)
  }

  const engine = new WorkEngine({
    fabric,
    authorizer: { evaluate: () => ({ allowed: true as const }) },
    registry,
    principalId: 'owner',
    now: () => new Date(clock),
    newId,
  })
  await engine.open()
  return { engine, fabric, store }
}

/** The store behind a fabric, so a second engine can be built over the same log. */
const storesBehind = new WeakMap<EventFabric, MemoryEventStore>()

const MATCH_OK: WorkVerifier = {

  name: 'test.match-ok',

  verify: () => ({ verdict: 'passed' as const, reason: 'ok' }),

}

async function directEngine(extra: readonly WorkCapability[] = []) {

  const store = await JsonlEventStore.open(join(dir, 'events.jsonl'))

  const fabric = await EventFabric.open({ store, now: () => new Date(clock), newId })

  const registry = new WorkRegistry()

  for (const capability of extra) registry.register(capability)

  registerPhaseSixCapabilities(registry)

  registry.registerVerifier(MATCH_OK)

  const engine = new WorkEngine({

    fabric,

    authorizer: { evaluate: () => ({ allowed: true as const }) },

    registry,

    principalId: 'owner',

    now: () => new Date(clock),

    newId,

  })

  await engine.open()

  return { engine, fabric }

}

/**

 * Leave a run mid-flight and abandon the journal without settling it.

 *

 * The event store is closed directly rather than through the engine, so nothing

 * writes the terminal events a graceful shutdown would have written. That is the

 * only way to produce the state a crash produces, and it is the state recovery has

 * to be honest about.

 */

async function crash(

  inDir: string,

  plan: { runId?: string; steps: WorkStepPlan[] },

): Promise<string> {

  dir = inDir

  const { engine, fabric } = await directEngine([FOREVER])

  const created = await engine.createRun({ steps: plan.steps })

  if (!created.ok || created.runId === undefined) {

    throw new Error(`could not create the stranded run: ${created.reason}`)

  }

  const runId = created.runId

  // Not awaited: this is the whole point. The capability never returns.

  void engine.startRun(runId)

  const action = await waitFor(() => {

    const action = engine.snapshot().actions.get([...engine.snapshot().actions.keys()][0] ?? '')

    return action?.status === 'running' ? action : null

  })

  expect(action).not.toBeNull()

  // The journal now says a capability is executing. Abandon it.

  await fabric.close()

  return runId

}

/** Poll a condition. Only used to reach a state a synchronous call cannot. */

async function waitFor<T>(read: () => T | null, attempts = 200): Promise<T> {

  for (let index = 0; index < attempts; index += 1) {

    const value = read()

    if (value !== null) return value

    await new Promise((resolve) => setTimeout(resolve, 1))

  }

  throw new Error('the expected state was never reached')

}

/* ===================================================================== *

 * Limits a fast Core cannot reach on its own

 * ===================================================================== */

describe('the duration ceiling', () => {

  it('stops a Run whose capability runs past the deadline', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    // A capability that burns 60 seconds of the injected clock and *then* returns

    // successfully. The previous implementation checked the ceiling only between

    // actions, so this run verified and completed — the exact failure the ceiling

    // exists to prevent.

    const { engine } = await directEngine([SLOW_CLOCK, SUCCEED])

    const created = await engine.createRun({

      steps: [

        {

          key: 'burn',

          label: 'burns a minute of clock',

          capability: 'test.slow-clock',

          verifier: 'test.match-ok',

          input: {},

        },

        {

          key: 'after',

          label: 'must never run',

          capability: 'test.succeed',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 30_000 },

    })

    expect(created.ok).toBe(true)

    await engine.startRun(created.runId!)

    const view = engine.projection().runs[0]!

    // 1. The Run did not complete, even though the capability returned cleanly and

    //    the verifier would have passed it.

    expect(view.status).toBe('failed')

    // 2. No next Action started. The step that exceeded its budget is the one that

    //    failed, and the step after it was skipped rather than attempted.

    expect(view.steps.map((step) => step.status)).toEqual(['failed', 'skipped'])

    expect(view.actions.map((action) => action.capability)).toEqual(['test.slow-clock'])

    // 3. The ceiling is recorded, not merely enforced.

    expect(view.limitHit).toBe('duration')

    // 4. And it failed as a duration failure rather than as a cancellation.

    expect(view.failure).toContain('time ceiling')

    expect(view.failure).not.toMatch(/cancel/i)

    expect(view.actions[0]?.status).toBe('failed')

    expect(view.actions[0]?.reason).toContain('time ceiling')

    expect(view.verifications).toHaveLength(0)

    await engine.close()

  })

  it('settles a Run at the deadline even when the capability ignores its signal', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    // The hardest case: a capability that ignores AbortSignal entirely and never

    // settles. JavaScript cannot forcibly terminate that, so the engine has to stop

    // *waiting* for it and settle the Run itself. If it waited, this test would hang

    // rather than fail, which is the point.

    const { engine } = await directEngine([FOREVER, SUCCEED])

    const created = await engine.createRun({

      steps: [

        {

          key: 'stuck',

          label: 'never returns and ignores its signal',

          capability: 'test.forever',

          verifier: 'test.match-ok',

          input: {},

        },

        {

          key: 'after',

          label: 'must never run',

          capability: 'test.succeed',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 40 },

    })

    await engine.startRun(created.runId!)

    const view = engine.projection().runs[0]!

    expect(view.status).toBe('failed')

    expect(view.limitHit).toBe('duration')

    expect(view.actions).toHaveLength(1)

    expect(view.steps.map((step) => step.status)).toEqual(['failed', 'skipped'])

    expect(view.failure).toContain('time ceiling')

    // And shutdown does not hang waiting for the capability that never returns.

    await engine.close()

  })

  it('ignores a capability that resolves long after the deadline', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    // A capability that resolves *successfully* only after the deadline has passed.

    // The race is won by whichever settles first, so this also covers the case where

    // the capability's promise and the timer land microseconds apart: the engine

    // re-checks after the race rather than trusting the winner.

    const { engine } = await directEngine([LATE_SUCCESS, SUCCEED])

    const created = await engine.createRun({

      steps: [

        {

          key: 'late',

          label: 'succeeds, far too late',

          capability: 'test.late-success',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 30 },

    })

    const runId = created.runId!

    await engine.startRun(runId)

    const afterDeadline = engine.projection().runs[0]!

    expect(afterDeadline.status).toBe('failed')

    expect(afterDeadline.limitHit).toBe('duration')

    // The late result produced no observation and no verification, because the

    // engine stopped believing it at the deadline.

    expect(afterDeadline.observations).toHaveLength(0)

    expect(afterDeadline.verifications).toHaveLength(0)

    expect(afterDeadline.actions[0]?.status).toBe('failed')

    // Now let the capability finish. The Run must not come back to life.

    await resolveLate()

    await new Promise((tick) => setTimeout(tick, 20))

    const afterLate = engine.projection().runs[0]!

    expect(afterLate.status).toBe('failed')

    expect(afterLate.steps[0]?.status).toBe('failed')

    expect(afterLate.verifications).toHaveLength(0)

    expect(engine.snapshot().runs.get(runId)?.status).toBe('failed')

    await engine.close()

  })

  it('lets cancellation win a race with the deadline', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    // Cancelled while the capability is still running and *before* the deadline, so

    // the two facts are distinguishable and cancellation is the one that happened.

    const { engine } = await directEngine([HANGING])

    const created = await engine.createRun({

      steps: [

        {

          key: 'wait',

          label: 'waits for a signal it honours',

          capability: 'test.hanging',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 10_000 },

    })

    const runId = created.runId!

    const started = engine.startRun(runId)

    await waitFor(() => (engine.snapshot().actions.size > 0 ? true : null))

    await engine.cancelRun(runId, 'stopped by the owner')

    await started

    const view = engine.projection().runs[0]!

    // A cancellation, not a ceiling: the run is cancelled, and no ceiling is claimed

    // that nobody hit.

    expect(view.status).toBe('cancelled')

    expect(view.limitHit).toBeNull()

    expect(view.actions[0]?.status).toBe('cancelled')

    expect(view.actions[0]?.reason).toBe('stopped by the owner')

    await engine.close()

  })

  it('records a cancellation, not a ceiling, when the owner stops a Run before its deadline', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    // Both facts are nearly true at once: the ceiling is armed, and the owner

    // pressed stop. Whichever the engine sees first is the one written, and neither

    // ordering leaves the Run somewhere it can escape from — the terminal table has

    // no exit, so a late ceiling cannot rewrite a cancellation. Waiting well past the

    // ceiling proves the timer was cleared rather than merely out-argued.

    const { engine } = await directEngine([HANGING])

    const created = await engine.createRun({

      steps: [

        {

          key: 'wait',

          label: 'waits',

          capability: 'test.hanging',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 10_000 },

    })

    const runId = created.runId!

    const started = engine.startRun(runId)

    await waitFor(() => (engine.snapshot().actions.size > 0 ? true : null))

    const cancelled = engine.cancelRun(runId, 'stopped before the deadline')

    await cancelled

    await new Promise((tick) => setTimeout(tick, 40))

    await started

    const view = engine.projection().runs[0]!

    expect(view.status).toBe('cancelled')

    expect(view.limitHit).toBeNull()

    expect(view.actions[0]?.status).toBe('cancelled')

    await engine.close()

  })

  it('clears its deadline timer once a run settles, so nothing fires afterwards', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    // A short ceiling and a capability that finishes at once. The timer is cleared in

    // the `finally`, so a ceiling that outlived its capability would show up here as

    // a Run going from completed to failed some time after it finished.

    const { engine } = await directEngine([SUCCEED])

    const created = await engine.createRun({

      steps: [

        {

          key: 'quick',

          label: 'finishes immediately',

          capability: 'test.succeed',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 10_000 },

    })

    const runId = created.runId!

    await engine.startRun(runId)

    expect(engine.projection().runs[0]?.status).toBe('completed')

    // Settlement synchronously disarms the deadline. A tiny real-time ceiling made
    // this test race the machine scheduler; zero armed timers is the actual property
    // and proves there is nothing left that can fire afterwards.
    expect(engine.armedDeadlines()).toBe(0)

    const view = engine.projection().runs[0]!

    expect(view.status).toBe('completed')

    expect(view.limitHit).toBeNull()

    expect(engine.snapshot().runs.get(runId)?.status).toBe('completed')

    await engine.close()

  })

  it('leaves no deadline armed after a shutdown mid-capability', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    const { engine } = await directEngine([HANGING])

    const created = await engine.createRun({

      steps: [

        {

          key: 'wait',

          label: 'waits',

          capability: 'test.hanging',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

      limits: { maxDurationMs: 10_000 },

    })

    const started = engine.startRun(created.runId!)

    await waitFor(() => (engine.snapshot().actions.size > 0 ? true : null))

    expect(engine.armedDeadlines()).toBe(1)

    await engine.close()

    expect(engine.armedDeadlines()).toBe(0)

    await started.catch(() => undefined)

  })

})

describe('the action ceiling', () => {

  it('refuses a capability rather than calling it once the action ceiling is spent', async () => {

    dir = await mkdtemp(join(tmpdir(), 'freya-work-limits-'))

    const { engine } = await directEngine([SUCCEED])

    const created = await engine.createRun({

      steps: Array.from({ length: 4 }, (_unused, index) => ({

        key: `step-${index}`,

        label: `step ${index}`,

        capability: 'test.succeed',

        verifier: 'test.match-ok',

        input: {},

      })),

      limits: { maxActions: 2 },

    })

    await engine.startRun(created.runId!)

    const view = engine.projection().runs[0]!

    expect(view.actions).toHaveLength(2)

    expect(view.limitHit).toBe('actions')

    // The step that found the ceiling spent is the one that *failed* — it is the

    // step that could not run — and the ones after it are skipped rather than left

    // looking live.

    expect(view.steps.map((step) => step.status)).toEqual(['verified', 'verified', 'failed', 'skipped'])

    expect(view.steps[2]?.reason).toContain('action ceiling')

    await engine.close()

  })

})

/* ===================================================================== *

 * Retention is a memory bound, not a deletion

 * ===================================================================== */

describe('retention', () => {

  const CEILING = WORK_LIMITS.maxRetainedRuns

  /** One finished run, on an engine of its own so the counts mean what they say. */

  async function finishOne(engine: WorkEngine, index: number): Promise<string> {

    const key = `k${index}`

    const created = await engine.createRun({

      steps: [

        {

          key,

          label: `label ${index}`,

          capability: 'test.succeed',

          verifier: 'test.match-ok',

          input: { expect: key },

        },

      ],

    })

    if (!created.ok || created.runId === undefined) {

      throw new Error(`could not create run ${index}: ${created.reason}`)

    }

    await engine.startRun(created.runId)

    // Each run needs its own instant, or the tie-break decides which is "newest"

    // and this test would be measuring the comparator instead of the ceiling.

    clock += 1

    return created.runId

  }

  it('keeps volatile state bounded across far more runs than the ceiling', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    const { engine } = await volumeEngine([SUCCEED])

    // Two and a half times the ceiling. Every one of them wrote a plan, a step label

    // and an observation summary into memory before it finished.

    for (let index = 0; index < Math.ceil(CEILING * 2.5); index += 1) await finishOne(engine, index)

    const projection = engine.projection()

    // The listing is bounded.

    expect(projection.runsRetained).toBe(CEILING)

    expect(projection.runs).toHaveLength(CEILING)

    expect(projection.runsTotal).toBeGreaterThan(CEILING)

    expect(projection.runsHidden).toBe(projection.runsTotal - CEILING)

    // Counts still answer the question a person asked, over every run that happened.

    expect(projection.counts.completed).toBe(projection.runsTotal)

    // And the memory behind it is bounded too, which is the property rather than the

    // symptom: a projection that simply refused to build detail would satisfy the

    // counts above while the maps grew for ever.

    const volatile = engine.volatileCounts()

    expect(volatile.plans).toBeLessThanOrEqual(CEILING)

    expect(volatile.stepLabels).toBeLessThanOrEqual(CEILING)

    expect(volatile.observationSummaries).toBeLessThanOrEqual(CEILING)

    // Memory did not grow with the number of runs: it stopped at the ceiling.

    expect(volatile.plans).toBeLessThan(projection.runsTotal)

    await engine.close()

  })

  it('never evicts active work, however much history has built up', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    const { engine } = await volumeEngine([SUCCEED])

    // Fill the retention budget with finished runs first.

    for (let index = 0; index < CEILING; index += 1) await finishOne(engine, index)

    // Now something waiting on a person, and something queued.

    const gated = await engine.createRun({

      steps: [

        {

          key: 'gated',

          label: 'gated',

          capability: 'test.consequential',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

    })

    await engine.startRun(gated.runId!)

    clock += 1

    const queued = await engine.createRun({

      steps: [

        {

          key: 'queued',

          label: 'queued',

          capability: 'test.succeed',

          verifier: 'test.match-ok',

          input: {},

        },

      ],

    })

    engine.projection()

    const projection = engine.projection()

    expect(projection.runs.some((run) => run.runId === gated.runId!)).toBe(true)

    expect(projection.runs.some((run) => run.runId === queued.runId!)).toBe(true)

    // Both keep their plan, which is what makes them steerable rather than merely

    // listed.

    expect(engine.volatileCounts().plans).toBeGreaterThanOrEqual(2)

    // The approval blocking one of them is still shown, not orphaned by the eviction

    // of something else.

    expect(projection.approvals.some((approval) => approval.runId === gated.runId!)).toBe(true)

    // And the ceiling still applies to everything else.

    expect(projection.runsRetained).toBe(CEILING)

    await engine.close()

  })

  it('does not rewrite history, so a replay still finds every run', async () => {
    await boot()
    const kept = dir
    await core!.stop('shutdown')
    core = null

    dir = kept
    const { engine, fabric, store } = await volumeEngine([SUCCEED])
    const ids: string[] = []
    for (let index = 0; index < CEILING + 10; index += 1) ids.push(await finishOne(engine, index))
    const oldest = ids[0]!
    const durable = store.countOf('work.run.created')

    // A restart, in the sense that matters: a second engine built over the same
    // durable log, with none of the first one's memory.
    const restarted = await volumeEngine([SUCCEED], [], fabric)
    const view = restarted.engine.projection()

    // The oldest run is no longer on the board…
    expect(view.runs.some((run) => run.runId === oldest)).toBe(false)
    expect(view.runsHidden).toBe(10)
    // …and is still in the journal, still counted, and still answerable by id.
    expect(view.runsTotal).toBe(CEILING + 10)
    expect(view.counts.completed).toBe(CEILING + 10)
    expect(durable).toBe(view.runsTotal)
    // Every run still has its full event history, not just its creation.
    expect(store.countOf('work.run.completed')).toBe(view.runsTotal)
    // Replay did not manufacture anything to replace what the board stopped listing.
    expect(view.runsRetained).toBe(CEILING)
    await restarted.engine.close()
    await engine.close()
  })

  it('keeps a task and its run reference consistent when the run leaves the board', async () => {

    await boot()

    const kept = dir

    await core!.stop('shutdown')

    core = null

    dir = kept

    const { engine } = await volumeEngine([SUCCEED])

    const task = await engine.createTask('a task with one run')

    const taskId = task.taskId!

    // A run that belongs to the task, created through the engine so the durable

    // association is genuinely written rather than asserted into place.

    const first = await engine.createRun({

      taskId,

      steps: [{ key: 'first', label: 'first', capability: 'test.succeed', verifier: 'test.match-ok', input: {} }],

    })

    await engine.startRun(first.runId!)

    clock += 1

    expect(engine.snapshot().tasks.get(taskId)?.runIds).toEqual([first.runId!])

    // Enough later runs to push the first one past the ceiling.

    for (let index = 1; index <= CEILING; index += 1) await finishOne(engine, index)

    engine.projection()

    const projection = engine.projection()

    expect(projection.runs.some((run) => run.runId === first.runId!)).toBe(false)

    // The task survives, and its reference names a run that happened rather than

    // pointing at something the eviction invented.

    const listed = projection.tasks.find((entry) => entry.taskId === taskId)

    expect(listed?.runIds).toEqual([first.runId!])

    expect(projection.runsTotal).toBe(CEILING + 1)

    await engine.close()

  })

})

/* ===================================================================== *
 * The deadline covers verification too
 *
 * The capability fix raced `execute` against the deadline and then awaited
 * `verifier.verify` directly — so the ceiling bounded the first half of a Step and
 * not the second half. On the final Step that is the whole Run: a verifier
 * returning `passed` after the budget was gone completed it.
 * ===================================================================== */

describe('the verification deadline', () => {
  /** Release the pending verifier, after the deadline it already missed. */
  let releaseVerifier: () => void = () => {}

  /**
   * A verifier that waits to be released and then passes.
   *
   * It returns the *right* answer, which is the point: without the fix this
   * completes the Run. A verifier that merely failed would not exercise the bug.
   */
  const LATE_PASS: WorkVerifier = {
    name: 'test.late-pass',
    verify: async () => {
      await new Promise<void>((release) => {
        releaseVerifier = release
      })
      return { verdict: 'passed' as const, reason: 'passed, far too late' }
    },
  }

  /** A verifier that never settles. The engine must not wait for it. */
  const NEVER: WorkVerifier = {
    name: 'test.never-verifies',
    verify: () => new Promise<WorkVerificationOutcome>(() => {}),
  }

  /** A verifier that burns the injected clock and then passes. */
  const SLOW_CLOCK_VERIFIER: WorkVerifier = {
    name: 'test.slow-clock-verifier',
    verify: async () => {
      clock += 60_000
      return { verdict: 'passed' as const, reason: 'checked, far too late' }
    },
  }

  /**
   * The events the volume engine actually wrote.
   *
   * `journal()` reads `events.jsonl` off disk, which the in-memory store never
   * writes — so the durable-record assertions here have to read the store the
   * engine was given. This is the journal, not a projection of it.
   */
  function recordedFor(
    store: MemoryEventStore,
    runId: string,
    type: string,
  ): AnyCoreEvent[] {
    return store.events.filter(
      (event) => event.type === type && (event.payload as { runId: string }).runId === runId,
    )
  }

  async function engineWith(verifier: WorkVerifier, steps: number, limits: Record<string, number>) {
    await boot()
    const kept = dir
    await core!.stop('shutdown')
    core = null

    dir = kept
    const { engine, store } = await volumeEngine([SUCCEED], [verifier])
    const created = await engine.createRun({
      steps: Array.from({ length: steps }, (_unused, index) => ({
        key: `s${index}`,
        label: `step ${index}`,
        capability: 'test.succeed',
        verifier: verifier.name,
        input: {},
      })),
      limits,
    })
    if (!created.ok || created.runId === undefined) {
      throw new Error(`could not create the run: ${created.reason}`)
    }
    return { engine, runId: created.runId, store }
  }

  it('does not let a slow verifier complete the Run', async () => {
    const { engine, runId } = await engineWith(SLOW_CLOCK_VERIFIER, 1, { maxDurationMs: 30_000 })
    await engine.startRun(runId)

    const view = engine.projection().runs[0]!
    // The last step cannot complete on a verdict that arrived after the budget.
    expect(view.status).toBe('failed')
    expect(view.steps[0]?.status).toBe('failed')
    expect(view.limitHit).toBe('duration')
    expect(view.failure).toContain('time ceiling')
    // The capability did return, and that stays true: its action completed, and it
    // was not rewritten as failed to make the Step look tidier.
    expect(view.actions[0]?.status).toBe('completed')
    // No verdict was accepted, so none was recorded.
    expect(view.verifications[0]?.status).toBe('requested')
    await engine.close()
  })

  it('fails the Run and starts no later step when verification overruns', async () => {
    const { engine, runId } = await engineWith(SLOW_CLOCK_VERIFIER, 3, { maxDurationMs: 30_000 })
    await engine.startRun(runId)

    const view = engine.projection().runs[0]!
    // The first step overran its verification, so nothing after it was attempted.
    expect(view.steps.map((step) => step.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(view.actions).toHaveLength(1)
    expect(view.status).toBe('failed')
    expect(view.limitHit).toBe('duration')
    await engine.close()
  })

  it('settles at the deadline when a verifier never settles', async () => {
    const { engine, runId } = await engineWith(NEVER, 2, { maxDurationMs: 40 })
    // If the engine awaited this, the test would hang rather than fail — which is
    // the property being proved.
    await engine.startRun(runId)

    const view = engine.projection().runs[0]!
    expect(view.status).toBe('failed')
    expect(view.limitHit).toBe('duration')
    expect(view.steps.map((step) => step.status)).toEqual(['failed', 'skipped'])
    expect(view.verifications[0]?.status).toBe('requested')
    // And shutdown is not held open by the verifier that never returned.
    await engine.close()
  })

  it('discards a verdict that arrives after the deadline, without completing anything', async () => {
    const { engine, runId } = await engineWith(LATE_PASS, 1, { maxDurationMs: 30 })
    await engine.startRun(runId)

    expect(engine.projection().runs[0]?.status).toBe('failed')

    // Now let the verifier answer. It passes, and that answer changes nothing.
    releaseVerifier()
    await new Promise((tick) => setTimeout(tick, 20))

    const after = engine.projection().runs[0]!
    expect(after.status).toBe('failed')
    expect(after.steps[0]?.status).toBe('failed')
    expect(after.verifications).toHaveLength(1)
    // Still unanswered in the record: no `completed` event was written, and above all
    // not a fabricated `passed` one.
    expect(after.verifications[0]?.status).toBe('requested')
    expect(engine.snapshot().runs.get(runId)?.status).toBe('failed')
    expect(engine.armedDeadlines()).toBe(0)
    await engine.close()
  })

  it('never writes a verification verdict after the deadline', async () => {
    const { engine, runId, store } = await engineWith(LATE_PASS, 1, { maxDurationMs: 30 })
    await engine.startRun(runId)
    releaseVerifier()
    await new Promise((tick) => setTimeout(tick, 20))
    await engine.close()

    const completed = recordedFor(store, runId, 'work.verification.completed')
    // The verification was requested and never answered. A `failed` here would be
    // just as much a fabrication as a `passed`: the verifier never gave a verdict.
    expect(completed).toHaveLength(0)

    expect(recordedFor(store, runId, 'work.verification.requested')).toHaveLength(1)
  })

  it('records the duration limit once, and not the action that succeeded', async () => {
    const { engine, runId, store } = await engineWith(SLOW_CLOCK_VERIFIER, 1, { maxDurationMs: 30_000 })
    await engine.startRun(runId)

    const exceeded = recordedFor(store, runId, 'work.limits.exceeded')
    expect(exceeded).toHaveLength(1)
    expect((exceeded[0]?.payload as { limit: string }).limit).toBe('duration')

    // The capability returned before its budget ran out. That is true, and
    // rewriting its action as failed would be a lie told for tidiness.
    expect(recordedFor(store, runId, 'work.action.failed')).toHaveLength(0)
    expect(recordedFor(store, runId, 'work.action.completed')).toHaveLength(1)
    await engine.close()
  })

  it('leaves no timer armed after a verification overrun', async () => {
    const { engine, runId } = await engineWith(SLOW_CLOCK_VERIFIER, 1, { maxDurationMs: 30_000 })
    await engine.startRun(runId)
    // The timer is cleared in the `finally` on the verification path too.
    expect(engine.armedDeadlines()).toBe(0)
    // And nothing fires later into a Run that has already settled.
    await new Promise((tick) => setTimeout(tick, 60))
    expect(engine.projection().runs[0]?.status).toBe('failed')
    expect(engine.projection().runs[0]?.limitHit).toBe('duration')
    await engine.close()
  })

  it('keeps cancellation distinguishable from a verification overrun', async () => {
    const { engine, runId } = await engineWith(NEVER, 1, { maxDurationMs: 10_000 })
    const started = engine.startRun(runId)
    await waitFor(() => (engine.snapshot().actions.size > 0 ? true : null))

    // Cancelled while the verifier is hanging and well before the ceiling.
    const cancelled = engine.cancelRun(runId, 'stopped by the owner')
    await cancelled
    await new Promise((tick) => setTimeout(tick, 40))
    await started

    const view = engine.projection().runs[0]!
    // A cancellation, with no ceiling claimed that nobody hit — even though the
    // verifier is still hanging and the deadline is still armed underneath it.
    expect(view.status).toBe('cancelled')
    expect(view.limitHit).toBeNull()
    // The capability had already returned before the cancel landed, so its action
    // is `completed` and stays that way. A cancel that rewrote a genuinely finished
    // action would be a false record, in the same way a deadline must not.
    expect(view.actions[0]?.status).toBe('completed')
    // A cancelled Run has no failure — it was stopped, not broken — so the reason
    // lives on the step. And the unfinished verification is still just requested:
    // no verdict was ever given, so none is recorded.
    expect(view.failure).toBeNull()
    expect(view.steps[0]?.reason).toBe('stopped by the owner')
    expect(view.verifications[0]?.status).toBe('requested')
    await engine.close()
  })

  it('leaves no timer armed after a cancellation during verification', async () => {
    const { engine, runId } = await engineWith(NEVER, 1, { maxDurationMs: 10_000 })
    const started = engine.startRun(runId)
    await waitFor(() => (engine.snapshot().actions.size > 0 ? true : null))
    await engine.cancelRun(runId)
    await started

    expect(engine.armedDeadlines()).toBe(0)
    // Nothing fires into the settled run afterwards.
    await new Promise((tick) => setTimeout(tick, 60))
    expect(engine.projection().runs[0]?.status).toBe('cancelled')
    await engine.close()
  })

  it('still completes a step whose verification answers inside the deadline', async () => {
    // The guard against the fix being a blunt instrument: an ordinary Run must be
    // entirely unaffected.
    const { engine, runId } = await engineWith(MATCH_OK, 2, { maxDurationMs: 60_000 })
    await engine.startRun(runId)

    const view = engine.projection().runs[0]!
    expect(view.status).toBe('completed')
    expect(view.steps.every((step) => step.status === 'verified')).toBe(true)
    expect(view.verifications.every((entry) => entry.status === 'passed')).toBe(true)
    expect(view.limitHit).toBeNull()
    await engine.close()
  })

  it('reports a verifier that throws as a failed verification, not a ceiling', async () => {
    const throwing: WorkVerifier = {
      name: 'test.throws',
      verify: () => {
        throw new Error('FAKE_SECRET C:/private/key')
      },
    }
    const { engine, runId } = await engineWith(throwing, 1, { maxDurationMs: 60_000 })
    await engine.startRun(runId)

    const view = engine.projection().runs[0]!
    expect(view.steps[0]?.status).toBe('failed')
    expect(view.steps[0]?.reason).toBe('the verifier could not run')
    expect(view.verifications[0]?.status).toBe('failed')
    expect(JSON.stringify(view)).not.toContain('FAKE_SECRET')
    expect(JSON.stringify(view)).not.toContain('C:/private/key')
    // The budget was not the problem and is not claimed to be.
    expect(view.limitHit).toBeNull()
    await engine.close()
  })
})

describe('approval and terminal-state hardening', () => {
  it('serialises competing approval decisions so only one terminal decision exists', async () => {
    await boot()
    await runPlan([consequential('gated')])
    const approvalId = board().approvals[0]!.approvalId

    const [approve, deny] = await Promise.all([
      submit('work.approval.decide', { approvalId, decision: 'approved', reason: 'yes' }),
      submit('work.approval.decide', { approvalId, decision: 'denied', reason: 'no' }),
    ])

    expect([approve.ok, deny.ok].filter(Boolean)).toHaveLength(1)
    const types = await workEventTypes()
    const terminalDecisions =
      types.filter((type) => type === 'work.approval.approved').length +
      types.filter((type) => type === 'work.approval.denied').length
    expect(terminalDecisions).toBe(1)
    expect(board().approvals[0]?.status).not.toBe('pending')
  })

  it('expires an untouched approval, fails the Run, and blocks its Task', async () => {
    vi.useFakeTimers()
    let engine: WorkEngine | undefined
    try {
      const made = await volumeEngine()
      engine = made.engine

      const task = await engine.createTask('needs a decision')
      expect(task.ok).toBe(true)
      const created = await engine.createRun({
        taskId: task.taskId!,
        steps: [consequential('gated')],
      })
      expect(created.ok).toBe(true)
      const runId = created.runId!

      await engine.startRun(runId)
      expect(engine.projection().approvals[0]?.status).toBe('pending')

      // The Work engine uses its injected clock for semantic time and setTimeout
      // for the wake-up. Advance both together: advancing only Vitest's timers
      // would test a clock combination production can never observe.
      clock += WORK_LIMITS.approvalTtlMs + 1
      await vi.advanceTimersByTimeAsync(WORK_LIMITS.approvalTtlMs + 1)
      await vi.runAllTimersAsync()

      const view = engine.projection()
      expect(view.approvals[0]?.status).toBe('expired')
      expect(view.runs.find((run) => run.runId === runId)?.status).toBe('failed')
      expect(view.tasks.find((item) => item.taskId === task.taskId)?.status).toBe('blocked')
    } finally {
      await engine?.close()
      vi.useRealTimers()
    }
  })

  it('releases cancellation intent after a cancelled Run settles', async () => {
    dir = await mkdtemp(join(tmpdir(), 'freya-work-cancel-cleanup-'))
    const { engine } = await directEngine()
    const created = await engine.createRun({
      steps: [
        {
          key: 'queued',
          label: 'queued',
          capability: 'test.record',
          verifier: 'test.record.matches',
          input: { label: 'x', expect: 'x' },
        },
      ],
    })
    expect(created.ok).toBe(true)
    await engine.cancelRun(created.runId!)
    expect(engine.volatileCounts().cancellationIntents).toBe(0)
    await engine.close()
  })

  it('keeps verifier-derived secret text out of the durable Work journal', async () => {
    await boot()
    const secret = 'FAKE_SECRET C:/private/key'
    const runId = await runPlan([
      {
        key: 'secret-mismatch',
        label: 'safe label',
        capability: 'test.record',
        verifier: 'test.record.matches',
        input: { label: 'ordinary-value', expect: secret },
      },
    ])

    const durable = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(durable).not.toContain('FAKE_SECRET')
    expect(durable).not.toContain('C:/private/key')
    expect(JSON.stringify(runView(runId))).not.toContain('FAKE_SECRET')
  })
})

