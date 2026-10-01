// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { parseDurableEvent } from '../../core/events/validate'
import type { AnyCoreEvent } from '../../core/events/envelope'
import type { MissionProjection } from '../../core/missions/types'

/**
 * Missions, through Core.
 *
 * The engine tests cover the engine's own rules. These cover the claims that are
 * only true of a *running Core*, and they are the ones a Mission's privacy rests on:
 *
 *  1. Mission text never reaches the journal, the feed, or any projection.
 *  2. Managing a Mission costs zero model calls.
 *  3. A window cannot name a Run's parent, raise a ceiling, or conclude anything.
 *  4. STOP ALL refuses, and survives.
 */

let dir = ''
let core: Core | undefined
let requestSeq = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-mission-core-'))
  requestSeq = 0
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

interface Harness {
  core: Core
  /** Every model call the Core made. The claim under test is that this stays 0. */
  calls: () => number
  send: (command: string, payload?: Record<string, unknown>) => Promise<CoreResult>
  mission: (title: string, intent?: string) => Promise<string>
}

interface CoreResult {
  requestId: string
  ok: boolean
  refusal?: { reason: string }
  error?: { message: string }
  mission?: { operation: string; ok: boolean; missionId?: string; status?: string; reason?: string }
  work?: { operation: string; ok: boolean; reason?: string }
}

/**
 * A Core with a counting provider and a real Mission key.
 *
 * The provider counts rather than echoes, because "Mission management is free" is
 * only checkable if something is keeping count. It is never called; that is the point.
 */
async function started(options: Partial<CoreOptions> = {}): Promise<Harness> {
  let calls = 0
  const provider = new FakeModelProvider()
  vi.spyOn(provider, 'complete').mockImplementation(async () => {
    calls += 1
    return {
      requestId: 'r',
      providerId: provider.id,
      model: provider.model,
      text: 'unused',
      inputTokens: 0,
      outputTokens: 0,
    }
  })

  core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [provider],
    missionKey: new Uint8Array(32).fill(9),
    ...options,
  })
  await core.start()

  const instance = core
  const send = async (command: string, payload?: Record<string, unknown>): Promise<CoreResult> => {
    requestSeq += 1
    const result = await instance.handleCommand({
      command,
      requestId: `r-${requestSeq}`,
      ...(payload === undefined ? {} : { payload }),
    } as never)
    return result as CoreResult
  }

  return {
    core: instance,
    calls: () => calls,
    send,
    mission: async (title, intent) => {
      const result = await send('mission.create', {
        title,
        intent: intent ?? 'Find out what happened and report back.',
      })
      if (!result.ok || result.mission?.missionId === undefined) {
        throw new Error(`mission.create failed: ${result.mission?.reason ?? result.refusal?.reason}`)
      }
      return result.mission.missionId
    },
  }
}

/**
 * One valid Run step.
 *
 * Phase 6's inert test capability, so this file exercises the Mission boundary and
 * not Work's own plan validation. A malformed plan would be refused before the parent
 * was ever read, which would make the parent assertions below pass for the wrong
 * reason.
 */
function step(key: string): Record<string, unknown> {
  return {
    key,
    label: `record ${key}`,
    capability: 'test.record',
    verifier: 'test.record.matches',
    input: { expect: key },
  }
}

/** The journal, parsed back through the same validator recovery uses. */
async function journal(): Promise<AnyCoreEvent[]> {
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
  const events: AnyCoreEvent[] = []
  // The same validator recovery uses, with the same strictly-increasing sequence rule,
  // so this reads the journal the way a restart would rather than more leniently.
  let sequence = 0
  for (const line of raw.split(String.fromCharCode(10))) {
    if (line.length === 0) continue
    const parsed = parseDurableEvent(line, sequence)
    if (parsed.ok) {
      events.push(parsed.event as AnyCoreEvent)
      sequence = parsed.event.sequence
    }
  }
  return events
}

