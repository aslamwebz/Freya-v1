// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_STATUSES,
  APPROVAL_TERMINAL_STATUSES,
  LIMIT_NAMES,
  OBSERVATION_KINDS,
  RUN_KINDS,
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  RUN_TRANSITIONS,
  STEP_STATUSES,
  STEP_TERMINAL_STATUSES,
  STEP_TRANSITIONS,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_TRANSITIONS,
  WORK_LIMITS,
  WORK_RISKS,
  canTransitionRun,
  canTransitionStep,
  isTerminalApprovalStatus,
  isTerminalRunStatus,
  isTerminalStepStatus,
  isTerminalTaskStatus,
} from '../../core/work/types'
import { sanitiseCapabilityInput } from '../../core/work/capability'
import { reduceWorkState, initialWorkState, isWorkEvent } from '../../core/work/state'
import { projectWork } from '../../core/work/projection'
import { CORE_EVENT_TYPES, isSecurityEvent } from '../../core/events/envelope'
import { validateDurableEvent } from '../../core/events/validate'
import { DefaultGuard } from '../../core/security/guard'
import { ALL_CAPABILITIES, CAPABILITIES, WORKER_CAPABILITIES } from '../../core/protocol/core-protocol'
import { isCapability } from '../../core/security/guard'
import { registerPhaseSixCapabilities, WorkRegistry } from '../../core/work/capability'

/**
 * THE WORK STATE MACHINES, THE INPUT BOUNDARY, AND THE EVENT SCHEMA.
 *
 * These are pure properties, tested over the whole vocabulary rather than
 * spot-checked, because the failure mode of a lifecycle is precisely the edge
 * nobody exercised. Four things matter here:
 *
 *  1. **Every declared status has an entry, and terminal ones are terminal.**
 *  2. **A Run never retries; a Step does, and only backwards to `ready`.**
 *  3. **Untrusted input is data or it is refused** — never repaired.
 *  4. **The event vocabulary is closed and every payload is validated by name.**
 */

describe('the run lifecycle', () => {
  it('declares an entry for every status in the vocabulary', () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RUN_STATUSES].sort())
  })

  it('has no exit from a terminal status', () => {
    for (const status of RUN_TERMINAL_STATUSES) {
      expect(RUN_TRANSITIONS[status]).toEqual([])
      expect(canTransitionRun(status, 'running')).toBe(false)
      expect(canTransitionRun(status, 'queued')).toBe(false)
    }
  })

  it('permits only the transitions the architecture names', () => {
    const expected: Record<string, readonly string[]> = {
      queued: ['running', 'paused', 'failed', 'cancelled'],
      running: ['waiting', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled'],
      waiting: ['running', 'paused', 'failed', 'cancelled'],
      awaiting_approval: ['running', 'waiting', 'failed', 'cancelled'],
      paused: ['running', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    }
    for (const [from, targets] of Object.entries(expected)) {
      expect([...RUN_TRANSITIONS[from as keyof typeof RUN_TRANSITIONS]].sort()).toEqual([...targets].sort())
    }
  })

  it('never allows a run to go backwards into queued', () => {
    for (const from of RUN_STATUSES) expect(canTransitionRun(from, 'queued')).toBe(false)
  })

  it('agrees with its own terminal helper', () => {
    for (const status of RUN_STATUSES) {
      const terminal = RUN_TERMINAL_STATUSES.includes(status as never)
      expect(isTerminalRunStatus(status)).toBe(terminal)
      expect(RUN_TRANSITIONS[status].length === 0).toBe(terminal)
    }
  })
})

