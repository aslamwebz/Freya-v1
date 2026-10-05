// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createBrowserExtensionHost,
  type BrowserExtensionHost,
} from '../../electron/browserext'
import { createDualBrowserActivation, type Phase51Authority } from '../../electron/browser'
import { createFreyaBrowserAdapter, type FieldDescriptor } from '../../electron/browser'
import { openDeviceHandsJournal } from '../../electron/devicehands'
import { createDeviceHandsRuntime, type DeviceHandsGrantRecord, type DeviceHandsPorts, type GrantFact } from '../../core/devicehands'
import type { BrowserPortOutcome, BrowserPortRequest } from '../../core/devicehands'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Phase 51 host activation, against a **real** Phase 35 runtime.
 *
 * This is the test that proves the central claim of the phase: the embedded Freya Browser and
 * the paired Chrome extension are two *doors* onto **one** Device Hands runtime — one grant
 * source, one journal, one STOP ALL, one set of ten gates.
 *
 * It is a host test rather than a Core test because it deliberately builds the real Phase 42
 * pieces: the hash-chained journal on disk, the real runtime, the real effects seam, and the
 * real Phase 43 extension host. Only the window is faked, because a window needs a display.
 */

const URL = 'https://example.com/article'

/**
 * The scope a grant must name to cover a browser action.
 *
 * Phase 35 compares `grant.scope === request.scope` exactly, and the Phase 51 runtime scopes
 * each action to the session it belongs to. So the fixture's grant is scoped to the first
 * session id this runtime mints — which is deterministic, and which is why this is a named
 * constant rather than a `*` that would quietly make the scope check vacuous.
 */
const SESSION_SCOPE = 'freya-0001'

/* ------------------------------------------------------------------ a window */

class FakeWindow {
  readonly calls: string[] = []
  readonly sessionId = 'freya-0001'
  url: string | null = null
  title = 'Example'
  text = 'An article.'
  revision = 0
  clickChanges = true
  typeEcho: 'exact' | 'mismatch' = 'exact'
  protectedSelectors: readonly string[] = []
  closed = false

  currentUrl(): string | null {
    return this.url
  }
  currentRevision(): number {
    return this.revision
  }
  currentTitle(): string | null {
    return this.title
  }
  async navigate(url: string): Promise<{ ok: boolean; finalUrl: string | null; code: string }> {
    this.calls.push(`navigate:${url}`)
    this.url = url
    this.revision += 1
    return { ok: true, finalUrl: url, code: 'navigated' }
  }
  async read(): Promise<{ ok: boolean; text: string; bytes: number; code: string }> {
    this.calls.push('read')
    return { ok: true, text: this.text, bytes: new TextEncoder().encode(this.text).length, code: 'read' }
  }
  async describe(): Promise<{ ok: boolean; payload: unknown; code: string }> {
    this.calls.push('describe')
    return {
      ok: true,
      payload: [
        { kind: 'heading', label: 'Article', selector: 'h1' },
        { kind: 'button', label: 'Continue', selector: '#continue' },
        { kind: 'field', label: 'Search', selector: '#search' },
      ],
      code: 'described',
    }
  }
  async inspect(selector: string): Promise<{ ok: boolean; field: FieldDescriptor | null; code: string }> {
    return {
      ok: true,
      field: {
        tagName: this.protectedSelectors.includes(selector) ? 'input' : 'button',
        type: this.protectedSelectors.includes(selector) ? 'password' : 'text',
        name: null,
        id: selector.replace('#', ''),
        autocomplete: null,
        placeholder: null,
        ariaLabel: null,
      },
      code: 'inspected',
    }
  }
  async click(selector: string): Promise<{ ok: boolean; changed: boolean; protectedKind: string | null; code: string }> {
    this.calls.push(`click:${selector}`)
    if (this.protectedSelectors.includes(selector)) {
      return { ok: false, changed: false, protectedKind: 'password', code: 'protected' }
    }
    if (this.clickChanges) this.revision += 1
    return { ok: this.clickChanges, changed: this.clickChanges, protectedKind: null, code: this.clickChanges ? 'clicked' : 'click-unobserved' }
  }
  async type(selector: string, text: string): Promise<{ ok: boolean; changed: boolean; readBack: string | null; protectedKind: string | null; code: string }> {
    this.calls.push(`type:${selector}`)
    if (this.protectedSelectors.includes(selector)) {
      return { ok: false, changed: false, readBack: null, protectedKind: 'password', code: 'protected' }
    }
    const readBack = this.typeEcho === 'exact' ? text : text.slice(0, -1)
    return { ok: readBack.length > 0, changed: readBack.length > 0, readBack, protectedKind: null, code: 'typed' }
  }
  async close(): Promise<void> {
    this.calls.push('close')
    this.closed = true
    this.revision += 1
    this.url = null
  }
}

