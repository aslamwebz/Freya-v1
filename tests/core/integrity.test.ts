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

  it('reports integrity on its own surface, not only inside the fault list', async () => {
    await seedHealthyLogWithStopAfterwards()
    const status = (await start()).status()
    // A degraded lifecycle may be noted in `faults`, but that list is advisory.
    // The gate has to be readable on its own, because a caller deciding whether
    // it may reach a provider must not have to parse prose.
    expect(status.integrity.integrity).toBe('corrupt')
    expect(status.integrity.reason).toBeTypeOf('string')
    expect(status.integrity.line).toBe(3)

    // Contrast: a torn tail adds nothing to `faults` at all, and is still
    // reported. Integrity is a separate surface, not a line in a list.
    await core?.stop('test')
    await rm(file, { force: true })
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        '{"eventId":"evt-torn","sequence":2,"type":"core.rea',
    )
    const torn = (await start()).status()
    expect(torn.faults).toEqual([])
    expect(torn.integrity.integrity).toBe('torn')
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

  it('stays degraded across a second restart, when the file on disk is clean', async () => {
    await seedHealthyLogWithStopAfterwards()
    await start()
    await core?.stop('test')

    // The file really is clean now. Recovery truncated it, so a naive Core
    // would read this prefix and conclude everything was fine — and would be
    // wrong, because the STOP ALL that came after the damage is gone and the
    // remaining prefix says "not stopped".
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('evt-bad')
    expect(raw).not.toContain('stop_all')

    const second = createCore({ dataPath: file, providers: [fake] })
    await second.start()
    core = second
    const status = second.status()

    expect(status.integrity.integrity).toBe('corrupt')
    expect(status.lifecycle).toBe('degraded')
    // And it is denied for the right reason, not merely un-stopped.
    expect(
      evaluateCognition(
        {
          cognitionRequestId: 'req-1',
          origin: 'user',
          cause: 'user_message',
          actor: 'owner',
          correlationId: 'corr-1',
          maxOutputTokens: 10,
          authorization: { grantId: null, userInitiated: true },
          background: false,
        },
        {
          stopAllActive: false,
          grants: [],
          journalTrustworthy: false,
          now: new Date(),
        },
      ).reason,
    ).toBe('journal-not-trustworthy')
  })

  it('stays degraded across a third restart too', async () => {
    await seedHealthyLogWithStopAfterwards()
    for (let start_ = 0; start_ < 3; start_ += 1) {
      const c = await start()
      expect(c.status().lifecycle, `start ${start_ + 1}`).toBe('degraded')
      expect(c.status().integrity.integrity, `start ${start_ + 1}`).toBe('corrupt')
      await core?.stop('test')
    }
  })

  it('never reaches a provider, however many times it is started', async () => {
    await seedHealthyLogWithStopAfterwards()
    for (let start_ = 0; start_ < 3; start_ += 1) {
      await start()
      expect(fake.calls, `start ${start_ + 1}`).toBe(0)
      await core?.stop('test')
    }
  })

  it('does not write core.ready for an integrity-degraded start', async () => {
    await seedHealthyLogWithStopAfterwards()
    await start()
    await core?.stop('test')

    const log = await readFile(file, 'utf8')
    const events = log
      .split(String.fromCharCode(10))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string })

    // The seeded log contains one `core.ready`, from before the damage. Every
    // start after it must say what is actually true.
    const afterDamage = events.slice(2)
    expect(afterDamage.length).toBeGreaterThan(0)
    for (const event of afterDamage) {
      expect(event.type, JSON.stringify(event)).not.toBe('core.ready')
    }
    expect(afterDamage.filter((e) => e.type === 'core.degraded').length).toBeGreaterThanOrEqual(1)
    expect(afterDamage.filter((e) => e.type === 'core.integrity_fault').length).toBe(1)
  })

  it('records the fault in the journal, and keeps the damaged bytes', async () => {
    await seedHealthyLogWithStopAfterwards()
    const status = (await start()).status()

    const faultLine = (await readFile(file, 'utf8'))
      .split(String.fromCharCode(10))
      .filter((l) => l.includes('core.integrity_fault'))
      .map((l) => JSON.parse(l) as { payload: Record<string, unknown> })[0]
    expect(faultLine).toBeDefined()
    if (faultLine === undefined) throw new Error('no integrity fault was recorded')
    expect(faultLine.payload.reason).toBe(status.integrity.reason)
    expect(faultLine.payload.line).toBe(3)

    // The evidence is on disk, not deleted: the discarded STOP ALL is still
    // there to be read by whoever deals with this.
    const quarantine = String(faultLine.payload.quarantinePath)
    const preserved = await readFile(quarantine, 'utf8')
    expect(preserved).toContain('evt-bad')
    expect(preserved).toContain('stop_all')
  })

  it('recovers only when the log is deliberately replaced', async () => {
    await seedHealthyLogWithStopAfterwards()
    await start()
    expect((await start()).status().integrity.integrity).toBe('corrupt')

    // The documented Phase 1 remedy: no recovery UI, so recovery is removing
    // the journal. That is a deliberate act, not something a restart can do.
    await core?.stop('test')
    await rm(file, { force: true })

    const fresh = await start()
    expect(fresh.status().integrity.integrity).toBe('ok')
    expect(fresh.status().lifecycle).toBe('ready')
  })

  it('still recovers a torn unfinished tail normally', async () => {
    // No corruption here — just a crash part-way through the last write.
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        line(2, 'core.ready', {}) +
        line(3, 'core.ready', {}) +
        '{"eventId":"evt-torn","sequence":4,"type":"core.rea',
    )

    const status = (await start()).status()
    expect(status.integrity.integrity).toBe('torn')
    expect(status.lifecycle, status.integrity.reason).toBe('ready')
    expect(status.stopAll.active).toBe(false)

    // No quarantine, because there was nothing corrupt to preserve.
    expect(status.integrity.bytesDiscarded).toBeGreaterThan(0)
  })
})


