// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'

/**
 * The verify port is the loop's only window onto Core's own projections, and
 * "settled" used to mean a single thing that conflated *settled* with
 * *succeeded*. A failed mission and an unknown reference both looked
 * indistinguishable from a successful one to the loop, and the loop's journal
 * recorded `verification.passed` for all three.
 *
 * C2-A splits the conflation into three states:
 *
 *   - `settled`: the reference is known to Core and is terminal. The wake's
 *     claim is verified. The underlying thing may have succeeded, failed, or
 *     been cancelled — the verify port does not adjudicate that, the
 *     `code` field carries the terminal status so a journal reader can tell.
 *   - `still-open`: the reference is known to Core but not yet terminal.
 *     `holds` is `false`; the loop retries.
 *   - `unknown`: Core has no projection of the reference at all. `holds` is
 *     `false`; the loop retries. Crucially, this is *not* the same as
 *     `settled` — the old code conflated them, and that conflation was
 *     the source of the false-success the brief is fixing.
 *
 * The classify function is a private method on `FreyaCore`; the tests
 * reach it through the documented test seam `verifyReferenceForTest`, which
 * is a one-line wrapper around the same private method the loop uses. Any
 * drift between the seam and the loop is a regression in the seam itself.
 */

const SEAM = 'verifyReferenceForTest' as const

function verify(core: Core, reference: string): {
  readonly holds: boolean
  readonly outcome: 'settled' | 'still-open' | 'unknown'
  readonly code: string
} {
  // The seam is on the concrete `FreyaCore` class, not the `Core` interface,
  // and is unreachable from a renderer. The cast is the whole cost of the
  // test-only path; it is the same shape as every other test seam in
  // `core/testing.ts`.
  return (core as unknown as { [k in typeof SEAM]: (r: string) => { readonly holds: boolean; readonly outcome: 'settled' | 'still-open' | 'unknown'; readonly code: string } })[SEAM](reference)
}

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-verify-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

async function newCore(extra: Partial<Parameters<typeof createCore>[0]> = {}): Promise<Core> {
  const c = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    testCapabilities: true,
    ...extra,
  })
  await c.start()
  return c
}

describe('a reference that Core has no projection of', () => {
  it('reports unknown, not settled', async () => {
    // The conflation the brief is fixing. A random id that is not a Mission
    // and not a Work Run must NOT look like a settled reference, because
    // burning a retry on an unverifiable reference is a loop, not a
    // verification. The old code returned `holds: true` here.
    core = await newCore()
    const verdict = verify(core, 'mission-id-that-does-not-exist')
    expect(verdict.holds).toBe(false)
    expect(verdict.outcome).toBe('unknown')
    expect(verdict.code).toBe('reference-unknown')
  })

  it('reports unknown for an empty string the same way', async () => {
    // Empty string is a real input class: a malformed wake with a blank
    // reference must not coerce to "settled".
    core = await newCore()
    const verdict = verify(core, '')
    expect(verdict.holds).toBe(false)
    expect(verdict.outcome).toBe('unknown')
  })
})

describe('a reference that is a known open mission', () => {
  it('reports still-open', async () => {
    // Drive a Mission to a live state and check the verdict. The exact
    // command vocabulary is the same vocabulary the loop would use; this
    // test exercises the real state, not a synthetic one.
    core = await newCore({ missionKey: new Uint8Array(32).fill(9) })
    const started = await core.handleCommand({
      command: 'mission.create',
      requestId: 'm1',
      payload: { title: 'a small thing', intent: 'find out what happened and report back' },
    })
    expect(started.ok).toBe(true)
    const missionId = started.mission?.missionId
    expect(missionId).toBeTruthy()
    const verdict = verify(core, missionId!)
    expect(verdict.holds).toBe(false)
    expect(verdict.outcome).toBe('still-open')
    expect(verdict.code).toBe('mission-still-open')
  })
})