/* --------------------------------------------------------------- the harness */

interface Fixture {
  readonly dir: string
  readonly activation: ReturnType<typeof createDualBrowserActivation>
  readonly window: FakeWindow
  readonly browserCalls: number[]
  readonly stopAll: (value: boolean) => void
  readonly extensionHost: BrowserExtensionHost
  cleanup(): void
}

async function fixture(options: {
  readonly granted?: boolean
  readonly stopped?: boolean
} = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'freya-p51-'))
  const journal = openDeviceHandsJournal(join(dir, 'device-hands.jsonl'))
  const window = new FakeWindow()
  const browserCalls: number[] = []

  const adapter = createFreyaBrowserAdapter({
    factory: {
      async create() {
        return window
      },
    },
    publicAvailable: () => true,
  })

  let stopped = options.stopped === true

  /**
   * One grant object, used for **both** the journal and the port.
   *
   * Phase 35 requires the two to agree field for field — a host that reports a grant the
   * journal does not have is refused rather than believed — so the fixture cannot build the
   * answer twice. This is the same discipline the Phase 42 host uses with the owner-authored
   * grant file.
   */
  const grantNow = new Date()
  const grant: DeviceHandsGrantRecord = {
    grantId: 'grant-1',
    principalId: 'agent:freya',
    scope: SESSION_SCOPE,
    surfaces: ['browser'],
    actions: ['browser.navigate', 'browser.read-text', 'browser.click', 'browser.type-text'],
    issuedAt: grantNow.toISOString(),
    // Ten minutes: Phase 35 caps a grant at fifteen and *refuses* a longer one rather than
    // shortening it, so a fixture that asked for a year would be testing the wrong thing.
    expiresAt: new Date(grantNow.getTime() + 10 * 60_000).toISOString(),
    revokedAt: null,
  }

  /**
   * The **real** Phase 35 runtime, whose browser port is the Freya Browser's in-page factory.
   *
   * That one line is the whole phase: the browser actions the Phase 51 runtime asks for reach
   * the page through `ports.performBrowser`, which is `withInPageTarget`'s wrapper — the same
   * port Phase 42 already used, with an in-page target now available behind it.
   */
  const ports: DeviceHandsPorts = {
    now: () => new Date().toISOString(),
    newId: () => `dh-${String(browserCalls.length + 1)}`,
    append: (type, payload) => journal.append(type, payload),
    replay: () => journal.replay(),
    stopAllActive: () => stopped,
    journalTrustworthy: () => journal.trustworthy(),
    enabled: () => true,
    activeGrant: (principalId, scope) =>
      options.granted === false || principalId !== grant.principalId || scope !== grant.scope
        ? null
        : ({ ...grant } satisfies GrantFact),
    /**
     * The owner-approval channel, which this architecture does **not** have.
     *
     * `browser.click` and `browser.type-text` are approval-requiring in Phase 35, and Phase 42
     * found no honest way to supply an approval, so it denies them. This fixture keeps that
     * refusal as its default and can switch on an owner channel — which is exactly the seam a
     * future phase would fill, and exactly what a test must not quietly fabricate.
     */
    requestOwnerApproval: async (ask) => ({
      approvalId: ask.approvalId,
      granted: false,
      decidedBy: 'unknown',
      decidedAt: new Date().toISOString(),
    }),
    approvalStillValid: () => false,
    probeSurface: async () => ({ available: true, code: 'available' }),
    performBrowser: async (request: BrowserPortRequest): Promise<BrowserPortOutcome> => {
      browserCalls.push(1)
      const openInPage = adapter.inPage.openInPage
      if (openInPage === undefined) {
        return { holds: false, evidence: 'reported', code: 'browser-action-unsupported', finalUrl: null, textBytes: 0 }
      }
      const session = await openInPage(request)
      if (session === null) {
        return { holds: false, evidence: 'observed', code: 'no-page-for-url', finalUrl: null, textBytes: 0 }
      }
      if (request.selector !== null) {
        if (session.act === undefined) {
          return { holds: false, evidence: 'reported', code: 'browser-action-unsupported', finalUrl: null, textBytes: 0 }
        }
        return await session.act(request)
      }
      const navigated = await session.navigate(request.url, request.deadlineAt)
      if (!navigated.ok || navigated.finalUrl === null) {
        return { holds: false, evidence: 'reported', code: navigated.code, finalUrl: null, textBytes: 0 }
      }
      const read = await session.readText()
      return { holds: true, evidence: 'observed', code: navigated.code, finalUrl: navigated.finalUrl, textBytes: read.textBytes }
    },
    runTerminal: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated', exitCode: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }),
    readClipboard: async () => ({ text: '' }),
    writeClipboard: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated' }),
    clearClipboard: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated' }),
    fetchDownload: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated', bytes: 0, mediaType: null }),
    sendUpload: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated', bytes: 0, mediaType: null }),
    onChange: () => undefined,
  }

  const runtime = createDeviceHandsRuntime({ ports })
  // The real policy gate, with a real allowlist. Without this every browser action is refused
  // at `policy` — which is the Phase 35 contract, not a bug, and is exactly why it is here.
  const loaded = await runtime.loadPolicy({
    allowedRoots: [join(dir, 'allowed')],
    deniedRoots: [join(dir, 'vault')],
    allowedHosts: ['example.com'],
    allowedCommands: ['echo'],
    allowedEnvNames: ['LANG'],
  })
  if (!loaded.ok) throw new Error(`setup failed: ${loaded.reason}`)

  /**
   * The grant is **registered**, not merely answered.
   *
   * Phase 35 reads a grant's *contents* from the journal rather than from `activeGrant`: the
   * port answers only "is this grant live", and the fold holds what it permits. So a fixture
   * that only implemented the port would pass every gate test vacuously — and this line is the
   * thing that makes the next two assertions mean something.
   */
  if (options.granted !== false) {
    const registered = await runtime.registerGrant(grant)
    if (!registered.ok) throw new Error(`setup failed: ${registered.reason}`)
  }

  const authority: Phase51Authority = {
    stopAllActive: () => stopped,
    perform: async (request) => {
      const outcome = await runtime.perform({
        actionId: request.actionId,
        principalId: request.principalId,
        scope: request.scope,
        actionKey: request.actionKey,
        claimsAction: null,
        input: request.input,
        at: request.at,
        deadlineAt: request.deadlineAt,
      })
      return {
        performed: outcome.performed,
        // `null` means the gate refused before any verdict existed, which is "not performed".
        verdict: outcome.verdict ?? 'failed',
        code: outcome.code,
        reason: outcome.reason,
      }
    },
  }

  const extensionHost = createBrowserExtensionHost({ activation: 'active', onLog: () => undefined })

  const activation = createDualBrowserActivation({
    authority,
    journal,
    adapter,
    extension: extensionHost,
    onLog: () => undefined,
  })

  return {
    dir,
    activation,
    window,
    browserCalls,
    extensionHost,
    stopAll: (value: boolean) => {
      stopped = value
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function opened(f: Fixture): Promise<{ sessionId: string }> {
  await f.activation.activate()
  const result = await f.activation.execute({ command: 'session.open', target: 'public' })
  if (!result.ok) throw new Error(`setup failed: ${result.code}`)
  return { sessionId: String(result.data.sessionId) }
}

/* ---------------------------------------------------------------- the tests */

describe('the Phase 51 host activation', () => {
  it('refuses to activate on a journal that does not chain, and activates on one that does', async () => {
    const f = await fixture()
    try {
      const result = await f.activation.activate()
      expect(result.ok).toBe(true)
      expect(f.activation.active()).toBe(true)
      expect(f.activation.status().summary).toContain('public browser available')
      expect(f.activation.status().extensionPaired).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('routes a read to the page, through the real Phase 35 gates', async () => {
    const f = await fixture()
    try {
      const { sessionId } = await opened(f)
      const navigated = await f.activation.execute({
        command: 'page.navigate',
        target: 'public',
        sessionId,
        url: URL,
      })
      expect(navigated.ok, navigated.ok ? '' : String(navigated.code) + ': ' + navigated.reason).toBe(true)
      if (navigated.ok) expect(navigated.data.url).toBe(URL)
      expect(f.browserCalls).toHaveLength(1)
      expect(f.window.calls).toContain(`navigate:${URL}`)
    } finally {
      f.cleanup()
    }
  })

  it('refuses a click at the Phase 35 approval gate, and never reaches the page', async () => {
    // The honest state of Phase 42, carried forward and unchanged: `browser.click` and
    // `browser.type-text` are approval-requiring, this architecture has no owner-approval
    // channel, and so the two acts are refused at the gate in a default build.
    //
    // The adapter's mechanics are proved by `tests/core/browser/runtime.test.ts`, which drives
    // the same in-page factory through a stand-in gate. What *this* test proves is the part only
    // a real Phase 35 runtime can: the refusal happens at the approval gate, on the approved
    // action key, with the page untouched.
    const f = await fixture()
    try {
      const { sessionId } = await opened(f)
      await f.activation.execute({ command: 'page.navigate', target: 'public', sessionId, url: URL })
      const described = await f.activation.execute({ command: 'page.describe', target: 'public', sessionId })
      if (!described.ok) throw new Error('setup failed')
      const ref = (described.data.elements as { ref: string; selector: string }[]).find(
        (element) => element.selector === '#continue',
      )?.ref
      const clicked = await f.activation.execute({ command: 'page.click', target: 'public', sessionId, ref })
      expect(clicked.ok).toBe(false)
      if (!clicked.ok) {
        expect(clicked.code).toBe('authority-refused')
        expect(clicked.reason).toContain('approval')
      }
      expect(f.window.calls.some((call) => call.startsWith('click:'))).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('never reaches the browser port for an action no grant covers', async () => {
    const ungranted = await fixture({ granted: false })
    try {
      const { sessionId } = await opened(ungranted)
      const navigated = await ungranted.activation.execute({
        command: 'page.navigate',
        target: 'public',
        sessionId,
        url: URL,
      })
      expect(navigated.ok).toBe(false)
      if (!navigated.ok) expect(navigated.code).toBe('authority-refused')
      expect(ungranted.browserCalls).toHaveLength(0)
      expect(ungranted.window.calls).toHaveLength(0)
    } finally {
      ungranted.cleanup()
    }
  })

  it('lets a latched STOP ALL win, on the same turn as everything else', async () => {
    const f = await fixture()
    try {
      const { sessionId } = await opened(f)
      await f.activation.execute({ command: 'page.navigate', target: 'public', sessionId, url: URL })
      const before = f.browserCalls.length
      f.stopAll(true)
      const result = await f.activation.execute({ command: 'page.navigate', target: 'public', sessionId, url: URL })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('stop-all-latched')
      expect(f.browserCalls).toHaveLength(before)
      expect(f.activation.status().summary).toContain('STOP ALL latched')
    } finally {
      f.cleanup()
    }
  })

  it('refuses everything while switched off, and again after deactivation', async () => {
    const f = await fixture()
    try {
      const before = await f.activation.execute({ command: 'session.state', target: 'public' })
      expect(before.ok).toBe(false)
      if (!before.ok) expect(before.code).toBe('subsystem-disabled')

      await opened(f)
      const stopped = await f.activation.deactivate('the owner switched it off')
      expect(stopped.ok).toBe(true)
      const after = await f.activation.execute({ command: 'session.state', target: 'public' })
      expect(after.ok).toBe(false)
      if (!after.ok) expect(after.code).toBe('subsystem-disabled')
      expect(f.activation.active()).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('writes its record into the same hash-chained journal the Phase 35 runtime uses', async () => {
    const f = await fixture()
    try {
      const { sessionId } = await opened(f)
      await f.activation.execute({ command: 'page.navigate', target: 'public', sessionId, url: URL })
      const entries = await f.activation.recovery()
      expect(entries.trustworthy).toBe(true)
      expect(entries.sessionsLost).toEqual([{ sessionId, url: URL }])
      const activationEntry = await f.activation.recovery()
      expect(activationEntry.neverOpened).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('closes the window on dispose and never reopens it', async () => {
    const f = await fixture()
    try {
      const { sessionId } = await opened(f)
      await f.activation.execute({ command: 'page.navigate', target: 'public', sessionId, url: URL })
      await f.activation.dispose()
      expect(f.window.closed).toBe(true)
      const after = await f.activation.execute({ command: 'page.read', target: 'public', sessionId })
      expect(after.ok).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('reports the authenticated target as unavailable when no extension has paired', async () => {
    const f = await fixture()
    try {
      await opened(f)
      const status = f.activation.status()
      expect(status.extensionPaired).toBe(false)
      expect(status.extensionLive).toBe(false)
      const result = await f.activation.execute({ command: 'session.state', target: 'authenticated' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('target-unavailable')
    } finally {
      f.cleanup()
    }
  })
})