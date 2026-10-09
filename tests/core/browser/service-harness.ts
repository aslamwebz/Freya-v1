// @vitest-environment node
import {
  createDualBrowserRuntime,
  type BrowserAuthenticatedPort,
  type BrowserEventType,
  type BrowserJournalPort,
  type BrowserPayload,
  type BrowserAdapterPort,
  type BrowserRequest,
  type BrowserResult,
  type DualBrowserRuntime,
} from '../../../core/browser'
import { createBrowserService, type BrowserService, type BrowserServiceState } from '../../../core/browser/service'
import type { BrowserSurfacePort, SurfaceBounds, SurfaceSnapshot, SurfaceTabReading } from '../../../core/browser/service'
import type { BrowserPortOutcome, BrowserPortRequest, DeviceHandsActionKey } from '../../../core/devicehands'

/**
 * A Core-free harness for the Browser Service.
 *
 * It reaches no window, no Electron and no network. The surface is a plain object whose
 * readings the test writes, the routed runtime is the real one over a scripted adapter, and
 * the journal validates every payload against the code-owned tables — so a refusal is proved
 * by a counter that did not move and an effect by the same counter moving once.
 *
 * The surface is fake on purpose. It is the seam the whole architecture exists to make
 * substitutable: a Browser Relay surface would drive tabs in a person's own Chrome through
 * exactly this port, and a test that can swap the surface proves that.
 */

/* -------------------------------------------------------------- scripted pages */

export interface ScriptedElement {
  readonly kind: string
  readonly label: string
  readonly selector: string
  readonly protected?: boolean
  readonly disabled?: boolean
  readonly options?: readonly string[]
}

export interface ScriptedPageOptions {
  readonly url?: string | null
  readonly title?: string | null
  readonly text?: string
  readonly elements?: readonly ScriptedElement[]
  /** Whether a click is reported as having changed the page. */
  readonly clickChanges?: boolean
  /** What a control's name reads as, for the delete and authentication hints. */
  readonly destructiveSelector?: string
  /** Force the next navigation to land nowhere, to reproduce the empty-URL failure. */
  readonly navigateLandsNowhere?: boolean
  /** Force the next navigation to fail outright. */
  readonly failNextNavigate?: boolean
  /** Force every navigation to fail, so a failure can be scripted without a first call. */
  readonly alwaysFailNavigate?: boolean
}

export class ScriptedSurfacePage {
  readonly calls: string[] = []
  revision = 0
  url: string | null
  title: string | null
  text: string
  elements: readonly ScriptedElement[]
  loading = false
  error: string | null = null
  clickChanges: boolean
  failNextNavigate = false
  alwaysFailNavigate = false
  navigateLandsNowhere = false
  scrollTop = 0
  /** The document height the scripted scroll reports. 0 models an unsized view. */
  scrollHeight = 4_000
  readonly listeners = new Set<(reading: SurfaceTabReading) => void>()

  constructor(readonly sessionId: string, options: ScriptedPageOptions = {}) {
    this.url = options.url ?? null
    this.title = options.title ?? 'Scripted page'
    this.text = options.text ?? 'A page with a heading and a button.'
    this.elements = options.elements ?? [
      { kind: 'heading', label: 'Example', selector: 'h1' },
      { kind: 'link', label: 'Contact', selector: '#contact' },
      { kind: 'button', label: 'Continue', selector: '#continue' },
      { kind: 'field', label: 'Search', selector: '#search' },
    ]
    this.clickChanges = options.clickChanges ?? true
    if (options.navigateLandsNowhere === true) this.navigateLandsNowhere = true
    if (options.failNextNavigate === true) this.failNextNavigate = true
    if (options.alwaysFailNavigate === true) this.alwaysFailNavigate = true
  }

  private emit(): SurfaceTabReading {
    const reading: SurfaceTabReading = {
      sessionId: this.sessionId,
      url: this.url,
      title: this.title,
      revision: this.revision,
      loading: this.loading,
      canGoBack: false,
      canGoForward: false,
      error: this.error,
    }
    for (const listener of [...this.listeners]) listener(reading)
    return reading
  }