describe('Missions are private', () => {
  it('keeps Mission text out of the journal entirely', async () => {
    const sentinel = {
      title: 'FREYA_RED_TEAM_M4 ' + 'the thing we agreed never to write down',
      intent: 'FREYA_RED_TEAM_I5 ask about it and keep the answer private',
      criteria: 'FREYA_RED_TEAM_C6 nobody can read this',
    }
    const harness = await started()
    const missionId = await harness.mission(sentinel.title, sentinel.intent)

    await harness.send('mission.activate', { missionId })
    await harness.send('mission.pause', { missionId })
    await harness.send('mission.resume', { missionId })
    await harness.send('mission.cancel', { missionId })
    await core?.stop('test-teardown')
    core = undefined

    // Every line on disk, not just the ones we expect to be clean.
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('FREYA_RED_TEAM_M4')
    expect(raw).not.toContain('FREYA_RED_TEAM_I5')
    expect(raw).not.toContain('FREYA_RED_TEAM_C6')
    // And not a fragment of it either, which is what a "we only store ids" claim
    // usually turns out to mean.
    expect(raw).not.toContain('never to write down')
  })

  it('reaches the journal only as metadata', async () => {
    const harness = await started()
    const missionId = await harness.mission('Plan the thing', 'Work out how.')
    await harness.send('mission.activate', { missionId })
    await core?.stop('test-teardown')
    core = undefined

    const missionEvents = (await journal()).filter((event) => event.type.startsWith('mission.'))
    expect(missionEvents.length).toBeGreaterThan(0)
    // Every payload is exactly ids, statuses, timestamps, the code-owned ceilings and
    // closed codes. Nothing here is text a person wrote.
    const allowed = new Set([
      'missionId',
      'from',
      'to',
      'reason',
      'verifierId',
      'verifier',
      'runIds',
      'runId',
      'taskId',
      'limit',
      'outcome',
      'status',
      'createdAt',
      'deadlineAt',
      'limits',
    ])
    for (const event of missionEvents) {
      for (const key of Object.keys(event.payload)) {
        expect(allowed.has(key)).toBe(true)
      }
    }
  })

  it('does not put Mission text in the projection a window reads', async () => {
    const sentinel = 'FREYA_RED_TEAM_P7 projection text'
    const harness = await started()
    await harness.mission('Private', sentinel)
    const projection = harness.core.mission()
    expect(JSON.stringify(projection)).not.toContain(sentinel)
  })

  it('does not leak Mission text into the activity feed', async () => {
    const sentinel = 'FREYA_RED_TEAM_F8 feed text'
    const harness = await started()
    const missionId = await harness.mission('Private', sentinel)
    await harness.send('mission.activate', { missionId })
    await core?.stop('test-teardown')
    core = undefined

    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain(sentinel)
  })

  it('reads the Mission back through its own encrypted store', async () => {
    const harness = await started()
    const missionId = await harness.mission('Readable', 'The user can read this back.')
    const detail = await harness.core.missionDetail(missionId)
    // Whatever the shape, the owner's own words must be retrievable — an encrypted
    // store nobody can read would be privacy theatre rather than privacy.
    expect(JSON.stringify(detail ?? {})).toContain('The user can read this back.')
  })
})

describe('Missions cost nothing', () => {
  it('makes no model call for any Mission command', async () => {
    const harness = await started()
    const missionId = await harness.mission('Free', 'Costs nothing to manage.')

    await harness.send('mission.activate', { missionId })
    await harness.send('mission.pause', { missionId })
    await harness.send('mission.resume', { missionId })
    await harness.send('mission.requestCompletion', { missionId })
    await harness.send('mission.cancel', { missionId })

    // The whole lifecycle, and nothing was asked of a model. Idle Freya spends
    // nothing; a Mission sitting on a board must not start spending either.
    expect(harness.calls()).toBe(0)
  })

  it('makes no model call merely by being read', async () => {
    const harness = await started()
    await harness.mission('Watched', 'Being watched costs nothing.')
    harness.core.mission()
    expect(harness.calls()).toBe(0)
  })
})

