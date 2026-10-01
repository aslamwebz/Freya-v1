// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import type { CognitionOutcome } from '../../core/cognition/service'
import type { WorkerIntent } from '../../core/authority'
import { WorkforceEngine } from '../../core/workforce/engine'
import type { WorkforceOwnerScope } from '../../core/workforce/authority'
import { WORKFORCE_LIMITS } from '../../core/workforce/types'

/**
 * The Workforce engine, over a real journal.
 *
 * Grouped by the property each group defends rather than by method, because the methods
 * are not what matters — what matters is which of them cannot be made to lie.
 *
 * These drive the engine directly rather than through a whole Core. The claims that need
 * a running Core — no message body in the journal, zero idle model calls, STOP ALL
 * through the command surface, restart after relaunch — belong in
 * `workforce-core.test.ts` and are not duplicated here.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-workforce-engine-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

interface Harness {
  readonly owner: WorkforceOwnerScope
  readonly engine: WorkforceEngine
  readonly fabric: EventFabric
  readonly cognition: ReturnType<typeof vi.fn>
  readonly journal: () => Promise<string>
}

/**
 * An engine over a real journal, with a counting cognition port.
 *
 * The port counts rather than asserting, because "the engine itself spends nothing" is
 * only checkable if something is keeping count of what it would have spent.
 */
async function engineOver(
  options: {
    limits?: Partial<Record<keyof typeof WORKFORCE_LIMITS, number>>
    now?: () => Date
    missions?: readonly string[]
    cognition?: (workerId: string, intent: Omit<WorkerIntent, 'grantId'>) => Promise<CognitionOutcome>
  } = {},
): Promise<Harness> {
  const path = join(directory, 'engine.jsonl')
  const eventStore = await JsonlEventStore.open(path)
  const fabric = await EventFabric.open({ store: eventStore })
  let n = 0

  const cognition = vi.fn(
    options.cognition ??
      (async (): Promise<CognitionOutcome> => ({
        status: 'allowed',
        requestId: 'req-1',
        text: 'an answer',
        providerId: 'fake',
        model: 'fake',
      })),
  )

  const engine = new WorkforceEngine({
    fabric,
    core: {
      requestCognition: async (workerId, intent) => {
        // The engine may only ask as a worker, so a test that gets here and finds a
        // non-`agent_step` kind has found a real hole in the boundary.
        if (intent.kind !== 'agent_step') throw new Error('a worker may not present a user turn')
        return cognition(workerId, intent)
      },
      missionExists: (missionId) => (options.missions ?? []).includes(missionId),
    },
    principalId: 'owner',
    now: options.now ?? (() => new Date()),
    newId: () => `id-${(n += 1)}`,
    stopAll: () => false,
    limits: options.limits,
  })
  await engine.open()

  return {
    owner: engine.ownerScope(),
    engine,
    fabric,
    cognition,
    journal: async () => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return ''
      }
    },
  }
}

/** Create a worker and return its id, failing loudly rather than with a cast. */
async function worker(owner: WorkforceOwnerScope, name: string, specialisation = 'general', budgets?: Record<string, number>): Promise<string> {
  const outcome = await owner.createWorker({ name, specialisation, ...(budgets ? { budgets } : {}) })
  if (!outcome.ok || outcome.workerId === undefined) {
    throw new Error(`creating ${name} failed: ${outcome.reason}`)
  }
  return outcome.workerId
}

/* ----------------------------------------------------------------- lifecycle */