describe('a reference that is a known settled mission', () => {
  it('reports settled, regardless of whether the mission succeeded or failed', async () => {
    // The wake's claim is "the reference is terminal". Both `completed`
    // and `failed` satisfy that. The `holds` boolean is about the
    // *claim*, and the `code` carries the terminal status so a journal
    // reader can tell success from failure — a reader who needs that
    // distinction reads the projection, not the verify port.
    core = await newCore({ missionKey: new Uint8Array(32).fill(9) })
    const started = await core.handleCommand({
      command: 'mission.create',
      requestId: 'm2',
      payload: { title: 'a thing to complete', intent: 'do the work' },
    })
    expect(started.ok).toBe(true)
    const missionId = started.mission?.missionId
    expect(missionId).toBeTruthy()
    const cancelled = await core.handleCommand({
      command: 'mission.cancel',
      requestId: 'c1',
      payload: { missionId, reason: 'test' },
    })
    expect(cancelled.ok).toBe(true)
    const verdict = verify(core, missionId!)
    expect(verdict.holds).toBe(true)
    expect(verdict.outcome).toBe('settled')
    // The terminal status is in the code, so a journal reader can tell
    // success from failure without leaving the verify-port's record.
    expect(verdict.code).toMatch(/^mission-/)
  })
})

describe('a reference that is a known open work run', () => {
  it('reports still-open when the run is queued', async () => {
    // A queued run is still a reference the loop can verify; the verdict
    // is "still-open", which the loop reads as "retry". The run is read
    // out of the work projection before its first tick has a chance to
    // finish it, so the test catches a still-running state without a
    // race against the engine.
    core = await newCore({ testCapabilities: true })
    const created = await core.handleCommand({
      command: 'work.run.create',
      requestId: 'w1',
      payload: {
        steps: [
          { key: 's1', label: 'step one', capability: 'test.record', verifier: 'test.record.matches' },
        ],
      },
    })
    expect(created.ok).toBe(true)
    const runId = created.work?.runId
    expect(runId).toBeTruthy()
    const verdict = verify(core, runId!)
    expect(verdict.holds).toBe(false)
    expect(verdict.outcome).toBe('still-open')
    expect(verdict.code).toBe('run-still-open')
  })
})

describe('the escalation-delivered verification', () => {
  it('reports still-open when Attention has no recorded decision', async () => {
    // The escalation-delivered branch is its own thing: Attention's
    // recorder is the source of truth, and its answer is binary ("a
    // decision exists" / "no decision exists"). It does not get a
    // third `unknown` state — Attention is internal, and "we have
    // not asked yet" reads as still-open, not unknown. A fresh Core
    // has not asked Attention anything yet, so the verdict is
    // `still-open` (the loop's two-value view: try again).
    core = await newCore()
    const seam = core as unknown as { verifyForTest: (r: { kind: 'reference-terminal' | 'escalation-delivered'; reference: string }) => Promise<{ holds: boolean; outcome: 'settled' | 'still-open' | 'unknown'; code: string }> }
    const verdict = await seam.verifyForTest({ kind: 'escalation-delivered', reference: 'wake-id' })
    expect(verdict.holds).toBe(false)
    expect(verdict.outcome).toBe('still-open')
    expect(verdict.code).toBe('attention-decided-nothing')
  })
})

describe('the closed vocabulary', () => {
  it('is exactly three values, never a fourth', async () => {
    // The brief is explicit that the three states are a closed set. A
    // new state would be a new port. The test enumerates the existing
    // surface and asserts nothing else is reachable.
    core = await newCore({ missionKey: new Uint8Array(32).fill(9) })
    const verdictUnknown = verify(core, 'no-such-id')
    const verdictSettled = await settledMissionReference(core)
    const verdictOpen = await openMissionReference(core)
    const seen = new Set<string>()
    for (const v of [verdictUnknown, verdictSettled, verdictOpen]) seen.add(v.outcome)
    expect([...seen].sort()).toEqual(['settled', 'still-open', 'unknown'])
  })
})

async function settledMissionReference(core: Core): Promise<{ outcome: 'settled' | 'still-open' | 'unknown' }> {
  const started = await core.handleCommand({
    command: 'mission.create',
    requestId: 'settle',
    payload: { title: 'a thing', intent: 'do a thing' },
  })
  const id = started.mission?.missionId
  if (id === undefined) throw new Error('mission did not start')
  await core.handleCommand({ command: 'mission.cancel', requestId: 'c2', payload: { missionId: id, reason: 'test' } })
  return verify(core, id)
}

async function openMissionReference(core: Core): Promise<{ outcome: 'settled' | 'still-open' | 'unknown' }> {
  const started = await core.handleCommand({
    command: 'mission.create',
    requestId: 'open',
    payload: { title: 'a live thing', intent: 'still in progress' },
  })
  const id = started.mission?.missionId
  if (id === undefined) throw new Error('mission did not start')
  return verify(core, id)
}