  /** Move the page on its own, the way a link click inside a page would. */
  drift(url: string): SurfaceTabReading {
    this.revision += 1
    this.url = url
    return this.emit()
  }

  async navigate(url: string): Promise<{ ok: boolean; finalUrl: string | null; code: string }> {
    this.calls.push(`navigate:${url}`)
    if (this.failNextNavigate || this.alwaysFailNavigate) {
      this.failNextNavigate = false
      this.error = 'navigate-failed'
      this.revision += 1
      this.url = null
      this.emit()
      return { ok: false, finalUrl: null, code: 'navigate-failed' }
    }
    this.revision += 1
    if (this.navigateLandsNowhere) {
      // The exact shape that started all of this: Electron reported a load and the page
      // reported no address at all.
      this.url = ''
      this.emit()
      return { ok: true, finalUrl: null, code: 'navigated' }
    }
    this.url = url
    this.loading = false
    this.error = null
    // A real window reports its own navigation. Emitting here is what makes the harness
    // faithful rather than convenient: history, loading and canGoBack are all driven by
    // these pushes, and a harness that swallowed them would test a fiction.
    this.emit()
    return { ok: true, finalUrl: url, code: 'navigated' }
  }

  async describe(): Promise<{ ok: boolean; payload: unknown; code: string }> {
    this.calls.push('describe')
    return { ok: true, payload: this.elements, code: 'described' }
  }

  async read(): Promise<{ ok: boolean; text: string; bytes: number; code: string }> {
    this.calls.push('read')
    return { ok: true, text: this.text, bytes: this.text.length, code: 'read' }
  }

  async click(selector: string): Promise<{ ok: boolean; changed: boolean; protectedKind: string | null; code: string }> {
    this.calls.push(`click:${selector}`)
    return { ok: true, changed: this.clickChanges, protectedKind: null, code: 'clicked' }
  }

  async type(selector: string, text: string): Promise<{ ok: boolean; changed: boolean; readBack: string | null; protectedKind: string | null; code: string }> {
    this.calls.push(`type:${selector}`)
    return { ok: true, changed: true, readBack: text, protectedKind: null, code: 'typed' }
  }

  inspect(): Promise<{ ok: boolean; field: null; code: string }> {
    return Promise.resolve({ ok: true, field: null, code: 'inspected' })
  }

  async snapshot(): Promise<{ ok: boolean; payload: SurfaceSnapshot | null; code: string }> {
    this.calls.push('snapshot')
    if (this.url === null) return { ok: false, payload: null, code: 'page-missing' }
    return {
      ok: true,
      payload: {
        url: this.url,
        title: this.title,
        revision: this.revision,
        text: this.text,
        truncated: false,
        elements: this.elements.map((entry) => ({
          kind: entry.kind === 'link' || entry.kind === 'button' || entry.kind === 'field' || entry.kind === 'heading' || entry.kind === 'text' ? entry.kind : 'text',
          name: entry.label,
          selector: entry.selector,
          disabled: entry.disabled === true,
          protected: entry.protected === true,
          destructive: entry.label === 'Delete account',
          ...(entry.options === undefined ? {} : { options: entry.options }),
        })),
      },
      code: 'snapshot',
    }
  }

  async scroll(request: { kind: 'top' | 'bottom' | 'delta' | 'fraction'; amount?: number }): Promise<{ ok: boolean; top: number; height: number; code: string }> {
    this.calls.push(`scroll:${request.kind}`)
    const height = this.scrollHeight
    this.scrollTop = request.kind === 'top' ? 0 : request.kind === 'bottom' ? height : request.kind === 'fraction' ? Math.round(height * (request.amount ?? 0)) : this.scrollTop + (request.amount ?? 0)
    return { ok: true, top: Math.max(0, Math.min(height, this.scrollTop)), height, code: 'scrolled' }
  }

  async select(selector: string, index: number): Promise<{ ok: boolean; selected: string | null; code: string }> {
    this.calls.push(`select:${selector}:${String(index)}`)
    const element = this.elements.find((entry) => entry.selector === selector)
    const option = element?.options?.[index] ?? null
    return { ok: option !== null, selected: option, code: option === null ? 'request-malformed' : 'selected' }
  }

