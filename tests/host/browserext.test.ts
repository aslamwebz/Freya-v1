import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeAcceptKey,
  createBrowserAdapter,
  createBrowserExtensionHost,
  decodeClientFrames,
  encodeText,
  type ExtensionRequest,
  type ExtensionResponse,
} from '../../electron/browserext'
import type { BrowserTransport } from '../../electron/browserext'
import { CONNECTION, EXT_ID, ORIGIN, T0 } from '../core/browserext/harness'

/* ------------------------------------------------------------------ frames */

function maskedTextFrame(text: string, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = Buffer.from([0x81, 0x80 | payload.length])
  const masked = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return Buffer.concat([header, mask, masked])
}

describe('websocket frame codec', () => {
  it('computes the RFC 6455 accept key', () => {
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('decodes a masked client text frame', () => {
    const result = decodeClientFrames(maskedTextFrame('{"kind":"hello"}'), 4096)
    expect(result.error).toBeNull()
    expect(result.frames).toHaveLength(1)
    expect(result.frames[0]?.opcode).toBe(0x1)
    expect(result.frames[0]?.payload.toString('utf8')).toBe('{"kind":"hello"}')
  })

  it('leaves a partial frame in the buffer', () => {
    const frame = maskedTextFrame('hello')
    const result = decodeClientFrames(frame.subarray(0, 4), 4096)
    expect(result.frames).toHaveLength(0)
    expect(result.rest.length).toBe(4)
  })

  it('refuses an unmasked client frame', () => {
    const unmasked = Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('hi')])
    const result = decodeClientFrames(unmasked, 4096)
    expect(result.error).not.toBeNull()
  })

  it('refuses a frame larger than the ceiling', () => {
    const frame = maskedTextFrame('x'.repeat(300))
    const result = decodeClientFrames(frame, 64)
    expect(result.error).not.toBeNull()
  })

  it('encodes a server text frame', () => {
    const encoded = encodeText('{"kind":"server.hello"}')
    expect(encoded[0]).toBe(0x81)
    expect(encoded.subarray(2).toString('utf8')).toBe('{"kind":"server.hello"}')
  })
})

/* ----------------------------------------------------------------- adapter */

function transportReturning(handler: (request: ExtensionRequest) => ExtensionResponse): BrowserTransport {
  return {
    send: async (_connectionId, request) => handler(request),
  }
}

const okResponse = (request: ExtensionRequest, result: unknown): ExtensionResponse => ({
  kind: 'response',
  requestId: request.requestId,
  ok: true,
  code: 'ok',
  reason: 'ok',
  result,
})

describe('browser adapter', () => {
  it('performs a page operation and stashes the observed content out of band', async () => {
    const adapter = createBrowserAdapter({
      now: () => T0,
      transport: transportReturning((request) => okResponse(request, { text: 'hello world' })),
    })
    adapter.begin('act-1', { connectionId: CONNECTION, command: 'page.read-text', tabId: 3, url: 'https://example.com/', deadlineAt: T0 + 5_000 })
    const outcome = await adapter.performBrowser({
      actionId: 'act-1',
      url: 'https://example.com/',
      selector: null,
      text: null,
      deadlineAt: new Date(T0 + 5_000).toISOString(),
    })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('observed')
    expect(outcome.textBytes).toBe(11)
    expect(adapter.takeObserved('act-1')).toEqual({ text: 'hello world' })
    // A second read is empty: the buffer is single-use.
    expect(adapter.takeObserved('act-1')).toBeNull()
  })

  it('reports a failure as not-holding rather than guessing', async () => {
    const adapter = createBrowserAdapter({
      now: () => T0,
      transport: transportReturning((request) => ({
        kind: 'response',
        requestId: request.requestId,
        ok: false,
        code: 'protected-field',
        reason: 'that is a password field',
        result: null,
      })),
    })
    adapter.begin('act-2', { connectionId: CONNECTION, command: 'element.type-text', tabId: 3, url: 'https://example.com/', deadlineAt: T0 + 5_000 })
    const outcome = await adapter.performBrowser({
      actionId: 'act-2',
      url: 'https://example.com/',
      selector: '#pw',
      text: 'secret',
      deadlineAt: new Date(T0 + 5_000).toISOString(),
    })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('protected-field')
  })

  it('refuses a port call with no authenticated command context', async () => {
    const adapter = createBrowserAdapter({ now: () => T0, transport: transportReturning((request) => okResponse(request, {})) })
    const outcome = await adapter.performBrowser({
      actionId: 'orphan',
      url: 'https://example.com/',
      selector: null,
      text: null,
      deadlineAt: new Date(T0 + 5_000).toISOString(),
    })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('no-command-context')
  })

  it('bounds a selection read and surfaces a refusal', async () => {
    const adapter = createBrowserAdapter({
      now: () => T0,
      transport: transportReturning((request) => okResponse(request, { text: 'x'.repeat(10_000) })),
    })
    const result = await adapter.observe({
      sessionId: 's',
      connectionId: CONNECTION,
      extensionId: EXT_ID,
      command: 'selection.read',
      actionKey: null,
      args: {},
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/',
      origin: 'https://example.com',
      at: T0,
      deadlineAt: T0 + 5_000,
      actionId: 'act-3',
    })
    expect(result.ok).toBe(true)
    const value = result.result as { bytes: number }
    expect(value.bytes).toBeLessThanOrEqual(4 * 1024)
  })
})

/* -------------------------------------------------------------------- host */

describe('browser extension host', () => {
  let host: ReturnType<typeof createBrowserExtensionHost> | null = null

  afterEach(async () => {
    if (host !== null) await host.stop()
    host = null
  })

  it('starts, reports fail-closed activation, and stops', async () => {
    host = createBrowserExtensionHost({ activation: 'pending-phase42', now: () => T0 })
    const { port } = await host.start()
    expect(port).toBeGreaterThan(0)
    const status = host.status()
    expect(status.activation).toBe('pending-phase42')
    expect(status.enabled).toBe(false)
    await host.stop()
    host = null
  })

  it('refuses a consequential action at the enabled gate while Phase 42 is absent', async () => {
    host = createBrowserExtensionHost({
      activation: 'pending-phase42',
      now: () => T0,
      requestControl: async () => true,
    })
    await host.start()
    const opened = host.bridge.openPairing()
    const paired = await host.bridge.handle(CONNECTION, ORIGIN, {
      kind: 'pair.request',
      pairingCode: opened.code,
      extensionId: EXT_ID,
      extensionVersion: '0.1.0',
    })
    if (paired.kind !== 'pair.ok') throw new Error('pairing failed')
    const sessionId = paired.sessionId
    const send = (seq: number, command: string, args: Record<string, unknown>) =>
      host!.bridge.handle(CONNECTION, ORIGIN, {
        kind: 'command',
        sessionId,
        seq,
        nonce: `n-${String(seq)}`,
        idempotencyKey: `i-${String(seq)}`,
        command,
        args,
      })
    await send(1, 'page.share', { tabId: 1, url: 'https://example.com/' })
    // The owner approves control, so the bridge capability is present — and the action
    // is still refused, by Core's enabled gate, because Phase 42 has not activated it.
    const control = await send(2, 'control.request', {})
    expect(control.kind).toBe('command.result')
    const click = await send(3, 'element.click', { selector: '#go' })
    expect(click.kind).toBe('command.result')
    if (click.kind === 'command.result') {
      expect(click.ok).toBe(false)
      expect(click.code).toBe('subsystem-disabled')
    }
    await host.stop()
    host = null
  })
})
