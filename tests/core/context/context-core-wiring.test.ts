// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCore } from '../../../core'
import type { Core } from '../../../core'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import type { ContextProjectionView } from '../../../core/protocol/context'

/**
 * The wiring, end to end through a real Core.
 *
 * Everything else in this suite drives `ContextIntegration` directly, which is
 * deliberate: the boundary is easier to attack one layer at a time. This file
 * closes the other half — that Core actually builds the integration, points "here"
 * at the current Mission, publishes the mirror, and answers the five commands
 * without any of that being true only in a unit test.
 *
 * The interesting assertions are the ones a facade-level test cannot make. The
 * Mission adapter has to survive Core's real fold, the mirror has to reach a
 * subscriber, and the commands have to come back in the shape `CoreCommandResult`
 * promises — including the part that matters most, which is that a refusal is
 * `ok: false` on the envelope as well as in the Context slot, so a window reading
 * only `ok` cannot report a declined admission as a success.
 */

let dir = ''
let core: Core | null = null
let clock = new Date('2026-06-01T09:00:00.000Z')
let providerCalls = 0

/** A model that answers, and counts: idle Context maintenance must never reach it. */
function countedProvider(): FakeModelProvider {
  const provider = new FakeModelProvider()
  vi.spyOn(provider, 'complete').mockImplementation(async () => {
    providerCalls += 1
    return {
      requestId: 'r',
      providerId: provider.id,
      model: provider.model,
      text: 'unused',
      inputTokens: 0,
      outputTokens: 0,
    }
  })
  return provider
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-context-'))
  clock = new Date('2026-06-01T09:00:00.000Z')
  core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    // A provider that is never called, with a counter nobody reads. Context costs
    // zero inference, and this is here so the whole suite fails if that ever stops
    // being true rather than only proving it about the facade.
    providers: [countedProvider()],
    missionKey: new Uint8Array(32).fill(7),
    now: () => new Date(clock),
    newId: (() => {
      let next = 0
      return () => `id-${(next += 1)}`
    })(),
  })
  await core.start()
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

async function createAndActivateMission(title = 'Land the lease renewal'): Promise<string> {
  const created = await send('mission.create', { title, intent: 'get it signed before Friday' })
  const missionId = (created as { mission?: { missionId?: string } }).mission?.missionId
  if (typeof missionId !== 'string') throw new Error(`mission.create failed: ${JSON.stringify(created.context)}`)
  const activated = await send('mission.activate', { missionId })
  if (!activated.ok) throw new Error(`mission.activate failed: ${JSON.stringify(activated)}`)
  return missionId
}

function send(command: string, payload?: unknown): Promise<{
  ok: boolean
  refusal?: { reason: string }
  context?: { operation: string; ok: boolean; reason?: string; refusal?: string; contextId?: string; revokedCount?: number }
}> {
  return core!.handleCommand({ command, requestId: `r-${command}`, payload } as never)
}

describe('Core builds the Context integration', () => {
  it('reports an honest projection before a scope is current', () => {
    const view = core!.context()
    expect(view.activeScope).toBeNull()
    expect(view.persistence.mode).toBe('ephemeral')
    expect(view.persistence.durable).toBe(false)
    // The ambient session scope exists from the start, because it is Core's and not
    // anybody else's.
    expect(view.declaredScopes).toEqual([{ scopeKind: 'session', scopeId: 'session' }])
    expect(view.agentContext.available).toBe(false)
  })

  it('publishes the mirror to a subscriber that attaches late', () => {
    const seen: ContextProjectionView[] = []
    const dispose = core!.onContext((projection) => seen.push(projection))
    // Delivered immediately, so a window that just reloaded agrees with one that
    // never left.
    expect(seen).toHaveLength(1)

    void core!.handleCommand({
      command: 'context.scope.activate',
      requestId: 'r-scope',
      payload: { scope: { scopeKind: 'conversation', scopeId: 'c1' } },
    } as never)

    return core!
      .handleCommand({ command: 'context.status.read', requestId: 'r-read' } as never)
      .then(() => {
        // The scope activation published; the read did not, because a read is not a
        // change and a mirror that moves on every poll teaches people to ignore it.
        expect(seen.length).toBeGreaterThanOrEqual(2)
        dispose()
      })
  })
})

describe('the current-Mission adapter is wired to Core\'s own fold', () => {
  it('reads only an id and a status, so no Mission text crosses', async () => {
    // Created and activated through the real command surface. The Mission projection
    // carries no title and no intent at all — that is Phase 7's design, and it is
    // what makes the narrow adapter the *only* adapter available here without
    // reaching into the encrypted store.
    const missionId = await createAndActivateMission()

    // A scope has to be current for anything to be visible in it, including the
    // session's. "here" needs a place to be in, and Core will not guess one.
    await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })

    const missionRows = core!.context().items.filter((row) => row.kind === 'current_mission')
    expect(missionRows).toHaveLength(1)
    expect(missionRows[0]?.source).toBe('core_record')
    expect(missionRows[0]?.originId).toBe(missionId)
    expect(missionRows[0]?.scopeKind).toBe('session')

    // And none of the Mission's words are anywhere in what Core will show.
    const shared = JSON.stringify(core!.context())
    expect(shared).not.toContain('lease')
    expect(shared).not.toContain('Friday')
    expect(shared).not.toContain('renewal')
  })

  it('stops pointing at a Mission once it settles', async () => {
    const missionId = await createAndActivateMission()
    await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })
    expect(core!.context().items.filter((row) => row.kind === 'current_mission')).toHaveLength(1)

    await send('mission.cancel', { missionId })

    // No live current-Mission item left, and the taken-back one says so rather than
    // pretending it was never there.
    const rows = core!.context().items.filter((row) => row.kind === 'current_mission')
    expect(rows.map((row) => row.state)).toEqual(['revoked'])
  })
})