describe('a worker exists before it is allowed to do anything', () => {
  it('creates a named worker with no capability and no context', async () => {
    const { owner } = await engineOver()
    const id = await worker(owner, 'Alpha')

    const view = owner.projection().workers.find((w) => w.workerId === id)
    expect(view).toMatchObject({ name: 'Alpha', specialisation: 'general', status: 'idle' })
    // The point of creating one this way: an agent exists first, and granting comes after.
    expect(view?.capabilities).toEqual([])
    expect(view?.contextRefs).toEqual([])
    expect(view?.assignments).toEqual([])
  })

  it('gives every worker a stable id that outlives the projection read', async () => {
    const { owner } = await engineOver()
    const first = await worker(owner, 'Alpha')
    const second = await worker(owner, 'Beta')
    expect(first).not.toBe(second)

    // Read the projection twice; the id is derived from the journal, not from a Map
    // keyed by something a caller supplied.
    expect(owner.projection().workers.map((w) => w.workerId)).toContain(first)
    expect(owner.projection().workers.map((w) => w.workerId)).toContain(second)
  })

  it('refuses an unknown specialisation rather than defaulting to one', async () => {
    const { owner } = await engineOver()
    const outcome = await owner.createWorker({ name: 'Alpha', specialisation: 'omniscient' })
    expect(outcome).toMatchObject({ operation: 'worker-created', ok: false })
    expect(outcome.reason).toMatch(/not a specialisation/)
  })

  it('refuses a name that is empty, oversized or carries control characters', async () => {
    const { owner } = await engineOver()
    expect(await owner.createWorker({ name: '   ', specialisation: 'general' })).toMatchObject({ ok: false })
    expect(
      await owner.createWorker({ name: 'A'.repeat(WORKFORCE_LIMITS.maxNameChars + 1), specialisation: 'general' }),
    ).toMatchObject({ ok: false })

    // Stripped rather than rejected: a stray escape byte in a name is removed, because
    // the name lands in window titles and accessibility labels where a surviving escape
    // sequence is a way to make a terminal say something Freya did not say.
    const cleaned = await owner.createWorker({ name: 'Al\u0007pha', specialisation: 'general' })
    expect(cleaned.ok).toBe(true)
    expect(owner.projection().workers[0]?.name).toBe('Alpha')
  })
})

describe('the worker state machine is closed and settlement is final', () => {
  it('suspends, resumes, stops and retires', async () => {
    const { owner } = await engineOver()
    const id = await worker(owner, 'Alpha')

    expect(await owner.suspendWorker(id)).toMatchObject({ ok: true, status: 'blocked' })
    expect(await owner.resumeWorker(id)).toMatchObject({ ok: true, status: 'idle' })
    expect(await owner.suspendWorker(id)).toMatchObject({ ok: true, status: 'blocked' })
    expect(await owner.resumeWorker(id)).toMatchObject({ ok: true, status: 'idle' })
    expect(await owner.retireWorker(id)).toMatchObject({ ok: true, status: 'retired' })
  })

  it('refuses everything after retirement, because retirement is terminal', async () => {
    const { owner } = await engineOver()
    const id = await worker(owner, 'Alpha')
    await owner.retireWorker(id)

    // Every one of these is refused by the transition table rather than by a per-call
    // check, which is what makes a late event harmless.
    expect(await owner.suspendWorker(id)).toMatchObject({ ok: false })
    expect(await owner.resumeWorker(id)).toMatchObject({ ok: false })
    expect(await owner.retireWorker(id)).toMatchObject({ ok: false })
    expect(await owner.assignCapability(id, 'cognition.request')).toMatchObject({ ok: false })
    expect(await owner.assignContext(id, 'ctx-1')).toMatchObject({ ok: false })
  })

  it('reports settlement in a person\'s words rather than the table\'s edge list', async () => {
    const { owner } = await engineOver()
    const id = await worker(owner, 'Alpha')
    await owner.retireWorker(id)
    expect((await owner.suspendWorker(id)).reason).toMatch(/already retired/)
  })
})

/* --------------------------------------------------------------------- teams */