describe('known Freya-authored journal compatibility repair', () => {
  const brokenCognitionRequest = (sequence: number, requestId: string): string =>
    line(sequence, 'cognition.requested', {
      requestId,
      origin: 'user',
      cause: 'user_message',
      maxOutputTokens: 128,
      requestedModel: null,
      parentRunId: null,
      goalId: null,
    })

  it('repairs the legacy # continuation id in place and preserves a later STOP ALL', async () => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        line(2, 'core.ready', {}) +
        brokenCognitionRequest(3, 'turn-legacy#1') +
        line(4, 'security.stop_all.activated', { by: 'owner', reason: 'keep this latch' }),
    )

    const status = (await start()).status()
    expect(status.lifecycle).toBe('ready')
    expect(status.integrity.integrity).toBe('ok')
    expect(status.stopAll.active).toBe(true)

    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"requestId":"turn-legacy:1"')
    expect(raw).not.toContain('"requestId":"turn-legacy#1"')
    expect(raw).toContain('core.integrity_repaired')
    expect(raw).toContain('security.stop_all.activated')
  })

  it('repairs the full historical tool-loop request chain used by the real app', async () => {
    await mkdir(dirname(file), { recursive: true })
    const base = '1c60bb32-a9f0-4f1d-b74e-0c4787c8f43d'
    const legacy = base + '#1'
    const repaired = base + ':1'
    const grant = 'turn:' + base

    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        line(2, 'core.ready', {}) +
        line(3, 'cognition.requested', {
          requestId: legacy,
          origin: 'user',
          cause: 'user_message',
          maxOutputTokens: 256,
          requestedModel: null,
          parentRunId: null,
          goalId: null,
        }, { actor: 'owner', correlationId: base }) +
        line(4, 'cognition.allowed', {
          requestId: legacy,
          grantId: grant,
        }, { actor: 'owner', correlationId: base }) +
        line(5, 'cognition.grant.reserved', {
          grantId: grant,
          requestId: legacy,
          outputTokenBudgetReserved: 256,
        }, { correlationId: legacy }) +
        line(6, 'model.request.started', {
          requestId: legacy,
          grantId: grant,
          providerId: 'nanogpt',
          model: 'qwen/qwen3.8-27b-uncensored',
          maxOutputTokens: 256,
          startedAt: '2026-10-05T23:18:19.180Z',
        }, { correlationId: legacy }) +
        line(7, 'model.request.completed', {
          requestId: legacy,
          providerId: 'nanogpt',
          model: 'qwen/qwen3.8-27b-uncensored',
          inputTokens: 1475,
          outputTokens: 13,
        }, { correlationId: legacy }) +
        line(8, 'cognition.grant.usage_reported', {
          grantId: grant,
          requestId: legacy,
          inputTokens: 1475,
          outputTokens: 13,
        }, { correlationId: legacy }) +
        line(9, 'security.stop_all.activated', { by: 'owner', reason: 'must survive chain repair' }),
    )

    const status = (await start()).status()
    expect(status.lifecycle).toBe('ready')
    expect(status.integrity.integrity).toBe('ok')
    expect(status.stopAll.active).toBe(true)

    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(legacy)
    expect(raw).toContain(repaired)
    expect(raw).toContain('core.integrity_repaired')
    expect(raw).toContain('security.stop_all.activated')
  })

  it('restores an already-degraded profile from its verified legacy quarantine', async () => {
    await mkdir(dirname(file), { recursive: true })
    const quarantine = join(dir, 'core-events.jsonl.quarantine')
    const prefix =
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
      line(2, 'core.ready', {})

    await writeFile(
      quarantine,
      prefix +
        brokenCognitionRequest(3, 'turn-old-profile#1') +
        line(4, 'security.stop_all.activated', { by: 'owner', reason: 'must survive repair' }),
    )

    await writeFile(
      file,
      prefix +
        line(3, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 2 },
          { eventId: 'later-start', occurredAt: new Date(1_700_000_010_000).toISOString() }) +
        line(4, 'core.integrity_fault', {
          reason:
            'The event log is corrupt: line 3 is a complete event that does not validate (payload does not match the shape of cognition.requested).',
          line: 3,
          quarantinePath: quarantine,
          trustedPrefixEvents: 2,
          trustedPrefixBytes: 0,
          damagedBytes: 100,
        }, { eventId: 'later-fault', occurredAt: new Date(1_700_000_011_000).toISOString() }) +
        line(5, 'core.degraded', {
          reason: 'the event journal was found corrupt; see the preceding integrity fault',
        }, { eventId: 'later-degraded', occurredAt: new Date(1_700_000_012_000).toISOString() }),
    )

    const status = (await start()).status()
    expect(status.lifecycle).toBe('ready')
    expect(status.integrity.integrity).toBe('ok')
    expect(status.stopAll.active).toBe(true)

    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"requestId":"turn-old-profile:1"')
    expect(raw).toContain('core.integrity_repaired')
    // Resolved health no longer gates Core; its original evidence still exists.
    expect(raw).toContain('core.integrity_fault')
    expect(raw).toContain('core.degraded')
  })

  it('still exposes status reads when unknown corruption keeps Core degraded', async () => {
    await seedHealthyLogWithStopAfterwards()
    const c = await start()

    const result = await c.handleCommand({
      command: 'core.status.read',
      requestId: 'status-degraded-1',
    })
    expect(result.ok).toBe(true)
    expect(result.status?.lifecycle).toBe('degraded')
    expect(result.status?.integrity.integrity).toBe('corrupt')
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
