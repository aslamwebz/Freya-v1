// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'

/**
 * The Phase 6 fixture capabilities are a *test* set, not a *product* set.
 *
 * They exist so a Work run has something to drive, so the engine can be
 * demonstrated end to end, and so a Skills workflow has a deterministic
 * shape to verify against. They are inert by construction (no fs, no
 * child_process, no socket, no model access), but `test.failing` is a
 * deliberate failure generator and `test.consequential` exists so a test
 * can exercise a non-routine risk class. A renderer `work.run.create` or
 * a Skills workflow that names one of these in a shipped Core is doing
 * exactly the thing Phase 6's design said it must not build.
 *
 * The gate is `options.testCapabilities === true`, with `false` and
 * `undefined` treated identically, and the value is never inferred from
 * any debug flag, environment or test runner. This file proves the two
 * halves of the contract: the default Core refuses the fixtures, and an
 * explicitly opted-in Core exposes them. Anything in between is a bug.
 *
 * Reference: `core/index.ts:2359` (the only call site, now gated) and
 * `core/work/capability.ts:336-355` (the source's own description of the
 * decision to keep them in production).
 */

const PHASE_SIX_CAPABILITIES = [
  'test.record',
  'test.failing',
  'test.unverifiable',
  'test.slow',
  'test.consequential',
] as const

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-test-capabilities-'))
})

afterEach(async () => {
  await core?.stop('test-capabilities-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

describe('a Core built without the test-capabilities opt-in', () => {
  it('does not register any Phase 6 fixture capability', async () => {
    core = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await core.start()
    const projection = core.work()
    // The work projection reports the names of registered capabilities. Reading it
    // through the public projection (not the internal registry) is the only check
    // that would catch a future "register silently in start()" regression.
    for (const name of PHASE_SIX_CAPABILITIES) {
      expect(projection.capabilities, `capability list should not include ${name}`).not.toContain(name)
    }
    // And the negative has to be a real negative: the list itself is still served.
    expect(Array.isArray(projection.capabilities)).toBe(true)
  })

  it('refuses a work.run.create that names a Phase 6 fixture', async () => {
    core = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await core.start()
    const result = await core.handleCommand({
      command: 'work.run.create',
      requestId: 'refuse-test-record',
      payload: {
        steps: [
          { key: 's1', label: 'should not run', capability: 'test.record', verifier: 'test.record.matches' },
        ],
      },
    })
    // The command-level result carries `ok: false` and a `work` block that
    // names the capability as missing. Reading the shape rather than the
    // message keeps the test stable across wording edits.
    expect(result.ok).toBe(false)
    expect(result.work?.ok).toBe(false)
    expect(typeof result.work?.reason).toBe('string')
    expect(result.work?.reason).toMatch(/test\.record|does not have/i)
  })
})

describe('a Core built with the explicit test-capabilities opt-in', () => {
  it('registers the Phase 6 fixtures, and the explicit flag is the only knob', async () => {
    core = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
      testCapabilities: true,
    })
    await core.start()
    const projection = core.work()
    for (const name of PHASE_SIX_CAPABILITIES) {
      expect(projection.capabilities, `capability list should include ${name}`).toContain(name)
    }
  })
})

describe('the opt-in', () => {
  it('is never inferred from a debug flag, env var, or test runner', async () => {
    // The C1-B decision says the opt-in is explicit and never inferred. The
    // protection is mechanical: production never sets `testCapabilities`, the
    // e2e does so through its own `FREYA_E2E` gate, and the test fixture
    // passes it directly. There is no other switch in Core that turns it on.
    //
    // This test does not check all of the absence — there is no positive way
    // to enumerate what isn't there — but it does check the *shape* of the
    // option: false is the same as undefined, and a string is the same as
    // undefined. The gate is `=== true`, not "truthy".
    for (const value of [undefined, false, '', 'true', '1', 'yes']) {
      const localDir = await mkdtemp(join(tmpdir(), 'freya-test-capabilities-opt-'))
      const probe = createCore({
        dataPath: join(localDir, 'events.jsonl'),
        providers: [new FakeModelProvider()],
        // Cast through `unknown` so the test's own type does not enforce the
        // boolean shape; the gate under test is the runtime behaviour, not
        // the compile-time contract.
        ...(value === undefined ? {} : { testCapabilities: value as unknown as boolean }),
      })
      try {
        await probe.start()
        const projection = probe.work()
        expect(projection.capabilities, `testCapabilities=${JSON.stringify(value)} should be off`).not.toContain('test.record')
      } finally {
        await probe.stop('opt-shape-teardown')
        await rm(localDir, { recursive: true, force: true })
      }
    }
  })
})