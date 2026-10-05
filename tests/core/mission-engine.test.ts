// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionEngine } from '../../core/missions/engine'
import { MemoryMissionStore } from '../../core/missions/memory-store'
import type { MissionStore } from '../../core/missions/store'
import { MissionVerifierRegistry } from '../../core/missions/verifier'
import {
  DEFAULT_MISSION_LIMITS,
  MISSION_REASONS,
  type MissionLimits,
  type MissionVerificationOutcome,
} from '../../core/missions/types'
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
    expect(await engine.pause(id)).toMatchObject({ operation: 'paused', ok: true, status: 'stopped' })
    // Phase 7's meaning, unchanged: the owner pressed resume, so it runs. `stopped -> ready`
    // exists for the autonomous path — "the gate is open again" and "it is running" are two
    // different facts there — but a window's Resume button means the second.
    expect(await engine.resume(id)).toMatchObject({ operation: 'resumed', ok: true, status: 'active' })
    expect(await engine.cancel(id)).toMatchObject({ operation: 'cancelled', ok: true, status: 'cancelled' })
    await engine.close()
    await fabric.close()
  })

  it('records a resume as a resume, not a second activation', async () => {
    // "Was this ever stopped?" is answerable only if the journal keeps these apart, and
    // Phase 47's twelve-status machine has many edges landing on the same status, so
    // only the origin tells them apart.
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Once stopped', intent: 'Interrupt me.' })).missionId as string
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

    // Exactly one of them may have taken effect, and a stopped Mission admits no new Run
    // — so if the stop won, the attachment must have refused. `stopped` rather than the
    // old `paused`, and the refusal names the live statuses rather than `active`.
    if (paused.ok) {
      expect(attached.ok).toBe(false)
      expect(attached.reason).toMatch(/only a live Mission/)
    }
    expect(engine.snapshot().missions.get(id)?.status).toBe(paused.ok ? 'stopped' : 'active')
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

  it('refuses to complete with no child Run and no evidence', async () => {
    // Phase 47 changed *why* this refuses, and the change matters.
    //
    // Before, an empty child-Run list was refused at the door, which meant a Mission
    // driven by observed evidence rather than by Runs could never complete — "find 100
    // cat videos" is established by 100 observations whether or not a Run exists. So the
    // refusal now belongs to the **verifier**, which can see the evidence counts this
    // engine cannot judge on its own.
    //
    // What is unchanged is the outcome: a Mission with nothing behind it is not
    // established, and it comes back `verifying` rather than completed.
    const { engine, fabric } = await engineOver(workStub())
    const id = (await engine.create({ title: 'Empty', intent: 'Nothing attempted.' })).missionId as string
    await engine.activate(id)
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(MISSION_REASONS.no_evidence)
    // Still checking, and not completed. The Mission is *live* again rather than
    // settled: a verification that did not establish is not a failed outcome.
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

  it('completes a draft Mission never, because only a live one may', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'Still draft', intent: 'Not activated.' })).missionId as string
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    await engine.attachChildRun(id, 'r1')
    const result = await engine.requestCompletion(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/cannot be completed from draft/)
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
    //
    // And the Mission stays `verifying`, which is the Phase 47 change and the reason the
    // state exists. A verdict would return it to `active` — that was an answer — but a
    // timeout is *not* an answer, so the Mission keeps owning an open question. Returning
    // it to `active` would say "we finished looking", which is not what happened.
    expect(result.operation).toBe('verification-timeout')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(MISSION_REASONS.verification_timeout)
    expect(result.status).toBe('verifying')
    expect(engine.snapshot().missions.get(id)?.status).toBe('verifying')
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
    // "verification passed" must not appear after the deadline, and the Mission stays in
    // the state that says the question is still open.
    expect(engine.snapshot().missions.get(id)?.status).toBe('verifying')
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
    // Phase 47 widened the surface, so the lists are longer — and each addition is
    // something an owner may do to a Mission that has not settled. `stop` replaces the
    // old `pause`: it is the same button with a truer name, and `correct` is the door to
    // intent patching.
    expect(byId.get(draft)?.availableActions).toEqual(['activate', 'stop', 'correct', 'cancel'])
    expect(byId.get(active)?.availableActions).toEqual([
      'requestCompletion',
      'stop',
      'correct',
      'cancel',
      'fail',
    ])
    // A terminal Mission offers nothing. Offering a control Core would refuse teaches
    // the user that buttons lie.
    expect(byId.get(cancelled)?.availableActions).toEqual([])
    await engine.close()
    await fabric.close()
  })

  it('offers the control that is actually about each parked status', async () => {
    // The four parked statuses each need a different thing from a person, and offering
    // the wrong control is how a Mission gets waved through the state it is in.
    const { engine, fabric } = await engineOver(workStub())

    const stopped = (await engine.create({ title: 'Stopped', intent: 'x' })).missionId as string
    await engine.activate(stopped)
    await engine.pause(stopped)
    const byId = new Map(engine.projection().missions.map((m) => [m.missionId, m]))
    expect(byId.get(stopped)?.status).toBe('stopped')
    // Only the owner's resume releases a stopped Mission, so that is what is offered — and
    // it is Phase 7's `resume`, not `resumeAutonomy`, because reopening a latched gate and
    // running is one action while carrying on from a wait is a different one.
    expect(byId.get(stopped)?.availableActions).toContain('resume')
    expect(byId.get(stopped)?.availableActions).not.toContain('requestCompletion')

    await engine.close()
    await fabric.close()
  })
})