describe('the step lifecycle', () => {
  it('declares an entry for every status in the vocabulary', () => {
    expect(Object.keys(STEP_TRANSITIONS).sort()).toEqual([...STEP_STATUSES].sort())
  })

  it('has no exit from verified, cancelled or skipped', () => {
    for (const status of STEP_TERMINAL_STATUSES) {
      expect(STEP_TRANSITIONS[status]).toEqual([])
      expect(isTerminalStepStatus(status)).toBe(true)
    }
  })

  it('retries only a failed step, and only back to ready', () => {
    // The single retry edge. It is deliberately not a Run-level behaviour: a retry
    // is a new attempt within one Run, and each attempt writes its own action,
    // observation and verification events, so a flapping step's history stays whole.
    expect(STEP_TRANSITIONS.failed).toEqual(['ready'])
    // Nothing may re-enter `pending` — a step is never un-started, because
    // "pending" is the board's word for work that has not begun and un-starting
    // something that began is a lie about ordering.
    for (const targets of Object.values(STEP_TRANSITIONS)) expect(targets).not.toContain('pending')
    // And a terminal step is never retried by anything.
    for (const status of STEP_TERMINAL_STATUSES) {
      expect(STEP_TRANSITIONS[status]).toEqual([])
    }
  })

  it('lets an approval-gated step come back through ready rather than straight to running', () => {
    // Both edges are real: `ready` is how a granted step re-enters the ordered
    // selection, `running` is how a Step that was already executing carries on.
    expect(canTransitionStep('awaiting_approval', 'ready')).toBe(true)
    expect(canTransitionStep('awaiting_approval', 'running')).toBe(true)
    expect(canTransitionStep('awaiting_approval', 'verified')).toBe(false)
  })

  it('never lets a step close without passing through running', () => {
    for (const from of STEP_STATUSES) {
      expect(canTransitionStep(from, 'verified')).toBe(from === 'running')
    }
  })
})

describe('the other closed vocabularies', () => {
  it('closes tasks, approvals, kinds, risks and limits', () => {
    for (const status of TASK_STATUSES) expect(isTerminalTaskStatus(status)).toBe(TASK_TERMINAL_STATUSES.includes(status as never))
    for (const status of APPROVAL_STATUSES) {
      expect(isTerminalApprovalStatus(status)).toBe(APPROVAL_TERMINAL_STATUSES.includes(status as never))
    }
    // `pending` is the only non-terminal approval, and it has real consequences —
    // which is why it is a status rather than a boolean on an action.
    expect(APPROVAL_STATUSES.filter((status) => !isTerminalApprovalStatus(status))).toEqual(['pending'])
  })

  it('never lets a task leave a terminal state', () => {
    for (const status of TASK_TERMINAL_STATUSES) expect(TASK_TRANSITIONS[status]).toEqual([])
    expect(TASK_TRANSITIONS.open).toContain('in_progress')
    expect(TASK_TRANSITIONS.blocked).toContain('in_progress')
  })

  it('never calls an observation a success, in the type or in the vocabulary', () => {
    expect(OBSERVATION_KINDS).toContain('result')
    expect(OBSERVATION_KINDS).not.toContain('success')
  })

  it('ships exactly one run kind, and it is the one it can execute', () => {
    expect(RUN_KINDS).toEqual(['deterministic'])
  })

  it('puts the approval gate on consequential and nowhere else', () => {
    expect(WORK_RISKS).toEqual(['none', 'routine', 'consequential'])
  })

  it('bounds every kind of growth a run could have', () => {
    for (const name of LIMIT_NAMES) expect(name.length).toBeGreaterThan(0)
    expect(WORK_LIMITS.maxRunSteps).toBeGreaterThan(0)
    expect(WORK_LIMITS.maxRunActions).toBeGreaterThan(0)
    expect(WORK_LIMITS.maxRunDurationMs).toBeGreaterThan(0)
    expect(WORK_LIMITS.maxAttemptsPerStep).toBeGreaterThan(0)
    // Actions must exceed steps, or a run could not retry even one step.
    expect(WORK_LIMITS.maxRunActions).toBeGreaterThan(WORK_LIMITS.maxRunSteps)
  })
})

/* ===================================================================== *
 * The input boundary
 * ===================================================================== */

