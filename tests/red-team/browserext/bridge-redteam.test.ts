import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_BRIDGE_CAPABILITIES,
  BROWSER_BRIDGE_COMMANDS,
  BROWSER_BRIDGE_COMMAND_ACTION,
  BROWSER_BRIDGE_CONTROL_CAPABILITIES,
  BROWSER_BRIDGE_OBSERVATION_CAPABILITIES,
  checkBridgeFrame,
  checkBridgePageUrl,
  classifyProtectedField,
  protectedFieldRefusal,
} from '../../../core/browserext'
import { CONNECTION, T0, harness } from '../../core/browserext/harness'

/** The Device Hands browser actions this bridge maps its commands onto. */
const BROWSER_ACTIONS = [
  ...new Set(
    Object.values(BROWSER_BRIDGE_COMMAND_ACTION).filter((value): value is string => value !== null),
  ),
]

async function paired(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const outbound = await h.pair()
  if (outbound.kind !== 'pair.ok') throw new Error('pairing failed')
  return { h, token: outbound.token, sessionId: outbound.sessionId }
}

describe('the extension cannot impersonate its way in', () => {
  it('refuses a command whose transport origin is a web page, not the extension', async () => {
    const { h, sessionId } = await paired()
    const forged = await h.command(sessionId, 'session.status', {}, { origin: 'https://evil.example' })
    expect(forged.kind).toBe('refused')
    if (forged.kind === 'refused') expect(forged.code).toBe('origin-mismatch')
  })

  it('refuses an extension that declares an id other than its own origin', async () => {
    const h = harness()
    await h.pair()
    const auth = await h.auth('whatever', { extensionId: 'someotherid' })
    // The token is wrong too, but the origin/id mismatch is the property under test:
    // the host is paired with EXT_ID, so another id cannot authenticate at all.
    expect(auth.kind).toBe('refused')
  })
})

describe('replay, staleness and rebinding', () => {
  it('refuses a replayed nonce', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'session.status', {}, { nonce: 'n-fixed', seq: 1 })
    const replay = await h.command(sessionId, 'session.status', {}, { nonce: 'n-fixed', seq: 2 })
    expect(replay.kind).toBe('refused')
    if (replay.kind === 'refused') expect(replay.code).toBe('nonce-replayed')
  })

  it('refuses a stale session after its TTL', async () => {
    const { h, sessionId } = await paired()
    h.setClock(T0 + 31 * 60_000)
    const stale = await h.command(sessionId, 'session.status', {})
    expect(stale.kind).toBe('refused')
    if (stale.kind === 'refused') expect(stale.code).toBe('session-expired')
  })

  it('refuses a session lifted onto another connection', async () => {
    const { h, sessionId } = await paired()
    const other = await h.command(sessionId, 'session.status', {}, { connectionId: 'conn-2' })
    expect(other.kind).toBe('refused')
    if (other.kind === 'refused') expect(other.code).toBe('session-missing')
  })

  it('revokes every session on disconnect and lets the token reconnect', async () => {
    const { h, token, sessionId } = await paired()
    h.bridge.onDisconnect(CONNECTION)
    const afterClose = await h.command(sessionId, 'session.status', {})
    expect(afterClose.kind).toBe('refused')
    if (afterClose.kind === 'refused') expect(afterClose.code).toBe('session-revoked')
    const reauth = await h.auth(token)
    expect(reauth.kind).toBe('auth.ok')
  })

  it('refuses a command naming a different tab than the shared one', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 1, url: 'https://example.com/' })
    const mismatch = await h.command(sessionId, 'selection.read', { tabId: 2 })
    expect(mismatch.kind).toBe('refused')
    if (mismatch.kind === 'refused') expect(mismatch.code).toBe('tab-mismatch')
  })
})

describe('pages Freya must not touch', () => {
  it('refuses browser-internal and local URLs', () => {
    for (const url of ['chrome://settings', 'chrome-extension://x/y', 'file:///etc/passwd', 'view-source:https://x', 'data:text/html,x']) {
      const reading = checkBridgePageUrl(url)
      expect(reading.ok, url).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('sensitive-url')
    }
  })

  it('refuses loopback and private hosts', () => {
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://192.168.0.1/', 'http://169.254.1.1/']) {
      const reading = checkBridgePageUrl(url)
      expect(reading.ok, url).toBe(false)
    }
  })

  it('refuses a cross-origin frame and a subframe', () => {
    expect(checkBridgeFrame({ frameId: 0, topFrame: true, sameOrigin: false }).ok).toBe(false)
    expect(checkBridgeFrame({ frameId: 3, topFrame: false, sameOrigin: true }).ok).toBe(false)
  })

  it('never reads or types into a password, payment, hidden or auth field', () => {
    const descriptors = [
      { tagName: 'input', type: 'password', name: null, id: null, autocomplete: null, placeholder: null, ariaLabel: null },
      { tagName: 'input', type: 'hidden', name: 'csrf', id: null, autocomplete: null, placeholder: null, ariaLabel: null },
      { tagName: 'input', type: 'text', name: 'card_number', id: null, autocomplete: 'cc-number', placeholder: null, ariaLabel: null },
      { tagName: 'input', type: 'text', name: 'cvv', id: null, autocomplete: null, placeholder: null, ariaLabel: null },
      { tagName: 'input', type: 'text', name: 'api_token', id: null, autocomplete: null, placeholder: null, ariaLabel: null },
    ]
    for (const descriptor of descriptors) {
      expect(classifyProtectedField(descriptor), descriptor.name ?? descriptor.type ?? '').not.toBeNull()
      expect(protectedFieldRefusal(descriptor)).not.toBeNull()
    }
  })
})

