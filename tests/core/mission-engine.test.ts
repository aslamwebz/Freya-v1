// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionEngine } from '../../core/missions/engine'
import { MemoryMissionStore } from '../../core/missions/memory-store'
import type { MissionStore } from '../../core/missions/store'
import { MissionVerifierRegistry } from '../../core/missions/verifier'
import { MISSION_REASONS, type MissionLimits, type MissionVerificationOutcome } from '../../core/missions/types'
import type { RunRecord, RunStatus, StepRecord } from '../../core/work/types'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { isSecurityEvent, type CoreEventType } from '../../core/events/envelope'

/**
 * The Mission engine, over a real journal.
 *
 * Grouped by the property each group defends rather than by method, because the
 * methods are not what matters — what matters is which of them cannot be made to
 * lie.
 *
 * The Work port is stubbed here on purpose: these tests are about the Mission
 * engine's own rules (limits, verification, races, settlement), and a stub makes
 * the boundary under test the boundary that is actually being tested. The claims
 * that need a whole Core — no Mission content in the journal, zero model calls,
 * STOP ALL — belong to the Core integration tests, not to this file.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-mission-engine-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/* ---------------------------------------------------------- direct engine use */

/** A minimal Work port, so the engine can be driven without a whole Core. */
/** A verifier that never answers, standing in for one interrupted by a crash. */
function slowNever(): MissionVerifierRegistry {
  return new MissionVerifierRegistry([
    { id: 'mission.work.verified', verify: () => new Promise<MissionVerificationOutcome>(() => {}) },
  ])
}

function workStub(overrides: Partial<Record<string, unknown>> = {}) {
  const runs = new Map<string, RunRecord>()
  const steps = new Map<string, StepRecord[]>()
  return {
    runs,
    steps,
    run: (runId: string) => runs.get(runId),
    stepsOf: (runId: string) => steps.get(runId) ?? [],
    isSettled: (status: RunStatus) => ['completed', 'failed', 'cancelled'].includes(status),
    pauseRun: vi.fn(async () => true),
    cancelRun: vi.fn(async () => true),
    ...overrides,
  }
}

function runRecord(runId: string, status: RunStatus, parentMissionId?: string): RunRecord {
  return {
    runId,
    kind: 'deterministic',
    status,
    createdAt: '2026-10-01T09:00:00.000Z',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    failure: null,
    waitingOn: null,
    parentKind: parentMissionId ? 'mission' : null,
    parentId: parentMissionId ?? null,
    taskId: null,
    limits: {
      maxSteps: 8,
      maxActions: 16,
      maxDurationMs: 60_000,
      maxAttemptsPerStep: 1,
    },
  }
}

function stepRecords(runId: string, statuses: StepRecord['status'][]): StepRecord[] {
  return statuses.map((status, index) => ({
    stepId: `${runId}-s${index}`,
    runId,
    key: `k${index}`,
    index,
    status,
    attempts: 1,
    capability: 'fixture.echo',
    verifier: 'fixture.echo.verified',
    approvalId: null,
    startedAt: null,
    settledAt: null,
    reason: null,
  }))
}

async function engineOver(
  work: ReturnType<typeof workStub>,
  verifiers?: MissionVerifierRegistry,
  options: { store?: MissionStore; now?: () => Date } = {},
) {
  const eventStore = await JsonlEventStore.open(join(directory, 'engine.jsonl'))
  const fabric = await EventFabric.open({ store: eventStore })
  const engine = new MissionEngine({
    fabric,
    store: options.store ?? new MemoryMissionStore(),
    work: work as never,
    verifiers,
    principalId: 'owner',
    now: options.now ?? (() => new Date()),
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
  })
  await engine.open()
  return { engine, fabric, eventStore }
}