describe('the input boundary', () => {
  it('accepts plain data', () => {
    const result = sanitiseCapabilityInput({
      label: 'hello',
      count: 3,
      ratio: 0.5,
      enabled: true,
      missing: null,
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ label: 'hello', count: 3, ratio: 0.5, enabled: true, missing: null })
  })

  it('treats an absent input as an empty one', () => {
    expect(sanitiseCapabilityInput(undefined)).toMatchObject({ ok: true, value: {} })
    expect(sanitiseCapabilityInput(null)).toMatchObject({ ok: true, value: {} })
  })

  it('refuses rather than repairs, because a hole looks like valid input', () => {
    for (const hostile of [
      () => true,
      Symbol('nope'),
      10n,
      new Date(),
      [1, 2, 3],
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(sanitiseCapabilityInput({ value: hostile }).ok).toBe(false)
    }
  })

  it('refuses any object, which is how a capability could otherwise be smuggled', () => {
    // Objects are refused wholesale rather than walked. A capability is an object
    // with a prototype and methods; if any structure could cross this boundary, a
    // plan would eventually carry one, and the sanitiser would have to be the thing
    // that noticed.
    expect(sanitiseCapabilityInput({ nested: { deeper: { value: 'x' } } }).ok).toBe(false)
    expect(sanitiseCapabilityInput({ capability: { execute: () => true } }).ok).toBe(false)
    expect(sanitiseCapabilityInput({ nested: [] }).ok).toBe(false)
  })

  it('refuses the field names that reach object internals', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(sanitiseCapabilityInput({ [key]: 'polluted' }).ok).toBe(false)
    }
  })

  it('refuses a field name that could not be a field name', () => {
    expect(sanitiseCapabilityInput({ 'not a key': 1 }).ok).toBe(false)
    expect(sanitiseCapabilityInput({ '': 1 }).ok).toBe(false)
    expect(sanitiseCapabilityInput({ ['x'.repeat(65)]: 1 }).ok).toBe(false)
  })

  it('refuses too many fields, and an oversized one', () => {
    const many: Record<string, number> = {}
    for (let index = 0; index < WORK_LIMITS.maxInputFields + 1; index += 1) many[`f${index}`] = index
    expect(sanitiseCapabilityInput(many).ok).toBe(false)
    expect(sanitiseCapabilityInput({ big: 'x'.repeat(WORK_LIMITS.maxInputBytes + 1) }).ok).toBe(false)
  })

  it('produces an empty value on every refusal, so nothing partial escapes', () => {
    const result = sanitiseCapabilityInput({ good: 'kept', bad: () => true })
    expect(result.ok).toBe(false)
    expect(result.value).toEqual({})
    expect(result.reason).not.toBeNull()
  })
})

/* ===================================================================== *
 * The event schema
 * ===================================================================== */

