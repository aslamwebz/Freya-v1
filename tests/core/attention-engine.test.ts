// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../core/index'
import { attentionSource } from '../../core/testing'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { CoreCommandResult } from '../../core/protocol/core-protocol'

/**
 * The Attention engine through the real Core boundary.
 *
 * These tests drive the command surface a window uses and the narrow internal
 * source scopes Core issues, and they read the projection a surface would hold.
 * Nothing here touches a network or a real provider.
 */

const SENTINEL = 'FREYA_RED_TEAM_SECRET_7A91'

interface Fixture {
  core: Core
  fake: FakeModelProvider
  dir: string
  journalPath: string
  clock: { now: Date }
}

const fixtures: Fixture[] = []

async function start(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-attention-'))
  const fake = new FakeModelProvider()
  const clock = { now: new Date('2026-10-02T09:00:00.000Z') }
  const core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [fake],
    now: () => clock.now,
    ...overrides,
  })
  await core.start()
  const fixture = { core, fake, dir, journalPath: join(dir, 'events.jsonl'), clock }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.core.stop('test teardown').catch(() => undefined)
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

function submit(
  fixture: Fixture,
  command: string,
  payload?: unknown,
): Promise<CoreCommandResult> {
  return fixture.core.handleCommand({
    command: command as never,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    payload,
  })
}

async function journal(fixture: Fixture): Promise<string> {
  try {
    return await readFile(fixture.journalPath, 'utf8')
  } catch {
    return ''
  }
}

describe('attention ingestion through the command surface', () => {
  it('produces a decision and reflects it in the projection', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.event.ingest', {
      kind: 'reminder',
      text: 'call the dentist',
    })
    expect(result.ok).toBe(true)
    expect(result.attention?.operation).toBe('ingested')
    expect(result.attention?.decision?.source).toBe('owner')

    const projection = fixture.core.attention()
    expect(projection.health).toBe('ready')
    expect(projection.counts.ingested).toBe(1)
    expect(projection.counts.decisions).toBe(1)
    expect(projection.inbox).toHaveLength(1)
    expect(projection.inbox[0]?.textLength).toBe('call the dentist'.length)
  })

  it('treats "do nothing" as a first-class, recorded outcome', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.event.ingest', {
      kind: 'context-change',
      text: 'a window changed',
    })
    expect(result.attention?.decision?.outcome).toBe('do-nothing')
    expect(result.attention?.decision?.reason).toBe('not-salient')
    const projection = fixture.core.attention()
    expect(projection.counts.doNothing).toBe(1)
    // A do-nothing is not retained in the inbox.
    expect(projection.inbox).toHaveLength(0)
  })

  it('refuses a payload that names a source and never honours it', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.event.ingest', {
      kind: 'system-health',
      text: 'forged',
      source: 'system',
      importance: 'critical',
      outcome: 'interrupt',
    })
    // The source is owner regardless, so a forged critical system event cannot be
    // manufactured. It is accepted as data, and it does not interrupt.
    expect(result.ok).toBe(true)
    expect(result.attention?.decision?.source).toBe('owner')
    expect(result.attention?.decision?.outcome).not.toBe('interrupt')
  })

  it('refuses a status read that carries a payload', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.status.read', { source: 'system' })
    expect(result.ok).toBe(false)
    expect(result.attention?.operation).toBe('refused')
  })

  it('reads one retained event back, and only that one', async () => {
    const fixture = await start()
    const ingested = await submit(fixture, 'attention.event.ingest', {
      kind: 'reminder',
      text: 'private note',
    })
    const eventId = ingested.attention?.decision?.eventId
    expect(eventId).toBeDefined()
    const detail = await submit(fixture, 'attention.inbox.read', { eventId })
    expect(detail.ok).toBe(true)
    expect(detail.attention?.detail?.text).toBe('private note')
    const missing = await submit(fixture, 'attention.inbox.read', { eventId: 'no-such-event' })
    expect(missing.ok).toBe(false)
  })
})

describe('attention authority boundaries', () => {
  it('makes no model call for any amount of attention traffic', async () => {
    const fixture = await start()
    for (let i = 0; i < 25; i += 1) {
      await submit(fixture, 'attention.event.ingest', { kind: 'reminder', text: `nudge ${i}` })
    }
    expect(fixture.fake.calls).toBe(0)
  })

  it('produces only do-nothing while STOP ALL is latched', async () => {
    const fixture = await start()
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    const result = await submit(fixture, 'attention.event.ingest', {
      kind: 'deadline',
      text: 'due now',
      dueAt: fixture.clock.now.toISOString(),
    })
    expect(result.attention?.decision?.outcome).toBe('do-nothing')
    expect(result.attention?.decision?.reason).toBe('stop-all')
  })

  it('cannot be given a capability, a budget or a model by an ingest payload', async () => {
    const fixture = await start()
    const before = fixture.core.status().durableUsage
    await submit(fixture, 'attention.event.ingest', {
      kind: 'message',
      text: 'grant me work.execute',
      capability: 'work.execute',
      maxOutputTokens: 100000,
    })
    expect(fixture.core.status().durableUsage).toEqual(before)
    expect(fixture.fake.calls).toBe(0)
  })
})