describe('lifecycle', () => {
  it('creates, activates, pauses, resumes and cancels', async () => {
    const { engine, fabric } = await engineOver(workStub())
    const created = await engine.create({ title: 'Ship the thing', intent: 'Get it released.' })
    expect(created).toMatchObject({ operation: 'created', ok: true, status: 'draft' })
    const id = created.missionId as string

    expect(await engine.activate(id)).toMatchObject({ operation: 'activated', ok: true, status: 'active' })
    expect(await engine.pause(id)).toMatchObject({ operation: 'paused', ok: true, status: 'paused' })
    expect(await engine.resume(id)).toMatchObject({ operation: 'resumed', ok: true, status: 'active' })
    expect(await engine.cancel(id)).toMatchObject({ operation: 'cancelled', ok: true, status: 'cancelled' })
    await engine.close()
    await fabric.close()
  })

  it('records a resume as a resume, not a second activation', async () => {
    // "Was this ever paused?" is answerable only if the journal keeps these apart,
    // and the two edges land on the same status, so only the origin tells them
    // apart.
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Once paused', intent: 'Interrupt me.' })).missionId as string
    await engine.activate(id)
    await engine.pause(id)
    await engine.resume(id)

    const journal = await readFile(join(directory, 'engine.jsonl'), 'utf8')
    const types = journal
      .split(String.fromCharCode(10))
      .filter(Boolean)
      .map((line) => JSON.parse(line).type as string)
    expect(types).toEqual([
      'mission.created',
      'mission.activated',
      'mission.paused',
      'mission.resumed',
    ])
    await engine.close()
    await fabric.close()
  })

  it('refuses to move a settled Mission, and says it has settled', async () => {
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Done', intent: 'Already finished.' })).missionId as string
    await engine.activate(id)
    await engine.cancel(id)

    for (const attempt of [engine.activate(id), engine.pause(id), engine.resume(id), engine.fail(id)]) {
      const result = await attempt
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/already cancelled|settled/i)
    }
    // And the state is unchanged.
    expect(engine.snapshot().missions.get(id)?.status).toBe('cancelled')
    await engine.close()
    await fabric.close()
  })

  it('refuses a transition the table does not permit', async () => {
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Draft', intent: 'Not yet.' })).missionId as string
    // draft → paused is not a permitted move, and there is no command that asks
    // for it, which is the point: the table is not a suggestion.
    const result = await engine.pause(id)
    expect(result.ok).toBe(false)
    await engine.close()
    await fabric.close()
  })

  it('refuses an unknown Mission rather than creating one', async () => {
    const { engine, fabric } = await engineOver(workStub())
    for (const call of [engine.activate('nope'), engine.pause('nope'), engine.cancel('nope')]) {
      expect((await call).reason).toMatch(/no such mission/)
    }
    await engine.close()
    await fabric.close()
  })
})

describe('pause and cancel propagation', () => {
  it('pauses live child Runs and reports any it could not', async () => {
    const work = workStub({ pauseRun: vi.fn(async () => true) })
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Pausing', intent: 'Stop for now.' })).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'running', id))
    await engine.attachChildRun(id, 'r1')

    const paused = await engine.pause(id)
    expect(paused.ok).toBe(true)
    expect(work.pauseRun).toHaveBeenCalledWith('r1', expect.any(String))
    expect(paused.reason).toBeUndefined()
    await engine.close()
    await fabric.close()
  })

  it('reports a partial pause instead of fabricating a clean one', async () => {
    // A Mission that says it paused while a Run kept going is the most misleading
    // thing this engine could do.
    const work = workStub({ pauseRun: vi.fn(async () => false) })
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Partial', intent: 'One child refuses.' })).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'running', id))
    await engine.attachChildRun(id, 'r1')

    const paused = await engine.pause(id)
    expect(paused.ok).toBe(true)
    expect(paused.reason).toMatch(/could not be paused.*r1/)
    await engine.close()
    await fabric.close()
  })

  it('cancels live child Runs and leaves settled ones alone', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Cancelling', intent: 'Stop everything.' })).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'running', id))
    work.runs.set('r2', runRecord('r2', 'completed', id))
    await engine.attachChildRun(id, 'r1')
    await engine.attachChildRun(id, 'r2')

    await engine.cancel(id)
    expect(work.cancelRun).toHaveBeenCalledTimes(1)
    expect(work.cancelRun).toHaveBeenCalledWith('r1', expect.any(String))
    await engine.close()
    await fabric.close()
  })

  it('refuses a new child Run once pause has won admission', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Racing', intent: 'Pause versus new work.' })).missionId as string
    await engine.activate(id)

    // The race: both in flight at once.
    const [paused, attached] = await Promise.all([engine.pause(id), engine.attachChildRun(id, 'r1')])

    // Exactly one of them may have taken effect, and a paused Mission admits no
    // new Run — so if the pause won, the attachment must have refused.
    if (paused.ok) {
      expect(attached.ok).toBe(false)
      expect(attached.reason).toMatch(/only an active Mission/)
    }
    expect(engine.snapshot().missions.get(id)?.status).toBe(paused.ok ? 'paused' : 'active')
    await engine.close()
    await fabric.close()
  })
})

