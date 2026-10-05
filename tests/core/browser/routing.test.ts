import { describe, expect, it } from 'vitest'
import {
  auditRoutingDefaults,
  classifyAuthenticationNeed,
  routeBrowserIntent,
  type AuthNeedObservation,
  type RoutingContext,
} from '../../../core/browser'

function context(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    publicAvailable: true,
    authenticated: { paired: true, live: true, sharedTabId: 7 },
    session: { exists: true, target: 'public', open: true },
    observed: null,
    autoEscalate: false,
    ...overrides,
  }
}

const A_DOCUMENT: AuthNeedObservation = {
  status: 200,
  url: 'https://example.com/article',
  finalUrl: 'https://example.com/article',
  textFields: 0,
  protectedFields: 0,
  signInAffordances: 0,
  textBytes: 8_000,
}

describe('authentication need', () => {
  it('passes when a page reads as a document', () => {
    expect(classifyAuthenticationNeed(A_DOCUMENT).need).toBe('none')
  })

  it('recognises a 401, a 403 and a proxy auth demand', () => {
    expect(classifyAuthenticationNeed({ ...A_DOCUMENT, status: 401 }).need).toBe('session-required')
    expect(classifyAuthenticationNeed({ ...A_DOCUMENT, status: 403 }).need).toBe('session-required')
    expect(classifyAuthenticationNeed({ ...A_DOCUMENT, status: 407 }).need).toBe('session-required')
  })

  it('recognises a sign-in form and an account address', () => {
    const wall: AuthNeedObservation = {
      status: 200,
      url: 'https://example.com/',
      finalUrl: 'https://example.com/login',
      textFields: 2,
      protectedFields: 1,
      signInAffordances: 1,
      textBytes: 180,
    }
    expect(classifyAuthenticationNeed(wall).need).toBe('login-required')
    expect(classifyAuthenticationNeed({ ...A_DOCUMENT, finalUrl: 'https://example.com/account/settings' }).need).toBe('login-required')
  })

  it('recognises a one-time-code challenge as the person\'s, not Freya\'s', () => {
    const challenge: AuthNeedObservation = {
      status: 200,
      url: 'https://example.com/',
      finalUrl: 'https://example.com/mfa/verify',
      textFields: 1,
      protectedFields: 1,
      signInAffordances: 0,
      textBytes: 100,
    }
    const reading = classifyAuthenticationNeed(challenge)
    expect(reading.need).toBe('mfa-required')
    expect(reading.detail).toContain('one-time code')
  })

  it('treats an owner-listed host as blocked before it looks at the page at all', () => {
    const reading = classifyAuthenticationNeed(
      { ...A_DOCUMENT, url: 'https://mail.example.org/', finalUrl: 'https://mail.example.org/inbox' },
      ['mail.example.org'],
    )
    expect(reading.need).toBe('site-blocked')
  })

  it('says why, in a sentence, for every answer it gives', () => {
    for (const observation of [
      A_DOCUMENT,
      { ...A_DOCUMENT, status: 401 },
      { ...A_DOCUMENT, signInAffordances: 2, textBytes: 10 },
    ]) {
      expect(classifyAuthenticationNeed(observation).detail.length).toBeGreaterThan(20)
    }
  })
})