  async reload(): Promise<{ ok: boolean; finalUrl: string | null; code: string }> {
    this.calls.push('reload')
    return { ok: this.url !== null, finalUrl: this.url, code: 'reloaded' }
  }

  async wait(request: { settleMs: number; until?: string }): Promise<{ ok: boolean; settled: boolean; url: string | null; code: string }> {
    this.calls.push(`wait:${request.until ?? 'settle'}`)
    return { ok: true, settled: true, url: this.url, code: 'settled' }
  }
}

/* ------------------------------------------------------------------- surface */

export interface ScriptedSurfaceOptions {
  readonly available?: boolean
  readonly create?: (sessionId: string) => ScriptedSurfacePage
}

/**
 * A surface with no native view and no Electron.
 *
 * `dock` answers false, which is the honest answer for a surface with nothing to place — and
 * it is what lets these tests run without a window while still exercising every protocol
 * operation above the port.
 */
export function createScriptedSurface(options: ScriptedSurfaceOptions = {}): {
  readonly port: BrowserSurfacePort
  readonly pages: Map<string, ScriptedSurfacePage>
  readonly dockCalls: { sessionId: string | null; bounds: SurfaceBounds | null }[]
} {
  const pages = new Map<string, ScriptedSurfacePage>()
  const dockCalls: { sessionId: string | null; bounds: SurfaceBounds | null }[] = []
  const listeners = new Set<(reading: SurfaceTabReading) => void>()
  const create = options.create ?? ((sessionId: string) => new ScriptedSurfacePage(sessionId))

  function emit(reading: SurfaceTabReading): void {
    for (const listener of [...listeners]) listener(reading)
  }

  function fail(code: string, reason: string): { ok: false; code: string; reason: string } {
    return { ok: false, code, reason }
  }

  const port: BrowserSurfacePort = {
    kind: 'embedded',
    available: () => options.available !== false,
    openTabs: () => [...pages.keys()].sort(),
    async open(request) {
      const existing = pages.get(request.sessionId)
      if (existing !== undefined) return { ok: true, value: readingOf(existing) }
      const page = create(request.sessionId)
      page.listeners.add(emit)
      pages.set(request.sessionId, page)
      if (request.url !== '') await page.navigate(request.url)
      const reading = readingOf(page)
      emit(reading)
      return { ok: true, value: reading }
    },
    async close(sessionId) {
      pages.delete(sessionId)
      emit({ sessionId, url: null, title: null, revision: 0, loading: false, canGoBack: false, canGoForward: false, error: 'closed' })
      return { ok: true, value: Object.freeze({ closed: true }) }
    },
    async navigate(sessionId, url) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      await page.navigate(url)
      emit(readingOf(page))
      return { ok: true, value: Object.freeze({ accepted: true }) }
    },
    async reload(sessionId) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      await page.reload()
      return { ok: true, value: Object.freeze({ accepted: true }) }
    },
    async observe(sessionId) {
      const page = pages.get(sessionId)
      return page === undefined ? fail('tab-unknown', 'no page') : { ok: true, value: readingOf(page) }
    },
    async snapshot(sessionId) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      const taken = await page.snapshot()
      if (!taken.ok || taken.payload === null) return fail(taken.code, 'no snapshot')
      return { ok: true, value: taken.payload }
    },
    async click(sessionId, selector) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      const done = await page.click(selector)
      return done.ok ? { ok: true, value: Object.freeze({ changed: done.changed }) } : fail(done.code, 'no click')
    },
    async type(sessionId, selector, text) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      const done = await page.type(selector, text)
      return done.ok ? { ok: true, value: Object.freeze({ changed: done.changed }) } : fail(done.code, 'no type')
    },
    async select(sessionId, selector, index) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      const done = await page.select(selector, index)
      return done.ok ? { ok: true, value: Object.freeze({ selected: done.selected }) } : fail(done.code, 'no select')
    },
    async scroll(sessionId, request) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      const done = await page.scroll(request)
      return { ok: true, value: Object.freeze({ top: done.top, height: done.height }) }
    },
    async screenshot(sessionId) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      // The harness has no real engine; a screenshot is a 1x1 transparent PNG that
      // tests can still inspect for the bytes they expect, and the URL is stable.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
      return { ok: true, value: Object.freeze({
        png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
        mediaUrl: `freya-browser://screenshot/${encodeURIComponent(sessionId)}/0.png`,
        width: 1, height: 1, revision: 0, url: page.url ?? '', title: page.title ?? '',
      }) }
    },
    async wait(sessionId, request) {
      const page = pages.get(sessionId)
      if (page === undefined) return fail('tab-unknown', 'no page')
      const done = await page.wait(request)
      return { ok: true, value: Object.freeze({ settled: done.settled, url: done.url }) }
    },
    dock(sessionId, bounds) {
      dockCalls.push({ sessionId, bounds })
      return false
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async dispose() {
      pages.clear()
      listeners.clear()
    },
  }

  function readingOf(page: ScriptedSurfacePage): SurfaceTabReading {
    return {
      sessionId: page.sessionId,
      url: page.url === '' ? null : page.url,
      title: page.title,
      revision: page.revision,
      loading: page.loading,
      canGoBack: false,
      canGoForward: false,
      error: page.error,
    }
  }

  return { port, pages, dockCalls }
}