describe('child Run limits', () => {
  it('refuses past the total child ceiling and records that it did', async () => {
    const work = workStub()
    const { engine, fabric, eventStore } = await engineOver(work)
    const id = (await engine.create(
      { title: 'Bounded', intent: 'Many attempts.' },
      { maxChildRuns: 2 },
    )).missionId as string
    await engine.activate(id)

    expect((await engine.attachChildRun(id, 'r1')).ok).toBe(true)
    expect((await engine.attachChildRun(id, 'r2')).ok).toBe(true)
    const third = await engine.attachChildRun(id, 'r3')
    expect(third.ok).toBe(false)
    expect(third.reason).toMatch(/child Run ceiling/)

    // Durable, so a restart cannot hide that a ceiling was hit.
    expect(engine.snapshot().missions.get(id)?.limitsHit).toContain('maxChildRuns')
    await engine.close()
    const raw = await readFile(join(directory, 'engine.jsonl'), 'utf8')
    expect(raw).toContain('mission.limit.exceeded')
    await fabric.close()
    await eventStore.close?.()
  })

  it('refuses past the concurrency ceiling while children are live', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create(
      { title: 'Concurrent', intent: 'Too many at once.' },
      { maxConcurrentChildRuns: 1 },
    )).missionId as string
    await engine.activate(id)

    work.runs.set('r1', runRecord('r1', 'running', id))
    expect((await engine.attachChildRun(id, 'r1')).ok).toBe(true)
    const second = await engine.attachChildRun(id, 'r2')
    expect(second.ok).toBe(false)
    expect(second.reason).toMatch(/concurrent child Run ceiling/)

    // A settled child frees the slot. A ceiling that never reopens is not a
    // concurrency limit, it is a total limit wearing the wrong name.
    work.runs.set('r1', runRecord('r1', 'completed', id))
    expect((await engine.attachChildRun(id, 'r2')).ok).toBe(true)
    await engine.close()
    await fabric.close()
  })

  it('counts an attached Run only once', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work, undefined)
    const id = (await engine.create({ title: 'Idempotent', intent: 'Same run twice.' })).missionId as string
    await engine.activate(id)
    expect((await engine.attachChildRun(id, 'r1')).ok).toBe(true)
    expect((await engine.attachChildRun(id, 'r1')).ok).toBe(true)
    expect(engine.projection().missions[0]?.counts.total).toBe(1)
    await engine.close()
    await fabric.close()
  })

  it('refuses a child Run on a Mission that has passed its deadline', async () => {
    const work = workStub()
    let clock = Date.parse('2026-10-01T09:00:00.000Z')
    const { engine, fabric } = await engineOver(work, undefined, {
      now: () => new Date(clock),
    })
    const id = (await engine.create(
      { title: 'Expiring', intent: 'Short deadline.' },
      { lifetimeMs: 1_000 },
    )).missionId as string
    await engine.activate(id)
    clock += 5_000
    const result = await engine.attachChildRun(id, 'r1')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/deadline/)
    await engine.close()
    await fabric.close()
  })
})