describe('routing policy', () => {
  it('passes its own audit', () => {
    expect(auditRoutingDefaults()).toEqual([])
  })

  it('defaults to the credential-free browser, never to the person\'s', () => {
    const reading = routeBrowserIntent({ command: 'page.navigate', sessionId: 's1' }, context())
    expect(reading.ok).toBe(true)
    if (reading.ok) expect(reading.target).toBe('public')
  })

  it('honours a named target', () => {
    const reading = routeBrowserIntent({ command: 'session.state', target: 'authenticated' }, context())
    expect(reading.ok).toBe(true)
    if (reading.ok) expect(reading.target).toBe('authenticated')
  })

  it('refuses a target outside the vocabulary, including a plausible default', () => {
    for (const target of ['any', 'default', 'chrome', 'webview', '', 7, null]) {
      const reading = routeBrowserIntent({ command: 'session.state', target }, context())
      expect(reading.ok, String(target)).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('target-unknown')
    }
  })

  it('does not fall back to the other browser when the named one cannot run', () => {
    const reading = routeBrowserIntent(
      { command: 'page.navigate', target: 'public', sessionId: 's1' },
      context({ publicAvailable: false }),
    )
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.code).toBe('target-unavailable')
    expect(reading.ok).toBe(false)
  })

  it('requires the extension to be paired and live before the authenticated target exists', () => {
    const unpaired = routeBrowserIntent(
      { command: 'session.state', target: 'authenticated' },
      context({ authenticated: { paired: false, live: false, sharedTabId: null } }),
    )
    expect(unpaired.ok).toBe(false)
    if (!unpaired.ok) expect(unpaired.code).toBe('target-unavailable')
    expect(unpaired.reason).toContain('pair')

    const notLive = routeBrowserIntent(
      { command: 'session.state', target: 'authenticated' },
      context({ authenticated: { paired: true, live: false, sharedTabId: null } }),
    )
    expect(notLive.ok).toBe(false)
    if (!notLive.ok) expect(notLive.reason).toContain('not connected')
  })

  it('refuses a command that cannot exist on the target it was asked for', () => {
    const openInFreya = routeBrowserIntent(
      { command: 'handoff.accept', target: 'public', handoffId: 'handoff-0001' },
      context(),
    )
    expect(openInFreya.ok).toBe(false)
    if (!openInFreya.ok) expect(openInFreya.code).toBe('handoff-target-mismatch')

    const openInChrome = routeBrowserIntent({ command: 'session.open', target: 'authenticated' }, context())
    expect(openInChrome.ok).toBe(false)
    if (!openInChrome.ok) expect(openInChrome.code).toBe('target-unavailable')
  })

  it('refuses a command that needs a session when there is none, rather than opening one', () => {
    const reading = routeBrowserIntent(
      { command: 'page.describe', sessionId: 'missing' },
      context({ session: null }),
    )
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.code).toBe('session-unknown')
  })

  it('refuses to move work between contexts behind the caller\'s back', () => {
    const reading = routeBrowserIntent(
      { command: 'page.read', target: 'public', sessionId: 's1' },
      context({ session: { exists: true, target: 'authenticated', open: true } }),
    )
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.code).toBe('handoff-target-mismatch')
  })

  it('proposes the authenticated target only when the owner allowed a proposal, and never applies it', () => {
    const wall: AuthNeedObservation = { ...A_DOCUMENT, status: 401 }

    const off = routeBrowserIntent(
      { command: 'page.navigate', sessionId: 's1' },
      context({ observed: wall, autoEscalate: false }),
    )
    expect(off.ok).toBe(true)
    if (off.ok) {
      expect(off.escalation).toBeNull()
      expect(off.target).toBe('public')
    }

    const on = routeBrowserIntent(
      { command: 'page.navigate', sessionId: 's1' },
      context({ observed: wall, autoEscalate: true }),
    )
    expect(on.ok).toBe(true)
    if (on.ok) {
      expect(on.escalation).not.toBeNull()
      expect(on.escalation?.to).toBe('authenticated')
      // Proposed, not applied: the route is still the public browser.
      expect(on.target).toBe('public')
    }
  })

  it('never proposes an escalation for a page that read as a document', () => {
    const reading = routeBrowserIntent(
      { command: 'page.navigate', sessionId: 's1' },
      context({ observed: A_DOCUMENT, autoEscalate: true }),
    )
    expect(reading.ok).toBe(true)
    if (reading.ok) expect(reading.escalation).toBeNull()
  })

  it('refuses a request that is not an object, or names a command outside the vocabulary', () => {
    for (const intent of [null, [], 'page.navigate', 42, {}, { command: 'browser.eval' }, { command: 'page.screenshot' }]) {
      const reading = routeBrowserIntent(intent, context())
      expect(reading.ok, JSON.stringify(intent)).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('request-malformed')
    }
  })
})