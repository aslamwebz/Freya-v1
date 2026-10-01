// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import type { CoreStatus } from '../../core/protocol/core-protocol'
import type { WorkProjection } from '../../core/work/projection'

/**
 * The Core belongs to the process, not the window.
 *
 * The host is where that is decided, so it is tested here rather than only in
 * the app: a window attaching and detaching must not disturb the Core it
 * attached to, and a replacement window must find the *same* one — same event
 * sequence, same latched security state, no replay.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('the Core host', () => {
  it('reports a not-ready status before it has started, without inventing facts', () => {
    const status = host!.status()
    expect(status.lifecycle).toBe('booting')
    expect(status.providers).toEqual([])
    expect(status.governor.status).toBe('unknown')
    expect(status.faults).toEqual([])
  })

  it('refuses a command before it has started rather than throwing', async () => {
    const result = await host!.submit({ command: 'core.status.read', requestId: 'r1' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/not ready/i)
  })

  it('starts once, however many times it is asked', async () => {
    await Promise.all([host!.start(), host!.start(), host!.start()])
    const status = host!.status()
    expect(status.lifecycle).toBe('ready')
    // One start means one set of startup events, not three sets: `core.started`,
    // `brain.seeded` and `core.ready`. The Brain seeds on first start because its
    // identity has to be on disk before anything can be remembered under it.
    expect(status.eventSequence).toBe(3)
  })

  it('keeps running when its last window detaches', async () => {
    await host!.start()
    const before = host!.status().eventSequence

    const dispose = host!.attach(() => {})
    dispose()

    // The window is gone; the Core is not. A closed window is not a quit.
    const after = host!.status()
    expect(after.lifecycle).toBe('ready')
    expect(after.eventSequence).toBe(before)
  })

  it('gives a replacement window the same Core, continuing the same sequence', async () => {
    await host!.start()

    // Window one attaches, sees the state, and goes away.
    const seen: CoreStatus[] = []
    const first = host!.attach((s) => seen.push(s))
    const firstSequence = host!.status().eventSequence
    const stop = await host!.submit({ command: 'security.stopAll', requestId: 's1' })
    expect(stop.ok).toBe(true)
    first()

    // Window two attaches after Core has moved on.
    const second: CoreStatus[] = []
    host!.attach((s) => second.push(s))

    expect(host!.status().eventSequence).toBeGreaterThan(firstSequence)
    // The latch the first window caused is what the second one finds.
    expect(second[0]?.stopAll.active).toBe(true)
    // And it was a new subscriber, not a replay of the old one.
    expect(seen.length).toBeGreaterThan(0)
  })

  it('pushes to every attached window, and stops after a disposer', async () => {
    await host!.start()
    const a: CoreStatus[] = []
    const b: CoreStatus[] = []
    const disposeA = host!.attach((s) => a.push(s))
    host!.attach((s) => b.push(s))

    await host!.submit({ command: 'security.stopAll', requestId: 's1' })
    const aBefore = a.length
    disposeA()
    await host!.submit({ command: 'security.resume', requestId: 's2' })

    expect(a.length).toBe(aBefore)
    expect(b.length).toBeGreaterThan(1)
  })

  it('stops Core only when told to', async () => {
    await host!.start()
    expect(host!.status().lifecycle).toBe('ready')
    await host!.stop('app quitting')
    // The log records the stop, and the host says it is no longer serving.
    expect(host!.status().lifecycle).toBe('booting')
  })

  it('does not start a second Core if asked again after stopping', async () => {
    await host!.start()
    await host!.stop('app quitting')
    await host!.start()
    // A fresh Core over the same log replays it, so the sequence continues
    // rather than restarting — the durable record is what carries the state.
    expect(host!.status().lifecycle).toBe('ready')
    expect(host!.status().eventSequence).toBeGreaterThan(2)
  })
})

describe('the Work mirror belongs to the process too', () => {
  it('reports Work as unavailable before Core has started', () => {
    // A host that has not started has no engine, and must say so rather than
    // handing a window an empty board that reads as "there is no work".
    const projection = host!.work()
    expect(projection).toBeNull()
  })

  it('pushes the current projection on attach, so a reloaded window catches up', async () => {
    await host!.start()
    const seen: WorkProjection[] = []
    const dispose = host!.onWork((projection) => seen.push(projection))

    // Delivered immediately: a window that has just reloaded must know where the
    // work stands without asking for it.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('ready')
    expect(seen[0]?.runs).toEqual([])
    dispose()
  })

  it('keeps work across a window detaching and another attaching', async () => {
    await host!.start()
    const first: WorkProjection[] = []
    const disposeFirst = host!.onWork((projection) => first.push(projection))

    const created = await host!.submit({
      command: 'work.run.create',
      requestId: 'w1',
      payload: {
        steps: [
          {
            key: 'record',
            label: 'Record the first note',
            capability: 'test.record',
            verifier: 'test.record.matches',
            input: { expect: 'record' },
          },
        ],
      },
    })
    expect(created.ok).toBe(true)
    const runId = created.work?.runId
    expect(runId).toBeTruthy()

    // The window goes away mid-flight. This is the property the whole architecture
    // rests on: the renderer is the disposable half.
    disposeFirst()

    const second: WorkProjection[] = []
    host!.onWork((projection) => second.push(projection))

    expect(second[0]?.runs.map((run) => run.runId)).toEqual([runId])
    // And it is still there, still queued, and untouched by the reload.
    expect(second[0]?.runs[0]?.status).toBe('queued')
  })

  it('drops a window that throws rather than taking the mirror down with it', async () => {
    await host!.start()
    const healthy: WorkProjection[] = []
    host!.onWork(() => {
      throw new Error('this window is broken')
    })
    host!.onWork((projection) => healthy.push(projection))

    await host!.submit({
      command: 'work.run.create',
      requestId: 'w1',
      payload: { steps: [{ key: 'a', label: 'a', capability: 'test.record', verifier: 'test.record.matches' }] },
    })

    // One broken subscriber must not stop the others being told, exactly as with
    // status, activity, conversation and Brain.
    expect(healthy.length).toBeGreaterThan(1)
  })
})

describe('the renderer bridge refuses what a window should not name', () => {
  it('does not include grant governance, which Core does support', async () => {
    // Core can create and revoke grants. A window cannot. The list the preload
    // bridge checks is a subset on purpose, so a compromised renderer has no
    // path to grant authority even though the command exists.
    const source = await readFile(
      new URL('../../electron/preload.ts', import.meta.url),
      'utf8',
    )
    const listed = source.slice(source.indexOf('CORE_COMMANDS'))
    expect(listed).toContain("'security.stopAll'")
    expect(listed).not.toContain("'cognition.grant.create'")
    expect(listed).not.toContain("'cognition.grant.revoke'")
  })

  it('gives a window no way to approve on a principal of its own choosing', async () => {
    const source = await readFile(
      new URL('../../electron/preload.ts', import.meta.url),
      'utf8',
    )
    // The decision reaches the bridge and the decision is rebuilt from named
    // fields. There is no `decidedBy` in the payload contract at all, so a window
    // that appends one is not merely ignored — it never crosses the boundary.
    // Comments stripped, because the case explains in prose that it does not read
    // a `decidedBy` — and this test is about the code, not the commentary.
    const contract = source
      .slice(
        source.indexOf("case 'work.approval.decide'"),
        source.indexOf('// Grant governance is intentionally not in CORE_COMMANDS'),
      )
.split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join(' ')
    expect(contract).toContain("string('approvalId'")
    expect(contract).toContain("string('decision'")
    expect(contract).not.toContain('decidedBy')
    expect(contract).not.toContain('principal')
  })

  it('gives a window no way to reach a capability, a verifier or a plan', async () => {
    const source = await readFile(
      new URL('../../electron/preload.ts', import.meta.url),
      'utf8',
    )
    const api = source.slice(source.indexOf('const api = {'), source.indexOf('contextBridge.exposeInMainWorld'))
    // The bridge exposes projections and commands. There is no function that
    // returns a registered capability or verifier, because an object that could
    // describe its own approval is an object that could ask for one.
    expect(api).not.toMatch(/capabilit(y|ies)\(\):/i)
    expect(api).not.toMatch(/verifier\(\):/i)
  })
})