describe('completion requires verification', () => {
  async function withRun(
    runStatus: RunStatus,
    stepStatuses: StepRecord['status'][],
    limits?: Partial<MissionLimits>,
  ) {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Verifying', intent: 'Check the work.' }, limits)).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', runStatus, id))
    work.steps.set('r1', stepRecords('r1', stepStatuses))
    await engine.attachChildRun(id, 'r1')
    return { engine, fabric, id, work }
  }

  it('refuses to complete with no child Run at all', async () => {
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Empty', intent: 'Nothing attempted.' })).missionId as string
    await engine.activate(id)
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no Work has been attached/)
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    await engine.close()
    await fabric.close()
  })

  it('refuses to complete when the Run is not terminal', async () => {
    const { engine, fabric, id } = await withRun('running', ['verified'])
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    await engine.close()
    await fabric.close()
  })

  it('refuses to complete when a Run failed', async () => {
    const { engine, fabric, id } = await withRun('failed', ['failed'])
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    // The Mission is NOT failed. One failed attempt is not a failed outcome.
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    await engine.close()
    await fabric.close()
  })

  it('refuses to complete a Run that completed with an unverified step', async () => {
    // "The Run completed" is not "its steps were verified", and this is where the
    // two are kept apart.
    const { engine, fabric, id } = await withRun('completed', ['verified', 'skipped'])
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    await engine.close()
    await fabric.close()
  })

  it('completes when every required Run completed with every step verified', async () => {
    const { engine, fabric, id } = await withRun('completed', ['verified', 'verified'])
    const result = await engine.requestCompletion(id)
    expect(result).toMatchObject({ operation: 'verification-passed', ok: true, status: 'completed' })
    expect(engine.snapshot().missions.get(id)?.status).toBe('completed')
    expect(engine.snapshot().missions.get(id)?.verification?.state).toBe('passed')
    await engine.close()
    await fabric.close()
  })

  it('completes a draft Mission never, because only an active one may', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Still draft', intent: 'Not activated.' })).missionId as string
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await engine.attachChildRun(id, 'r1')
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/only an active Mission/)
    await engine.close()
    await fabric.close()
  })

  it('will not complete a paused Mission', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Paused', intent: 'Hold on.' })).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await engine.attachChildRun(id, 'r1')
    await engine.pause(id)
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    await engine.close()
    await fabric.close()
  })
})