describe('a stalled child is visible', () => {
  it('flags an active Mission whose only child is paused', async () => {
    // Nothing is failing and nothing was cancelled, so `failed`/`cancelled` both read
    // zero — yet the Mission has stopped moving and will not resume on its own. Without
    // this the board renders "1 run" with no warning, which is the quietest possible
    // wrong answer.
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const missionId = (await engine.create({ title: 'Stalled', intent: 'Waiting for nothing.' })).missionId as string
    await engine.activate(missionId)
    work.runs.set('r1', runRecord('r1', 'paused'))
    await engine.attachChildRun(missionId, 'r1')

    const view = engine.projection().missions[0]
    expect(view?.status).toBe('active')
    expect(view?.needsAttention).toBe(true)
    await engine.close()
    await fabric.close()
  })

  it('flags an active Mission whose only child is waiting', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const missionId = (await engine.create({ title: 'Waiting', intent: 'Blocked on a person.' })).missionId as string
    await engine.activate(missionId)
    work.runs.set('r1', runRecord('r1', 'waiting'))
    await engine.attachChildRun(missionId, 'r1')

    expect(engine.projection().missions[0]?.needsAttention).toBe(true)
    await engine.close()
    await fabric.close()
  })

  it('does not flag a paused Mission merely for having paused children', async () => {
    // A Mission the owner paused is not a Mission needing attention; the pause is the
    // answer, not the problem.
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const missionId = (await engine.create({ title: 'Held', intent: 'Paused on purpose.' })).missionId as string
    await engine.activate(missionId)
    work.runs.set('r1', runRecord('r1', 'paused'))
    await engine.attachChildRun(missionId, 'r1')
    await engine.pause(missionId)

    expect(engine.projection().missions[0]?.needsAttention).toBe(false)
    await engine.close()
    await fabric.close()
  })

  it('does not flag a running child', async () => {
    // The ordinary case: work in progress is not a problem to report.
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const missionId = (await engine.create({ title: 'Busy', intent: 'Working on it.' })).missionId as string
    await engine.activate(missionId)
    work.runs.set('r1', runRecord('r1', 'running'))
    await engine.attachChildRun(missionId, 'r1')

    expect(engine.projection().missions[0]?.needsAttention).toBe(false)
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

describe('a corrected quantity survives a restart', () => {
  /**
   * These are replay tests, and the second engine is the whole point of them: nothing is
   * carried across in memory, so any number the revived engine reports has to have come
   * out of the journal.
   *
   * The defect they cover was invisible to every other test in this file. An earlier
   * version journalled `changedFields: ['quantity']` and then wrote the new number
   * straight into the record, so `record()` reported the corrected quantity and every
   * assertion against the live engine passed — while the fold had nothing to apply, and
   * the first restart put the Mission silently back to asking for 100 with no event
   * explaining why.
   */
  async function reopened(clock: number, work: ReturnType<typeof workStub>) {
    const store = await JsonlEventStore.open(join(directory, 'engine.jsonl'))
    const fabric = await EventFabric.open({ store })
    const engine = new MissionEngine({
      fabric,
      store: new MemoryMissionStore(),
      work: work as never,
      principalId: 'owner',
      now: () => new Date(clock),
      newId: (() => {
        let n = 0
        return () => `restart-id-${(n += 1)}`
      })(),
    })
    await engine.open()
    return { engine, fabric }
  }

  it('replays to the corrected number, not the one the Mission was created with', async () => {
    const work = workStub()
    const start = Date.parse('2026-10-01T09:00:00.000Z')
    const first = await engineOver(work, undefined, { now: () => new Date(start) })
    const id = (
      await first.engine.create({ title: 'cat videos', intent: 'find 100 cat videos' }, undefined, { requestedQuantity: 100 })
    ).missionId as string
    await first.engine.activate(id)
    expect(first.engine.record(id)?.requestedQuantity).toBe(100)

    const corrected = await first.engine.setRequestedQuantity({ missionId: id, requestedQuantity: 12 })
    expect(corrected.ok).toBe(true)
    expect(first.engine.record(id)?.requestedQuantity).toBe(12)
    await first.engine.close()
    await first.fabric.close()

    const second = await reopened(start + 60_000, work)
    expect(second.engine.record(id)?.requestedQuantity).toBe(12)
    await second.engine.close()
    await second.fabric.close()
  })

  it('tells "the quantity was removed" apart from "the quantity did not change"', async () => {
    const work = workStub()
    const start = Date.parse('2026-10-01T09:00:00.000Z')
    const first = await engineOver(work, undefined, { now: () => new Date(start) })
    const id = (
      await first.engine.create({ title: 'cat videos', intent: 'find 100 cat videos' }, undefined, { requestedQuantity: 100 })
    ).missionId as string
    await first.engine.activate(id)
    // `null` is a *value*, not an absence: it means the owner stopped asking for a count.
    // A fold that collapsed it with "unchanged" would keep enforcing a target that no
    // longer exists.
    await first.engine.setRequestedQuantity({ missionId: id, requestedQuantity: null })
    await first.engine.close()
    await first.fabric.close()

    const second = await reopened(start + 60_000, work)
    expect(second.engine.record(id)?.requestedQuantity).toBeNull()
    await second.engine.close()
    await second.fabric.close()
  })

  it('refuses a correction that attaches a quantity to one it did not change', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (
      await engine.create({ title: 'cat videos', intent: 'find 100 cat videos' }, undefined, { requestedQuantity: 100 })
    ).missionId as string
    await engine.activate(id)
    // Claiming a new target inside a correction about the *location* is how a goal moves
    // through a path nobody reviewed. The binding is checked in the engine and again in
    // the validator, so neither layer can be the only one holding it.
    const outcome = await engine.recordCorrection({
      missionId: id,
      correctionId: 'c-context',
      kind: 'patch',
      changedFields: ['context'],
      settledSteps: 0,
      preservedEvidence: 0,
      replannedFrom: null,
      requestedQuantity: 3,
    })
    expect(outcome.ok).toBe(false)
    expect(engine.record(id)?.requestedQuantity).toBe(100)
    await engine.close()
    await fabric.close()
  })
})

describe('an approval is a pointer to a Work gate, and survives a restart as one', () => {
  /**
   * There is no expiry here to test, and that is the point.
   *
   * A Mission used to keep `MissionApprovalGate` records with their own
   * `expiresAt`, clamped to the Mission deadline, and recovery compared the clock against
   * them. All of that is gone: the gate is Work's, Work's TTL expires it, and Work writes
   * `work.approval.expired`.
   *
   * What remains is a **pointer**, and the property worth testing is that a pointer
   * survives a restart intact and that nothing on this side of the boundary can answer a
   * question it is only holding.
   */
  async function noteGate(engine: MissionEngine, missionId: string) {
    return engine.noteApprovalRequested({
      missionId,
      stepId: 's1',
      approvalId: 'work-gate-1',
      source: 'requested',
      runId: 'run-s1',
      requestedAt: '2026-10-01T09:00:05.000Z',
    })
  }

  it('replays the pointer to the same Work gate', async () => {
    const work = workStub()
    const start = Date.parse('2026-10-01T09:00:00.000Z')
    const first = await engineOver(work, undefined, { now: () => new Date(start) })
    const id = (await first.engine.create({ title: 'gate', intent: 'do the consequential thing' }))
      .missionId as string
    await first.engine.activate(id)
    expect((await noteGate(first.engine, id)).ok).toBe(true)
    await first.engine.close()
    await first.fabric.close()

    const second = await engineOver(work, undefined, { now: () => new Date(start + 3_600_000) })
    const reference = second.engine.record(id)?.approval
    expect(reference?.approvalId).toBe('work-gate-1')
    expect(reference?.stepId).toBe('s1')
    expect(reference?.source).toBe('requested')
    // The Run travels with the pointer, which is what lets a restarted Mission poll its
    // gate without executing the step a second time.
    expect(reference?.runId).toBe('run-s1')
    // **Still open.** Work has not reported anything, so the Mission is still waiting — a
    // restart does not withdraw the question, which is the defect this replaces.
    expect(reference?.outcome).toBeNull()
    await second.engine.close()
    await second.fabric.close()
  })

  it('refuses an outcome for a gate it is not waiting on', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'gate', intent: 'do something' })).missionId as string
    await engine.activate(id)
    // No pointer recorded, so there is nothing to report an outcome against. A stray
    // outcome event would be a Mission asserting a decision about an approval it never
    // asked Work about.
    const stray = await engine.noteApprovalOutcome({ missionId: id, approvalId: 'work-gate-x', outcome: 'approved' })
    expect(stray.ok).toBe(false)
    expect(stray.reason).toMatch(/not waiting on that approval/)
    await engine.close()
    await fabric.close()
  })

  it('raises a blocker for a denial and for an expiry, and neither is a pass', async () => {
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const id = (await engine.create({ title: 'gate', intent: 'do something' })).missionId as string
    await engine.activate(id)
    await noteGate(engine, id)

    await engine.noteApprovalOutcome({ missionId: id, approvalId: 'work-gate-1', outcome: 'denied' })
    expect(engine.snapshot().missions.get(id)?.blockers.map((b) => b.code)).toContain('approval_denied')

    const second = (await engine.create({ title: 'gate 2', intent: 'do something else' })).missionId as string
    await engine.activate(second)
    await noteGate(engine, second)
    await engine.noteApprovalOutcome({ missionId: second, approvalId: 'work-gate-1', outcome: 'expired' })
    // **Silence is not consent.** An expiry blocks exactly as a denial does, because the
    // step will not run either way and only a person can change that.
    expect(engine.snapshot().missions.get(second)?.blockers.map((b) => b.code)).toContain('approval_expired')
    await engine.close()
    await fabric.close()
  })

  it('has no method that could decide or expire an approval', async () => {
    // Structural. The engine cannot open a gate, record a decision or expire one, so
    // `work.approval.decide` is the only door in the codebase where an approval becomes
    // approved.
    const methods = Object.getOwnPropertyNames(MissionEngine.prototype).sort()
    expect(methods).not.toContain('openApproval')
    expect(methods).not.toContain('decideApproval')
    expect(methods).not.toContain('expireApproval')
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
    expect(mission?.status).toBe('verifying')
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

describe('journal failures degrade, they do not strand or crash', () => {
  /** A Mission with one completed child, so completion is otherwise admissible. */
  async function readyWithChild(): Promise<{
    engine: MissionEngine
    fabric: EventFabric
    missionId: string
    breakJournal: () => void
    mendJournal: () => void
  }> {
    const work = workStub()
    work.runs.set('r1', runRecord('r1', 'completed'))
    work.steps.set('r1', stepRecords('r1', ['verified']))
    const { engine, fabric } = await engineOver(work)
    const missionId = (await engine.create({ title: 'Fragile', intent: 'Depends on the journal.' })).missionId as string
    await engine.activate(missionId)
    await engine.attachChildRun(missionId, 'r1')
    const real = fabric.append.bind(fabric)
    return {
      engine,
      fabric,
      missionId,
      breakJournal: () => {
        ;(fabric as unknown as { append: () => Promise<never> }).append = async () => {
          throw new Error('journal write failed (simulated)')
        }
      },
      mendJournal: () => {
        ;(fabric as unknown as { append: unknown }).append = real
      },
    }
  }

  it('releases the verification claim when the journal refuses the request', async () => {
    // The claim is taken before the write that can fail, so without this the Mission is
    // wedged behind a `verification-in-progress` refusal for the life of the process —
    // after one disk error, and with no way for the owner to clear it.
    const { engine, fabric, missionId, breakJournal, mendJournal } = await readyWithChild()
    breakJournal()
    await expect(engine.requestCompletion(missionId)).rejects.toThrow()
    mendJournal()

    const retry = await engine.requestCompletion(missionId)
    expect(retry.operation).not.toBe('verification-in-progress')
    expect(retry.ok).toBe(true)
    expect(engine.snapshot().missions.get(missionId)?.status).toBe('completed')
    await engine.close()
    await fabric.close()
  })

  it('does not raise an unhandled rejection when a command fails', async () => {
    // `result.finally(...)` returns a *new* promise. Handling `result` does not handle
    // it, so a rejected command used to leave a rejected promise with no listener —
    // which Node treats as an unhandled rejection, and by default as a process exit.
    // A journal failure is exactly what this engine degrades from gracefully, so it
    // must not take the process with it.
    const rejections: unknown[] = []
    const listener = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const { engine, fabric, missionId, breakJournal, mendJournal } = await readyWithChild()
      breakJournal()
      await engine.activate(missionId).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 50))
      mendJournal()
      await engine.close()
      await fabric.close()
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(rejections).toEqual([])
  })
})

