import {
  browserPayloadIsValid,
  createDualBrowserRuntime,
  type BrowserAuthenticatedPort,
  type BrowserEventType,
  type BrowserJournalPort,
  type BrowserObservation,
  type BrowserPayload,
  type BrowserRequest,
  type BrowserResult,
  type DualBrowserRuntime,
} from '../../../core/browser'
import type { BrowserPortOutcome, BrowserPortRequest, DeviceHandsActionKey, GrantFact } from '../../../core/devicehands'
import { createFreyaBrowserAdapter, type FreyaBrowserAdapter, type FreyaBrowserPage, type FreyaBrowserPageFactory } from '../../../electron/browser'

/**
 * A Core-free harness for the dual-browser runtime.
 *
 * It reaches no window, no Electron and no socket. The `FreyaBrowserPage` is a plain object
 * whose fields the test writes, the authority port counts its calls and returns a scripted
 * verdict, and the journal records what it was asked to append — so a refusal is proved by a
 * counter that did not move and an effect by the same counter moving once.
 *
 * The journal fake is *strict*: every payload is validated against
 * `browserPayloadIsValid` before it is stored, so a test cannot accidentally pass by
 * journalling page content that the code-owned table forbids.
 */

/* ------------------------------------------------------------------ the page */

export interface ScriptedElement {
  readonly kind: string
  readonly label: string
  readonly selector: string
  readonly protected?: boolean
  readonly disabled?: boolean
}

export interface ScriptedPageOptions {
  /** What a click does. `no-change` is the honest answer for a dead button. */
  readonly clickChanges?: boolean
  /** What the field reads back after typing. `mismatch` is the lying-adapter case. */
  readonly typeEcho?: 'exact' | 'mismatch' | 'unchanged'
  /** Selectors the page will report as protected, whatever the page claims. */
  readonly protectedSelectors?: readonly string[]
  readonly url?: string
  readonly text?: string
  readonly elements?: readonly ScriptedElement[]
}

/**
 * A Freya Browser window the test drives.
 *
 * Every method answers with a code rather than throwing, and every one records that it was
 * called, because most of the interesting assertions here are "this must not have happened".
 */
export class ScriptedPage implements FreyaBrowserPage {
  readonly calls: string[] = []
  revision = 0
  url: string | null
  title: string | null = 'Example'
  text: string
  elements: readonly ScriptedElement[]
  clickChanges: boolean
  typeEcho: 'exact' | 'mismatch' | 'unchanged'
  readonly protectedSelectors: readonly string[]
  closed = false
  failNext = new Set<string>()

