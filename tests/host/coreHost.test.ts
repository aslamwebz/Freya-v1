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
    // One start means one set of startup events, not three sets. The exact count
    // is not pinned here: startup now also records one runtime activation
    // decision per registered domain, and pinning the number would make this a
    // test about the registry rather than about idempotent startup. The property
    // is that a further start appends nothing.
    const first = status.eventSequence
    expect(first).toBeGreaterThan(3)
    await host!.start()
    expect(host!.status().eventSequence).toBe(first)
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

/**
 * One `case` arm of the preload payload contract, comments stripped.
 *
 * These tests read the bridge's source rather than calling it, because
 * `rendererPayload` is deliberately not exported: a module-private boundary is
 * worth more than a directly callable one, and the fields it refuses are only
 * provable by looking at what it does *not* read.
 *
 * Comments are stripped because several arms explain in prose exactly which field
 * they do not accept, and these tests are about the code rather than the
 * commentary — leaving the prose in would let a comment satisfy the assertion it
 * describes.
 */
async function contractBetween(
  from: string,
  to: string,
): Promise<{ source: string; contract: string }> {
  const source = await readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8')
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`the preload bridge has no region between ${from} and ${to}`)
  }
  const contract = source
    .slice(start, end)
    .split(String.fromCharCode(10))
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join(' ')
  return { source, contract }
}

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

  it('refuses a Run that names its own parent, and rebuilds the one it does accept', async () => {
    const { contract } = await contractBetween("case 'work.run.create'", "case 'work.run.start'")

    // A window names *which Mission* a Run belongs to, and nothing else. The old
    // contract forwarded a `{ kind, id }` pair read straight off the payload, which
    // let any window attach a Run to anything by asserting one — and `kind` is a claim
    // about structure, which is Core's to make rather than a window's.
    //
    // Refused rather than dropped, so code still sending the old shape is told rather
    // than left believing it worked.
    expect(contract).toContain("'parent' in record")
    expect(contract).toContain("string('missionId'")

    // And the forwarded payload carries an id, never a parent object.
    const forwarded = contract.slice(contract.indexOf('payload: {'))
    expect(forwarded).toContain('missionId')
    expect(forwarded).not.toMatch(/\bparent\b\s*[,:}]/)
  })

  it('rebuilds run limits from named ceilings instead of forwarding the object', async () => {
    const { contract } = await contractBetween("case 'work.run.create'", "case 'work.run.start'")

    // Every other field on this command is rebuilt so an ignored blob is never
    // structured-cloned into the main process; `limits` was the one field that skipped
    // that. It cannot raise a ceiling either way - Core clamps downward - but it could
    // carry an arbitrarily large object across the boundary.
    expect(contract).toContain('for (const name of')
    expect(contract).toContain('Math.floor(value)')
    expect(contract).not.toContain('limits: rawLimits')
  })

  it('lets a Mission command carry its words and nothing else', async () => {
    const { contract } = await contractBetween("case 'mission.create'", "case 'core.command.submit':")

    // The three pieces of text a Mission is made of.
    expect(contract).toContain("string('title'")
    expect(contract).toContain("string('intent'")
    expect(contract).toContain('successCriteria')

    // And none of the four things that would let a Mission lie: a code-owned ceiling,
    // an identity, an asserted outcome, or a chosen verifier. Each of those is read by
    // name, so leaving them out means a window appending one never gets it across the
    // boundary rather than merely having it ignored downstream.
    for (const forbidden of [
      'limits',
      'principal',
      'verification',
      'verifierId',
      'deadlineAt',
      'status',
    ]) {
      expect(contract).not.toContain(`string('${forbidden}'`)
      expect(contract).not.toContain(`${forbidden}:`)
    }
  })

  it('reaches the whole Mission lifecycle without letting a window conclude one by assertion', async () => {
    const source = await readFile(
      new URL('../../electron/preload.ts', import.meta.url),
      'utf8',
    )
    const reachable = source.slice(source.indexOf('const CORE_COMMANDS'))
    for (const command of [
      'mission.status.read',
      'mission.create',
      'mission.activate',
      'mission.pause',
      'mission.resume',
      'mission.cancel',
      'mission.fail',
      'mission.requestCompletion',
    ]) {
      expect(reachable).toContain(`'${command}'`)
    }

    // All six state-changing commands share one arm that reads exactly one field.
    const { contract } = await contractBetween(
      "case 'mission.activate'",
      "case 'core.command.submit':",
    )
    expect(contract).toContain("string('missionId'")
    // `requestCompletion` asks a verifier rather than carrying the answer, so there is
    // no `verifierId` for a window to pick the one that will say yes.
    expect(contract).not.toContain('verifierId')
  })

  it('exposes no Mission key, store or content channel to a window', async () => {
    const source = await readFile(
      new URL('../../electron/preload.ts', import.meta.url),
      'utf8',
    )
    const api = source.slice(source.indexOf('const api = {'), source.indexOf('contextBridge.exposeInMainWorld'))
    // A Mission's words come back from the encrypted store, not from the bridge. So
    // there is no function handing a window the store or its key, and the projection
    // channel carries statuses rather than text: a window sitting open does not hold a
    // copy of what the owner asked Freya to do.
    expect(api).not.toMatch(/mission(Key|Store|Content)\s*\(\)/i)
    expect(source).not.toContain('missionKey')
    expect(source).not.toContain('MISSION_LIMITS.maxTitleChars as')
  })
})
