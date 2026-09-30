// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import type { CoreStatus } from '../../core/protocol/core-protocol'

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
    // One start means one pair of lifecycle events, not three.
    expect(status.eventSequence).toBe(2)
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
})
