import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ABSENT_RELAY_PROJECTION, type RelayProjection } from '../../core/protocol/relay'
import { initialRelayState } from '../../core/relay/state'
import { projectRelay } from '../../core/relay/projection'
import { relayMirror, createRelayMirror, resetRelayMirror } from '../../src/platform/relayClient'

/**
 * The renderer's Relay mirror.
 *
 * The boundary properties are the point:
 *
 *  1. It holds what Core pushed and cannot write any of it.
 *  2. Its one read takes **no arguments** — there is no parameter in which a
 *     connector, an action or a capability could travel.
 *  3. It exposes no method that registers a connector, faults one, sets an
 *     allowlist or executes a write without an approval.
 *  4. Its requestRead/requestWrite calls send only the named fields.
 */

function projection(sequence = 0): RelayProjection {
  return projectRelay(sequence, initialRelayState(), () => 'ready')
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreRelay: ReturnType<typeof vi.fn>
let handlers: Set<(projection: RelayProjection) => void>

function push(next: RelayProjection): void {
  for (const handler of [...handlers]) handler(next)
}

beforeEach(() => {
  resetRelayMirror()
  handlers = new Set()
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: true, relay: { operation: 'status', ok: true } }))
  coreRelay = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreRelay: coreRelay as never,
    onCoreRelay: ((next: (p: RelayProjection) => void) => {
      handlers.add(next)
      return () => {
        handlers.delete(next)
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetRelayMirror()
})

describe('relay mirror', () => {
  it('holds what Core pushed and cannot write any of it', async () => {
    const mirror = relayMirror()
    await mirror.attach()
    const first = projection(1)
    push(first)
    expect(mirror.projection).toBe(first)
    // The mirror has no setter: the projection is replaced only by a push.
    expect(Object.getOwnPropertyNames(mirror)).not.toContain('setProjection')
  })

  it('its read takes no arguments', async () => {
    const mirror = relayMirror()
    await mirror.read()
    expect(coreRelay).toHaveBeenCalledWith()
  })

  it('reports the absent projection before Core has reported', async () => {
    const mirror = createRelayMirror()
    coreRelay.mockResolvedValue(null)
    await mirror.attach()
    expect(mirror.projection).toBe(ABSENT_RELAY_PROJECTION)
  })

  it('exposes no method that registers a connector', () => {
    const mirror = relayMirror()
    const record = mirror as unknown as Record<string, unknown>
    expect(record.registerConnector).toBeUndefined()
    expect(record.faultConnector).toBeUndefined()
    expect(record.setAllowlist).toBeUndefined()
  })

  it('exposes no method that executes a write without an approval', () => {
    const mirror = relayMirror()
    const record = mirror as unknown as Record<string, unknown>
    // There is no 'execute' or 'send' method: writes go through requestWrite,
    // which creates a pending approval.
    expect(record.execute).toBeUndefined()
    expect(record.send).toBeUndefined()
  })

  it('requestRead sends only the named fields', async () => {
    const mirror = relayMirror()
    await mirror.requestRead({ command: 'relay.email.read', query: 'hello' })
    expect(coreSubmit).toHaveBeenCalledWith('relay.email.read', { command: 'relay.email.read', query: 'hello' })
  })

  it('requestWrite sends only the named fields', async () => {
    const mirror = relayMirror()
    await mirror.requestWrite({
      command: 'relay.email.send',
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(coreSubmit).toHaveBeenCalledWith('relay.email.send', {
      command: 'relay.email.send',
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
  })

  it('decide sends only the approval id and decision', async () => {
    const mirror = relayMirror()
    await mirror.decide('approval-1', 'approved')
    expect(coreSubmit).toHaveBeenCalledWith('relay.approval.decide', {
      approvalId: 'approval-1',
      decision: 'approved',
    })
  })

  it('a refusal from Core is surfaced as a refused outcome', async () => {
    const mirror = relayMirror()
    coreSubmit.mockResolvedValue({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'Freya is stopped' },
    })
    const outcome = await mirror.requestRead({ command: 'relay.email.read' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('Freya is stopped')
  })

  it('a bridge that predates Relay is tolerated', async () => {
    const mirror = createRelayMirror()
    window.freyaHost = { isDesktop: true } as never
    await mirror.attach()
    expect(mirror.projection).toBe(ABSENT_RELAY_PROJECTION)
  })
})