describe('the work event schema', () => {
  it('adds a work family to the closed vocabulary without disturbing the others', () => {
    const work = CORE_EVENT_TYPES.filter((type) => type.startsWith('work.'))
    expect(work.length).toBeGreaterThan(0)
    // Names are `subsystem.entity.verb`, matching `brain.*` and `conversation.*`.
    for (const type of work) {
      expect(type.split('.').length).toBeGreaterThanOrEqual(3)
    }
    expect(CORE_EVENT_TYPES.length).toBe(new Set(CORE_EVENT_TYPES).size)
  })

  it('keeps every work event out of the security stream', () => {
    for (const type of CORE_EVENT_TYPES) {
      if (!type.startsWith('work.')) continue
      // A work outcome says nothing about whether Freya may think, and a work
      // failure says nothing about a stop latch. Either in the security stream would
      // let an ordinary failure look like a safety posture.
      expect(isSecurityEvent(type)).toBe(false)
    }
  })

  it('recognises its own events and no others', () => {
    expect(isWorkEvent('work.run.created')).toBe(true)
    expect(isWorkEvent('brain.seeded')).toBe(false)
    expect(isWorkEvent('guard.decision')).toBe(false)
  })

  it('refuses a hand-written work line carrying something it does not name', () => {
    const base = {
      eventId: 'forged-1',
      sequence: 1,
      type: 'work.action.started',
      schemaVersion: 1,
      occurredAt: '2026-04-01T09:00:00.000Z',
      source: 'core',
      actor: 'owner',
      correlationId: 'run-1',
      causationId: null,
      payload: {
        runId: 'run-1',
        stepId: 'step-1',
        actionId: 'act-1',
        attempt: 1,
        capability: 'test.record',
        principal: 'owner',
      },
    }
    expect(validateDurableEvent(base, 0).ok).toBe(true)

    // The principal is the field that matters: this is what stops a forged line
    // claiming to have executed as somebody it was not.
    expect(
      validateDurableEvent({ ...base, payload: { ...base.payload, principal: 'agent:freya' } }, 0).ok,
    ).toBe(true)
    expect(
      validateDurableEvent({ ...base, payload: { ...base.payload, principal: 'root' } }, 0).ok,
    ).toBe(false)
    // And an observation carries lengths, never a body.
    const observation = {
      ...base,
      type: 'work.observation.recorded',
      payload: {
        runId: 'run-1',
        stepId: 'step-1',
        actionId: 'act-1',
        observationId: 'obs-1',
        kind: 'result',
        summaryLength: 12,
        detailLength: 40,
      },
    }
    expect(validateDurableEvent(observation, 0).ok).toBe(true)
    expect(
      validateDurableEvent(
        { ...observation, payload: { ...observation.payload, summary: 'the real text' } },
        0,
      ).ok,
    ).toBe(false)
  })

  it('refuses a work line whose ceilings are not positive integers', () => {
    const base = {
      eventId: 'forged-2',
      sequence: 1,
      type: 'work.run.created',
      schemaVersion: 1,
      occurredAt: '2026-04-01T09:00:00.000Z',
      source: 'core',
      actor: 'system',
      correlationId: 'run-1',
      causationId: null,
      payload: {
        runId: 'run-1',
        kind: 'deterministic',
        taskId: null,
        parentKind: null,
        parentId: null,
        limits: { maxSteps: 4, maxActions: 4, maxDurationMs: 1, maxAttemptsPerStep: 1 },
        steps: [{ stepId: 'step-1', key: 'one', capability: 'test.record', verifier: 'test.record.matches' }],
      },
    }
    expect(validateDurableEvent(base, 0).ok).toBe(true)
    // A zero ceiling in a durable record would make "bounded" mean nothing, and an
    // unbounded one would make the record a claim the engine never enforced.
    expect(
      validateDurableEvent(
        { ...base, payload: { ...base.payload, limits: { ...base.payload.limits, maxActions: 0 } } },
        0,
      ).ok,
    ).toBe(false)
    expect(
      validateDurableEvent(
        { ...base, payload: { ...base.payload, limits: { ...base.payload.limits, maxSteps: -1 } } },
        0,
      ).ok,
    ).toBe(false)
  })
})

/* ===================================================================== *
 * The reducer
 * ===================================================================== */

describe('the work reducer', () => {
  it('ignores events that are not work, and still advances the sequence', () => {
    const before = initialWorkState()
    const after = reduceWorkState(before, {
      eventId: 'e1',
      sequence: 7,
      type: 'core.ready',
      schemaVersion: 1,
      occurredAt: '2026-04-01T09:00:00.000Z',
      source: 'system',
      actor: 'system',
      correlationId: 'c',
      causationId: null,
      payload: {},
    })
    expect(after.runs.size).toBe(0)
    expect(after.sequence).toBe(7)
  })

  it('adopts a transition it recognises and drops one the table forbids', () => {
    // The reducer is the second line of defence: the engine validates before it
    // writes, and a replay must not adopt a state the engine could not produce.
    const created = {
      eventId: 'e1',
      sequence: 1,
      type: 'work.run.created',
      schemaVersion: 1,
      occurredAt: '2026-04-01T09:00:00.000Z',
      source: 'system',
      actor: 'system',
      correlationId: 'c',
      causationId: null,
      payload: {
        runId: 'run-1',
        kind: 'deterministic',
        taskId: null,
        parentKind: null,
        parentId: null,
        limits: { maxSteps: 4, maxActions: 4, maxDurationMs: 1000, maxAttemptsPerStep: 1 },
        steps: [{ stepId: 'step-1', key: 'one', capability: 'test.record', verifier: 'test.record.matches' }],
      },
    } as const

    let state = reduceWorkState(initialWorkState(), created)
    expect(state.runs.get('run-1')?.status).toBe('queued')

    const started = {
      ...created,
      eventId: 'e2',
      sequence: 2,
      type: 'work.run.started',
      payload: { runId: 'run-1' },
    } as const
    state = reduceWorkState(state, started)
    expect(state.runs.get('run-1')?.status).toBe('running')

    // `running → completed` is legal, so it is adopted.
    state = reduceWorkState(state, {
      ...started,
      eventId: 'e3',
      sequence: 3,
      type: 'work.run.completed',
      payload: { runId: 'run-1', stepCount: 1, verifiedCount: 1 },
    } as never)
    expect(state.runs.get('run-1')?.status).toBe('completed')

    // `completed → cancelled` is not, so a forged or stale line cannot rewrite it.
    state = reduceWorkState(state, {
      ...started,
      eventId: 'e4',
      sequence: 4,
      type: 'work.run.cancelled',
      payload: { runId: 'run-1', reason: 'too late' },
    } as never)
    expect(state.runs.get('run-1')?.status).toBe('completed')
  })

  it('never invents a record for an event about something it does not hold', () => {
    const before = initialWorkState()
    const after = reduceWorkState(before, {
      eventId: 'e1',
      sequence: 1,
      type: 'work.run.started',
      schemaVersion: 1,
      occurredAt: '2026-04-01T09:00:00.000Z',
      source: 'system',
      actor: 'system',
      correlationId: 'c',
      causationId: null,
      payload: { runId: 'run-that-was-never-created' },
    })
    expect(after.runs.size).toBe(0)
    expect(after.steps.size).toBe(0)
  })
})