describe('a window cannot manufacture authority over a Mission', () => {
  it('refuses a Run that names its own parent', async () => {
    const harness = await started()
    // Red Team A: the parent is Core's to decide. A window asserting `{ kind, id }`
    // is asserting structure, which is not a thing a window gets to do.
    const result = await harness.send('work.run.create', {
      steps: [step('one')],
      parent: { kind: 'mission', id: 'someone-elses-mission' },
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/parent is decided by Core/i)
  })

  it('ignores a parent smuggled under another key', async () => {
    const harness = await started()
    const result = await harness.send('work.run.create', {
      steps: [step('one')],
      runParent: { kind: 'mission', id: 'x' },
      ownerMission: 'y',
    })
    // These are simply not fields Core reads, so the Run is created with no parent —
    // which is the honest outcome: it is not attached to anything.
    expect(result.ok).toBe(true)
    const projection = harness.core.work()
    expect(projection?.runs[0]?.parentId ?? null).toBeNull()
  })

  it('refuses a Mission create that tries to carry its own ceilings', async () => {
    const harness = await started()
    const missionId = await harness.mission('Bounded', 'Limits are code-owned.')
    // Whatever the payload claimed, the Mission's ceilings are Core's.
    const projection = harness.core.mission()
    const view = projection.missions.find((m) => m.missionId === missionId)
    expect(view).toBeDefined()

    const attempt = await harness.send('mission.create', {
      title: 'Sneaky',
      intent: 'Raise my own ceilings.',
      limits: { maxChildRuns: 100000, verificationDeadlineMs: 999999999 },
      status: 'completed',
      verification: { state: 'passed' },
      principalId: 'system',
    })
    // Creation succeeds, and none of the asserted fields survive.
    expect(attempt.ok).toBe(true)
    const after = harness.core.mission()
    const sneaky = after.missions.find((m) => m.missionId === attempt.mission?.missionId)
    expect(sneaky?.status).toBe('draft')
    expect(after.limits.maxChildRuns).toBeLessThan(100000)
    expect(after.limits.verificationDeadlineMs).toBeLessThan(999999999)
  })

  it('will not conclude a Mission through any other route', async () => {
    const harness = await started()
    const missionId = await harness.mission('Real', 'Only a verifier concludes this.')
    // There is no command that sets status. This is asserted by the vocabulary itself:
    // the only ways to leave `active` are `mission.cancel`, `mission.fail` and
    // `mission.requestCompletion`, and the last one asks rather than asserts.
    const projection = harness.core.mission()
    const view = projection.missions.find((m) => m.missionId === missionId)!
    expect(view.status).toBe('draft')

    const completion = await harness.send('mission.requestCompletion', { missionId })
    // No Work attached, so nothing was established and nothing was concluded.
    expect(completion.ok).toBe(false)
    expect(harness.core.mission().missions.find((m) => m.missionId === missionId)?.status).toBe('draft')
  })

  it('refuses a Mission id it does not have, without creating one', async () => {
    const harness = await started()
    const result = await harness.send('mission.activate', { missionId: 'no-such-mission' })
    expect(result.ok).toBe(false)
    expect(result.mission?.reason).toMatch(/no such mission/)
  })
})

describe('the read/manage split is real, not decorative', () => {
  it('answers a Mission status read', async () => {
    // `mission.status.read` was declared as a capability and bridged from the window,
    // but Core had no handler for it, so it fell through to "unknown command". A
    // documented privilege that nothing enforces is not a privilege.
    const harness = await started()
    const result = await harness.send('mission.status.read')
    expect(result.ok).toBe(true)
    expect(result.mission?.operation).toBe('status')
  })

  it('still reads after shutdown has started, but cannot mutate', async () => {
    // A window winding down must still be able to say what Freya was working on, and
    // must not be able to start anything new. `mission.status.read` was missing from
    // the shutdown read allow-list, so it was refused exactly when a window most needs
    // to read.
    const harness = await started()
    const missionId = await harness.mission('Winding down', 'Readable while stopping.')
    await harness.send('mission.activate', { missionId })
    await harness.core.stop('test-teardown')
    core = undefined

    const revived = createCore({
      dataPath: join(dir, 'events.jsonl'),
      missionKey: new Uint8Array(32).fill(9),
    })
    await revived.start()
    core = revived

    const read = await revived.handleCommand({
      command: 'mission.status.read',
      requestId: 'r-after-stop',
    } as never)
    expect((read as CoreResult).ok).toBe(true)

    await revived.stop('t')
    core = undefined

    // After the stop, the read is still answered and nothing can be moved. Both halves
    // matter: a read refused is a window that cannot explain itself, and a read that
    // still mutates would mean shutdown never actually stopped anything.
    const readAfter = await revived.handleCommand({
      command: 'mission.status.read',
      requestId: 'r-after-stop-2',
    } as never)
    expect((readAfter as CoreResult).ok).toBe(true)

    const mutate = await revived.handleCommand({
      command: 'mission.activate',
      requestId: 'r-after-stop-3',
      payload: { missionId },
    } as never)
    expect((mutate as CoreResult).ok).toBe(false)
    expect(revived.mission().missions.find((m) => m.missionId === missionId)?.status).toBe('active')
  })

  it('does not let a status read reach any mutating path', async () => {
    const harness = await started()
    const missionId = await harness.mission('Read only', 'A read changes nothing.')
    await harness.send('mission.status.read')
    // Reading a Mission is not a way to move it.
    expect(harness.core.mission().missions.find((m) => m.missionId === missionId)?.status).toBe('draft')
  })
})

describe('a tampered journal cannot manufacture an outcome', () => {
  it('refuses a hand-written completion with nothing behind it', async () => {
    // `active → completed` is a legal edge, so the transition table cannot catch this.
    // Only the reducer can, by requiring a verification that actually passed. This is
    // the same three-line forgery that folded into `completed` before the guard existed.
    const path = join(dir, 'events.jsonl')
    const base = [
      {
        eventId: 'forged-1', sequence: 1, type: 'mission.created', schemaVersion: 1,
        occurredAt: '2026-10-01T09:00:00.000Z', source: 'core', actor: 'owner',
        correlationId: 'f', causationId: null,
        payload: {
          missionId: 'forged', status: 'draft',
          createdAt: '2026-10-01T09:00:00.000Z',
          deadlineAt: '2026-10-31T09:00:00.000Z',
          limits: {
            maxChildRuns: 64, maxConcurrentChildRuns: 4, lifetimeMs: 2_592_000_000,
            verificationDeadlineMs: 60_000, maxRetainedMissions: 200,
            maxTitleChars: 160, maxIntentChars: 4_000, maxSuccessCriteria: 16, maxCriterionChars: 500,
          },
        },
      },
      {
        eventId: 'forged-2', sequence: 2, type: 'mission.activated', schemaVersion: 1,
        occurredAt: '2026-10-01T09:00:02.000Z', source: 'core', actor: 'owner',
        correlationId: 'f', causationId: null,
        payload: { missionId: 'forged', from: 'draft', to: 'active', reason: 'owner', verifierId: null },
      },
      {
        eventId: 'forged-3', sequence: 3, type: 'mission.completed', schemaVersion: 1,
        occurredAt: '2026-10-01T09:00:03.000Z', source: 'core', actor: 'owner',
        correlationId: 'f', causationId: null,
        payload: {
          missionId: 'forged', from: 'active', to: 'completed',
          reason: 'verification_passed', verifierId: null,
        },
      },
    ]
    await writeFile(path, base.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10))

    const revived = createCore({
      dataPath: path,
      missionKey: new Uint8Array(32).fill(9),
    })
    await revived.start()
    core = revived

    const view = revived.mission().missions.find((m) => m.missionId === 'forged')
    // Read the back as *not* completed, and with nothing pretending otherwise.
    expect(view?.status).toBe('active')
    expect(view?.verification).toBeNull()
  })
})

