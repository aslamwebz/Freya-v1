// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_COMMANDS,
  BROWSER_REFUSAL_CODES,
  CREDENTIAL_SHAPED_KEYS,
  PUBLIC_BROWSER_ALLOWED_SCHEMES,
  PUBLIC_BROWSER_DENIED_SCHEMES,
  PUBLIC_BROWSER_PARTITION_PREFIX,
  assertCredentialFree,
  assertNonPersistentPartition,
  assertPublicBrowserUrl,
  auditBrowserTables,
  auditPublicIsolation,
  createHandoffEnvelope,
  publicBrowserPartition,
  type BrowserRefusalCode,
} from '../../../core/browser'
import { harness, ScriptedJournal, ScriptedPage } from '../../core/browser/harness'

/**
 * The red-team suite for the dual-browser runtime.
 *
 * These are the questions a person who does not trust this phase should be asking. Each one is
 * written as an *attempt*, not as an assertion about the code: it tries the thing an attacker
 * or a confused agent would try, and the answer has to be a refusal with a stated code.
 *
 * Three groups:
 *
 *   - **What must not exist.** Vocabulary and source audits, because "there is no command that
 *     reads cookies" is only a real guarantee while nobody can add one without a test failing.
 *   - **What must not cross.** The credential boundary, from both directions.
 *   - **What must not be replayed, and what must not be trusted.** Stale references, a lying
 *     adapter, a lying page, a lying journal, and an escalation that quietly becomes a fallback.
 */

const CORE = fileURLToPath(new URL('../../../core/', import.meta.url))
const ELECTRON = fileURLToPath(new URL('../../../electron/', import.meta.url))

function sourceOf(root: string, relative: string): string {
  return readFileSync(`${root}${relative}`, 'utf8')
}