/* ===================================================================== *
 * The capability vocabulary
 * ===================================================================== */

describe('the work capabilities', () => {
  it('gives every work capability an owner-only default and no worker reach', () => {
    for (const capability of CAPABILITIES) expect(ALL_CAPABILITIES).toContain(capability)
    const workCapabilities = CAPABILITIES.filter((capability) => capability.startsWith('work.'))
    expect(workCapabilities).toContain('work.approval.decide')
    // Deny by default is structural here too: a name outside the vocabulary is not
    // a capability, so a plan cannot smuggle one in as a string.
    expect(isCapability('work.do_anything')).toBe(false)
    for (const capability of workCapabilities) {
      expect(WORKER_CAPABILITIES).not.toContain(capability)
    }
  })

  it('makes a capability guard-checkable and refuses an unknown one', () => {
    const guard = new DefaultGuard()
    const owner = { id: 'owner' as const, capabilities: new Set(ALL_CAPABILITIES), trusted: true }
    for (const capability of CAPABILITIES) {
      expect(guard.evaluate(owner, capability).allowed).toBe(true)
    }
    // A capability outside the vocabulary is refused before anything else is read.
    expect(guard.evaluate(owner, 'shell.exec' as never)).toMatchObject({ allowed: false })
  })

  it('registers Phase 6 capabilities that all name the work.execute capability', () => {
    const registry = new WorkRegistry()
    registerPhaseSixCapabilities(registry)
    for (const name of registry.names()) {
      expect(registry.capability(name)?.capability).toBe('work.execute')
    }
    // And exactly one of them carries the approval requirement on its own account.
    const consequential = registry.names().filter(
      (name) => registry.capability(name)?.risk === 'consequential',
    )
    expect(consequential).toEqual(['test.consequential'])
  })

  it('registers no verifier that could pass an observation it did not check', () => {
    const registry = new WorkRegistry()
    registerPhaseSixCapabilities(registry)
    // Every Phase 6 verifier is registered separately from every capability, so a
    // capability cannot reach one and there is no path from producing evidence to
    // certifying it.
    expect(registry.verifierNames().length).toBeGreaterThan(0)
    expect(registry.names().some((name) => registry.verifierNames().includes(name))).toBe(false)
  })
})

/* ===================================================================== *
 * Retention
 * ===================================================================== */