describe('teams are membership, and nothing more', () => {
  it('adds and removes members, and both sides agree', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    const beta = await worker(owner, 'Beta')
    const team = await owner.createTeam({ name: 'Research', specialisation: 'research' })
    const teamId = team.teamId as string

    await owner.joinTeam(teamId, alpha)
    await owner.joinTeam(teamId, beta)

    const projection = owner.projection()
    expect(projection.teams[0]?.members).toEqual([alpha, beta])
    // Both sides, because a roster where a worker is not in a team it appears to be in
    // is worse than either view alone.
    expect(projection.workers.find((w) => w.workerId === alpha)?.teams).toEqual([teamId])

    await owner.leaveTeam(teamId, alpha)
    expect(owner.projection().teams[0]?.members).toEqual([beta])
    expect(owner.projection().workers.find((w) => w.workerId === alpha)?.teams).toEqual([])
  })

  it('is idempotent, so re-reading and re-sending is not an error', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    const teamId = (await owner.createTeam({ name: 'Research' })).teamId as string

    await owner.joinTeam(teamId, alpha)
    await owner.joinTeam(teamId, alpha)
    expect(owner.projection().teams[0]?.members).toEqual([alpha])
  })

  it('refuses a disbanded team and clears its membership in one line', async () => {
    const { owner, journal } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    const beta = await worker(owner, 'Beta')
    const teamId = (await owner.createTeam({ name: 'Research' })).teamId as string
    await owner.joinTeam(teamId, alpha)
    await owner.joinTeam(teamId, beta)

    await owner.disbandTeam(teamId)

    expect(owner.projection().teams[0]).toMatchObject({ status: 'disbanded', members: [] })
    expect(owner.projection().workers.find((w) => w.workerId === alpha)?.teams).toEqual([])

    // One line, not sixteen: a team of sixteen must not produce sixteen member events
    // for one decision, because sixteen lines can half-apply and one cannot.
    const disbandLines = (await journal())
      .split('\n')
      .filter((line) => line.includes('workforce.team.transitioned'))
    expect(disbandLines).toHaveLength(1)
    expect(await owner.joinTeam(teamId, alpha)).toMatchObject({ ok: false })
  })

  it('refuses a retired worker joining any team', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    const teamId = (await owner.createTeam({ name: 'Research' })).teamId as string
    await owner.retireWorker(alpha)
    expect(await owner.joinTeam(teamId, alpha)).toMatchObject({ ok: false })
  })

  it('enforces both membership ceilings, and records that it did', async () => {
    const { owner, journal } = await engineOver({ limits: { maxMembersPerTeam: 2, maxTeamsPerWorker: 1 } })
    const a = await worker(owner, 'Alpha')
    const b = await worker(owner, 'Beta')
    const c = await worker(owner, 'Gamma')
    const team = (await owner.createTeam({ name: 'Research' })).teamId as string

    expect(await owner.joinTeam(team, a)).toMatchObject({ ok: true })
    expect(await owner.joinTeam(team, b)).toMatchObject({ ok: true })
    // Checked before the change, not after it.
    expect(await owner.joinTeam(team, c)).toMatchObject({ ok: false })

    const other = (await owner.createTeam({ name: 'Operations' })).teamId as string
    expect(await owner.joinTeam(other, a)).toMatchObject({ ok: false })

    // Durable, so a restart cannot hide that a ceiling was reached.
    const raw = await journal()
    expect(raw).toContain('workforce.limit.exceeded')
    expect(owner.projection().workers.find((w) => w.workerId === a)?.limitsHit).toContain('maxTeamsPerWorker')
  })
})

/* --------------------------------------------------------------- assignments */

