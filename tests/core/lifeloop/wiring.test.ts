// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import type { LifeLoopProjection } from '../../../core/protocol/lifeloop'

/**
 * The Continuous Life Loop inside a real Core.
 *
 * The runtime suite proves the loop's own logic against ports it controls. This one
 * proves the *wiring*: that Core builds the loop, that an authoritative journal
 * event wakes it, that the model route it fills is the Governor and the Gateway and
 * not something invented here, and that everything it writes is a payload the
 * journal accepts — which matters because an event the validator refuses is written
 * to disk and rejected on the next read, truncating the durable security state.
 *
 * Every instant is frozen and passed in, for the reason `attentionTick` takes one:
 * "the same durable state at the same instant gives the same answer" is only
 * checkable if the clock is the caller's.
 */

const AT = new Date('2026-10-03T12:00:00.000Z')
const AT_PLUS_1M = new Date('2026-10-03T12:01:00.000Z')
const AT_PLUS_1H = new Date('2026-10-03T13:00:00.000Z')

let dir = ''
let clock = AT
let core: Core | null = null

async function start(overrides: Partial<CoreOptions> = {}): Promise<Core> {
  const built = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    now: () => new Date(clock),
    // Composition on, because that is what the production host does and this suite
    // is about the production wiring.
    lifeLoop: { observeSubsystemEvents: true },
    attentionObserveSources: false,
    ...overrides,
  })
  core = built
  await built.start()
  return built
}

/** Every life-loop line in the durable journal, in order. */
async function journal(): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
}

async function lifeLoopTypes(): Promise<string[]> {
  return (await journal())
    .map((event) => event.type)
    .filter((type) => type.startsWith('lifeloop.'))
}

/**
 * Drive a Mission to the point where it becomes active, through the real commands.
 *
 * Written the long way rather than by appending `mission.activated` by hand, because
 * the point of this suite is the wiring: the wake has to arrive from the same durable
 * stream every other subsystem reads, not from a fixture that skips it.
 *
 * `mission-activated` is one of the four kinds that do *not* justify a thought, which
 * makes it the ideal one to assert on — the whole claim is that an authoritative event
 * wakes the loop, is evaluated, and is deterministically refused without spending.
 */
async function missionActivated(c: Core, label: string): Promise<string> {
  const created = await c.handleCommand({
    command: 'mission.create',
    requestId: `create-${label}`,
    // The id is minted by Core and returned, never supplied: a payload that could
    // name its own durable identity would be a way to collide with another Mission.
    payload: { title: 'ship the thing', intent: 'make it ship', successCriteria: ['it ships'] },
  })
  const missionId = (created.mission as { missionId?: string } | undefined)?.missionId
  if (typeof missionId !== 'string') throw new Error('the Mission was not created')
  const activated = await c.handleCommand({
    command: 'mission.activate',
    requestId: `activate-${label}`,
    payload: { missionId },
  })
  if (!activated.ok) throw new Error(`the Mission was not activated: ${JSON.stringify(activated.refusal)}`)
  return missionId
}

/** Register a due attention schedule and offer it to the loop as a heartbeat. */
async function heartbeatFires(c: Core, at: Date): Promise<number> {
  await c.handleCommand({
    command: 'attention.schedule.register',
    requestId: `sched-${at.getTime()}`,
    payload: { kind: 'reminder', text: 'look again', dueAt: at.toISOString(), condition: 'always' },
  })
  return await c.attentionTick(at)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-lifeloop-'))
  clock = AT
})