describe('the retention ceiling', () => {
  /**
   * A finished Run, built through the reducer rather than the engine.
   *
   * Retention is a property of the fold and the projection, so testing it through
   * the engine would be testing a slower path to the same function.
   */
  function finishedRun(index: number, at: string, id = `run-${String(index).padStart(4, '0')}`) {
    return {
      run: {
        eventId: `e-created-${index}`,
        sequence: index * 4,
        type: 'work.run.created' as const,
        schemaVersion: 1,
        occurredAt: at,
        source: 'system' as const,
        actor: 'system' as const,
        correlationId: id,
        causationId: null,
        payload: {
          runId: id,
          kind: 'deterministic',
          taskId: null,
          parentKind: null,
          parentId: null,
          limits: { maxSteps: 4, maxActions: 4, maxDurationMs: 1000, maxAttemptsPerStep: 1 },
          steps: [{ stepId: `${id}-step`, key: 'one', capability: 'test.record', verifier: 'test.record.matches' }],
        },
      },
      started: {
        eventId: `e-started-${index}`,
        sequence: index * 4 + 1,
        type: 'work.run.started' as const,
        schemaVersion: 1,
        occurredAt: at,
        source: 'system' as const,
        actor: 'system' as const,
        correlationId: id,
        causationId: null,
        payload: { runId: id },
      },
      stepReady: {
        eventId: `e-ready-${index}`,
        sequence: index * 4 + 2,
        type: 'work.step.ready' as const,
        schemaVersion: 1,
        occurredAt: at,
        source: 'system' as const,
        actor: 'system' as const,
        correlationId: id,
        causationId: null,
        payload: { runId: id, stepId: `${id}-step`, stepKey: 'one' },
      },
      verified: {
        eventId: `e-completed-${index}`,
        sequence: index * 4 + 3,
        type: 'work.run.completed' as const,
        schemaVersion: 1,
        occurredAt: at,
        source: 'system' as const,
        actor: 'system' as const,
        correlationId: id,
        causationId: null,
        payload: { runId: id, stepCount: 1, verifiedCount: 1 },
      },
    }
  }

  function stateWithRuns(count: number) {
    let state = initialWorkState()
    for (let index = 0; index < count; index += 1) {
      const events = finishedRun(index, `2026-04-01T09:${String(index % 60).padStart(2, '0')}:00.000Z`)
      state = reduceWorkState(state, events.run as never)
      state = reduceWorkState(state, events.started as never)
      state = reduceWorkState(state, events.stepReady as never)
      state = reduceWorkState(state, events.verified as never)
    }
    return state
  }

  const EMPTY_DETAIL = {
    stepLabels: new Map<string, string>(),
    observationSummaries: new Map<string, string>(),
    taskTitles: new Map<string, string>(),
  }
  const NO_LIVE: ReadonlySet<string> = new Set<string>()

  it('lists the newest settled runs and says how many it hid', () => {
    const state = stateWithRuns(12)
    const projection = projectWork(state, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 5)

    expect(projection.runs).toHaveLength(5)
    expect(projection.runs[0]?.runId).toBe('run-0011')
    expect(projection.runsRetained).toBe(5)
    expect(projection.runsTotal).toBe(12)
    expect(projection.runsHidden).toBe(7)
    // Counts still describe every run, because somebody asking how many failed wants
    // an answer and not a rendering of how much fits on screen.
    expect(projection.counts.runs).toBe(12)
    expect(projection.counts.completed).toBe(12)
  })

  it('never hides a run that is still live', () => {
    // Twenty settled runs, and one that has not finished. A ceiling of three must
    // still show the live one, because dropping it would hide the only work in
    // progress — which is the opposite of what a ceiling is for.
    let state = stateWithRuns(20)
    const live = finishedRun(999, '2026-04-01T10:00:00.000Z')
    state = reduceWorkState(state, live.run as never)
    // Started and parked, but never completed.
    state = reduceWorkState(state, live.started as never)
    state = reduceWorkState(state, live.stepReady as never)

    const projection = projectWork(state, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 3)
    expect(projection.runs.some((run) => run.runId === 'run-0999')).toBe(true)
    expect(projection.runs).toHaveLength(3)
    expect(projection.runsHidden).toBe(18)
  })

  it('never hides a run that is waiting on an approval', () => {
    // A run that has finished is easy to retire. One blocked on a person is not: if
    // it vanished off the board, the only record that something was waiting would
    // be the board, and the board would have thrown it away.
    let state = stateWithRuns(20)
    const gated = finishedRun(998, '2026-04-01T10:00:00.000Z')
    state = reduceWorkState(state, gated.run as never)
    state = reduceWorkState(state, gated.started as never)
    state = reduceWorkState(state, {
      ...gated.verified,
      eventId: 'e-approval',
      sequence: gated.verified.sequence + 1,
      type: 'work.approval.requested',
      payload: {
        approvalId: 'apr-1',
        runId: 'run-0998',
        stepId: 'run-0998-step',
        capability: 'test.consequential',
        requiredCapability: 'work.execute',
        risk: 'consequential',
        principal: 'owner',
        justification: 'consequential',
        proposal: 'would do something',
      },
    } as never)

    const projection = projectWork(state, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 3)
    expect(projection.runs.some((run) => run.runId === 'run-0998')).toBe(true)
    // And its approval is still shown alongside it, not orphaned.
    expect(projection.approvals.some((approval) => approval.approvalId === 'apr-1')).toBe(true)
    expect(projection.counts.pendingApprovals).toBe(1)
  })

  it('selects deterministically, whatever order the fold happened to arrive in', () => {
    const forwards = stateWithRuns(8)
    // The same events, folded into maps whose iteration order is the reverse. This
    // is the real non-determinism risk: a viewer whose contents depended on Map
    // insertion order would show a person a different board after every restart.
    const backwards = {
      ...forwards,
      runs: new Map([...forwards.runs].reverse()),
    }

    const a = projectWork(forwards, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 3)
    const b = projectWork(backwards, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 3)
    expect(b.runs.map((run) => run.runId)).toEqual(a.runs.map((run) => run.runId))
    // And it is the *newest* three, which is what a person would expect to see.
    expect(a.runs.map((run) => run.runId)).toEqual(['run-0007', 'run-0006', 'run-0005'])
  })

  it('breaks a createdAt tie by id, so the newest is still well defined', () => {
    // Three runs created in the same millisecond have no meaningful age difference,
    // and an implementation that left that order to the comparator would show a
    // person different runs on different launches of the same journal.
    const at = '2026-04-01T09:00:00.000Z'
    let state = initialWorkState()
    for (const [index, id] of ['run-b', 'run-a', 'run-c'].entries()) {
      const events = finishedRun(index * 4, at, id)
      state = reduceWorkState(state, events.run as never)
      state = reduceWorkState(state, events.started as never)
      state = reduceWorkState(state, events.stepReady as never)
      state = reduceWorkState(state, events.verified as never)
    }
    const projection = projectWork(state, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 2)
    expect(projection.runs.map((run) => run.runId)).toEqual(['run-c', 'run-b'])
  })

  it('leaves the durable record alone, so nothing is manufactured or lost', () => {
    // Retention is not deletion, and this is the assertion that says so: the fold
    // still holds every run that ever happened, including the ones the board hid.
    const state = stateWithRuns(40)
    expect(state.runs.size).toBe(40)
    expect(state.runs.get('run-0000')?.status).toBe('completed')

    const projection = projectWork(state, EMPTY_DETAIL, NO_LIVE, [], [], 'ready', null, 5)
    expect(projection.runs).toHaveLength(5)
    // Hidden from the board, still readable by id.
    expect(state.runs.get('run-0000')).toBeDefined()
    expect(projection.counts.completed).toBe(40)
  })

  it('keeps the ceiling on the volatile material rather than on the record', () => {
    const state = stateWithRuns(10)
    const labels = new Map<string, string>()
    for (const [index, stepId] of [...state.steps.keys()].entries()) {
      labels.set(stepId, `label ${index}`)
    }
    const projection = projectWork({ ...state, sequence: state.sequence }, { ...EMPTY_DETAIL, stepLabels: labels }, NO_LIVE, [], [], 'ready', null, 3)

    expect(projection.runsRetained).toBe(3)
    // The labels the board shows are the ones for the runs it lists.
    expect([...projection.runs].map((run) => run.steps[0]?.label)).toEqual(['label 9', 'label 8', 'label 7'])
  })
})