/* -------------------------------------------------------------------- ports */

/**
 * The authority port, standing in for the whole of Device Hands below it.
 *
 * The real seam is `coreHost.performDeviceHandsAction`, which walks ten gates and only then
 * hands the action to the effect, which reaches the adapter. Modelling all of that here would
 * be a second Device Hands implementation, so this stands in for **the whole stack**: it
 * decides whether the action is permitted, and if it is, drives the adapter exactly the way
 * the effect does — building a `BrowserPortRequest` from the action input and calling
 * `performBrowser`.
 *
 * That is what makes a refusal here meaningful. `refuseWith` is a gate refusing and the
 * adapter is never called; a `failed` verdict with the adapter reporting nothing is a page
 * that did nothing. Those are different answers and the service must keep them apart.
 */
export class ScriptedAuthority {
  readonly calls: { readonly actionKey: DeviceHandsActionKey; readonly input: Readonly<Record<string, unknown>> }[] = []
  stopAll = false
  /** Set to a code to make every gate refuse. */
  refuseWith: string | null = null
  /** Set to a verdict to make the gate hold while the page does nothing. */
  verdict: 'passed' | 'failed' | 'unverified' = 'passed'
  /** Installed by the harness: the effect's reach into the adapter. */
  effect: ((request: BrowserPortRequest) => Promise<BrowserPortOutcome>) | null = null

  async perform(request: {
    readonly actionId: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Readonly<Record<string, unknown>>
    readonly deadlineAt: string
  }): Promise<{
    readonly performed: boolean
    readonly verdict: 'passed' | 'failed' | 'unverified'
    readonly code: string | null
    readonly reason: string
  }> {
    this.calls.push({ actionKey: request.actionKey, input: request.input })
    if (this.refuseWith !== null) {
      return { performed: false, verdict: 'failed', code: this.refuseWith, reason: `refused by ${this.refuseWith}` }
    }
    if (this.effect === null) {
      return { performed: true, verdict: this.verdict, code: null, reason: '' }
    }
    const reached = await this.effect({
      actionId: request.actionId,
      url: typeof request.input.url === 'string' ? request.input.url : '',
      selector: typeof request.input.selector === 'string' ? request.input.selector : null,
      text: typeof request.input.text === 'string' ? request.input.text : null,
      deadlineAt: request.deadlineAt,
    })
    if (!reached.holds) {
      return { performed: true, verdict: 'failed', code: reached.code, reason: 'the page did not do it' }
    }
    return { performed: true, verdict: this.verdict, code: null, reason: '' }
  }

  /** The keys the gates were asked for, in order. The spine of most assertions here. */
  actionKeys(): readonly DeviceHandsActionKey[] {
    return this.calls.map((call) => call.actionKey)
  }
}

export class ScriptedJournal {
  readonly entries: { readonly type: BrowserEventType; readonly payload: BrowserPayload }[] = []
  readonly types: BrowserEventType[] = []
  trustworthy = true