describe('the extension grants nothing', () => {
  it('has no command that names a grant, a capability, a cookie or a store', () => {
    const forbidden = /grant|widen|capability|permission|cookie|storage|history|token|credential|password|screenshot|capture|download|record|watch|poll|eval|script/i
    for (const command of BROWSER_BRIDGE_COMMANDS) {
      expect(command, command).not.toMatch(forbidden)
    }
  })

  it('does not widen capabilities when a command tries to set them', async () => {
    const { h, sessionId } = await paired({ capabilities: ['page.metadata'] })
    await h.command(sessionId, 'session.status', { capabilities: ['element.click'], authority: 'owner' })
    const click = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(click.kind).toBe('refused')
    if (click.kind === 'refused') expect(click.code).toBe('capability-missing')
  })

  it('does not widen capabilities when the host denies a control request', async () => {
    const h = harness({
      capabilities: ['page.metadata', 'control.request'],
      dispatch: async (request) =>
        request.command === 'control.request'
          ? { ok: false, code: 'authority-refused', reason: 'owner declined' }
          : { ok: true, code: null, reason: 'ok' },
    })
    const outbound = await h.pair()
    if (outbound.kind !== 'pair.ok') throw new Error('pairing failed')
    const request = await h.command(outbound.sessionId, 'control.request', {})
    expect(h.okOf(request)).toBe(false)
    const click = await h.command(outbound.sessionId, 'element.click', { selector: '#go' })
    expect(click.kind).toBe('refused')
    if (click.kind === 'refused') expect(click.code).toBe('capability-missing')
  })

  it('latches STOP ALL and refuses every acting command after it', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'control.stop', {})
    expect(h.stopRequests.length).toBe(1)
    const click = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(click.kind).toBe('refused')
  })
})

describe('bounded payloads and deadlines', () => {
  it('bounds typed text, selectors and messages', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 1, url: 'https://example.com/' })
    const bigText = await h.command(sessionId, 'element.type-text', { selector: '#q', text: 'x'.repeat(513) })
    expect(bigText.kind).toBe('refused')
    const bigSelector = await h.command(sessionId, 'element.click', { selector: '#' + 'a'.repeat(300) })
    expect(bigSelector.kind).toBe('refused')
  })

  it('always dispatches to the top frame only', async () => {
    const { h, sessionId } = await paired()
    await h.command(sessionId, 'page.share', { tabId: 1, url: 'https://example.com/' })
    await h.command(sessionId, 'selection.read', {})
    expect(h.dispatches.every((request) => request.frameId === 0)).toBe(true)
  })
})

describe('regression against the Phase 35 browser vocabulary', () => {
  it('maps only to the four Device Hands browser actions', () => {
    for (const action of BROWSER_ACTIONS) {
      expect(action).toMatch(/^browser\.(navigate|read-text|click|type-text)$/)
    }
  })

  it('never maps to a capture, credential or authority action', () => {
    for (const action of BROWSER_ACTIONS) {
      expect(action).not.toMatch(/capture|screenshot|image|frame|vault|keyring|credential|grant|widen/i)
    }
  })

  it('requests the minimum Chrome permissions and no host permissions', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'extension', 'manifest.json'), 'utf8'),
    ) as { permissions: string[]; host_permissions: string[] }
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'scripting', 'storage', 'tabs'])
    expect(manifest.host_permissions).toEqual([])
    const all = JSON.stringify(manifest)
    for (const forbidden of ['<all_urls>', 'cookies', 'history', 'downloads', 'webRequest', 'nativeMessaging']) {
      expect(all).not.toContain(forbidden)
    }
  })

  it('keeps the observation and control capability sets disjoint from grants', () => {
    const all = [...BROWSER_BRIDGE_CAPABILITIES, ...BROWSER_BRIDGE_OBSERVATION_CAPABILITIES, ...BROWSER_BRIDGE_CONTROL_CAPABILITIES]
    for (const capability of all) {
      expect(capability).not.toMatch(/grant|widen|authority|permission/i)
    }
  })
})