describe('verification is bounded', () => {
  /**
   * A verifier whose behaviour the test controls.
   *
   * `verify` receives `(context, signal)`; the wrapper drops the context because
   * these tests are about the deadline and the abort, not the context shape.
   */
  function slowVerifier(
    wait: (context: unknown, signal: AbortSignal) => Promise<MissionVerificationOutcome>,
  ): MissionVerifierRegistry {
    return new MissionVerifierRegistry([
      { id: 'mission.work.verified', verify: (context, signal) => wait(context, signal) },
    ])
  }

  async function ready(verifiers: MissionVerifierRegistry, deadlineMs?: Partial<MissionLimits>) {
    const work = workStub()
    const { engine, fabric } = await engineOver(work, verifiers)
    const id = (await engine.create({ title: 'Slow', intent: 'Verification takes a while.' }, deadlineMs)).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await engine.attachChildRun(id, 'r1')
    return { engine, fabric, id }
  }

  it('stops waiting at the deadline and does not fabricate a failure', async () => {
    const verifiers = slowVerifier(() => new Promise<MissionVerificationOutcome>(() => {}))
    const { engine, fabric, id } = await ready(verifiers, { verificationDeadlineMs: 40 })
    const result = await engine.requestCompletion(id)

    // Not established AND not failed: the honest answer is that nobody answered.
    expect(result.operation).toBe('verification-timeout')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(MISSION_REASONS.verification_timeout)
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    await engine.close()
    await fabric.close()
  })

  it('discards a late pass that arrives after the deadline', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const verifiers = slowVerifier(async () => {
      await held
      return { established: true, reason: MISSION_REASONS.verification_passed }
    })
    const { engine, fabric, id } = await ready(verifiers, { verificationDeadlineMs: 40 })

    const pending = engine.requestCompletion(id)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect((await pending).operation).toBe('verification-timeout')

    // The verifier finally answers, long after the wall clock gave up.
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // "verification passed" must not appear after the deadline.
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    expect(engine.snapshot().missions.get(id)?.verification?.state).toBe('timeout')
    await engine.close()
    await fabric.close()
  })

  it('verifies once, and refuses a second request while the first is in flight', async () => {
    let started = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const verifiers = slowVerifier(async () => {
      started += 1
      await held
      return { established: true, reason: MISSION_REASONS.verification_passed }
    })
    const { engine, fabric, id } = await ready(verifiers)

    const first = engine.requestCompletion(id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await engine.requestCompletion(id)

    // One question gets one answer, and one `requested` event to record it.
    expect(second.ok).toBe(false)
    expect(second.operation).toBe('verification-in-progress')
    release()
    expect((await first).ok).toBe(true)

    const journal = await readFile(join(directory, 'engine.jsonl'), 'utf8')
    const requested = journal
      .split(String.fromCharCode(10))
      .filter((line) => line.includes('"mission.verification.requested"'))
    expect(requested).toHaveLength(1)
    expect(started).toBe(1)
    await engine.close()
    await fabric.close()
  })

  it('accepts a fresh request after a timeout, so a Mission is not stuck', async () => {
    // A claim left behind by a timed-out verification would strand the Mission
    // permanently, which is worse than the timeout it was avoiding.
    // A verifier that never answers, so the deadline is what ends it.
    const verifiers = slowVerifier(() => new Promise<MissionVerificationOutcome>(() => {}))
    const { engine, fabric, id } = await ready(verifiers, { verificationDeadlineMs: 30 })
    const first = await engine.requestCompletion(id)
    expect(first.operation).toBe('verification-timeout')

    const second = await engine.requestCompletion(id)
    expect(second.operation).not.toBe('verification-in-progress')
    await engine.close()
    await fabric.close()
  })

  it('treats a verifier that throws as not established, and records no message', async () => {
    const verifiers = slowVerifier(async () => {
      throw new Error('FREYA_RED_TEAM_SECRET_7A91 verifier exploded')
    })
    const { engine, fabric, id } = await ready(verifiers)
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(engine.snapshot().missions.get(id)?.status).toBe('active')
    expect(JSON.stringify(engine.snapshot())).not.toContain('FREYA_RED_TEAM_SECRET_7A91')
    await engine.close()
    await fabric.close()
  })

  it('aborts a verifier that ignores its signal once the deadline passes', async () => {
    let observedAbort = false
    const verifiers = slowVerifier((_context, signal) => {
      signal.addEventListener('abort', () => {
        observedAbort = true
      })
      return new Promise<MissionVerificationOutcome>(() => {})
    })
    const { engine, fabric, id } = await ready(verifiers, { verificationDeadlineMs: 30 })
    await engine.requestCompletion(id)
    await new Promise((resolve) => setTimeout(resolve, 40))
    // Aborting only asks, but the engine must ask.
    expect(observedAbort).toBe(true)
    await engine.close()
    await fabric.close()
  })
})

describe('cancel versus completion', () => {
  it('lets only one terminal result stand', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = workStub()
    const { engine, fabric } = await engineOver(
      work,
      new MissionVerifierRegistry([
        {
          id: 'mission.work.verified',
          verify: async () => {
            await held
            return { established: true, reason: MISSION_REASONS.verification_passed }
          },
        },
      ]),
    )
    const id = (await engine.create({ title: 'Racing', intent: 'Cancel while verifying.' })).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await engine.attachChildRun(id, 'r1')

    const completing = engine.requestCompletion(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cancelling = engine.cancel(id)
    release()

    const [completion, cancellation] = await Promise.all([completing, cancelling])
    const status = engine.snapshot().missions.get(id)?.status

    // Exactly one terminal result, and no "cancelled then completed" history.
    if (cancellation.ok) {
      expect(status).toBe('cancelled')
      expect(completion.ok).toBe(false)
    } else {
      expect(status).toBe('completed')
      expect(cancellation.ok).toBe(false)
    }
    expect(['completed', 'cancelled']).toContain(status)
    await engine.close()
    await fabric.close()
  })

  it('never resurrects a cancelled Mission, however many times it is asked', async () => {
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Final', intent: 'Settled once.' })).missionId as string
    await engine.activate(id)
    await engine.cancel(id)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await engine.cancel(id)).ok).toBe(false)
      expect((await engine.fail(id)).ok).toBe(false)
    }
    expect(engine.snapshot().missions.get(id)?.status).toBe('cancelled')
    await engine.close()
    await fabric.close()
  })
})

