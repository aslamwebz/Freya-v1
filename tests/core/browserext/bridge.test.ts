import { describe, expect, it } from 'vitest'
import {
  BROWSER_BRIDGE_LIMITS,
  BROWSER_BRIDGE_PROTOCOL,
  parseInbound,
  type BridgeOutbound,
} from '../../../core/browserext'
import { CONNECTION, EXT_ID, ORIGIN, T0, harness } from './harness'

async function paired(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const outbound = await h.pair()
  if (outbound.kind !== 'pair.ok') throw new Error('pairing failed')
  return { h, token: outbound.token, sessionId: outbound.sessionId }
}

function code(outbound: BridgeOutbound): string | null {
  return outbound.kind === 'refused' ? outbound.code : null
}

describe('bridge handshake and pairing', () => {
  it('answers a hello with a protocol-tagged server hello', async () => {
    const h = harness()
    const hello = await h.bridge.handle(CONNECTION, ORIGIN, { kind: 'hello', protocol: BROWSER_BRIDGE_PROTOCOL, extensionId: EXT_ID, extensionVersion: '1' })
    expect(hello.kind).toBe('server.hello')
    if (hello.kind === 'server.hello') expect(hello.protocol).toBe(BROWSER_BRIDGE_PROTOCOL)
  })

  it('refuses a hello from another protocol version', async () => {
    const h = harness()
    const hello = await h.bridge.handle(CONNECTION, ORIGIN, { kind: 'hello', protocol: 999, extensionId: EXT_ID, extensionVersion: '1' })
    expect(code(hello)).toBe('protocol-mismatch')
  })

  it('pairs with the code it showed and stores only the token hash', async () => {
    const { h, token } = await paired()
    expect(token.length).toBeGreaterThan(0)
    expect([...h.tokens.values()]).toHaveLength(1)
    expect(h.tokens.has(token)).toBe(false)
  })

  it('refuses pairing when no code is open', async () => {
    const h = harness()
    const outbound = await h.bridge.handle(CONNECTION, ORIGIN, {
      kind: 'pair.request',
      pairingCode: 'ABCDEFGH',
      extensionId: EXT_ID,
      extensionVersion: '1',
    })
    expect(code(outbound)).toBe('pairing-closed')
  })

  it('authenticates with a stored token and refuses unknown or revoked ones', async () => {
    const { h, token } = await paired()
    const ok = await h.auth(token)
    expect(ok.kind).toBe('auth.ok')

    const unknown = await h.auth('not-a-token')
    expect(code(unknown)).toBe('token-invalid')

    const hash = [...h.tokens.keys()][0] ?? ''
    const record = h.tokens.get(hash)
    if (record !== undefined) h.tokens.set(hash, { ...record, revokedAt: T0 })
    const revoked = await h.auth(token)
    expect(code(revoked)).toBe('token-revoked')
  })
})

