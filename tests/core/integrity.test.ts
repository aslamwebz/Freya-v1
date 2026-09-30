// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { ownerAuthority } from '../../core/testing'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { CORE_EVENT_SCHEMA_VERSION } from '../../core/events/envelope'
import { evaluateCognition } from '../../core/cognition/governor'
import { emptyGrantUsage, type CognitionGrant } from '../../core/cognition/grants'
import type { CognitionCause, CognitionOrigin } from '../../core/protocol/core-protocol'

/**
 * A damaged journal must fail closed.
 *
 * The dangerous case is specific: a log where the corruption sits *before* a
 * STOP ALL event. Truncating at the damage discards the latch, so a Core that
 * replayed naively would come up healthy and unstopped — reporting exactly the
 * state the user tried to leave behind by stopping.
 *
 * Every test here is written from that direction.
 */

let dir = ''
let file = ''
let core: Core | null = null
let fake: FakeModelProvider

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-integrity-'))
  file = join(dir, 'core-events.jsonl')
  fake = new FakeModelProvider()
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

async function start(): Promise<Core> {
  core = createCore({ dataPath: file, providers: [fake] })
  return core.start().then(() => core!)
}

/** A complete, valid event line. */
function line(sequence: number, type: string, payload: unknown, overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      eventId: `evt-${sequence}`,
      sequence,
      type,
      schemaVersion: CORE_EVENT_SCHEMA_VERSION,
      occurredAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
      source: 'core',
      actor: 'system',
      correlationId: `corr-${sequence}`,
      causationId: null,
      payload,
      ...overrides,
    }) + '\n'
  )
}

async function seedHealthyLogWithStopAfterwards(): Promise<void> {
  // A healthy journal, then a STOP ALL, then damage *before* the latch. The
  // latch is the thing the truncation must not be able to lose.
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
      line(2, 'core.ready', {}) +
      // Damage here: a complete line that does not validate.
      '{"eventId":"evt-bad","sequence":3,"type":"core.ready","schemaVersion":1}\n' +
      line(4, 'security.stop_all.activated', { by: 'owner', reason: 'test' }),
  )
}

describe('a corrupt journal does not come up healthy', () => {
  it('reports a fault in CoreStatus rather than a normal ready Core', async () => {
    await seedHealthyLogWithStopAfterwards()
    const c = await start()
    const status = c.status()

    expect(status.integrity.integrity).toBe('corrupt')
    expect(status.integrity.line).toBe(3)
    expect(status.integrity.reason).toMatch(/corrupt/i)
    // Not ready. A Core with a hole in its journal is not ready.
    expect(status.lifecycle).toBe('degraded')
  })

  it('does not hide the warning in a generic fault list', async () => {
    await seedHealthyLogWithStopAfterwards()
    const status = (await start()).status()
    // The integrity block is the surface; it is not folded into `faults`, because
    // a fault list is advisory and this is a gate.
    expect(status.faults).toEqual([])
    expect(status.integrity.integrity).toBe('corrupt')
  })

  it('cannot restart as a healthy unstopped Core when a STOP ALL followed the damage', async () => {
    await seedHealthyLogWithStopAfterwards()
    const status = (await start()).status()

    // The latch was discarded along with the corrupted segment, so the replayed
    // state says "not stopped". That is exactly why the integrity gate exists.
    expect(status.stopAll.active).toBe(false)
    // And the Governor denies regardless, because the latch it replayed cannot be
    // shown to be the whole latch.
    expect(status.governor.status).toBe('deny_all')
  })

  it('refuses cognition and never reaches a provider', async () => {
    await seedHealthyLogWithStopAfterwards()
    const c = await start()

    // A grant that would otherwise allow, so only the journal can be the reason.
    await ownerAuthority(c).createGrant({
      grantId: 'g1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['user'],
      allowedCauses: ['user_message'],
      backgroundAllowed: true,
      maxCalls: 5,
      maxOutputTokens: 1000,
    })
    const outcome = await ownerAuthority(c).request({
      kind: 'user_turn',
      maxOutputTokens: 100,
      prompt: 'hello',
    })

    expect(outcome.status).toBe('denied')
    expect(outcome.status === 'denied' && outcome.reason).toBe('journal-not-trustworthy')
    expect(fake.calls).toBe(0)
  })

  it('keeps refusing after the damage is repaired, until a new log is trusted', async () => {
    await seedHealthyLogWithStopAfterwards()
    const c = await start()
    expect(c.status().integrity.integrity).toBe('corrupt')

    // Recovery truncated the file on disk, so the *next* start reads a clean
    // prefix. That is the documented remedy: repair or remove the log. The
    // running Core does not quietly upgrade itself, because it cannot know that
    // the file changed under it.
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('evt-bad')
    expect(c.status().integrity.integrity).toBe('corrupt')
  })

  it('recovers to ready once a trusted log is in place', async () => {
    await seedHealthyLogWithStopAfterwards()
    await start()
    await core?.stop('test')

    // The store truncated on recovery, so the second start reads a clean prefix.
    const second = createCore({ dataPath: file, providers: [fake] })
    await second.start()
    core = second
    const status = second.status()

    expect(status.integrity.integrity, `${status.integrity.reason} | ${JSON.stringify(status.faults)}`).toBe('ok')
    expect(status.lifecycle).toBe('ready')
  })
})

