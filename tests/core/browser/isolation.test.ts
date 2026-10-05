import { describe, expect, it } from 'vitest'
import {
  BROWSER_TARGETS,
  PUBLIC_BROWSER_DENIED_PERMISSIONS,
  PUBLIC_BROWSER_DENIED_SCHEMES,
  PUBLIC_BROWSER_PARTITION_PREFIX,
  assertCredentialFree,
  assertNonPersistentPartition,
  assertPublicBrowserUrl,
  auditBrowserTables,
  auditPublicIsolation,
  boundHandoffText,
  bytesOf,
  isBrowserTarget,
  publicBrowserPartition,
} from '../../../core/browser'

describe('phase 51 tables', () => {
  it('passes every audit', () => {
    expect(auditBrowserTables()).toEqual([])
    expect(auditPublicIsolation()).toEqual([])
  })

  it('routes exactly two targets, and neither is a synonym for the other', () => {
    expect([...BROWSER_TARGETS]).toEqual(['public', 'authenticated'])
    expect(isBrowserTarget('public')).toBe(true)
    expect(isBrowserTarget('authenticated')).toBe(true)
    for (const invented of ['any', 'default', 'chrome', 'firefox', 'system', 'webview', '']) {
      expect(isBrowserTarget(invented), invented).toBe(false)
    }
  })
})

describe('public browser isolation', () => {
  it('names an in-memory partition and refuses a persistent one', () => {
    const reading = publicBrowserPartition('freya-0001')
    expect(reading.ok).toBe(true)
    if (reading.ok) {
      expect(reading.partition).toBe(`${PUBLIC_BROWSER_PARTITION_PREFIX}freya-0001`)
      expect(reading.partition.startsWith('persist:')).toBe(false)
    }
    const persistent = assertNonPersistentPartition('persist:freya')
    expect(persistent.ok).toBe(false)
    if (!persistent.ok) expect(persistent.code).toBe('partition-persistent')
  })

  it('refuses a session id that is not already a safe token, rather than repairing it', () => {
    for (const id of ['', 'Freya-0001', 'freya 0001', 'freya/0001', '../escape', 'a'.repeat(65), 42, null]) {
      const reading = publicBrowserPartition(id as string)
      expect(reading.ok, String(id)).toBe(false)
    }
  })

  it('refuses a partition name with a path separator', () => {
    for (const name of ['a/b', 'a\\b', 'a..b', '', 'x'.repeat(200)]) {
      expect(assertNonPersistentPartition(name).ok, name).toBe(false)
    }
  })

  it('opens http and https, and nothing that can name the machine', () => {
    expect(assertPublicBrowserUrl('https://example.com/a').ok).toBe(true)
    expect(assertPublicBrowserUrl('http://example.com/a').ok).toBe(true)
    for (const url of [
      'file:///C:/secret.txt',
      'data:text/html,<h1>x</h1>',
      'javascript:alert(1)',
      'view-source:https://example.com',
      'chrome://settings',
      'devtools://devtools/x.html',
      'ws://example.com/socket',
      'shell:open',
    ]) {
      const reading = assertPublicBrowserUrl(url)
      expect(reading.ok, url).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('url-refused')
    }
  })

  it('refuses loopback, private and reserved addresses, and a URL that carries a credential', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', 'router.local', 'intranet']) {
      expect(assertPublicBrowserUrl(`http://${host}/`).ok, host).toBe(false)
    }
    expect(assertPublicBrowserUrl('https://user:pass@example.com/').ok).toBe(false)
    expect(assertPublicBrowserUrl('https://example.com:8443/').ok).toBe(false)
  })

  it('applies the owner host allowlist rather than a second list of its own', () => {
    expect(assertPublicBrowserUrl('https://other.com/', { allowedHosts: ['example.com'] }).ok).toBe(false)
    expect(assertPublicBrowserUrl('https://example.com/', { allowedHosts: ['example.com'] }).ok).toBe(true)
  })

  it('returns the normalised address, so a caller cannot act on the string it passed in', () => {
    const reading = assertPublicBrowserUrl('HTTPS://Example.COM/a#frag')
    expect(reading.ok).toBe(true)
    if (reading.ok) expect(reading.url).toBe('https://example.com/a#frag')
    // A URL with surrounding whitespace is refused rather than trimmed: two different
    // callers must not end up on two different addresses from one request.
    expect(assertPublicBrowserUrl(' https://example.com/ ').ok).toBe(false)
  })

  it('denies every permission it names, and names the ones that matter', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'display-capture', 'pointerLock']) {
      expect(PUBLIC_BROWSER_DENIED_PERMISSIONS, permission).toContain(permission)
    }
  })

  it('never lets a denied scheme also be an allowed one', () => {
    for (const scheme of PUBLIC_BROWSER_DENIED_SCHEMES) {
      expect(['http:', 'https:'], scheme).not.toContain(scheme)
    }
  })
})

describe('cross-context credential refusal', () => {
  it('refuses a key that names a credential, a session or storage', () => {
    for (const key of ['cookies', 'setCookie', 'authHeader', 'sessionStorage', 'localStorage', 'password', 'apiKey', 'totp', 'mfa', 'vaultKey', 'profilepath']) {
      const reading = assertCredentialFree({ [key]: 'anything' }, 'a handoff')
      expect(reading.ok, key).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('credential-carry-refused')
    }
  })

  it('refuses a credential-shaped value behind an innocent key', () => {
    const values = [
      '__Secure-sid=abc123',
      '__Host-session=1',
      'Authorization: Bearer abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijkl',
      '-----BEGIN RSA PRIVATE KEY-----',
    ]
    for (const value of values) {
      expect(assertCredentialFree({ note: value }, 'a handoff').ok, value.slice(0, 20)).toBe(false)
      expect(assertCredentialFree(value, 'a handoff').ok, value.slice(0, 20)).toBe(false)
    }
  })

  it('looks inside arrays and nested objects, not just at the top level', () => {
    expect(assertCredentialFree({ items: [{ deep: { cookies: 'a=b' } }] }, 'a handoff').ok).toBe(false)
    expect(assertCredentialFree({ a: [{ b: 'Authorization: Bearer zzzzzzzzz' }] }, 'a handoff').ok).toBe(false)
  })

  it('refuses a value that is not a scalar at all', () => {
    expect(assertCredentialFree({ thing: (() => 1) as unknown }, 'a handoff').ok).toBe(false)
  })

  it('allows the ordinary things a handoff legitimately carries', () => {
    const reading = assertCredentialFree(
      { title: 'Your monthly invoice', note: 'this page needs a login', count: 3, flag: true, nothing: null },
      'a handoff',
    )
    expect(reading.ok).toBe(true)
  })

  it('bounds free text on a character boundary and reports the same shape', () => {
    const bounded = boundHandoffText('héllo wörld', 6)
    expect(bounded.ok).toBe(true)
    if (bounded.ok) expect(bytesOf(bounded.text ?? '')).toBeLessThanOrEqual(6)
    expect(boundHandoffText(42 as unknown, 100).ok).toBe(false)
    expect(boundHandoffText(null, 100).ok).toBe(true)
  })
})