describe('bridge command authority', () => {
  it('refuses an unknown command', async () => {
    const { h, sessionId } = await paired()
    const outbound = await h.command(sessionId, 'browser.eval', {})
    expect(code(outbound)).toBe('command-unknown')
    expect(h.dispatches).toHaveLength(0)
  })

  it('refuses a command the session lacks the capability for', async () => {
    const { h, sessionId } = await paired({ capabilities: ['page.metadata'] })
    const outbound = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(code(outbound)).toBe('capability-missing')
    expect(h.dispatches).toHaveLength(0)
  })

  it('refuses a page command before a tab is shared', async () => {
    const { h, sessionId } = await paired()
    const outbound = await h.command(sessionId, 'selection.read', {})
    expect(code(outbound)).toBe('tab-not-shared')
    expect(h.dispatches).toHaveLength(0)
  })

  it('binds the shared tab, then dispatches reads against it', async () => {
    const { h, sessionId } = await paired()
    const share = await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    expect(h.okOf(share)).toBe(true)
    const read = await h.command(sessionId, 'page.read-text', {})
    expect(h.okOf(read)).toBe(true)
    expect(h.dispatches).toHaveLength(1)
    expect(h.dispatches[0]?.actionKey).toBe('browser.read-text')
    expect(h.dispatches[0]?.tabId).toBe(4)
  })

  it('refuses a command naming a different tab than the shared one', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    const outbound = await h.command(sessionId, 'selection.read', { tabId: 9 })
    expect(code(outbound)).toBe('tab-mismatch')
    expect(h.dispatches).toHaveLength(0)
  })

  it('navigates without a shared tab but only to an allowed host', async () => {
    const { h, sessionId } = await paired()
    const allowed = await h.command(sessionId, 'page.navigate', { url: 'https://example.com/next' })
    expect(h.okOf(allowed)).toBe(true)
    const denied = await h.command(sessionId, 'page.navigate', { url: 'https://evil.com/' })
    expect(code(denied)).toBe('sensitive-url')
    expect(h.dispatches).toHaveLength(1)
  })

  it('refuses a sensitive page at share time', async () => {
    const { h, sessionId } = await paired()
    const outbound = await h.command(sessionId, 'page.share', { tabId: 4, url: 'chrome://settings' })
    expect(code(outbound)).toBe('sensitive-url')
  })

  it('refuses a script-shaped selector', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    const outbound = await h.command(sessionId, 'element.click', { selector: 'a[onclick=alert(1)]' })
    expect(code(outbound)).toBe('payload-invalid')
    expect(h.dispatches).toHaveLength(0)
  })

  it('bounds typed text', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    const outbound = await h.command(sessionId, 'element.type-text', { selector: '#q', text: 'x'.repeat(600) })
    expect(code(outbound)).toBe('payload-too-large')
    expect(h.dispatches).toHaveLength(0)
  })

  it('returns a cached result for an idempotent retry without dispatching twice', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    await h.command(sessionId, 'page.read-text', {}, { idempotencyKey: 'once' })
    const retry = await h.command(sessionId, 'page.read-text', {}, { idempotencyKey: 'once' })
    expect(h.okOf(retry)).toBe(true)
    expect(h.dispatches).toHaveLength(1)
  })
})

describe('bridge control plane', () => {
  it('enables acting capabilities only when the host says the owner approved', async () => {
    const { h, sessionId } = await paired({ capabilities: ['page.metadata', 'control.request'] })
    const denied = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(code(denied)).toBe('capability-missing')

    const request = await h.command(sessionId, 'control.request', {})
    expect(h.okOf(request)).toBe(true)
    await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    const now = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(h.okOf(now)).toBe(true)
  })

  it('narrows back to observation on control.revoke', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'control.request', {})
    await h.command(sessionId, 'control.revoke', {})
    const outbound = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(code(outbound)).toBe('capability-missing')
  })

  it('revokes the session and latches STOP ALL on control.stop', async () => {
    const { h, sessionId } = await paired()
    const outbound = await h.command(sessionId, 'control.stop', {})
    expect(h.okOf(outbound)).toBe(true)
    expect(h.stopRequests).toHaveLength(1)
    const after = await h.command(sessionId, 'session.status', {})
    expect(code(after)).toBe('session-revoked')
  })

  it('refuses everything but stop and status while STOP ALL is latched', async () => {
    const { h, sessionId } = await paired()
    h.setStopAll(true)
    const read = await h.command(sessionId, 'session.status', {})
    expect(h.okOf(read)).toBe(true)
    const navigate = await h.command(sessionId, 'page.navigate', { url: 'https://example.com/' })
    expect(code(navigate)).toBe('stopped')
    expect(h.dispatches).toHaveLength(0)
  })
})

describe('bridge events and replay', () => {
  it('ends the share when the shared tab navigates', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 4, url: 'https://example.com/page' })
    await h.event(sessionId, 'page.navigated', { tabId: 4, url: 'https://example.com/other' })
    const read = await h.command(sessionId, 'selection.read', {})
    expect(code(read)).toBe('tab-not-shared')
  })

  it('refuses a replayed nonce even for a valid session', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'session.status', {}, { nonce: 'fixed', seq: 1 })
    const replay = await h.command(sessionId, 'session.status', {}, { nonce: 'fixed', seq: 2 })
    expect(code(replay)).toBe('nonce-replayed')
  })
})

describe('bridge message parsing', () => {
  it('refuses an oversized frame before parsing it', () => {
    const result = parseInbound('x'.repeat(BROWSER_BRIDGE_LIMITS.maxMessageBytes + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('message-too-large')
  })

  it('refuses malformed JSON', () => {
    const result = parseInbound('{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('malformed-message')
  })
})
