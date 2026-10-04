import { describe, expect, it } from 'vitest'
import {
  checkBridgeFrame,
  checkBridgePageUrl,
  classifyProtectedField,
  isPrivateOrLocalHost,
  isProtectedField,
  truncateUtf8,
  utf8Bytes,
} from '../../../core/browserext'

describe('page URL safety', () => {
  it('allows only http and https', () => {
    expect(checkBridgePageUrl('https://example.com/a').ok).toBe(true)
    expect(checkBridgePageUrl('http://example.com/a').ok).toBe(true)
    for (const url of [
      'chrome://settings',
      'chrome-extension://abc/page.html',
      'edge://flags',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'file:///C:/secret.txt',
      'view-source:https://example.com',
      'data:text/html,<h1>x</h1>',
      'blob:https://example.com/uuid',
      'javascript:alert(1)',
      'ftp://example.com/file',
    ]) {
      const reading = checkBridgePageUrl(url)
      expect(reading.ok, url).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('sensitive-url')
    }
  })

  it('refuses a URL that carries a credential rather than stripping it', () => {
    const reading = checkBridgePageUrl('https://user:pass@example.com/')
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.code).toBe('sensitive-url')
  })

  it('refuses loopback, private and link-local hosts by default', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '[::1]', 'router.local', 'intranet']) {
      expect(isPrivateOrLocalHost(host), host).toBe(true)
      const reading = checkBridgePageUrl(`http://${host}/`)
      expect(reading.ok, host).toBe(false)
    }
    expect(isPrivateOrLocalHost('example.com')).toBe(false)
  })

  it('permits a private host only when the owner has explicitly enabled it', () => {
    const reading = checkBridgePageUrl('http://127.0.0.1:8080/', { allowPrivateHosts: true })
    expect(reading.ok).toBe(true)
  })

  it('enforces a host allowlist when one is supplied', () => {
    const reading = checkBridgePageUrl('https://other.com/', { allowedHosts: ['example.com'] })
    expect(reading.ok).toBe(false)
    const allowed = checkBridgePageUrl('https://example.com/', { allowedHosts: ['example.com'] })
    expect(allowed.ok).toBe(true)
  })
})

describe('frame safety', () => {
  it('refuses subframes and cross-origin frames', () => {
    expect(checkBridgeFrame({ frameId: 0, topFrame: true, sameOrigin: true }).ok).toBe(true)
    const sub = checkBridgeFrame({ frameId: 1, topFrame: false, sameOrigin: true })
    expect(sub.ok).toBe(false)
    if (!sub.ok) expect(sub.code).toBe('not-top-frame')
    const cross = checkBridgeFrame({ frameId: 0, topFrame: true, sameOrigin: false })
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.code).toBe('cross-origin-frame')
  })
})

describe('protected fields', () => {
  const field = (overrides: Partial<Parameters<typeof classifyProtectedField>[0]>) => ({
    tagName: 'input',
    type: null,
    name: null,
    id: null,
    autocomplete: null,
    placeholder: null,
    ariaLabel: null,
    ...overrides,
  })

  it('protects password, hidden, payment and one-time-code fields', () => {
    expect(classifyProtectedField(field({ type: 'password' }))).toBe('password')
    expect(classifyProtectedField(field({ type: 'hidden' }))).toBe('hidden')
    expect(classifyProtectedField(field({ autocomplete: 'cc-number' }))).toBe('payment-card')
    expect(classifyProtectedField(field({ autocomplete: 'cc-csc' }))).toBe('payment-cvc')
    expect(classifyProtectedField(field({ autocomplete: 'one-time-code' }))).toBe('one-time-code')
    expect(classifyProtectedField(field({ name: 'user_password' }))).toBe('password')
    expect(classifyProtectedField(field({ id: 'card-number' }))).toBe('payment-card')
    expect(classifyProtectedField(field({ name: 'cvv' }))).toBe('payment-card')
    expect(classifyProtectedField(field({ name: 'api_token' }))).toBe('authentication')
  })

  it('leaves ordinary search and text fields alone', () => {
    expect(isProtectedField(field({ type: 'text', name: 'q' }))).toBe(false)
    expect(isProtectedField(field({ type: 'search', id: 'site-search' }))).toBe(false)
    expect(isProtectedField(field({ type: 'email', name: 'email' }))).toBe(false)
  })
})

describe('text bounds', () => {
  it('measures and truncates on code-point boundaries', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('😀')).toBe(4)
    const truncated = truncateUtf8('😀😀😀', 6)
    expect(utf8Bytes(truncated)).toBeLessThanOrEqual(6)
    expect(truncated).toBe('😀')
  })
})