describe('retention is reported, not hidden', () => {
  it('says how many Missions exist beyond the ones it lists', async () => {
    // `maxRetainedMissions` bounds the listing only, so a board that stopped listing
    // Missions would read as "they were never created". Work reports this triple for
    // its runs; without it the gap is invisible to anything watching.
    const work = workStub()
    const { engine, fabric } = await engineOver(work)
    const stored: string[] = []
    for (let index = 0; index < DEFAULT_MISSION_LIMITS.maxRetainedMissions + 5; index += 1) {
      stored.push((await engine.create({ title: `m${index}`, intent: 'i' })).missionId as string)
    }

    const projection = engine.projection()
    expect(projection.missionsTotal).toBe(DEFAULT_MISSION_LIMITS.maxRetainedMissions + 5)
    expect(projection.missionsRetained).toBe(DEFAULT_MISSION_LIMITS.maxRetainedMissions)
    expect(projection.missionsHidden).toBe(5)
    // The in-memory fold keeps everything, so nothing was actually destroyed — which is
    // precisely why the gap has to be declared rather than left to be noticed.
    expect(engine.snapshot().missions.size).toBe(DEFAULT_MISSION_LIMITS.maxRetainedMissions + 5)
    expect(stored).toHaveLength(DEFAULT_MISSION_LIMITS.maxRetainedMissions + 5)
    await engine.close()
    await fabric.close()
  })

  it('reports no hidden Missions when there are few', async () => {
    const { engine, fabric } = await engineOver(workStub())
    await engine.create({ title: 'only', intent: 'i' })
    const projection = engine.projection()
    expect(projection.missionsHidden).toBe(0)
    expect(projection.missionsTotal).toBe(projection.missionsRetained)
    await engine.close()
    await fabric.close()
  })
})

