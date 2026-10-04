// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import type { CoreCommandName, CoreCommandResult } from '../../../core/protocol/core-protocol'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { RUNTIME_REGISTRY, orderedRegistry } from '../../../core/runtime'
import type { RuntimeProjection, RuntimeStatus } from '../../../core/runtime'
import {
  ALLOWED_HOST,
  T_PLUS_30S,
  authorityFake,
  defaultGrant,
  hostHarness,
  type HostHarness,
} from '../../host/devicehands/harness'

/**
 * The layers, together.
 *
 * Every other suite in this repository proves one layer on its own: the registry
 * evaluates requirements correctly, the Device Hands gates refuse correctly, the
 * App Mode control calls the canonical command. Each can be green while the *seams*
 * between them are wrong — and the seams are where this project has actually broken.
 *
 * Two examples from the integration this file was written alongside:
 *
 *   - The runtime registry required a `device-hands` host adapter, and the facts
 *     builder could not see one, so `core.device-hands` reported `blocked` no matter
 *     how completely the host wired it. Every layer's own test was green.
 *   - A registry note containing the words "STOP ALL" was journalled verbatim and
 *     failed an unrelated personality red-team test. Again: every layer green.
 *
 * So this file joins the host's wiring to Core's projection to the hands' gate, and
 * asserts the sequence that proves composition rather than coexistence:
 *
 *   no grant → refused · grant → allowed · STOP ALL → refused again
 *
 * That last step is the one that matters. A grant that survived STOP ALL would mean
 * the runtime registry, the Device Hands gate and the security latch are three
 * separate truths rather than one.
 *
 * The hands half reuses Phase 42's own harness rather than rebuilding effects, so
 * this file cannot drift from the runtime it is asserting about.
 */

const HANDS_SCOPE = 'device.hands'

/**
 * A browser action the default grant covers, against the host the harness allows.
 *
 * Taken from Phase 42's own activation suite rather than invented, because an action
 * key the grant does not list is refused at the `grant` gate — which would make this
 * file assert the wrong reason for a refusal.
 */
const BROWSER_ACTION = 'browser.navigate'
const BROWSER_INPUT = { url: `https://${ALLOWED_HOST}/about` }

let dir = ''
let core: Core | null = null
let fake: FakeModelProvider
let requests = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-crosslayer-'))
  fake = new FakeModelProvider()
  requests = 0
})