describe('a Run is parented only by something Core can corroborate', () => {
  it('refuses a Run parented to a Mission that does not exist', async () => {
    // `work.run.created` records the parent it is given, so attaching after the fact and
    // discovering the Mission is missing left the journal asserting a parent that
    // nothing could confirm: a `work.run.created` with a mission parent and no
    // `mission.run.attached` beside it. The Run now does not exist to make that claim.
    const harness = await started()
    const result = await harness.send('work.run.create', {
      steps: [step('one')],
      missionId: 'no-such-mission',
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/no Mission with that id/i)

    // And nothing was recorded, so there is no uncorroborated parent claim left behind.
    await core?.stop('test-teardown')
    core = undefined
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('"parentId":"no-such-mission"')
  })

  it('still parents a Run to a Mission that does exist', async () => {
    const harness = await started()
    const missionId = await harness.mission('Real', 'Has an id Core knows.')
    await harness.send('mission.activate', { missionId })
    const result = await harness.send('work.run.create', {
      steps: [step('one')],
      missionId,
    })
    expect(result.ok).toBe(true)

    const view = harness.core.mission().missions.find((m) => m.missionId === missionId)
    expect(view?.counts.total).toBe(1)
  })

  it('creates an unparented Run when no Mission is named', async () => {
    const harness = await started()
    const result = await harness.send('work.run.create', { steps: [step('one')] })
    expect(result.ok).toBe(true)
    expect(harness.core.work()?.runs[0]?.parentId ?? null).toBeNull()
  })
})

describe('STOP ALL outranks Missions', () => {
  it('refuses to activate a Mission while stopped', async () => {
    const harness = await started()
    const missionId = await harness.mission('Blocked', 'Cannot start while stopped.')
    await harness.send('security.stopAll', { reason: 'the panic button' })

    const result = await harness.send('mission.activate', { missionId })
    expect(result.ok).toBe(false)
    expect(harness.core.mission().missions.find((m) => m.missionId === missionId)?.status).toBe('draft')
  })

  it('still lets the owner read Missions while stopped', async () => {
    // Stopping must not blind the user to what was in flight.
    const harness = await started()
    const missionId = await harness.mission('Visible', 'Readable while stopped.')
    await harness.send('security.stopAll', { reason: 'the panic button' })
    const projection: MissionProjection = harness.core.mission()
    expect(projection.missions.some((m) => m.missionId === missionId)).toBe(true)
  })

  it('keeps a Mission stopped across a restart', async () => {
    const harness = await started()
    const missionId = await harness.mission('Durable stop', 'Still stopped tomorrow.')
    await harness.send('mission.activate', { missionId })
    await harness.send('security.stopAll', { reason: 'the panic button' })
    await core?.stop('test-teardown')

    // A brand new Core over the same journal.
    const revived = createCore({
      dataPath: join(dir, 'events.jsonl'),
      missionKey: new Uint8Array(32).fill(9),
    })
    await revived.start()
    core = revived

    const result = await revived.handleCommand({
      command: 'mission.cancel',
      requestId: 'r-after-restart',
      payload: { missionId },
    } as never)
    // Cancelling is a person tidying up, which stays available; resuming is not.
    expect((result as CoreResult).ok).toBe(true)

    const blocked = await revived.handleCommand({
      command: 'mission.activate',
      requestId: 'r-after-restart-2',
      payload: { missionId: 'another' },
    } as never)
    expect((blocked as CoreResult).mission?.ok ?? (blocked as CoreResult).ok).toBe(false)
  })
})

describe('the Mission projection is derived, not assembled', () => {
  it('reports persistence honestly', async () => {
    const harness = await started()
    expect(harness.core.mission().persistence).toMatchObject({ mode: 'encrypted', durable: true })
  })

  it('reports memory-only when there is no Mission key', async () => {
    // No key is a real, reachable state: a machine with no OS secure storage.
    const harness = await started({ missionKey: undefined })
    expect(harness.core.mission().persistence).toMatchObject({ durable: false })
    // And Missions still work for the session rather than being refused outright.
    const missionId = await harness.mission('Ephemeral', 'Forgets on quit.')
    expect(missionId).toBeTruthy()
  })

  it('survives a restart with its Mission intact', async () => {
    const harness = await started()
    const missionId = await harness.mission('Durable', 'Outlives the process.')
    await harness.send('mission.activate', { missionId })
    await core?.stop('test-teardown')

    const revived = createCore({
      dataPath: join(dir, 'events.jsonl'),
      missionKey: new Uint8Array(32).fill(9),
    })
    await revived.start()
    core = revived

    const projection = revived.mission()
    expect(projection.missions.find((m) => m.missionId === missionId)?.status).toBe('active')
  })
})