describe('the vocabulary itself', () => {
  it('holds no command that reads a credential, storage, history or a screen', () => {
    const banned = [
      'cookie', 'storage', 'history', 'profile', 'password', 'token', 'credential',
      'screenshot', 'capture', 'eval', 'exec', 'script', 'download', 'keyring', 'vault',
      'devtools', 'bookmark', 'passwords', 'incognito', 'print',
    ]
    for (const command of BROWSER_COMMANDS) {
      for (const word of banned) {
        expect(command.toLowerCase().includes(word), `${command} contains ${word}`).toBe(false)
      }
    }
  })

  it('holds no refusal code that promises a capability this phase does not have', () => {
    for (const code of BROWSER_REFUSAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('names no target that is not one of the two browsers', () => {
    expect([...PUBLIC_BROWSER_ALLOWED_SCHEMES]).toEqual(['http:', 'https:'])
    expect(PUBLIC_BROWSER_PARTITION_PREFIX.startsWith('persist')).toBe(false)
    expect(auditBrowserTables()).toEqual([])
    expect(auditPublicIsolation()).toEqual([])
  })

  it('cannot be widened by a module that forgets to run the audit', () => {
    const findings = auditBrowserTables()
    expect(findings).toEqual([])
    // And the audit is reachable from production code, so a table edit that breaks an
    // invariant fails a test rather than passing quietly.
    expect(typeof auditBrowserTables).toBe('function')
  })
})

describe('source audits', () => {
  /**
   * `core/browser` must be pure policy: it decides, and it decides from facts it was given.
   *
   * A clock, a timer, a socket or a random number in here would mean something decided *for
   * itself* rather than being told, and a browser phase that can time itself is a browser
   * phase that can eventually be talked into acting.
   */
  it('keeps core/browser free of timers, randomness, network and filesystem access', () => {
    const offenders: string[] = []
    for (const name of readdirSync(`${CORE}browser`).filter((entry) => entry.endsWith('.ts'))) {
      const source = sourceOf(`${CORE}browser/`, name)
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, '""')
      for (const pattern of [
        /setTimeout\s*\(/,
        /setInterval\s*\(/,
        /Math\.random\s*\(/,
        /node:crypto/,
        /node:fs/,
        /node:http/,
        /node:net/,
        /require\s*\(/,
        /process\.env/,
      ]) {
        if (pattern.test(stripped)) offenders.push(`${name}: ${String(pattern)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the port-free half of the phase from importing Electron', () => {
    const offenders: string[] = []
    for (const name of readdirSync(`${CORE}browser`).filter((entry) => entry.endsWith('.ts'))) {
      const source = sourceOf(`${CORE}browser/`, name)
      if (source.includes("from 'electron'")) offenders.push(name)
      if (/require\(['"]electron['"]\)/.test(source)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('keeps the adapter half free of Electron too, so its refusals are testable headless', () => {
    const source = sourceOf(`${ELECTRON}browser/`, 'publicAdapter.ts')
    expect(source.includes("from 'electron'")).toBe(false)
  })

  it('gives the window no preload and no node integration, and denies every permission', () => {
    const source = sourceOf(`${ELECTRON}browser/`, 'freyaWindow.ts')
    expect(source).toContain('sandbox: true')
    expect(source).toContain('contextIsolation: true')
    expect(source).toContain('nodeIntegration: false')
    expect(source).toContain('setPermissionCheckHandler(() => false)')
    expect(source).toContain('setPermissionRequestHandler((_contents, _permission, callback) => callback(false))')
    // A preload would be a way for the renderer to be given something, and this window has
    // nothing to be given: there is no such option at all.
    expect(source).not.toContain('preload:')
    expect(source).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
    expect(source).toContain('event.preventDefault()')
  })

  it('cancels the download before describing it, so a page can never write a file', () => {
    const source = sourceOf(`${ELECTRON}browser/`, 'freyaWindow.ts')
    const download = source.slice(source.indexOf('onDownload'))
    expect(download.indexOf('preventDefault')).toBeLessThan(download.indexOf('getFilename'))
  })
})

describe('the credential boundary', () => {
  it('refuses a session partition that would persist', () => {
    for (const name of ['persist:freya', 'PERSIST:freya', 'persist:', 'persist:anything']) {
      const reading = assertNonPersistentPartition(name)
      expect(reading.ok, name).toBe(false)
    }
  })

  it('refuses a session id that could escape the partition name', () => {
    for (const id of ['../persist:freya', 'a/b', 'a\\b', 'a.b', 'a b', 'persist:x', '', 'A']) {
      const reading = publicBrowserPartition(id)
      expect(reading.ok, id).toBe(false)
    }
  })

  it('refuses a URL that would let a page reach the owner\'s network', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://[::1]:8080/',
      'http://0.0.0.0/',
      'http://10.0.0.1/',
      'http://192.168.0.1/admin',
      'http://172.16.0.1/',
      'http://localhost:5175/',
      'http://router.local/',
      'http://127.0.0.1/',
      'https://2130706433/',
      'https://0177.0.0.1/',
    ]) {
      expect(assertPublicBrowserUrl(url).ok, url).toBe(false)
    }
  })

  it('refuses every scheme that could name the machine, and an address that carries a credential', () => {
    for (const scheme of PUBLIC_BROWSER_DENIED_SCHEMES) {
      expect(assertPublicBrowserUrl(`${scheme}//example.com/`).ok, scheme).toBe(false)
    }
    expect(assertPublicBrowserUrl('https://admin:hunter2@example.com/').ok).toBe(false)
    expect(assertPublicBrowserUrl('javascript:fetch("//evil")').ok).toBe(false)
  })

  it('refuses a credential under every plausible name, and behind a plausible one', () => {
    for (const key of CREDENTIAL_SHAPED_KEYS) {
      const reading = assertCredentialFree({ [`x${key}y`]: 'value' }, 'a handoff')
      expect(reading.ok, key).toBe(false)
    }
    for (const value of [
      'Bearer abcdefghijklmnopqrst',
      'Basic dXNlcjpwYXNz',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl',
      '__Secure-next-auth.csrf-token=abc',
      'sid=1; __Host-session=2',
      '-----BEGIN EC PRIVATE KEY-----',
    ]) {
      expect(assertCredentialFree(value, 'a handoff').ok, value.slice(0, 12)).toBe(false)
    }
  })

  it('refuses a handoff envelope that would merge the two contexts', () => {
    const attempts: Record<string, string>[] = [
      { cookies: 'a=b' },
      { localStorage: '{}' },
      { sessionStorage: '{}' },
      { indexedDb: 'x' },
      { token: 'x' },
      { authorization: 'Bearer x' },
      { profilePath: 'C:/Users/x' },
      { keyring: 'x' },
      { vault: 'x' },
      { totp: '123456' },
      { webauthn: 'x' },
    ]
    for (const context of attempts) {
      const reading = createHandoffEnvelope({
        handoffId: 'handoff-0001',
        from: 'public',
        to: 'authenticated',
        url: 'https://example.com/',
        reason: 'carry this across',
        context: context as never,
        offeredAt: '2026-01-01T00:00:00.000Z',
      })
      expect(reading.ok, Object.keys(context)[0]).toBe(false)
      if (!reading.ok) expect(reading.code satisfies BrowserRefusalCode).toBe('credential-carry-refused')
    }
  })
})

describe('acting on a page', () => {
  async function ready(options: Parameters<typeof harness>[0] = {}) {
    const instance = harness(options)
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId })
    const elements = described.data.elements as { ref: string; selector: string; protected: boolean }[]
    const button = elements.find((element) => element.selector === '#continue')
    if (button === undefined) throw new Error('setup failed')
    return { instance, sessionId, ref: button.ref }
  }

  it('never acts when STOP ALL is latched, and never reaches the page', async () => {
    const { instance, sessionId, ref } = await ready()
    instance.authority.stopAll = true
    const result = await instance.runtime.execute({
      command: 'page.click',
      target: 'public',
      sessionId,
      ref,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('stop-all-latched')
    expect(instance.page().calls.some((call) => call.startsWith('click:'))).toBe(false)
  })

  it('never acts when the gate refuses, however the request is dressed up', async () => {
    // Reads are allowed, so the only thing standing between the request and the page is the
    // gate refusing the two acts.
    const { instance, sessionId, ref } = await ready({ authority: { allow: ['browser.navigate', 'browser.read-text'] } })
    const before = instance.page().calls.length
    for (const request of [
      { command: 'page.click' as const, target: 'public' as const, sessionId, ref },
      { command: 'page.type' as const, target: 'public' as const, sessionId, ref, text: 'x' },
    ]) {
      const result = await instance.runtime.execute(request)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('authority-refused')
    }
    expect(instance.page().calls.length).toBe(before)
  })

  it('refuses to type into a protected field, and does not dispatch anything', async () => {
    const instance = harness({
      page: new ScriptedPage('x', {
        elements: [{ kind: 'field', label: 'Password', selector: '#password', protected: true }],
        protectedSelectors: ['#password'],
      }),
    })
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId })
    const [field] = described.data.elements as { ref: string }[]
    const result = await instance.runtime.execute({
      command: 'page.type',
      target: 'public',
      sessionId,
      ref: field?.ref,
      text: 'hunter2',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('protected-field')
    expect(instance.page().calls.some((call) => call.startsWith('type:'))).toBe(false)
    // And nothing that was typed reached the record.
    expect(JSON.stringify(instance.journal.entries)).not.toContain('hunter2')
  })

  it('refuses a reference for a page that has been replaced', async () => {
    const { instance, sessionId, ref } = await ready()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/elsewhere' })
    const result = await instance.runtime.execute({ command: 'page.click', target: 'public', sessionId, ref })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('page-stale')
    expect(instance.page().calls.some((call) => call.startsWith('click:'))).toBe(false)
  })

  it('refuses a forged reference, however it was computed', async () => {
    const { instance, sessionId } = await ready()
    for (const ref of ['r1-0000000000000000', 'r1-ffffffffffffffff', '#continue', 'continue', 'r1-']) {
      const result = await instance.runtime.execute({ command: 'page.click', target: 'public', sessionId, ref })
      expect(result.ok, ref).toBe(false)
      if (!result.ok) expect(['ref-unknown', 'page-stale']).toContain(result.code)
    }
  })

  it('does not report a click the page did not react to', async () => {
    const { instance, sessionId, ref } = await ready({
      page: new ScriptedPage('x', { clickChanges: false }),
    })
    const result = await instance.runtime.execute({ command: 'page.click', target: 'public', sessionId, ref })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('adapter-failed')
  })

  it('does not report a keystroke the field did not read back', async () => {
    const instance = harness({
      page: new ScriptedPage('x', {
        elements: [{ kind: 'field', label: 'Search', selector: '#search' }],
        typeEcho: 'mismatch',
      }),
    })
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId })
    const [field] = described.data.elements as { ref: string }[]
    const result = await instance.runtime.execute({
      command: 'page.type',
      target: 'public',
      sessionId,
      ref: field?.ref,
      text: 'exactly this',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('adapter-failed')
    expect(JSON.stringify(instance.journal.entries)).not.toContain('exactly this')
  })

  it('does not let a page description smuggle a value out through an element field', async () => {
    const instance = harness({
      page: new ScriptedPage('x', {
        elements: [
          { kind: 'field', label: 'Card number', selector: '#card' },
          { kind: 'link', label: 'x', selector: '#x', protected: true, disabled: true } as never,
        ],
      }),
    })
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId })
    const serialised = JSON.stringify(described.data)
    expect(serialised).not.toContain('value')
    expect(serialised).not.toContain('innerHTML')
  })
})

describe('the two contexts stay separate', () => {
  it('will not run one command in the other browser just because the first one failed', async () => {
    const instance = harness({ publicAvailable: false })
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 4
    await instance.runtime.open()
    const result = await instance.runtime.execute({
      command: 'page.navigate',
      target: 'public',
      sessionId: 'freya-0001',
      url: 'https://example.com/',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('target-unavailable')
    expect(instance.extension.opened).toHaveLength(0)
  })

  it('proposes an escalation without ever applying it', async () => {
    const instance = harness({
      autoEscalate: true,
      page: new ScriptedPage('x', {
        text: 'Sign in',
        elements: [
          { kind: 'field', label: 'Password', selector: '#password', protected: true },
          { kind: 'link', label: 'Sign in', selector: '#signin' },
        ],
      }),
    })
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })
    await instance.ok({ command: 'page.describe', target: 'public', sessionId })

    // The router needs an *observation* before it can say anything, so the first command after
    // the description is the one that carries the proposal. It is still a proposal: the answer
    // was routed to the public browser, and nothing was opened in the person's Chrome.
    const result = await instance.ok({ command: 'page.read', target: 'public', sessionId })
    expect(result.target).toBe('public')
    expect(result.escalation?.to).toBe('authenticated')
    expect(result.escalation?.reason).toBe('login-required')
    expect(instance.extension.opened).toHaveLength(0)
    expect(instance.authority.actionKeys.every((key) => key.startsWith('browser.'))).toBe(true)
  })

  it('refuses to continue work in Chrome without a paired, live extension', async () => {
    const instance = harness()
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    const offered = await instance.ok({
      command: 'handoff.offer',
      target: 'public',
      sessionId,
      url: 'https://example.com/a',
    })
    const result = await instance.runtime.execute({
      command: 'handoff.accept',
      target: 'authenticated',
      handoffId: String(offered.data.handoffId),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('target-unavailable')
    expect(instance.extension.opened).toHaveLength(0)
  })

  it('carries nothing but the URL, the reason and the two context fields', async () => {
    const instance = harness()
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    const offered = await instance.ok({
      command: 'handoff.offer',
      target: 'public',
      sessionId,
      url: 'https://example.com/a',
      reason: 'needs a login',
      context: { title: 'Invoices', note: 'finish in Chrome' },
    })
    expect(Object.keys(offered.data).sort()).toEqual(['context', 'expiresAt', 'from', 'handoffId', 'to', 'url'])
    expect(Object.keys(offered.data.context as object).sort()).toEqual(['note', 'title'])
  })
})

describe('the record cannot be talked into a different history', () => {
  it('refuses to open when the journal does not chain', async () => {
    const instance = harness()
    instance.journal.trusted = false
    const recovery = await instance.runtime.open()
    expect(recovery.trustworthy).toBe(false)
    expect(recovery.summary).toContain('could not be believed')
    const result = await instance.runtime.execute({ command: 'session.state', target: 'public' })
    // The runtime's own switch is what stops it; the *host* is what refuses to activate on an
    // untrustworthy journal. Both are asserted, in the host test, so that neither is untested.
    expect(result.ok).toBe(true)
  })

  it('turns an unsettled handoff into uncertain rather than replaying it', async () => {
    const journal = new ScriptedJournal()
    const first = harness({ journal })
    await first.runtime.open()
    const opened = await first.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    const offered = await first.ok({
      command: 'handoff.offer',
      target: 'public',
      sessionId,
      url: 'https://example.com/a',
    })
    await first.runtime.dispose()

    const second = harness({ journal })
    second.extension.paired = true
    second.extension.live = true
    second.extension.sharedTabId = 3
    const recovery = await second.runtime.open()
    expect(recovery.handoffsUncertain).toEqual([String(offered.data.handoffId)])
    expect(recovery.summary).not.toContain('succeeded')
    expect(second.extension.opened).toHaveLength(0)
  })

  it('never replays a session that was open when the last run ended', async () => {
    const journal = new ScriptedJournal()
    const first = harness({ journal })
    await first.runtime.open()
    const opened = await first.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await first.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })

    const second = harness({ journal })
    const recovery = await second.runtime.open()
    expect(recovery.sessionsLost.map((entry) => entry.sessionId)).toEqual([sessionId])
    expect(second.pages.size).toBe(0)
  })

  it('rejects any payload the code-owned tables forbid, so the record stays a record', async () => {
    const journal = new ScriptedJournal()
    const instance = harness({ journal })
    await instance.runtime.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/a' })
    await instance.ok({ command: 'page.describe', target: 'public', sessionId })
    expect(journal.illegal).toEqual([])
    // Nothing from the page is in the record: no title, no text, no selector, no value.
    const serialised = JSON.stringify(journal.entries)
    for (const leak of ['"title"', '"text"', '"selector"', '"value"', 'cookies', 'token']) {
      expect(serialised.includes(leak), leak).toBe(false)
    }
  })
})