  async append(type: BrowserEventType, payload: BrowserPayload): Promise<void> {
    this.entries.push({ type, payload })
    this.types.push(type)
  }

  async replay(): Promise<readonly unknown[]> {
    return this.entries.map((entry) => ({ type: entry.type, payload: entry.payload }))
  }
}

function authenticatedPort(): BrowserAuthenticatedPort {
  return {
    status: () => ({ paired: false, live: false, sharedTabId: null }),
    openHandoff: () => Promise.resolve({ ok: false, code: 'target-unavailable', reason: 'no extension', tabId: null }),
  }
}

/* ----------------------------------------------------------------- harness */

export interface Harness {
  readonly service: BrowserService
  readonly runtime: DualBrowserRuntime
  readonly authority: ScriptedAuthority
  readonly journal: ScriptedJournal
  readonly pages: Map<string, ScriptedSurfacePage>
  readonly dockCalls: { sessionId: string | null; bounds: SurfaceBounds | null }[]
  /** Resolves when the routed runtime has reconciled. Every command awaits it. */
  ready(): Promise<void>
  /** Run a command and throw if it refused, so a test reads as an assertion. */
  ok(request: Parameters<BrowserService['run']>[0]): Promise<{ readonly op: string; readonly data: Readonly<Record<string, unknown>> }>
  /** Run a command and assert it refused with a code. */
  refused(request: Parameters<BrowserService['run']>[0], code: string): Promise<{ readonly reason: string }>
  state(): BrowserServiceState
  page(sessionId: string): ScriptedSurfacePage
  tab(sessionId: string): { readonly tabId: string; readonly status: string } | null
}

export interface HarnessOptions extends ScriptedSurfaceOptions {
  readonly journalTrustworthy?: boolean
  readonly maxTabs?: number
  readonly active?: boolean
}