  constructor(readonly sessionId: string, options: ScriptedPageOptions = {}) {
    this.url = options.url ?? null
    this.text = options.text ?? 'A page with a heading and a button.'
    this.elements = options.elements ?? [
      { kind: 'heading', label: 'Example', selector: 'h1' },
      { kind: 'button', label: 'Continue', selector: '#continue' },
      { kind: 'field', label: 'Search', selector: '#search', },
    ]
    this.clickChanges = options.clickChanges ?? true
    this.typeEcho = options.typeEcho ?? 'exact'
    this.protectedSelectors = options.protectedSelectors ?? []
  }

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
    if (this.failNext.has('navigate')) {
      this.failNext.delete('navigate')
      return { ok: false, finalUrl: null, code: 'navigate-failed' }
    }
    this.url = url
    this.revision += 1
    return { ok: true, finalUrl: url, code: 'navigated' }
  }

  async read(): Promise<{ ok: boolean; text: string; bytes: number; code: string }> {
    this.calls.push('read')
    if (this.failNext.has('read')) {
      this.failNext.delete('read')
      return { ok: false, text: '', bytes: 0, code: 'read-failed' }
    }
    return { ok: true, text: this.text, bytes: new TextEncoder().encode(this.text).length, code: 'read' }
  }

  async describe(): Promise<{ ok: boolean; payload: unknown; code: string }> {
    this.calls.push('describe')
    if (this.failNext.has('describe')) {
      this.failNext.delete('describe')
      return { ok: false, payload: null, code: 'describe-failed' }
    }
    return { ok: true, payload: this.elements, code: 'described' }
  }

  async inspect(selector: string): Promise<{ ok: boolean; field: FieldLike | null; code: string }> {
    this.calls.push(`inspect:${selector}`)
    const protectedField = this.protectedSelectors.includes(selector)
    const element = this.elements.find((entry) => entry.selector === selector)
    return {
      ok: true,
      field: {
        tagName: element?.kind === 'field' ? 'input' : 'button',
        type: protectedField ? 'password' : 'text',
        name: element?.label ?? null,
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
    const readBack = this.typeEcho === 'exact' ? text : this.typeEcho === 'unchanged' ? null : text.slice(0, -1)
    if (readBack !== null && readBack.length > 0) this.revision += 1
    return { ok: readBack !== null, changed: readBack !== null, readBack, protectedKind: null, code: 'typed' }
  }

  async close(): Promise<void> {
    this.calls.push('close')
    this.closed = true
    this.revision += 1
    this.url = null
  }
}

interface FieldLike {
  readonly tagName: string
  readonly type: string | null
  readonly name: string | null
  readonly id: string | null
  readonly autocomplete: string | null
  readonly placeholder: string | null
  readonly ariaLabel: string | null
}

/* ----------------------------------------------------------------- the ports */

export interface AuthorityCall {
  readonly actionId: string
  readonly actionKey: DeviceHandsActionKey
  readonly scope: string
  readonly input: Readonly<Record<string, unknown>>
}

export interface AuthorityScript {
  /** Which action keys pass. Anything not listed is refused. */
  readonly allow?: readonly DeviceHandsActionKey[]
  readonly verdict?: 'passed' | 'failed' | 'unverified'
  readonly code?: string | null
  readonly reason?: string
  /** When true the port answers `passed` but stashes nothing, to exercise the contradiction. */
  readonly silent?: boolean
}

/**
 * The Phase 35 stand-in for the Device Hands runtime.
 *
 * It mirrors what the real runtime does on the way to an effect, which is the part that
 * matters for these tests: it walks the gates, and **only then** calls the browser port. A
 * refusal therefore never reaches the page, and an authorisation always does — and both are
 * proved by the page's own call log rather than by a return value.
 */
export class ScriptedAuthority {
  readonly calls: AuthorityCall[] = []
  stopAll = false
  script: AuthorityScript = { allow: ['browser.navigate', 'browser.read-text', 'browser.click', 'browser.type-text'] }
  grant: GrantFact | null = null
  /** Set by the harness once the adapter exists. This is the Device Hands browser port. */
  browserPort: ((request: BrowserPortRequest) => Promise<BrowserPortOutcome>) | null = null

  stopAllActive(): boolean {
    return this.stopAll
  }

  async perform(request: {
    readonly actionId: string
    readonly principalId: string
    readonly scope: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Readonly<Record<string, unknown>>
    readonly at: string
    readonly deadlineAt: string
  }): Promise<{ performed: boolean; verdict: 'passed' | 'failed' | 'unverified'; code: string | null; reason: string }> {
    this.calls.push({ actionId: request.actionId, actionKey: request.actionKey, scope: request.scope, input: request.input })
    const allowed = this.script.allow ?? []
    if (!allowed.includes(request.actionKey)) {
      return { performed: false, verdict: 'failed', code: 'grant-missing', reason: 'No grant covers that action.' }
    }
    const verdict = this.script.verdict ?? 'passed'
    // Downstream of the gates: this is where the real runtime reaches its browser port.
    if (verdict === 'passed' && this.browserPort !== null && this.script.silent !== true) {
      const outcome = await this.browserPort({
        actionId: request.actionId,
        url: String(request.input.url ?? ''),
        selector: typeof request.input.selector === 'string' ? request.input.selector : null,
        text: typeof request.input.text === 'string' ? request.input.text : null,
        deadlineAt: request.deadlineAt,
      })
      if (!outcome.holds) {
        return { performed: true, verdict: 'failed', code: outcome.code, reason: 'The browser did not do what was asked.' }
      }
    }
    return {
      performed: true,
      verdict,
      code: this.script.code ?? null,
      reason: this.script.reason ?? 'Every gate held.',
    }
  }

  activeGrant(): GrantFact | null {
    return this.grant
  }

  /** The keys asked for, in order. */
  get actionKeys(): readonly DeviceHandsActionKey[] {
    return this.calls.map((call) => call.actionKey)
  }
}

/** An in-memory journal that refuses to store a payload the tables forbid. */
export class ScriptedJournal implements BrowserJournalPort {
  readonly entries: { type: string; payload: BrowserPayload }[] = []
  readonly illegal: { type: string; payload: BrowserPayload }[] = []
  trusted = true
  appendFails = false

  async append(type: BrowserEventType, payload: BrowserPayload): Promise<void> {
    if (!browserPayloadIsValid(type, payload)) {
      this.illegal.push({ type, payload })
      throw new Error('illegal payload')
    }
    if (this.appendFails) throw new Error('the record could not be written')
    this.entries.push({ type, payload })
  }

  async replay(): Promise<readonly unknown[]> {
    return this.entries
  }

  trustworthy(): boolean {
    return this.trusted
  }

  /** The recorded event types, in order. */
  get types(): readonly string[] {
    return this.entries.map((entry) => entry.type)
  }
}

/** The extension side, and the one tab it is willing to continue work in. */
export class ScriptedExtension {
  paired = false
  live = false
  sharedTabId: number | null = null
  readonly opened: { url: string; deadlineAt: string }[] = []
  failNext = false

  status(): { paired: boolean; live: boolean; sharedTabId: number | null } {
    return { paired: this.paired, live: this.live, sharedTabId: this.sharedTabId }
  }

  async openHandoff(request: { handoffId: string; url: string; deadlineAt: string }): Promise<{ ok: boolean; code: string; reason: string; tabId: number | null }> {
    this.opened.push({ url: request.url, deadlineAt: request.deadlineAt })
    if (this.failNext) {
      this.failNext = false
      return { ok: false, code: 'extension-error', reason: 'The extension did not answer.', tabId: null }
    }
    return { ok: true, code: 'opened', reason: 'The extension opened the URL in the shared tab.', tabId: this.sharedTabId }
  }
}

/* -------------------------------------------------------------- the assembly */

export interface HarnessOptions {
  readonly page?: ScriptedPage
  readonly authority?: AuthorityScript
  readonly autoEscalate?: boolean
  readonly allowedHosts?: readonly string[]
  readonly journal?: ScriptedJournal
  readonly trusted?: boolean
  readonly publicAvailable?: boolean
  readonly start?: number
  readonly maxSessions?: number
  readonly handoffTtlMs?: number
}

export interface Harness {
  readonly runtime: DualBrowserRuntime
  readonly adapter: FreyaBrowserAdapter
  readonly authority: ScriptedAuthority
  readonly extension: ScriptedExtension
  readonly journal: ScriptedJournal
  readonly pages: Map<string, ScriptedPage>
  readonly partitions: Map<string, string>
  /** The page for a session id, or the first page. */
  page(sessionId?: string): ScriptedPage
  /** Run one command and assert nothing was refused. */
  ok(request: BrowserRequest): Promise<{ ok: true; data: Readonly<Record<string, unknown>> } & BrowserResult>
  /** Run one command and assert it was refused with `code`. */
  refused(request: BrowserRequest, code: string): Promise<BrowserResult>
  open(): Promise<void>
  sessionId(): string
}

let idCounter = 0

export function harness(options: HarnessOptions = {}): Harness {
  const pages = new Map<string, ScriptedPage>()
  const partitions = new Map<string, string>()
  const authority = new ScriptedAuthority()
  if (options.authority !== undefined) authority.script = options.authority
  const journal = options.journal ?? new ScriptedJournal()
  if (options.trusted !== false) journal.trusted = true
  const extension = new ScriptedExtension()
  const clock = options.start ?? 1_800_000_000_000
  const available = options.publicAvailable ?? true

  const factory: FreyaBrowserPageFactory = {
    async create(sessionId, partition) {
      partitions.set(sessionId, partition)
      const page = options.page ?? new ScriptedPage(sessionId)
      pages.set(sessionId, page)
      return page
    },
  }

  // The adapter is the real one, built over the scripted factory, so the refusal logic in
  // `electron/browser/publicAdapter.ts` is what these tests exercise rather than a copy.
  const adapter = createFreyaBrowserAdapter({
    factory,
    publicAvailable: () => available,
    now: () => clock,
  })

  const authenticatedPort: BrowserAuthenticatedPort = {
    status: () => extension.status(),
    openHandoff: (request) => extension.openHandoff(request),
  }

  // The authority reaches the browser through the adapter's **in-page** factory, which is the
  // same door the production wiring uses: `openInPage` on the Phase 35 `DeviceBrowserFactory`.
  // These tests therefore exercise the real round trip rather than a private shortcut.
  authority.browserPort = async (request) => {
    const openInPage = adapter.inPage.openInPage
    if (openInPage === undefined) {
      return { holds: false, evidence: 'reported', code: 'browser-action-unsupported', finalUrl: null, textBytes: 0 }
    }
    const session = await openInPage(request)
    if (session === null) return { holds: false, evidence: 'observed', code: 'no-page-for-url', finalUrl: null, textBytes: 0 }
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
  }

  const runtime = createDualBrowserRuntime({
    authority: {
      stopAllActive: () => authority.stopAllActive(),
      perform: (request) => authority.perform(request),
      activeGrant: () => authority.activeGrant(),
    },
    adapter,
    sessions: adapter,
    authenticated: authenticatedPort,
    journal,
    clockMs: () => clock,
    newId: () => {
      idCounter += 1
      return `act-${String(idCounter).padStart(6, '0')}`
    },
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.autoEscalate === undefined ? {} : { autoEscalate: options.autoEscalate }),
    ...(options.maxSessions === undefined && options.handoffTtlMs === undefined
      ? {}
      : {
          limits: {
            ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
            ...(options.handoffTtlMs === undefined ? {} : { handoffTtlMs: options.handoffTtlMs }),
          },
        }),
  })

  const instance: Harness = {
    runtime,
    adapter,
    authority,
    extension,
    journal,
    pages,
    partitions,
    page(sessionId) {
      const first = sessionId === undefined ? [...pages.values()][0] : pages.get(sessionId)
      if (first === undefined) throw new Error('no page has been opened yet')
      return first
    },
    async ok(request) {
      const result = await runtime.execute(request)
      if (!result.ok) throw new Error(`expected success, refused with ${result.code}: ${result.reason}`)
      return result as { ok: true; data: Readonly<Record<string, unknown>> } & BrowserResult
    },
    async refused(request, code) {
      const result = await runtime.execute(request)
      if (result.ok) throw new Error(`expected refusal ${code}, but it succeeded`)
      if (result.code !== code) throw new Error(`expected refusal ${code}, got ${result.code}: ${result.reason}`)
      return result
    },
    async open() {
      await runtime.open()
    },
    sessionId() {
      const first = [...pages.keys()][0]
      if (first === undefined) throw new Error('no session has been opened yet')
      return first
    },
  }
  void clock
  return instance
}

/** The stashed observation a `passed` action produced, for the tests that need to look. */
export function observationFrom(value: unknown): BrowserObservation | null {
  return typeof value === 'object' && value !== null ? (value as BrowserObservation) : null
}

/** An outcome the adapter reports, for a test that wants to assert the port's shape. */
export function outcome(overrides: Partial<BrowserPortOutcome> = {}): BrowserPortOutcome {
  return { holds: true, evidence: 'observed', code: 'ok', finalUrl: 'https://example.com/', textBytes: 0, ...overrides }
}

/** The request a port receives, for a test that wants to assert the port's shape. */
export function portRequest(overrides: Partial<BrowserPortRequest> = {}): BrowserPortRequest {
  return {
    actionId: 'act-000001',
    url: 'https://example.com/',
    selector: null,
    text: null,
    deadlineAt: '2026-01-01T00:00:15.000Z',
    ...overrides,
  }
}