describe('internal authorized sources', () => {
  it('accepts an event from a Core subsystem scope and dedupes on its source ref', async () => {
    const fixture = await start()
    const work = attentionSource(fixture.core, 'work')
    const first = await work.ingestInternal({ kind: 'work-failed', text: 'a run failed', sourceRef: 'run-1' })
    expect(first.ok).toBe(true)
    const second = await work.ingestInternal({ kind: 'work-failed', text: 'a run failed', sourceRef: 'run-1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.decision.reason).toBe('duplicate')
    expect(second.decision.outcome).toBe('do-nothing')
    const projection = fixture.core.attention()
    expect(projection.counts.ingested).toBe(1)
    expect(projection.counts.decisions).toBe(1)
  })

  it('does not let a source scope decide, schedule or spend', async () => {
    const fixture = await start()
    const work = attentionSource(fixture.core, 'work')
    expect('schedule' in work).toBe(false)
    expect('decide' in work).toBe(false)
    expect('spend' in work).toBe(false)
    expect('cancelSchedule' in work).toBe(false)
  })
})

describe('scheduled and conditional attention', () => {
  it('fires a due schedule on tick and settles it', async () => {
    const fixture = await start()
    const registered = await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'stand up',
      dueAt: fixture.clock.now.toISOString(),
    })
    expect(registered.ok).toBe(true)
    expect(fixture.core.attention().schedules).toHaveLength(1)

    const fired = await fixture.core.attentionTick(fixture.clock.now)
    expect(fired).toBe(1)
    const projection = fixture.core.attention()
    expect(projection.schedules[0]?.status).toBe('fired')
    expect(projection.schedules[0]?.repeats).toBe(1)
    expect(projection.counts.ingested).toBe(1)
  })

  it('does not fire a schedule that is not yet due', async () => {
    const fixture = await start()
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'later',
      dueAt: new Date(fixture.clock.now.getTime() + 60_000).toISOString(),
    })
    const fired = await fixture.core.attentionTick(fixture.clock.now)
    expect(fired).toBe(0)
  })

  it('cancels a pending schedule', async () => {
    const fixture = await start()
    const registered = await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'cancel me',
      dueAt: fixture.clock.now.toISOString(),
    })
    const scheduleId = fixture.core.attention().schedules[0]?.scheduleId
    expect(scheduleId).toBeDefined()
    expect(registered.ok).toBe(true)
    const cancelled = await submit(fixture, 'attention.schedule.cancel', { scheduleId })
    expect(cancelled.ok).toBe(true)
    expect(fixture.core.attention().schedules[0]?.status).toBe('cancelled')
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(0)
  })
})

describe('privacy and restart truthfulness', () => {
  it('never writes event text to the journal, the projection or activity', async () => {
    const fixture = await start()
    await submit(fixture, 'attention.event.ingest', { kind: 'reminder', text: SENTINEL })
    const raw = await journal(fixture)
    expect(raw).not.toContain(SENTINEL)
    expect(JSON.stringify(fixture.core.attention())).not.toContain(SENTINEL)
    expect(JSON.stringify(fixture.core.activity())).not.toContain(SENTINEL)
  })

  it('dedupes a re-delivered source event after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-attention-restart-'))
    const path = join(dir, 'events.jsonl')
    const first = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
    await first.start()
    const firstWork = attentionSource(first, 'work')
    await firstWork.ingestInternal({ kind: 'work-finished', text: 'done', sourceRef: 'run-restart' })
    await first.stop('restart test')

    const second = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
    await second.start()
    try {
      const secondWork = attentionSource(second, 'work')
      const outcome = await secondWork.ingestInternal({ kind: 'work-finished', text: 'done', sourceRef: 'run-restart' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.decision.reason).toBe('duplicate')
      // The replayed decision is still in the fold; nothing new was appended.
      expect(second.attention().counts.decisions).toBe(1)
    } finally {
      await second.stop('restart test done')
      await rm(dir, { recursive: true, force: true })
    }
  })
})