describe('every corruption shape is corruption', () => {
  const cases: { name: string; body: string }[] = [
    { name: 'an invalid complete event', body: '{"eventId":"x","sequence":3}\n' },
    { name: 'an unsupported schema', body: line(3, 'core.ready', {}, { schemaVersion: 99 }) },
    { name: 'a duplicate sequence', body: line(2, 'core.ready', {}) },
    { name: 'a reversed sequence', body: line(1, 'core.ready', {}) },
    { name: 'an invalid middle line', body: 'not an event at all\n' },
    {
      name: 'a malformed security event',
      // A stop_all event with the wrong payload shape: right type, wrong record.
      body: line(3, 'security.stop_all.activated', { by: 'owner' }),
    },
    {
      name: 'a forged principal',
      body: line(3, 'core.ready', {}, { actor: 'owner; DROP TABLE' }),
    },
  ]

  for (const testCase of cases) {
    it(`reports corruption for ${testCase.name}`, async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
          line(2, 'core.ready', {}) +
          testCase.body +
          line(9, 'core.stopped', { durationMs: 1 }),
      )
      const status = (await start()).status()
      expect(status.integrity.integrity).toBe('corrupt')
      expect(status.lifecycle).toBe('degraded')
    })
  }
})

describe('a torn tail is not treated as corruption', () => {
  it('starts ready after an interrupted final write', async () => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        line(2, 'core.ready', {}) +
        // No terminator: the process died mid-write.
        line(3, 'core.stopped', { durationMs: 1 }).slice(0, 30),
    )
    const status = (await start()).status()

    expect(status.integrity.integrity).toBe('torn')
    expect(status.integrity.bytesDiscarded).toBeGreaterThan(0)
    // A crash is ordinary, so the Core is ready — with the fact stated.
    expect(status.lifecycle).toBe('ready')
  })

  it('keeps a STOP ALL that was written before the tear', async () => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        line(2, 'security.stop_all.activated', { by: 'owner', reason: 'test' }) +
        line(3, 'core.stopped', { durationMs: 1 }).slice(0, 24),
    )
    const status = (await start()).status()
    // The latch is complete and terminated, so it survives the tear.
    expect(status.stopAll.active).toBe(true)
    expect(status.integrity.integrity).toBe('torn')
  })
})

describe('the Governor gate is above everything', () => {
  const NOW = new Date('2026-03-01T12:00:00.000Z')
  const grant = (): CognitionGrant => ({
    id: 'g1',
    createdBy: 'owner',
    createdAt: '2026-03-01T11:00:00.000Z',
    expiresAt: '2026-03-01T13:00:00.000Z',
    allowedOrigins: ['agent'] as readonly CognitionOrigin[],
    allowedCauses: ['run_finished'] as readonly CognitionCause[],
    goalId: null,
    runId: null,
    actor: null,
    backgroundAllowed: true,
    maxCalls: 5,
    maxOutputTokens: 1000,
    usage: emptyGrantUsage(),
    revokedAt: null,
    revokedBy: null,
    parentGrantId: null,
  })

  const request = (overrides: Record<string, unknown> = {}) => ({
    cognitionRequestId: 'r1',
    correlationId: 'r1',
    origin: 'user' as const,
    cause: 'user_message' as const,
    actor: 'owner' as const,
    maxOutputTokens: 100,
    background: false,
    authorization: { grantId: null, userInitiated: true },
    ...overrides,
  })

  it('denies a grantless user turn when the journal is untrustworthy', () => {
    const decision = evaluateCognition(request(), {
      grants: [],
      stopAllActive: false,
      now: NOW,
      journalTrustworthy: false,
    })
    expect(decision).toMatchObject({ outcome: 'deny', reason: 'journal-not-trustworthy' })
  })

  it('denies a valid grant when the journal is untrustworthy', () => {
    const decision = evaluateCognition(
      request({
        origin: 'agent',
        cause: 'run_finished',
        background: true,
        authorization: { grantId: 'g1', userInitiated: false },
      }),
      { grants: [grant()], stopAllActive: false, now: NOW, journalTrustworthy: false },
    )
    expect(decision).toMatchObject({ outcome: 'deny', reason: 'journal-not-trustworthy' })
  })

  it('outranks the replayed latch, and says why', () => {
    // An untrustworthy journal with no latch at all still denies, and the reason
    // is the journal rather than a latch that was never there.
    const decision = evaluateCognition(request(), {
      grants: [],
      stopAllActive: false,
      now: NOW,
      journalTrustworthy: false,
    })
    expect(decision.reason).toBe('journal-not-trustworthy')
    expect(decision.grantId).toBeNull()
  })
})