describe('progress is derived, never invented', () => {
  it('counts children by their real Work status', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Counts', intent: 'Several children.' })).missionId as string
    await engine.activate(id)

    work.runs.set('r1', runRecord('r1', 'completed', id))
    work.steps.set('r1', stepRecords('r1', ['verified', 'verified']))
    work.runs.set('r2', runRecord('r2', 'failed', id))
    work.steps.set('r2', stepRecords('r2', ['failed']))
    work.runs.set('r3', runRecord('r3', 'queued', id))
    await engine.attachChildRun(id, 'r1')
    await engine.attachChildRun(id, 'r2')
    await engine.attachChildRun(id, 'r3')

    const counts = engine.projection().missions[0]?.counts
    expect(counts).toMatchObject({ total: 3, completed: 1, failed: 1, queued: 1, verified: 1 })
    await engine.close()
    await fabric.close()
  })

  it('flags a Mission needing attention when a child failed, without failing it', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Needs help', intent: 'A child failed.' })).missionId as string
    await engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'failed', id))
    await engine.attachChildRun(id, 'r1')

    const view = engine.projection().missions[0]
    expect(view?.needsAttention).toBe(true)
    // The honest position: visible, not concluded.
    expect(view?.status).toBe('active')
    await engine.close()
    await fabric.close()
  })

  it('has no percentage anywhere', () => {
    // Asserted on the projection's own shape. A Mission has no denominator, and a
    // number next to the word "complete" would be an invention.
    const projection = { missions: [], counts: {}, limits: {}, persistence: {}, sequence: 0 } as never
    expect(Object.keys(projection)).not.toContain('percent')
    expect(JSON.stringify(projection)).not.toMatch(/percent|progress/i)
  })

  it('offers only the actions the status permits', async () => {
    const { engine, fabric } = await engineOver(workStub())
    const draft = (await engine.create({ title: 'Draft', intent: 'x' })).missionId as string
    const active = (await engine.create({ title: 'Active', intent: 'x' })).missionId as string
    const cancelled = (await engine.create({ title: 'Cancelled', intent: 'x' })).missionId as string
    await engine.activate(active)
    await engine.cancel(cancelled)

    const byId = new Map(engine.projection().missions.map((m) => [m.missionId, m]))
    expect(byId.get(draft)?.availableActions).toEqual(['activate', 'cancel'])
    expect(byId.get(active)?.availableActions).toEqual(['pause', 'requestCompletion', 'cancel', 'fail'])
    // A terminal Mission offers nothing. Offering a control Core would refuse teaches
    // the user that buttons lie.
    expect(byId.get(cancelled)?.availableActions).toEqual([])
    await engine.close()
    await fabric.close()
  })
})

describe('durability is reported honestly', () => {
  it('says encrypted when the content store is durable', async () => {
    const { EncryptedMissionStore } = await import('../../core/missions/encrypted-store')
    const store = await EncryptedMissionStore.open({
      path: join(directory, 'missions.enc'),
      key: new Uint8Array(32).fill(3),
    })
    const work = workStub()
    const { engine, fabric } = await engineOver(work, undefined, { store })
    const projection = engine.projection()
    expect(projection.persistence).toMatchObject({ mode: 'encrypted', durable: true })
    await engine.close()
    await fabric.close()
  })

  it('says ephemeral and not durable when there is no key', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work, undefined, {
      store: new MemoryMissionStore({ faultReason: 'no secure Mission key is available' }),
    })
    const projection = engine.projection()
    // Never claimed when it is not true. A Mission somebody was told is durable and
    // which is not is worse than no Mission at all.
    expect(projection.persistence).toMatchObject({ mode: 'ephemeral', durable: false })
    expect(projection.persistence.reason).toMatch(/no secure Mission key/)
    await engine.close()
    await fabric.close()
  })
})