afterEach(async () => {
  await core?.stop('lifeloop-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

describe('Core owns the loop, and says so', () => {
  it('reports it as ready once started, and never as null', async () => {
    const c = await start()
    const projection = c.lifeLoop()
    expect(projection.health).toBe('ready')
    expect(projection.state).toBe('IDLE')
    expect(projection.isIdle).toBe(true)
    // An absent subsystem and an idle one are different facts, so the projection has
    // to be able to tell them apart, and `reason` is where it says which.
    expect(projection.reason).toBeNull()
  })

  it('reports the absent projection before start, rather than throwing', async () => {
    const built = createCore({ dataPath: join(dir, 'events.jsonl') })
    const projection = built.lifeLoop()
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toContain('no Continuous Life Loop')
    await built.stop()
  })

  it('adds nothing to the journal at startup, because a fresh Core has nothing to reconcile', async () => {
    await start()
    expect(await lifeLoopTypes()).toEqual([])
  })

  it('pushes the current projection to a late subscriber, like every other mirror', async () => {
    const c = await start()
    const seen: LifeLoopProjection[] = []
    const detach = c.onLifeLoop((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.state).toBe('IDLE')
    detach()
  })
})

describe('an authoritative event wakes the loop', () => {
  it('wakes on an activated Mission, is refused a thought, and spends nothing', async () => {
    const c = await start()
    await missionActivated(c, 'mission-1')
    await c.attentionTick()
    const types = await lifeLoopTypes()
    expect(types).toContain('lifeloop.wake.received')
    expect(types).toContain('lifeloop.filter.denied')
    // The filter's reason, read back off the journal rather than off a flag. On a
    // fresh Core the honest answer is that nothing has authorized Freya to spend,
    // which is a refusal the owner can act on rather than a silent zero.
    const denial = (await journal()).find((event) => event.type === 'lifeloop.filter.denied')
    expect(denial?.payload.code).toBe('grant-unavailable')
    expect(denial?.payload.outcome).toBe('deny')
    expect(c.lifeLoop().isIdle).toBe(true)
    expect(c.lifeLoop().counters.cognitionRequests).toBe(0)
  })

  it('journals the wake it accepted with the source and kind Core assigned', async () => {
    const c = await start()
    const missionId = await missionActivated(c, 'mission-2')
    await c.attentionTick()
    const wake = (await journal()).find((event) => event.type === 'lifeloop.wake.received')
    expect(wake?.payload.source).toBe('mission-transition')
    expect(wake?.payload.kind).toBe('mission-activated')
    expect(wake?.payload.sourceRef).toBe(missionId)
  })

  it('spends nothing when there is no grant, which is the normal state of a fresh Core', async () => {
    const c = await start()
    await missionActivated(c, 'mission-3')
    await c.attentionTick()
    // No `cognition.requested` at all, so the bill is provably unchanged rather than
    // merely small.
    expect((await journal()).some((event) => event.type === 'cognition.requested')).toBe(false)
    expect((await journal()).some((event) => event.type === 'model.request.started')).toBe(false)
  })

  it('wakes nothing at all when composition is off, and journals nothing', async () => {
    const c = await start({ lifeLoop: { observeSubsystemEvents: false } })
    await missionActivated(c, 'mission-4')
    await c.attentionTick()
    expect(await lifeLoopTypes()).toEqual([])
    expect(c.lifeLoop().isIdle).toBe(true)
  })
})

describe('every line the loop writes is a line the journal accepts', () => {
  it('and the journal is still readable in full afterwards', async () => {
    // The assertion that catches a whole class rather than one instance. An event the
    // validator refuses reaches disk regardless — the store does not validate on the
    // way in — and is rejected on the *next* read, which truncates the log at that
    // line and takes the derived security state with it. So this is not cosmetic: a
    // payload mismatch corrupts the journal.
    const c = await start()
    await missionActivated(c, 'mission-5')
    await c.attentionTick()
    await heartbeatFires(c, clock)
    await c.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: { reason: 'test' } })
    await c.handleCommand({ command: 'security.resume', requestId: 'resume-1', payload: {} })
    await c.handleCommand({ command: 'conversation.create', requestId: 'conv-1', payload: {} })

    // A second start over the same file: it only completes if every line validated.
    await c.stop('first process')
    const second = await start()
    expect(second.status().integrity.integrity).toBe('ok')
    expect(second.status().integrity.eventsRead).toBeGreaterThan(0)
  })
})

describe('STOP ALL reaches the loop, and only the owner lifts it', () => {
it('stops it, refuses a wake while latched, and says it is stopped', async () => {
    const c = await start()
    // Woken *before* the stop, so there is something for the latch to interrupt —
    // and because a stopped Core refuses mutating commands, the Mission has to be
    // activated first or this would be testing the refusal rather than the loop.
    await missionActivated(c, 'mission-6')
    await c.attentionTick()
    await c.handleCommand({ command: 'security.stopAll', requestId: 'stop-2', payload: { reason: 'test' } })
    expect((await lifeLoopTypes())).toContain('lifeloop.stopped')
    const stopped = c.lifeLoop()
    expect(stopped.isStopped).toBe(true)
    // And the projection says so in words rather than only in a flag, because a
    // surface has to be able to render "Freya is stopped".
    expect(stopped.health).toBe('degraded')
    expect(stopped.reason).toContain('stopped')
    // Degradation is layered on top of the reading, not substituted for it: a stopped
    // Freya is still idle and still holds the wake it was refused, and a projection
    // that reported both as zero would be claiming "nothing is known" as "nothing is
    // happening".
    expect(stopped.state).toBe('STOP')
    expect(stopped.sequence).toBeGreaterThan(0)

    await c.attentionTick()
    // A stopped Freya spends nothing.
    expect((await journal()).some((event) => event.type === 'model.request.started')).toBe(false)
  })

  it('lifts only on the owner resume, and the loop is usable again afterwards', async () => {
    const c = await start()
    await c.handleCommand({ command: 'security.stopAll', requestId: 'stop-3', payload: { reason: 'test' } })
    await c.handleCommand({ command: 'security.resume', requestId: 'resume-3', payload: {} })
    expect(await lifeLoopTypes()).toContain('lifeloop.unstopped')
    expect(c.lifeLoop().isStopped).toBe(false)
  })

  it('keeps the latch across a restart, because a panic button does not un-press itself', async () => {
    const c = await start()
    await c.handleCommand({ command: 'security.stopAll', requestId: 'stop-4', payload: { reason: 'test' } })
    await c.stop('first process')
    const second = await start()
    expect(second.lifeLoop().isStopped).toBe(true)
  })
})

describe('the owner comes first', () => {
  it('reconciles the loop on a new conversation, and the journal says so', async () => {
    const c = await start()
    await c.handleCommand({ command: 'conversation.create', requestId: 'conv-2', payload: {} })
    expect(await lifeLoopTypes()).toContain('lifeloop.reconciled')
    expect(c.lifeLoop().isIdle).toBe(true)
  })
})

describe('the heartbeat is the host timer, and there is no second one', () => {
  it("returns Attention's count unchanged, because that is what the number means", async () => {
    const c = await start()
    // The host, `electron/coreHost.ts` and three existing tests all read this as the
    // number of Attention schedules that fired. Folding a different subsystem's
    // count into it would make one number mean two things.
    expect(await c.attentionTick(clock)).toBe(0)
  })

it('drives the loop without the renderer being able to, because there is no command', async () => {
    const c = await start()
    // Checked against the published vocabulary rather than by calling it, because
    // `CoreCommandName` is a closed union: the compiler would refuse a `lifeloop.*`
    // literal at the call site, and that is the property — but a test that never ran
    // would not demonstrate it to anybody reading the suite later.
    const protocol = await import('../../../core/protocol/core-protocol')
    const names: readonly string[] = [...protocol.ALL_CAPABILITIES]
    expect(names.some((name) => name.startsWith('lifeloop.'))).toBe(false)
    // And the reverse direction: nothing a window can send through the one writable
    // channel reaches the loop as a wake. Naming a source and a kind in a payload is
    // refused outright — a read command carrying fields it does not take — which is
    // the more useful half of the answer: even a *successful* read has no door.
    const result = await c.handleCommand({
      command: 'attention.status.read',
      requestId: 'x',
      payload: { source: 'scheduled-heartbeat', kind: 'schedule-due' },
    })
    expect(result.ok).toBe(false)
    const types = (await journal()).map((event) => event.type)
    expect(types.filter((type) => type === 'lifeloop.wake.received')).toHaveLength(0)
    expect(types.filter((type) => type === 'model.request.started')).toHaveLength(0)
  })
})

describe('the projection is content-free', () => {
  it('carries codes, counters and instants, and no prompt, answer or event text', async () => {
    const c = await start()
    await missionActivated(c, 'mission-7')
    await c.attentionTick()
    const projection = c.lifeLoop()
    const serialised = JSON.stringify(projection)
    for (const forbidden of ['prompt', 'text', 'provider', 'answer', 'granted', 'capability']) {
      expect(serialised.includes(forbidden), `the projection leaked ${forbidden}`).toBe(false)
    }
    // And it states the loop's own promise by name rather than asking to be believed.
    expect(Object.values(projection.assertions).every((held) => held === true)).toBe(true)
  })

  it('echoes the ceilings it is operating under', async () => {
    const c = await start()
    const projection = c.lifeLoop()
    expect(projection.limits.maxLoopIterations).toBe(10)
    expect(projection.limits.maxCognitionRequestsPerWake).toBe(8)
    expect(projection.counters.maxAttempts).toBe(3)
  })
})

describe('a narrowed ceiling can only lower a bound', () => {
  it('takes the narrower of the two and never the wider', async () => {
    const c = await start({ lifeLoop: { observeSubsystemEvents: true, limits: { maxLoopIterations: 2, maxAttemptsPerUnit: 99_999 } } })
    const limits = c.lifeLoop().limits
    // Narrowed down to what was asked...
    expect(limits.maxLoopIterations).toBe(2)
    // ...and a raise ignored rather than clamped, so a misconfigured host gets the
    // tighter of the two behaviours and never a silent widening.
    expect(limits.maxAttemptsPerUnit).toBe(3)
  })
})

describe('shutdown is not a stop', () => {
  it('does not leave a latch the owner never set', async () => {
    const c = await start()
    await missionActivated(c, 'mission-8')
    await c.attentionTick()
    await c.stop('shutdown')
    const second = await start()
    // A stopped-by-shutdown loop comes back idle, because the process ending is not
    // the owner pressing a button and must not read as one on the next launch.
    expect(second.lifeLoop().isStopped).toBe(false)
    expect(second.lifeLoop().isIdle).toBe(true)
  })

it('leaves nothing half-finished for the next launch to have to guess about', async () => {
    const c = await start()
    await missionActivated(c, 'mission-9')
    await c.attentionTick()
    await c.stop('shutdown')
    const second = await start()
    const types = (await journal()).map((event) => event.type)
    // A loop that had already closed itself out needs no reconciliation: recovery
    // says "stay idle" and writes nothing, because inventing a reconciliation for a
    // loop that was not interrupted would put a false record in the journal.
    expect(types).not.toContain('lifeloop.reconciled')
    expect(second.lifeLoop().state).toBe('IDLE')
    // And nothing was marked successful on the strength of a start. The counters are
    // zero because the fresh process has folded a journal in which no action ever
    // completed, which is the whole truth.
    expect(second.lifeLoop().counters.actions).toBe(0)
    expect(second.lifeLoop().counters.cognitionRequests).toBe(0)
    expect(second.status().integrity.integrity).toBe('ok')
  })
})

describe("the clock is the caller's, which is what makes the same journal reproducible", () => {
  it('expires a held deadline only once the supplied time has passed it', async () => {
    const c = await start()
    await c.handleCommand({
      command: 'attention.schedule.register',
      requestId: 'sched-reg',
      payload: { kind: 'reminder', text: 'look again', dueAt: AT_PLUS_1M.toISOString(), condition: 'always' },
    })
    const scheduled = c.attention().schedules[0]
    expect(scheduled?.scheduleId).toBeTruthy()

    // Not due yet: Attention does not fire it and the loop is not offered anything.
    expect(await c.attentionTick(clock)).toBe(0)
    clock = AT_PLUS_1H
    expect(await c.attentionTick(clock)).toBe(1)
  })
})