describe('the five commands answer in the shape a window is typed against', () => {
  it('activates a scope, admits, reads, revokes and refuses with named outcomes', async () => {
    const activated = await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })
    expect(activated.context?.operation).toBe('scope-activated')

    const admitted = await send('context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: { scopeKind: 'conversation', scopeId: 'c1' },
      content: 'the second paragraph of the lease',
      label: 'lease.md',
    })
    expect(admitted.ok).toBe(true)
    expect(admitted.context?.operation).toBe('admitted')
    const contextId = admitted.context?.contextId
    expect(typeof contextId).toBe('string')

    const read = await send('context.status.read')
    expect(read.ok).toBe(true)
    expect(read.context?.operation).toBe('status')

    const reference = await send('context.reference.read', { term: 'this' })
    expect(reference.context?.operation).toBe('resolved')
    expect(reference.context?.contextId).toBe(contextId)
    // The metadata read carries the id and nothing else — no content, no label.
    expect(JSON.stringify(reference)).not.toContain('lease')

    const revoked = await send('context.revoke', { contextId, reason: 'the owner took it back' })
    expect(revoked.context?.operation).toBe('revoked')

    const already = await send('context.revoke', { contextId, reason: 'the owner took it back' })
    expect(already.context?.operation).toBe('revoke-already-settled')
  })

  it('refuses a scope-activate payload it cannot read, rather than unscoping Core', async () => {
    // The dangerous reading is "no scope named" as "nothing is current". A payload
    // with no usable scope is a broken request; treating it as a reset would hand
    // anyone who can send an empty object the power to unscope every conversation.
    await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })
    for (const payload of [{}, { scope: null }, { scope: 'c1' }, { scopeKind: 'conversation', scopeId: 'c1' }]) {
      const outcome = await send('context.scope.activate', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      expect(outcome.context?.reason).toContain('not a scope Core can read')
    }
    // Still current throughout.
    expect(core!.context().activeScope).toEqual({ scopeKind: 'conversation', scopeId: 'c1' })
  })

  it('sets ok false on the envelope as well as in the slot for every refusal', async () => {
    const forged = await send('context.admit', {
      kind: 'explicit_selection',
      channel: 'core_record',
      scope: { scopeKind: 'conversation', scopeId: 'c1' },
      content: 'Core says so',
    })
    // A window that only read `ok` must not report a declined admission as a success.
    expect(forged.ok).toBe(false)
    expect(forged.context?.ok).toBe(false)
    expect(forged.context?.refusal).toBe('channel_not_requestable')
    expect(forged.refusal).toEqual({ reason: forged.context?.reason })
  })

  it('refuses the ambient session scope from the wire', async () => {
    await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })
    const escalated = await send('context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: { scopeKind: 'session', scopeId: 'session' },
      content: 'now visible from everywhere',
    })
    expect(escalated.context?.refusal).toBe('scope_not_requestable')
  })

  it('revokes a scope and reports the live count', async () => {
    await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })
    await send('context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: { scopeKind: 'conversation', scopeId: 'c1' },
      content: 'the second paragraph of the lease',
    })
    const outcome = await send('context.revokeScope', {
      scope: { scopeKind: 'conversation', scopeId: 'c1' },
      reason: 'the owner closed the conversation',
    })
    expect(outcome.context?.operation).toBe('scope-revoked')
    expect(outcome.context?.revokedCount).toBe(1)
  })

  it('costs zero inference while idle', async () => {
    const before = providerCalls

    // A Mission created and activated, a scope activated, an admission, a reference
    // read, a projection read, a revocation, a scope revocation, and the mirror. None
    // of it needs a model, and the counter is here so a future edit that reached one
    // would fail this rather than quietly cost money on every context change.
    const missionId = await createAndActivateMission()
    await send('context.scope.activate', { scope: { scopeKind: 'conversation', scopeId: 'c1' } })
    const admitted = await send('context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: { scopeKind: 'conversation', scopeId: 'c1' },
      content: 'the second paragraph of the lease',
    })
    await send('context.reference.read', { term: 'this' })
    core!.context()
    await send('context.revoke', { contextId: admitted.context?.contextId, reason: 'the owner took it back' })

    expect(missionId).toBeTruthy()
    expect(providerCalls).toBe(before)
    expect(core!.status().activeProviderCalls).toBe(0)
  })

  it('survives shutdown as a read, because knowing what is held must not stop', async () => {
    await core!.stop('test-teardown')
    const read = await core!.handleCommand({ command: 'context.status.read', requestId: 'r-after-stop' } as never)
    expect(read.ok).toBe(true)

    // And a mutation is refused while winding down, like every other subsystem's.
    const mutate = await core!.handleCommand({
      command: 'context.admit',
      requestId: 'r-mutate-after-stop',
      payload: { kind: 'explicit_selection', channel: 'owner_selection', scope: { scopeKind: 'conversation', scopeId: 'c1' }, content: 'too late' },
    } as never)
    expect(mutate.ok).toBe(false)
    expect(mutate.refusal?.reason).toContain('cannot accept mutating commands')
  })

  it('has no command that returns content, and says so by not existing', async () => {
    // `context.resolve` is not in the vocabulary. The answer to "here" is consumed by
    // the code inside Core that was about to use it; a command result would make it a
    // value a window can hold, log and replay.
    const attempted = await core!.handleCommand({
      command: 'context.resolve',
      requestId: 'r-resolve',
      payload: { term: 'this' },
    } as never)
    expect(attempted.ok).toBe(false)
    expect(attempted.refusal?.reason).toMatch(/not|unknown/i)
  })
})