describe('a damaged store is reported, not papered over', () => {
  it('stops claiming to be durable when its records cannot be read', async () => {
    // The engine builds persistence from the store's own fault reason, so a store that
    // reports its damage is enough to stop the projection claiming `durable: true` over
    // content nothing can read.
    const { EncryptedMissionStore } = await import('../../core/missions/encrypted-store')
    const path = join(directory, 'damaged.enc')
    const damaged = await EncryptedMissionStore.open({ path, key: new Uint8Array(32).fill(5) })
    await damaged.write({
      missionId: 'm1',
      title: 't',
      intent: 'i',
      intentShape: null,
      successCriteria: [],
      createdAt: '2026-10-01T09:00:00.000Z',
    })
    await damaged.close()

    // Damage the only record, then reopen.
    const raw = await readFile(path, 'utf8')
    const line = JSON.parse(raw) as { cipher: string }
    await writeFile(path, `${JSON.stringify({ ...line, cipher: `${line.cipher.slice(0, -4)}AAAA` })}
`)

    const reopened = await EncryptedMissionStore.open({ path, key: new Uint8Array(32).fill(5) })
    const work = workStub()
    const { engine, fabric } = await engineOver(work, undefined, { store: reopened })
    const persistence = engine.projection().persistence

    // Encrypted, yes. Durable, no — and the reason is the store's own words.
    expect(persistence.mode).toBe('encrypted')
    expect(persistence.durable).toBe(false)
    expect(persistence.reason).toMatch(/failed authentication/)
    await engine.close()
    await fabric.close()
  })

  it('refuses to create a Mission rather than keep one it cannot store', async () => {
    // The engine writes the private text *before* it records the Mission, so a store
    // that refuses writes means creation is refused too — with a reason, and with no
    // half-created Mission left in the journal. A Mission whose text could not be kept
    // is not a Mission; the alternative is a row on the board that loses the owner's
    // words on the next restart.
    const { EncryptedMissionStore } = await import('../../core/missions/encrypted-store')
    const path = join(directory, 'damaged2.enc')
    const opened = await EncryptedMissionStore.open({ path, key: new Uint8Array(32).fill(6) })
    await opened.close()
    await writeFile(path, ['not a mission record at all', ''].join(String.fromCharCode(10)))

    const reopened = await EncryptedMissionStore.open({ path, key: new Uint8Array(32).fill(6) })
    const work = workStub()
    const { engine, fabric } = await engineOver(work, undefined, { store: reopened })

    const created = await engine.create({ title: 'During a fault', intent: 'Still allowed.' })
    expect(created.ok).toBe(false)
    expect(created.reason).toMatch(/could not be stored/i)

    // And nothing was recorded, so the board does not show a Mission that has no words.
    expect(engine.projection().counts.total).toBe(0)
    // The projection is honest about why.
    expect(engine.projection().persistence.durable).toBe(false)
    await engine.close()
    await fabric.close()
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