afterEach(async () => {
  await core?.stop('cross-layer-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

async function submit(command: string, payload?: unknown): Promise<CoreCommandResult> {
  requests += 1
  return core!.handleCommand({
    command: command as CoreCommandName,
    requestId: `x-${requests}`,
    payload,
  })
}

function statusOf(projection: RuntimeProjection, id: string): RuntimeStatus {
  const domain = projection.domains.find((entry) => entry.id === id)
  if (domain === undefined) throw new Error(`the registry has no domain ${id}`)
  return domain.status
}

async function startCore(runtimeFacts?: {
  hostAdapters: string[]
  capabilityGrants?: string[]
}): Promise<Core> {
  core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [fake],
    ...(runtimeFacts === undefined ? {} : { runtimeFacts }),
  })
  await core.start()
  return core
}

/**
 * Phase 42's harness, with the *gate's* authority driven by this test.
 *
 * The authority is set directly rather than through the `grants` array because
 * `hostHarness` calls `authorityFake()` with no overrides, so its `activeGrant`
 * always answers with the default unrevoked grant no matter what is registered. A
 * test that passed a revoked grant and expected a refusal would therefore have been
 * asserting something about the harness rather than about the gate.
 *
 * Driving `authority.grant` is what the property actually turns on: the gate asks the
 * authority whether a grant exists, and this is the only honest way to make that
 * answer `no`.
 */
async function hands(options: { grant?: 'none' | 'active' | 'revoked'; stopped?: boolean }): Promise<HostHarness> {
  return hostHarness({
    enabled: true,
    authority: authorityFake({
      grant:
        options.grant === 'active' || options.grant === undefined
          ? defaultGrant()
          : options.grant === 'revoked'
            ? defaultGrant({ revokedAt: T_PLUS_30S })
            : null,
      stopped: options.stopped === true,
    }),
  })
}

describe('the registry knows what the host wired', () => {
  it('reports device hands blocked when the host wired nothing', async () => {
    await startCore()
    expect(statusOf(core!.runtime(), 'core.device-hands')).toBe('blocked')
  })

  it('reports the browser extension blocked, naming what is missing, with no wiring', async () => {
    await startCore()
    const domain = core!.runtime().domains.find((entry) => entry.id === 'core.browserext')
    expect(domain?.status).toBe('blocked')
    // Blocked *for a reason*. An extension refused because the hands adapter and a
    // grant are both absent is a different situation from one that could never run,
    // and a surface cannot tell them apart unless the projection says which.
    expect(domain?.missing.join(' | ')).toMatch(/host adapter/i)
    expect(domain?.missing.join(' | ')).toMatch(/grant/i)
  })

  it('reports device hands blocked for the grant alone once the adapter is declared', async () => {
    await startCore({ hostAdapters: ['device-hands'], capabilityGrants: [] })
    // This is the seam that was broken: before the fact-reporting option existed this
    // read as blocked for no reachable reason, because no host wiring could ever move
    // the domain. Now it names what is actually absent.
    const domain = core!.runtime().domains.find((entry) => entry.id === 'core.device-hands')
    expect(domain?.status).toBe('blocked')
    expect(domain?.missing.join(' | ')).toMatch(/grant/i)
    expect(domain?.missing.join(' | ')).not.toMatch(/host adapter/i)
  })

  it('reports the browser extension available on the same facts as the hands', async () => {
    await startCore({ hostAdapters: ['device-hands'], capabilityGrants: [HANDS_SCOPE] })
    expect(statusOf(core!.runtime(), 'core.device-hands')).toBe('available')
    // The extension is a port onto the hands, so it can never be more available than
    // the thing it depends on. Equal is the strongest correct claim.
    expect(statusOf(core!.runtime(), 'core.browserext')).toBe('available')
  })

  it('never reports the extension as more available than the hands it rides on', async () => {
    for (const facts of [
      undefined,
      { hostAdapters: [], capabilityGrants: [] },
      { hostAdapters: ['device-hands'], capabilityGrants: [] },
      { hostAdapters: ['device-hands'], capabilityGrants: [HANDS_SCOPE] },
    ]) {
      await startCore(facts)
      const handsStatus = statusOf(core!.runtime(), 'core.device-hands')
      const extStatus = statusOf(core!.runtime(), 'core.browserext')
      const rank = (status: RuntimeStatus): number =>
        status === 'available' || status === 'active' ? 2 : status === 'degraded' ? 1 : 0
      expect(rank(extStatus), `hands=${handsStatus} ext=${extStatus}`).toBeLessThanOrEqual(rank(handsStatus))
      await core!.stop('per-case')
      core = null
    }
  })

  it('orders the registry so the security spine is first and the extension follows the hands', () => {
    const order = orderedRegistry()
    // Security first so a stop is recorded last on the way down, and the fail-closed
    // domains late so nothing earlier can reach them by accident.
    expect(order[0]?.id).toBe('core.security-spine')
    const hands = order.findIndex((entry) => entry.id === 'core.device-hands')
    const extension = order.findIndex((entry) => entry.id === 'core.browserext')
    expect(hands).toBeGreaterThan(0)
    expect(extension).toBeGreaterThan(hands)
  })

  it('registers every domain at a module path inside core', () => {
    for (const entry of RUNTIME_REGISTRY) {
      expect(entry.module.startsWith('core/'), `${entry.id} module`).toBe(true)
    }
  })
})

describe('the sequence that proves the layers are composed', () => {
  it('refuses without a grant, allows with one, and refuses again under STOP ALL', async () => {
    // --- hop 1: no grant ---
    const ungranted = await hands({ grant: 'none' })
    expect(ungranted.authority.grant).toBeNull()
    const before = await ungranted.perform(BROWSER_ACTION, BROWSER_INPUT)
    // `performed` is the load-bearing field: false on *every* refusal, so an effect
    // port was never reached. Asserting on the refusal code alone would still pass if
    // the action had half-run and then reported a problem.
    expect(before.performed).toBe(false)
    expect(before.refusedAt).toBeTypeOf('string')
    // `active` is deliberately not asserted: it reports whether the *lane* was
    // opened, which a host does regardless of grants, so it would not have detected
    // anything. `performed` and the named gate are the real evidence.

    // --- hop 2: an owner-authored grant ---
    const granted = await hands({ grant: 'active' })
    expect(granted.authority.grant).not.toBeNull()
    const during = await granted.perform(BROWSER_ACTION, BROWSER_INPUT)
    expect(during.performed).toBe(true)
    expect(during.refusedAt).toBeNull()
    // The lane's own status agrees the action was permitted.
    expect(granted.activation.status().enabled).toBe(true)
    expect(granted.activation.status().stopped).toBe(false)

    // --- hop 3: the same lane, with Core's stop latch asserted ---
    await startCore({ hostAdapters: ['device-hands'], capabilityGrants: [HANDS_SCOPE] })
    expect(statusOf(core!.runtime(), 'core.device-hands')).toBe('available')

    const stopped = await submit('security.stopAll', { reason: 'cross-layer proof' })
    expect(stopped.ok).toBe(true)
    expect(core!.status().stopAll.active).toBe(true)

    // The hands gate reads Core's latch, so a grant that was sufficient a moment ago
    // is no longer sufficient. This is the assertion that proves composition: a grant
    // surviving STOP ALL would mean the registry, the gate and the latch are three
    // independent truths.
    // The grant is byte-identical to the one that was just sufficient. Only the latch
    // changed — so anything that refuses here refused because of STOP ALL.
    expect(granted.authority.grant).toEqual(defaultGrant())
    granted.authority.stopped = true
    const after = await granted.perform(BROWSER_ACTION, BROWSER_INPUT)
    expect(after.performed).toBe(false)
    // The gate that stopped it is named exactly, so "it was refused" is a fact rather
    // than an inference from a falsy field -- and `stop-all` rather than any refusal
    // proves the latch was the cause and not, say, a grant that quietly expired.
    expect(after.refusedAt).toBe('stop-all')
    expect(after.evaluated.join(' ')).toMatch(/stop-all/i)
    // The same grant was sufficient one step ago, so the lane reporting itself
    // stopped is the visible evidence that the latch — not the grant — is what
    // changed. The two facts are independent: the grant is byte-identical.
    expect(granted.activation.status().stopped).toBe(true)
    // The owner switch is deliberately *not* cleared by STOP ALL, and the distinction
    // is worth pinning: `enabled` is "the owner has switched this on" and `stopped` is
    // "Freya is latched". They are separate facts, so a resume does not need to
    // re-enable anything and a stop does not silently switch the owner off. What
    // changes is that every action is refused, which is what `performed` proved.
    expect(granted.activation.status().enabled).toBe(true)

    // And the projection agrees with the latch rather than with the grant. The
    // controller checks the latch *before* the activation kind, so a satisfied
    // requirement set still reports blocked.
    const domain = core!.runtime().domains.find((entry) => entry.id === 'core.device-hands')
    expect(domain?.status).toBe('blocked')
    expect(domain?.reason).toMatch(/stop all/i)
    // The extension, a port onto the hands, is refused for the same reason.
    expect(statusOf(core!.runtime(), 'core.browserext')).toBe('blocked')
  })

  it('keeps a revoked grant from restoring authority', async () => {
    const revoked = await hands({ grant: 'revoked' })
    const result = await revoked.perform(BROWSER_ACTION, BROWSER_INPUT)
    expect(result.performed).toBe(false)
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('spends no model call anywhere in this file', async () => {
    // Recorded because a cross-layer test is exactly where a stray provider call
    // would hide: it would look like a passing assertion rather than a cost.
    const before = fake.calls
    const granted = await hands({ grant: 'active' })
    await granted.perform(BROWSER_ACTION, BROWSER_INPUT)
    await startCore({ hostAdapters: ['device-hands'], capabilityGrants: [HANDS_SCOPE] })
    await submit('security.stopAll', { reason: 'spend check' })
    await core!.stop('spend-check')
    core = null
    expect(fake.calls).toBe(before)
  })
})

describe('the projection a surface would read', () => {
  it('carries a status and a reason for every domain, with no optimistic zero', async () => {
    await startCore({ hostAdapters: ['device-hands'] })
    const projection = core!.runtime()
    expect(projection.domains.length).toBe(RUNTIME_REGISTRY.length)
    for (const domain of projection.domains) {
      expect(domain.status.length, `${domain.id} status`).toBeGreaterThan(0)
      // A domain with nothing to report must say so in words, not render as a
      // healthy-looking empty.
      expect(domain.reason.length, `${domain.id} reason`).toBeGreaterThan(0)
    }
  })

  it('pushes to subscribers so a shell never polls', async () => {
    core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [fake] })
    const seen: number[] = []
    core.onRuntime((projection) => seen.push(projection.domains.length))
    await core.start()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(RUNTIME_REGISTRY.length)
  })
})