export function harness(options: HarnessOptions = {}): Harness {
  const authority = new ScriptedAuthority()
  const journal = new ScriptedJournal()
  journal.trustworthy = options.journalTrustworthy !== false
  const surface = createScriptedSurface(options)
  let counter = 0
  const contexts = new Map<string, { readonly sessionId: string; readonly command: string }>()
  const observed = new Map<string, { readonly revision: number; readonly url: string | null; readonly title?: string | null; readonly elements?: unknown; readonly text?: string; readonly changed?: boolean; readonly fieldValue?: string | null }>()
  function stash(actionId: string, value: { readonly revision: number; readonly url: string | null; readonly title?: string | null; readonly elements?: unknown; readonly text?: string; readonly changed?: boolean; readonly fieldValue?: string | null }): void {
    observed.set(actionId, value)
  }

  // The adapter, hoisted, because the authority's effect reaches into it. Written here
  // rather than inline so both halves of the production chain — the routed runtime above, the
  // effect below — are visible in one place rather than split across a closure.
  const adapter: BrowserAdapterPort = {
    begin(sessionId, actionId, context) {
      contexts.set(actionId, { sessionId, command: context.command })
    },
    abandon(actionId) {
      contexts.delete(actionId)
    },
    takeObserved(actionId) {
      const stashed = observed.get(actionId)
      observed.delete(actionId)
      return stashed ?? null
    },
    async performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome> {
      const context = contexts.get(request.actionId)
      const page = context === undefined ? undefined : surface.pages.get(context.sessionId)
      if (page === undefined || context === undefined) {
        return { holds: false, evidence: 'observed', code: 'session-closed', finalUrl: null, textBytes: 0 }
      }
      const selector = request.selector
      if (selector !== null && request.text !== null) {
        const typed = await page.type(selector, request.text)
        stash(request.actionId, { revision: page.revision, url: page.url, changed: typed.changed, fieldValue: typed.readBack })
        return { holds: typed.changed, evidence: 'observed', code: typed.code, finalUrl: page.url, textBytes: 0 }
      }
      if (selector !== null) {
        const clicked = await page.click(selector)
        stash(request.actionId, { revision: page.revision, url: page.url, changed: clicked.changed })
        return { holds: clicked.changed, evidence: 'observed', code: clicked.code, finalUrl: page.url, textBytes: 0 }
      }
      // A read. Only `page.navigate` moves the page — a describe of a live page reads *that*
      // page, and re-navigating to the recorded URL would quietly put the page behind the
      // owner's back every time something asked what was on it.
      if (context.command === 'page.navigate') {
        const navigated = await page.navigate(request.url)
        if (!navigated.ok || navigated.finalUrl === null) {
          return { holds: false, evidence: 'observed', code: navigated.code, finalUrl: null, textBytes: 0 }
        }
      }
      const described = await page.describe()
      stash(request.actionId, { revision: page.revision, url: page.url, title: page.title, elements: described.payload, text: page.text })
      return { holds: true, evidence: 'observed', code: 'observed', finalUrl: page.url, textBytes: page.text.length }
    },
  }

  // What Device Hands would do once every gate had passed.
  authority.effect = async (request) => await adapter.performBrowser(request)

  const runtime = createDualBrowserRuntime({
    authority: {
      stopAllActive: () => authority.stopAll,
      perform: (request) => authority.perform(request),
      activeGrant: () => null,
    },
    adapter,
    sessions: {
      openSession: () => Promise.resolve(),
      closeSession: () => Promise.resolve(),
      publicAvailable: () => options.available !== false,
    },
    authenticated: authenticatedPort(),
    journal: {
      append: (type, payload) => journal.append(type, payload),
      replay: () => journal.replay(),
      trustworthy: () => journal.trustworthy,
    } satisfies BrowserJournalPort,
    clockMs: () => 1_700_000_000_000,
    newId: () => {
      counter += 1
      return `act-${String(counter).padStart(6, '0')}`
    },
    ...(options.maxTabs === undefined ? {} : { limits: { maxSessions: options.maxTabs } }),
  })

  // The routed runtime reconciles before it acts, exactly as the activation does. Calling it
  // here is what a host does at startup, and skipping it is why an early `session.open` would
  // be refused with `subsystem-disabled`.
  const activation: { opened: Promise<unknown> } = { opened: Promise.resolve(null) }

  const service = createBrowserService({
    surface: surface.port,
    commands: {
      execute: async (request: BrowserRequest): Promise<BrowserResult> =>
        await runtime.execute(request, { origin: 'owner', createdBy: 'user' }),
      active: () => options.active !== false,
    },
    clockMs: () => 1_700_000_000_000,
    newId: () => {
      counter += 1
      return `t${String(counter)}`
    },
    record: async (type, payload) => {
      await journal.append(type, payload)
    },
  })
  service.trust(journal.trustworthy)

  activation.opened = runtime.open()

  return {
    service,
    runtime,
    authority,
    journal,
    pages: surface.pages,
    dockCalls: surface.dockCalls,
    /** The activation has reconciled. Awaited by every command a test runs. */
    ready: () => activation.opened.then(() => undefined),
    async ok(request) {
      await activation.opened
      const result = await service.run(request)
      if (!result.ok) throw new Error(`expected success for ${result.op}, refused with ${result.code}: ${result.reason}`)
      return result as { readonly op: string; readonly data: Readonly<Record<string, unknown>> }
    },
    async refused(request, code) {
      await activation.opened
      const result = await service.run(request)
      if (result.ok) throw new Error(`expected refusal ${code}, but ${result.op} succeeded`)
      if (result.code !== code) throw new Error(`expected refusal ${code}, got ${result.code}: ${result.reason}`)
      return result
    },
    state: () => service.state(),
    page(sessionId) {
      const page = surface.pages.get(sessionId)
      if (page === undefined) throw new Error(`no page for ${sessionId}`)
      return page
    },
    tab(sessionId) {
      const found = service.tabs().find((tab) => tab.sessionId === sessionId)
      return found === undefined ? null : { tabId: found.tabId, status: found.status }
    },
  }
}

/** Run a request and read its result without asserting anything about it. */
export async function run(h: Harness, request: Parameters<BrowserService['run']>[0]): ReturnType<BrowserService['run']> {
  return await h.service.run(request)
}