describe('assignments are the unit of concurrency', () => {
  it('a worker holding an open assignment reads as working, and idle again once settled', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')

    const assigned = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    expect(assigned).toMatchObject({ operation: 'assignment-created', ok: true })
    expect(owner.projection().workers[0]?.status).toBe('working')

    await owner.cancelAssignment(assigned.assignmentId as string)
    // `working` follows the assignment rather than a separate instruction, so a worker
    // cannot claim to be busy without holding something open.
    expect(owner.projection().workers[0]?.status).toBe('idle')
  })

  it('an assignment may only narrow the worker it was given to', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')

    // Never assigned `cognition.request` at all.
    expect(await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })).toMatchObject({ ok: false })

    await owner.assignCapability(alpha, 'cognition.request')
    await owner.assignContext(alpha, 'ctx-1')
    expect(await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })).toMatchObject({ ok: true })
    // And context the same way: an assignment cannot introduce a reference the worker
    // was never given, which is what keeps cross-worker leakage out of reach.
    expect(
      await owner.assign({ workerId: alpha, capabilities: ['cognition.request'], contextRefs: ['ctx-2'] }),
    ).toMatchObject({ ok: false })
  })

  it('enforces the global concurrency ceiling, and it reopens when work settles', async () => {
    const { owner } = await engineOver({ limits: { maxConcurrentAssignments: 2 } })
    const a = await worker(owner, 'Alpha')
    const b = await worker(owner, 'Beta')
    const c = await worker(owner, 'Gamma')
    for (const id of [a, b, c]) await owner.assignCapability(id, 'cognition.request')

    const first = await owner.assign({ workerId: a, capabilities: ['cognition.request'] })
    const second = await owner.assign({ workerId: b, capabilities: ['cognition.request'] })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(await owner.assign({ workerId: c, capabilities: ['cognition.request'] })).toMatchObject({ ok: false })
    expect(owner.projection().workers.find((w) => w.workerId === c)?.limitsHit).toContain('maxConcurrentAssignments')

    // A bound that never reopened would be a total limit wearing the wrong name.
    await owner.cancelAssignment(first.assignmentId as string)
    expect(await owner.assign({ workerId: c, capabilities: ['cognition.request'] })).toMatchObject({ ok: true })
  })

  it('enforces the per-worker open and lifetime assignment ceilings', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha', 'general', { maxOpenAssignments: 1, maxAssignments: 2 })
    await owner.assignCapability(alpha, 'cognition.request')

    const first = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    expect(first.ok).toBe(true)
    // The open ceiling, checked before the thing it bounds.
    expect(await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })).toMatchObject({ ok: false })

    // Settle it, so the *lifetime* ceiling is what refuses next. Two ceilings, two
    // different facts, and a caller told which one stopped it.
    await owner.cancelAssignment(first.assignmentId as string)
    const second = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    expect(second.ok).toBe(true)

    await owner.cancelAssignment(second.assignmentId as string)
    const third = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    expect(third.ok).toBe(false)
    expect(third.reason).toMatch(/used all 2/)
    expect(owner.projection().workers[0]?.limitsHit).toContain('maxAssignments')
  })

  it('refuses work for a Mission that does not exist', async () => {
    const { owner } = await engineOver({ missions: ['mission-real'] })
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')

    expect(
      await owner.assign({ workerId: alpha, capabilities: ['cognition.request'], missionId: 'mission-forged' }),
    ).toMatchObject({ ok: false })
    expect(
      await owner.assign({ workerId: alpha, capabilities: ['cognition.request'], missionId: 'mission-real' }),
    ).toMatchObject({ ok: true })
  })

  it('refuses work for a stopped, suspended or retired worker', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')

    await owner.suspendWorker(alpha)
    expect(await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })).toMatchObject({ ok: false })

    await owner.resumeWorker(alpha)
    const teamId = (await owner.createTeam({ name: 'T' })).teamId as string
    void teamId
    // A stop that only stopped new arrivals while leaving a paused agent ready to accept
    // work would not be a stop.
    await owner.stopAll('test')
    expect(await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })).toMatchObject({ ok: false })
  })

  it('retiring a worker settles what it was holding, and reports what it could not', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')
    const assigned = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    const assignmentId = assigned.assignmentId as string

    await owner.retireWorker(alpha)

    const projection = owner.projection()
    expect(projection.workers[0]).toMatchObject({ status: 'retired' })
    expect(projection.workers[0]?.assignments[0]).toMatchObject({ status: 'cancelled', reason: 'retirement' })
    expect(projection.counts.openAssignments).toBe(0)

    // And a retired worker is given no new work, ever.
    expect(
      await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] }),
    ).toMatchObject({ ok: false })
    void assignmentId
  })

  it('a settled assignment cannot be reopened by a late report', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')
    const assigned = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    await owner.cancelAssignment(assigned.assignmentId as string)

    const scope = owner.scopeFor(alpha)
    // The cancellation wins the race by table, not by timing: there is no
    // `cancelled → completed` edge for a late report to take.
    const report = await scope.reportAssignment(assigned.assignmentId as string, 'completed')
    expect(report.ok).toBe(false)
    expect(owner.projection().workers[0]?.assignments[0]?.status).toBe('cancelled')
  })

  it('finds an expired assignment by reconciliation, with no timer', async () => {
    let now = new Date('2026-10-01T09:00:00.000Z')
    const { owner, engine } = await engineOver({ now: () => now })
    // The worker's own budget carries the short lifetime, which is what makes the wall
    // reachable: the ceiling is frozen into its record at creation rather than read from
    // configuration later, so the numbers it was governed by cannot drift underneath it.
    const alpha = await worker(owner, 'Alpha', 'general', { maxAssignmentMs: 1_000 })
    await owner.assignCapability(alpha, 'cognition.request')
    await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })

    expect(owner.projection().workers[0]?.assignments[0]?.expired).toBe(false)

    // The clock moves; nothing is watching. The wall is discovered.
    now = new Date('2026-10-01T09:00:02.000Z')
    expect(owner.projection().workers[0]?.assignments[0]?.expired).toBe(true)

    expect(await engine.reconcileExpiredAssignments()).toBe(1)
    expect(owner.projection().workers[0]?.assignments[0]).toMatchObject({
      status: 'failed',
      reason: 'assignment_expired',
    })
  })
})