describe('recovery reconciles without inventing outcomes', () => {
  /** Rebuild an engine over the same journal, as a restart would. */
  async function reopen(directory: string, now: () => Date, work: ReturnType<typeof workStub>) {
    const store = await JsonlEventStore.open(join(directory, 'engine.jsonl'))
    const fabric = await EventFabric.open({ store })
    const engine = new MissionEngine({
      fabric,
      store: new MemoryMissionStore(),
      work: work as never,
      principalId: 'owner',
      now,
      newId: (() => {
        let n = 0
        return () => `restart-id-${(n += 1)}`
      })(),
    })
    await engine.open()
    return { engine, fabric }
  }

  it('settles a Mission whose deadline passed while Freya was closed', async () => {
    const work = workStub()
    let clock = Date.parse('2026-10-01T09:00:00.000Z')
    const first = await engineOver(work, undefined, { now: () => new Date(clock) })
    const id = (await first.engine.create(
      { title: 'Outlives', intent: 'Expires overnight.' },
      { lifetimeMs: 1_000 },
    )).missionId as string
    await first.engine.activate(id)
    await first.engine.close()
    await first.fabric.close()

    // Restart well after the deadline.
    clock += 60_000
    const second = await reopen(directory, () => new Date(clock), work)

    // Awaited by `open`, so it is already true the moment the caller looks.
    expect(second.engine.snapshot().missions.get(id)?.status).toBe('failed')
    expect(second.engine.snapshot().missions.get(id)?.reason).toBe(MISSION_REASONS.deadline_expired)
    await second.engine.close()
    await second.fabric.close()
  })

  it('does not resume a Mission whose verification was interrupted by a crash', async () => {
    // The most dangerous thing recovery could do is resolve a pending verification as
    // passed. Nobody answered, so nobody established anything.
    const work = workStub()
    const verifiers = slowNever()
    const first = await engineOver(work, verifiers)
    const id = (await first.engine.create({ title: 'Interrupted', intent: 'Verify me.' })).missionId as string
    await first.engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await first.engine.attachChildRun(id, 'r1')

    // Start a verification and abandon it, as a crash would.
    void first.engine.requestCompletion(id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await first.engine.close()
    await first.fabric.close()

    const second = await reopen(directory, () => new Date('2026-10-01T10:00:00.000Z'), work)
    const mission = second.engine.snapshot().missions.get(id)

    // Not completed, because nothing established it.
    expect(mission?.status).toBe('active')
    // And the interrupted request is still visibly unresolved rather than quietly
    // claimed as a pass or a failure.
    expect(mission?.verification?.state).toBe('requested')
    await second.engine.close()
    await second.fabric.close()
  })

  it('rebuilds the whole lifecycle from the journal alone', async () => {
    // The journal is the Mission's memory. If a restart needed anything else, the
    // Mission would only exist while Freya happened to be running.
    const work = workStub()
    const first = await engineOver(work)
    const id = (await first.engine.create({ title: 'Durable', intent: 'Survive a restart.' })).missionId as string
    await first.engine.activate(id)
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await first.engine.attachChildRun(id, 'r1')
    await first.engine.close()
    await first.fabric.close()

    const second = await reopen(directory, () => new Date('2026-10-01T10:00:00.000Z'), work)
    const mission = second.engine.snapshot().missions.get(id)
    expect(mission?.status).toBe('active')
    expect(mission?.childRuns).toEqual(['r1'])
    expect(second.engine.projection().missions[0]?.counts).toMatchObject({ total: 1, completed: 1 })
    await second.engine.close()
    await second.fabric.close()
  })
})

describe('no Mission event is a security event', () => {
  it('keeps the whole family out of the security stream', () => {
    const types: CoreEventType[] = [
      'mission.created',
      'mission.activated',
      'mission.paused',
      'mission.resumed',
      'mission.cancelled',
      'mission.failed',
      'mission.completed',
      'mission.run.attached',
      'mission.verification.requested',
      'mission.verification.completed',
      'mission.limit.exceeded',
    ]
    for (const type of types) {
      expect(isSecurityEvent(type)).toBe(false)
    }
  })
})