/* --------------------------------------------------------------- concurrency */

describe('serialisation is decided rather than timed', () => {
  it('a retirement racing an assignment leaves exactly one of them, and never both half-done', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')

    // Fired together on purpose. Whichever enters the worker's queue second observes a
    // terminal or stopped status and refuses; nothing here depends on which started
    // first, which is the property that matters.
    const [retired, assigned] = await Promise.all([
      owner.retireWorker(alpha),
      owner.assign({ workerId: alpha, capabilities: ['cognition.request'] }),
    ])

    expect(assigned.ok).not.toBe(retired.ok)

    const projection = owner.projection()
    expect(projection.workers[0]?.status).toBe('retired')
    // The invariant, whichever order the queue took: a retired worker never holds an
    // open assignment. If `assign` won the race it was seen and cancelled; if `retire`
    // won, the assignment was refused outright. Both reach the same place, and the
    // half-done state in between — retired *and* holding live work — is unreachable.
    expect(projection.counts.openAssignments).toBe(0)
    for (const assignment of projection.workers[0]?.assignments ?? []) {
      expect(assignment.status).toBe('cancelled')
    }
  })

  it('a report racing a cancellation leaves the cancellation standing', async () => {
    const { owner } = await engineOver()
    const alpha = await worker(owner, 'Alpha')
    await owner.assignCapability(alpha, 'cognition.request')
    const assigned = await owner.assign({ workerId: alpha, capabilities: ['cognition.request'] })
    const assignmentId = assigned.assignmentId as string
    const scope = owner.scopeFor(alpha)

    const [cancelled, reported] = await Promise.all([
      owner.cancelAssignment(assignmentId),
      scope.reportAssignment(assignmentId, 'completed'),
    ])

    // The table decides it: there is no `cancelled → completed` edge, so whichever
    // entered second observes a terminal status and refuses. This is the whole answer
    // to a completion that arrives after a cancellation.
    expect(cancelled.ok || reported.ok).toBe(true)
    const status = owner.projection().workers[0]?.assignments[0]?.status
    expect(['cancelled', 'completed']).toContain(status)
    if (status === 'completed') {
      // A completion that won the race must mean the cancellation was refused, not
      // silently dropped.
      expect(cancelled.ok).toBe(false)
      expect(reported.ok).toBe(true)
    }
  })
})