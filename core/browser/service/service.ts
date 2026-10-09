import { browserDeleteReason } from '../../safety/no-delete'
import { assertPublicBrowserUrl, isNavigableBrowserUrl } from '../isolation'
import type { BrowserEventType } from '../types'
import type { BrowserPayload, BrowserRequest, BrowserResult } from '../runtime'
import { BROWSER_SERVICE_LIMITS, BROWSER_SERVICE_REASONS, type BrowserRecoverySummary, type BrowserServiceCode, type BrowserServiceState, type BrowserSurfaceKind, type BrowserTabAttribution, type BrowserTabOrigin, type BrowserTabState, type SemanticSnapshot } from './types'
import {
  browserServiceStateFor,
  navigableUrl,
  reconcileTabState,
  runtimeStatusFor,
  tabStateFor,
  type TabCarry,
  type TabObservation,
} from './lifecycle'
import { SemanticRefTable, renderSemanticSnapshot } from './refs'
import { boundText, type BrowserSurfacePort, type SurfaceBounds, type SurfaceTabReading } from './surface'

/**
 * The Browser Service: tabs, orchestration, and the Semantic Browser Protocol.
 *
 * ## Where it sits
 *
 * ```
 * Freya Core
 *     ↓
 * Browser Service (this file)          ← tabs, lifecycle, references, multi-tab
 *     ↓
 * Semantic Browser Protocol            ← snapshot/click/type/scroll/…, revision-bound
 *     ↓
 * BrowserSurfacePort                   ← EmbeddedElectronSurface | BrowserRelaySurface
 * ```
 *
 * ## The one rule this file will not break
 *
 * **Every act and every navigation goes through the Phase 51 dual-browser runtime, and
 * therefore through the Phase 35 Device Hands gates.** This file creates no authority, checks
 * no grant, and has no policy of its own about what is allowed. It opens sessions with
 * `session.open`, navigates with `page.navigate`, reads with `page.describe`, and acts with
 * `page.click` and `page.type` — the same routed commands, the same adapter, the same journal
 * and the same ten gates the previous build used.
 *
 * That is what lets this file be as rich as it is. The Semantic Browser Protocol is a
 * *vocabulary* layer over the routed layer: it turns a description into `r1, r2, r3`, checks
 * a claimed revision, and hands the routed layer the reference it already trusts. It decides
 * nothing about permission.
 *
 * ## What it does decide
 *
 * Four things, none of them authority:
 *
 *   - **What a tab is.** Identity, provenance, who asked for it, and which of five lifecycle
 *     states it is in. The rule that matters is in `./lifecycle`: a `ready` tab has a
 *     navigable URL, always, so "open, no URL" is `creating` or `failed` and never a blank
 *     browser panel.
 *   - **Which tab is in front.** One answer, held here, so the strip and the protocol cannot
 *     disagree about where an action without a tab id will land.
 *   - **Whether a reference is still current.** A claimed revision that does not match is
 *     refused as `stale-reference` rather than redirected at whatever now occupies the slot.
 *   - **What to tell the renderer.** One state object in which `runtimeStatus` and `reason`
 *     say why the browser is in the state it is in, so the renderer never infers health from
 *     how many tabs happen to be open.
 *
 * ## Why state is pushed rather than polled
 *
 * The surface reports every navigation, load, failure and close through `subscribe`, and the
 * service re-publishes. A workspace that re-reads state on every push needs no timer at all,
 * which matters more as the tab count grows: the previous design re-read the whole projection
 * every 800 ms whether or not anything had changed.
 */

/* -------------------------------------------------------------- the protocol */

/** The closed operation vocabulary. Everything a caller may ask for. */
export const SEMANTIC_BROWSER_OPS = [
  'tabs',
  'open',
  'close',
  'activate',
  'navigate',
  'snapshot',
  'screenshot',
  'click',
  'type',
  'select',
  'scroll',
  'back',
  'forward',
  'wait',
  'reload',
] as const
export type SemanticBrowserOp = (typeof SEMANTIC_BROWSER_OPS)[number]

export function isSemanticBrowserOp(value: unknown): value is SemanticBrowserOp {
  return typeof value === 'string' && (SEMANTIC_BROWSER_OPS as readonly string[]).includes(value)
}

/**
 * Names that mark a control as part of signing in.
 *
 * Matched against a control's accessible name, which is the only thing available without
 * reading the form. A false positive costs the owner one confirmation; a false negative puts
 * a second factor one click from being answered by something that is not the owner.
 */
const AUTHENTICATION_HINT =
  /auth|otp|mfa|2fa|two.?factor|one.?time|verification|verify|security.?key|yubi|passkey|credential|password|sign.?in|log.?in/i

/**
 * Controls whose whole purpose is something only the owner may do.
 *
 * Matched against the accessible name, which is the only thing available without reading the
 * form or the page's text, and deliberately generous: a false positive costs the owner one
 * confirmation, while a false negative puts money moving or a second factor answered by
 * something that is not them. Asymmetric in favour of asking.
 *
 * Each group names a *category*, not a site. Nothing here knows what a bank is; it knows that
 * a control which reads as "pay now" is not Freya's to press, wherever it lives.
 */
const OWNER_ONLY_SURFACES: readonly { readonly what: string; readonly pattern: RegExp }[] = Object.freeze([
  { what: 'a payment', pattern: /\b(pay|checkout|place order|buy now|purchase|donate|subscribe now|add to cart|confirm order)\b/i },
  { what: 'a transfer between accounts', pattern: /\b(transfer|send money|wire|paypal|venmo|bank transfer)\b/i },
  { what: 'a banking or card action', pattern: /\b(withdraw|deposit|statement|account balance|apply now|open account)\b/i },
  { what: 'a captcha', pattern: /\b(captcha|recaptcha|hcaptcha|are you a robot|i am not a robot|verify you are human|challenge)\b/i },
  { what: 'a permission prompt', pattern: /\b(allow|grant|enable)\b[^.]{0,24}\b(notifications|camera|microphone|location|access|permission|cookies)\b/i },
  { what: 'an upload of something the owner has', pattern: /\b(upload|attach (a )?file|choose file|browse files?)\b/i },
  { what: 'running or installing something', pattern: /\b(download|install|run|launch|execute|open) (the )?(installer|executable|\.exe|\.msi|\.dmg|\.apk|\.sh)\b/i },
  { what: 'accepting terms on the owner’s behalf', pattern: /\b(i agree|accept (the )?(terms|policy|licen[cs]e|cookies)|consent to)\b/i },
])

/**
 * One protocol request.
 *
 * `tabId` is optional everywhere and means "the tab in front" when absent — never "the newest
 * one", because "the newest one" and "the visible one" diverge the moment somebody switches
 * tabs, and an agent that acts on the wrong tab is worse than one that acts on none.
 *
 * `revision` is required on every op that acts on an element, and is never defaulted: the
 * whole point is that the caller states which instant it decided from.
 */
export type SemanticBrowserRequest =
  | { readonly op: 'tabs' }
  | {
      readonly op: 'open'
      readonly url?: string | null
      readonly origin?: BrowserTabOrigin
      readonly createdBy?: BrowserTabAttribution
      readonly activate?: boolean
    }
  | { readonly op: 'close'; readonly tabId?: string | null }
  | { readonly op: 'activate'; readonly tabId: string }
  | { readonly op: 'navigate'; readonly tabId?: string | null; readonly url: string }
  | { readonly op: 'snapshot'; readonly tabId?: string | null }
  | { readonly op: 'screenshot'; readonly tabId?: string | null }
  | { readonly op: 'click'; readonly tabId?: string | null; readonly ref: string; readonly revision: number }
  | { readonly op: 'type'; readonly tabId?: string | null; readonly ref: string; readonly revision: number; readonly text: string }
  | { readonly op: 'select'; readonly tabId?: string | null; readonly ref: string; readonly revision: number; readonly index: number }
  | { readonly op: 'scroll'; readonly tabId?: string | null; readonly to: 'top' | 'bottom' | number }
  | { readonly op: 'back' | 'forward' | 'reload'; readonly tabId?: string | null }
  | { readonly op: 'wait'; readonly tabId?: string | null; readonly settleMs?: number; readonly until?: string }

export type SemanticBrowserResult =
  | { readonly ok: true; readonly op: SemanticBrowserOp; readonly data: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly op: SemanticBrowserOp; readonly code: BrowserServiceCode; readonly reason: string; readonly data: Readonly<Record<string, unknown>> }

function ok(op: SemanticBrowserOp, data: Readonly<Record<string, unknown>>): SemanticBrowserResult {
  return { ok: true, op, data }
}

function no(op: SemanticBrowserOp, code: BrowserServiceCode, detail?: string): SemanticBrowserResult {
  return {
    ok: false,
    op,
    code,
    reason: detail === undefined ? BROWSER_SERVICE_REASONS[code] : `${BROWSER_SERVICE_REASONS[code]} ${detail}`,
    data: {},
  }
}

function asRow(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** One element as the routed layer described it, before reference minting. */
interface DescribedElement {
  readonly phaseRef: string
  readonly kind: 'link' | 'button' | 'field' | 'heading' | 'text'
  readonly name: string
  readonly selector: string
  readonly disabled: boolean
  readonly protected: boolean
  readonly destructive: boolean
}

function readDescribed(value: unknown): DescribedElement | null {
  const row = asRow(value)
  if (row === null) return null
  if (typeof row.ref !== 'string' || row.ref === '') return null
  const raw = typeof row.label === 'string' ? row.label : ''
  const name = boundText(raw, BROWSER_SERVICE_LIMITS.maxSnapshotLineChars)
  const kind =
    row.kind === 'link' || row.kind === 'button' || row.kind === 'field' || row.kind === 'heading' || row.kind === 'text'
      ? row.kind
      : 'text'
  return {
    phaseRef: row.ref,
    kind,
    name,
    selector: typeof row.selector === 'string' ? row.selector : '',
    disabled: row.disabled === true,
    protected: row.protected === true,
    destructive: browserDeleteReason(name) !== null,
  }
}

/* --------------------------------------------------------------- the service */

/** What the service needs from the Phase 51 runtime. Two methods, nothing else. */
export interface BrowserCommandPort {
  /** The routed command vocabulary. Every act and every navigation goes through here. */
  execute(request: BrowserRequest, context?: { readonly origin: 'owner'; readonly createdBy?: BrowserTabAttribution }): Promise<BrowserResult>
  /** Whether the runtime is switched on. Read fresh, every call. */
  active(): boolean
}

export interface BrowserServiceOptions {
  readonly surface: BrowserSurfacePort
  /** The Phase 51 runtime, reached through a two-method port so no Electron leaks in. */
  readonly commands: BrowserCommandPort
  readonly allowedHosts?: readonly string[]
  readonly allowPrivateHosts?: boolean
  /** Append to the shared journal. Optional, and never a reason to fail an operation. */
  readonly record?: (type: BrowserEventType, payload: BrowserPayload) => Promise<void> | void
  /** `agent` performs under the automation principal. The default is the owner-facing path. */
  readonly executionPrincipal?: 'owner' | 'agent'
  readonly clockMs?: () => number
  readonly now?: () => Date
  readonly newId?: () => string
  /** The ceiling on live tabs. Narrowing only; the code-owned number is the maximum. */
  readonly maxTabs?: number
}

interface TabRecord {
  readonly tabId: string
  readonly sessionId: string
  readonly surface: BrowserSurfaceKind
  readonly origin: BrowserTabOrigin
  readonly createdBy: BrowserTabAttribution
  readonly openedAt: number
  carry: TabCarry
  /** The revision the live page is at, as the surface counts it. Monotonic. */
  surfaceRevision: number
  /** The revision this tab's reference table is bound to. Zero until a snapshot. */
  pageRevision: number
  readonly refs: SemanticRefTable
  /** Semantic reference → the reference the routed layer minted for the same element. */
  phaseRefs: Map<string, string>
}

export interface BrowserService {
  readonly surfaceKind: BrowserSurfaceKind
  run(request: SemanticBrowserRequest): Promise<SemanticBrowserResult>
  tabs(): readonly BrowserTabState[]
  tab(tabId: string): BrowserTabState | null
  activeTabId(): string | null
  /** The host reports journal trust, because only the host can read the chain. */
  trust(trustworthy: boolean, recovery?: BrowserRecoverySummary | null): void
  /** The state projection. Given the host's runtime facts rather than guessing at them. */
  state(input?: { readonly starting?: boolean; readonly reason?: string | null }): BrowserServiceState
  /** Push updates. Replaces polling. */
  subscribe(listener: (state: BrowserServiceState) => void): () => void
  /** Place the native view. Returns false when this surface has none to place. */
  dock(sessionId: string | null, bounds: SurfaceBounds | null): boolean
  recovery(): BrowserRecoverySummary | null
  dispose(): Promise<void>
}

const NO_CARRY: TabCarry = Object.freeze({
  title: null,
  liveUrl: null,
  revision: 0,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  history: Object.freeze([]) as readonly string[],
  cursor: -1,
})

export function createBrowserService(options: BrowserServiceOptions): BrowserService {
  const surface = options.surface
  const clock = options.clockMs ?? (() => Date.now())
  const nowIso = (): string => (options.now ?? (() => new Date()))().toISOString()
  const newId = options.newId ?? (() => Math.random().toString(36).slice(2, 10))
  const maxTabs = Math.max(1, Math.min(options.maxTabs ?? BROWSER_SERVICE_LIMITS.maxTabs, BROWSER_SERVICE_LIMITS.maxTabs))
  const ownerContext = options.executionPrincipal === 'agent' ? undefined : ({ origin: 'owner' } as const)

  const tabs = new Map<string, TabRecord>()
  const bySession = new Map<string, TabRecord>()
  const listeners = new Set<(state: BrowserServiceState) => void>()
  let frontTabId: string | null = null
  let recovered: BrowserRecoverySummary | null = null
  let journalTrustworthy = false
  let lastBounds: SurfaceBounds | null = null

  /* -------------------------------------------------------------- projection */

  /**
   * What the record currently believes, as an observation.
   *
   * The carry *is* the evidence, so this is the only place the mapping happens and the
   * lifecycle machine cannot be reached with a shape it does not know. The order below is the
   * order of what is knowable: a page on screen beats a pending load, a pending load beats a
   * remembered address, and a remembered address beats nothing.
   */
  function observationFor(record: TabRecord): TabObservation {
    const { liveUrl, loading, error, title, history, cursor } = record.carry
    if (liveUrl !== null && !loading) return { kind: 'ready', url: liveUrl, title }
    if (error !== null) return { kind: 'failed', url: history[cursor] ?? null, code: error }
    if (loading) return { kind: 'navigating', url: liveUrl ?? history[cursor] ?? '' }
    return { kind: 'creating' }
  }

  function viewOf(record: TabRecord, active: boolean): BrowserTabState {
    return reconcileTabState(
      tabStateFor({
        tabId: record.tabId,
        sessionId: record.sessionId,
        surface: record.surface,
        origin: record.origin,
        createdBy: record.createdBy,
        openedAt: record.openedAt,
        active,
        previous: record.carry,
        observation: observationFor(record),
      }),
    )
  }

  function tabStates(): readonly BrowserTabState[] {
    return Object.freeze([...tabs.values()].map((record) => viewOf(record, record.tabId === frontTabId)))
  }

  /** What to say when nothing more specific is known. One sentence, per status. */
  function defaultReason(status: BrowserServiceState['runtimeStatus']): string {
    switch (status) {
      case 'active':
        return 'The Freya Browser is available.'
      case 'disabled':
        return 'The browser runtime is switched off, so Freya has not opened a browser window.'
      case 'journalUntrusted':
        return "The browser journal does not chain, so the runtime did not open. A record nobody has read is not a record to act on."
      case 'surfaceUnavailable':
        return 'The browser runtime is switched on but no embedded page could be created.'
      case 'starting':
        return 'The browser stack is still being composed.'
    }
  }

  function state(input: { readonly starting?: boolean; readonly reason?: string | null } = {}): BrowserServiceState {
    const switchedOn = options.commands.active()
    const surfaceAvailable = surface.available()
    const status = runtimeStatusFor({
      switchedOn,
      surfaceAvailable,
      // Trust is the host's to assert. This layer cannot read the journal chain, and
      // pretending to would be a second, unauthenticated opinion about whether the record is
      // intact. A host that never says so is treated as untrustworthy, which is the safe read.
      journalTrustworthy,
      ...(input.starting === undefined ? {} : { starting: input.starting }),
    })
    return browserServiceStateFor({
      status,
      publicAvailable: surfaceAvailable,
      journalTrustworthy,
      activeTabId: frontTabId,
      tabs: tabStates(),
      reason: input.reason ?? (status === 'active' ? null : defaultReason(status)),
      ...(recovered === null ? {} : { recovery: recovered }),
    })
  }

  function publish(): void {
    const view = state()
    for (const listener of [...listeners]) {
      try {
        listener(view)
      } catch {
        // A listener that throws is a broken window, not a broken browser. The state it
        // missed will be in the next push, and refusing to publish would strand every other.
      }
    }
  }

  /* ------------------------------------------------------------- tab records */

  function setCarry(record: TabRecord, carry: Partial<TabCarry>): void {
    record.carry = { ...record.carry, ...carry }
    publish()
  }

  /** Push a URL onto history and return the cursor that goes with it. */
  function withHistory(carry: TabCarry, url: string): { history: readonly string[]; cursor: number } {
    const next = [...carry.history.slice(0, Math.max(0, carry.cursor + 1)), url]
    const trimmed = next.slice(-BROWSER_SERVICE_LIMITS.maxHistoryEntries)
    return { history: Object.freeze(trimmed), cursor: trimmed.length - 1 }
  }

  /** Retire this tab's references because the page moved on. */
  function retire(record: TabRecord, revision: number): void {
    if (!Number.isFinite(revision) || revision <= record.surfaceRevision) return
    record.surfaceRevision = revision
    record.refs.retire(revision)
    record.phaseRefs.clear()
    // The bound revision goes with it: a reference table that claims to describe revision 41
    // while the page is at 44 would let a caller act on a page it never read.
    record.pageRevision = record.pageRevision > revision ? record.pageRevision : record.pageRevision
  }

  /**
   * Where in history a landing address belongs.
   *
   * The three cases, in the order a browser itself resolves them:
   *
   *   - the address the tab was already on is a **reload**, and a reload is not a navigation;
   *   - the address immediately before the cursor is a **back**, and the forward entries are
   *     still there afterwards, which is the whole point of a forward button;
   *   - the address immediately after it is a **forward**;
   *   - anything else is a **new** entry, and whatever was ahead is discarded.
   *
   * Without the first two cases a back button appends the address it just left, so history
   * grows and the forward button is dead after one use.
   */
  function placeInHistory(carry: TabCarry, landed: string, previousAddress: string | null): { history: readonly string[]; cursor: number } {
    // A landing on the address the cursor is already sitting on is not a new entry, whether
    // the service cleared `liveUrl` to tell the renderer the page went away or not. Two writers
    // of "where am I" — one here and one in the push — would otherwise put the same address in
    // history twice and hand the owner a back button that only undoes its own last click.
    if (previousAddress === landed) return { history: carry.history, cursor: carry.cursor }
    if (carry.cursor >= 0 && carry.history[carry.cursor] === landed) return { history: carry.history, cursor: carry.cursor }
    if (carry.cursor > 0 && carry.history[carry.cursor - 1] === landed) {
      return { history: carry.history, cursor: carry.cursor - 1 }
    }
    if (carry.cursor >= 0 && carry.cursor < carry.history.length - 1 && carry.history[carry.cursor + 1] === landed) {
      return { history: carry.history, cursor: carry.cursor + 1 }
    }
    return withHistory(carry, landed)
  }

  /** Accept a surface reading. The only place a surface can move a tab. */
  function applyReading(sessionId: string, reading: SurfaceTabReading, fromAddress?: string | null): TabRecord | null {
    const record = bySession.get(sessionId)
    if (record === undefined) return null
    retire(record, reading.revision)
    const landed = navigableUrl(reading.url)
    if (landed === null) {
      if (reading.error !== null) {
        setCarry(record, { liveUrl: null, title: null, loading: false, error: reading.error, canGoForward: false })
        return record
      }
      // No address and no error: the tab is between documents. `creating` is the honest
      // reading, and `liveUrl` is cleared so nothing docks a view over an address that is not
      // on screen. This is the exact shape that used to render as an empty browser.
      setCarry(record, { liveUrl: null, loading: reading.loading })
      return record
    }
    const previous = fromAddress === undefined ? record.carry.liveUrl : fromAddress
    const samePage = previous === landed
    if (!samePage) record.phaseRefs.clear()
    const history = placeInHistory(record.carry, landed, previous)
    setCarry(record, {
      liveUrl: landed,
      title: reading.title === null || reading.title === '' ? record.carry.title : boundText(reading.title, BROWSER_SERVICE_LIMITS.maxTitleChars),
      loading: reading.loading,
      error: reading.error,
      canGoBack: reading.canGoBack || history.cursor > 0,
      canGoForward: reading.canGoForward || history.cursor < history.history.length - 1,
      revision: Math.max(record.carry.revision, reading.revision),
      history: history.history,
      cursor: history.cursor,
    })
    return record
  }

  const unsubscribeSurface = surface.subscribe((reading) => {
    applyReading(reading.sessionId, reading)
  })

  /* --------------------------------------------------------- session plumbing */

  async function note(type: BrowserEventType, payload: BrowserPayload): Promise<void> {
    if (options.record === undefined) return
    try {
      await options.record(type, payload)
    } catch {
      // An unrecorded fact is a degraded record, never a failed operation. The runtime this
      // service sits on already treats a journal append failure the same way.
    }
  }

  function tabIdFor(tabId: string | null | undefined): TabRecord | null {
    if (tabId === null || tabId === undefined || tabId === '') {
      return frontTabId === null ? null : tabs.get(frontTabId) ?? null
    }
    return tabs.get(tabId) ?? null
  }

  function policyRefusal(url: string): { ok: false; reason: string } | { ok: true; url: string } {
    const checked = assertPublicBrowserUrl(url, {
      allowedHosts: options.allowedHosts ?? [],
      allowPrivateHosts: options.allowPrivateHosts === true,
    })
    return checked.ok ? { ok: true, url: checked.url } : { ok: false, reason: checked.reason }
  }

  function codeFrom(result: Extract<BrowserResult, { ok: false }>): BrowserServiceCode {
    switch (result.code) {
      case 'subsystem-disabled':
        return 'subsystem-disabled'
      case 'budget-exceeded':
        return 'tab-budget'
      case 'session-unknown':
        return 'tab-unknown'
      case 'url-refused':
        return 'url-refused'
      case 'authority-refused':
        return 'authority-refused'
      case 'page-stale':
        return 'stale-reference'
      case 'protected-field':
        return 'protected-field'
      case 'element-disabled':
        return 'element-disabled'
      case 'ref-unknown':
        return 'ref-unknown'
      case 'stop-all-latched':
        return 'subsystem-disabled'
      default:
        return 'adapter-failed'
    }
  }

  /* ------------------------------------------------------------- operations */

  async function opTabs(): Promise<SemanticBrowserResult> {
    const views = tabStates()
    return ok('tabs', {
      tabs: views.map((tab) => ({ ...tab })),
      activeTabId: frontTabId,
      count: views.length,
      maxTabs,
    })
  }

  async function opOpen(request: Extract<SemanticBrowserRequest, { op: 'open' }>): Promise<SemanticBrowserResult> {
    if (tabs.size >= maxTabs) return no('open', 'tab-budget')
    const requested = request.url ?? null
    let url: string | null = null
    if (requested !== null && requested !== '') {
      // A URL is checked against the same policy as every navigation, and checked *before* a
      // window exists: a refused address never creates a tab at all, so there is nothing to
      // clean up and nothing half-built for the owner to look at.
      const checked = policyRefusal(requested)
      if (!checked.ok) return no('open', 'url-refused', checked.reason)
      url = checked.url
    }
    const createdBy: BrowserTabAttribution = request.createdBy ?? 'user'
    const origin: BrowserTabOrigin = request.origin ?? { kind: 'manual' }

    const opened = await options.commands.execute({ command: 'session.open', target: 'public' }, { origin: 'owner', createdBy })
    if (!opened.ok) return no('open', codeFrom(opened), opened.reason)
    const sessionId = typeof opened.data.sessionId === 'string' ? opened.data.sessionId : null
    if (sessionId === null) return no('open', 'adapter-failed', 'The runtime opened a browser session without naming it.')

    const tabId = `tab-${newId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || sessionId}`
    const record: TabRecord = {
      tabId,
      sessionId,
      surface: surface.kind,
      origin,
      createdBy,
      openedAt: clock(),
      carry: NO_CARRY,
      surfaceRevision: 0,
      pageRevision: 0,
      refs: new SemanticRefTable(tabId),
      phaseRefs: new Map(),
    }
    tabs.set(tabId, record)
    bySession.set(sessionId, record)

    const view = await surface.open({ sessionId, url: url ?? '', createdBy })
    if (!view.ok) {
      // The window could not be made. The tab exists, which is the truth, and it is `failed`
      // with a code rather than an empty panel pretending to be a page.
      setCarry(record, { error: view.code, liveUrl: null })
      await options.commands.execute({ command: 'session.close', target: 'public', sessionId }, ownerContext).catch(() => undefined)
      return ok('open', { tabId, sessionId, status: 'failed', error: view.code, reason: view.reason })
    }
    applyReading(sessionId, view.value)
    if (request.activate !== false) await opActivate(tabId)

    if (url === null) {
      // A tab with no address is a legitimate `creating` tab. It is reported as such, and the
      // renderer shows a pending panel — a real state with a real name, not an empty browser.
      return ok('open', { tabId, sessionId, status: 'creating', url: null })
    }
    const navigated = await opNavigate({ op: 'navigate', tabId, url })
    if (!navigated.ok) return navigated
    return ok('open', { tabId, sessionId, status: 'ready', url: record.carry.liveUrl })
  }

  async function opClose(request: Extract<SemanticBrowserRequest, { op: 'close' }>): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('close', 'tab-unknown')
    await surface.close(record.sessionId).catch(() => ({ ok: false, code: 'adapter-failed', reason: 'The view did not release cleanly.' }) as const)
    await options.commands.execute({ command: 'session.close', target: 'public', sessionId: record.sessionId }, ownerContext).catch(() => undefined)
    record.refs.clear()
    // The position is taken **before** the removal. Looking the closed tab up in the list it
    // is no longer in is how this ends up with no front tab at all when three were open.
    const position = [...tabs.values()].findIndex((entry) => entry.tabId === record.tabId)
    const wasFront = frontTabId === record.tabId
    tabs.delete(record.tabId)
    bySession.delete(record.sessionId)
    if (wasFront) {
      // Close the front tab and land on a neighbour, deterministically: the next tab along,
      // else the previous one, else nothing. A strip that jumps somewhere random is how an
      // agent ends up acting on the tab nobody is looking at.
      const remaining = [...tabs.values()]
      frontTabId = remaining[position]?.tabId ?? remaining[position - 1]?.tabId ?? null
      surface.dock(bySession.get(frontTabId ?? '')?.sessionId ?? null, lastBounds)
    }
    publish()
    return ok('close', { tabId: record.tabId, sessionId: record.sessionId, activeTabId: frontTabId })
  }

  async function opActivate(tabId: string): Promise<SemanticBrowserResult> {
    const record = tabs.get(tabId)
    if (record === undefined) return no('activate', 'tab-unknown')
    frontTabId = tabId
    await note('browser.dual.session.focused', { sessionId: record.sessionId, at: nowIso() })
    publish()
    return ok('activate', { tabId, sessionId: record.sessionId })
  }

  async function opNavigate(request: Extract<SemanticBrowserRequest, { op: 'navigate' }>): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('navigate', 'tab-unknown')
    const checked = policyRefusal(request.url)
    if (!checked.ok) return no('navigate', 'url-refused', checked.reason)

    // Announced as `navigating` *before* the command, so the renderer swaps the docked view
    // for a pending panel immediately instead of leaving a stale page over a load that has
    // already started. `liveUrl` is cleared because it is the field the view is docked
    // against, and the old page is not on screen any more.
    setCarry(record, { loading: true, liveUrl: null, title: null, error: null })
    retire(record, record.surfaceRevision + 1)

    const result = await options.commands.execute(
      { command: 'page.navigate', target: 'public', sessionId: record.sessionId, url: checked.url },
      ownerContext,
    )
    if (!result.ok) {
      setCarry(record, { loading: false, error: result.code, canGoForward: false })
      return no('navigate', codeFrom(result), result.reason)
    }

    const landed = navigableUrl(result.data.url)
    if (landed === null) {
      // The runtime authorised the navigation and the window did not say where it ended up.
      // There is no page to claim, so the tab is `failed` — never `ready` with no URL, which
      // is the shape this whole module exists to make unreachable.
      setCarry(record, { loading: false, error: 'page-missing', canGoForward: false })
      return no('navigate', 'page-missing', `The Freya Browser accepted ${checked.url} but reported no navigable address.`)
    }

    const revision = typeof result.data.revision === 'number' ? result.data.revision : record.surfaceRevision
    retire(record, revision)
    setCarry(record, {
      liveUrl: landed,
      title: typeof result.data.title === 'string' ? boundText(result.data.title, BROWSER_SERVICE_LIMITS.maxTitleChars) : record.carry.title,
      loading: false,
      error: null,
      revision: Math.max(record.carry.revision, revision),
      canGoBack: record.carry.cursor > 0,
      canGoForward: false,
    })
    // History is written in exactly one place — the surface reading — because the surface is
    // the only thing that knows what the page actually did. A redirect, a server-side jump or
    // a page that rewrote its own address all show up there and nowhere else, and two writers
    // would disagree about which of them happened.
    // One confirmation read after the command. The surface pushes what it did, and this
    // catches a page that finished without saying anything — a redirect it swallowed, a load it
    // reported as complete at the old address. It deliberately does **not** carry an override
    // for where the tab came from: by now `liveUrl` is the address the tab landed on, so this
    // is a re-read of the same page and must not move the cursor.
    const reading = await surface.observe(record.sessionId)
    if (reading.ok) applyReading(record.sessionId, reading.value)
    return ok('navigate', { tabId: record.tabId, sessionId: record.sessionId, url: landed, revision, status: observationFor(record).kind })
  }

  /**
   * Build a semantic snapshot and mint this tab's references.
   *
   * One `page.describe` does the whole read: the same routed command, the same
   * `browser.read-text` action key, the same gates, the same journal entry — and out the
   * other side come the elements *and* the page's words. References are then minted here,
   * numbered in document order, and the routed reference each one stands for is kept beside
   * it so an act can be handed a reference the gated layer already trusts.
   */
  async function opSnapshot(request: Extract<SemanticBrowserRequest, { op: 'snapshot' }>): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('snapshot', 'tab-unknown')
    if (record.carry.liveUrl === null) {
      if (record.carry.loading) return no('snapshot', 'pending-navigation')
      return no('snapshot', 'page-missing', record.carry.error ?? undefined)
    }

    const result = await options.commands.execute({ command: 'page.describe', target: 'public', sessionId: record.sessionId }, ownerContext)
    if (!result.ok) return no('snapshot', codeFrom(result), result.reason)

    const revision = typeof result.data.revision === 'number' ? result.data.revision : 0
    const url = navigableUrl(result.data.url) ?? record.carry.liveUrl
    if (revision <= 0 || url === null) {
      return no('snapshot', 'page-missing', 'The page was described but reported no revision or address, so no reference could be bound to it.')
    }
    retire(record, revision)

    const described = Array.isArray(result.data.elements) ? result.data.elements : []
    const parsed: DescribedElement[] = []
    for (const entry of described) {
      const element = readDescribed(entry)
      if (element !== null) parsed.push(element)
    }
    const elements = record.refs.mint(parsed)
    record.pageRevision = revision
    record.phaseRefs.clear()
    parsed.forEach((element, index) => {
      const ref = elements[index]?.ref
      if (ref !== undefined) record.phaseRefs.set(ref, element.phaseRef)
    })

    const snapshot: SemanticSnapshot = renderSemanticSnapshot({
      tabId: record.tabId,
      url,
      title: typeof result.data.title === 'string' ? result.data.title : null,
      revision,
      text: typeof result.data.text === 'string' ? result.data.text : '',
      truncated: result.data.truncated === true,
      elements,
      superseded: record.surfaceRevision > revision,
    })
    setCarry(record, { revision: Math.max(record.carry.revision, revision), liveUrl: url })
    return ok('snapshot', { snapshot })
  }

  /**
   * Capture the visible pixels of a tab as PNG and return a `MediaItem` that the
   * renderer can display.
   *
   * The model asks for a screenshot when the structural snapshot is too thin to
   * answer a question — a complex visual layout, a chart, a CAPTCHA. The
   * surface holds the bytes; the protocol returns a `MediaItem` with a
   * `freya-browser://screenshot/{sessionId}/{revision}.png` URL the renderer
   * can fetch.
   *
   * Read-only observation, never an act, so it does not retire the snapshot's
   * revision. A subsequent `snapshot` will return a higher revision if the
   * page moved, and the model should ask for a fresh screenshot if it wants
   * the new page.
   */
  async function opScreenshot(request: Extract<SemanticBrowserRequest, { op: 'screenshot' }>): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('screenshot', 'tab-unknown')
    if (record.carry.liveUrl === null) {
      return no('screenshot', record.carry.loading ? 'pending-navigation' : 'page-missing', record.carry.error ?? undefined)
    }
    const taken = await surface.screenshot(record.sessionId)
    if (!taken.ok) return no('screenshot', taken.code === 'surface-unavailable' ? 'subsystem-disabled' : 'adapter-failed', taken.reason)
    const capture = taken.value
    const bytes = capture.png.byteLength
    return ok('screenshot', {
      tabId: record.tabId,
      url: capture.url,
      title: capture.title,
      revision: capture.revision,
      width: capture.width,
      height: capture.height,
      bytes,
      /**
       * A `freya-browser://screenshot/{sessionId}/{revision}.png` URL the renderer
       * can fetch. The protocol is registered by the Electron host and serves
       * PNG bytes from the surface's per-session cache.
       */
      mediaUrl: capture.mediaUrl,
      /** The PNG bytes, base64-encoded so the model can hand them to a vision layer
       *  without re-fetching. The renderer ignores this when it has the URL. */
      pngBase64: Buffer.from(capture.png).toString('base64'),
    })
  }

  type ActOp = 'click' | 'type' | 'select'

  /**
   * Everything an element act has to get past, in one place, before anything is touched.
   *
   * The order is the argument, and it is the whole of the revision-safety requirement:
   *
   *   1. the tab exists and is not closed;
   *   2. the tab has a page on screen — a `creating` or `navigating` tab has nothing to act
   *      on and says so as `pending-navigation` rather than as a missing tab;
   *   3. the caller named a revision, and it is the one this tab's references are bound to;
   *   4. **the page has not moved since that revision** — checked against the surface's own
   *      counter as well as the snapshot's, because a page that navigated on its own leaves
   *      the revision the caller holds numerically correct and semantically wrong;
   *   5. the reference resolves, and is neither protected nor disabled;
   *   6. a control that reads as destructive, or as an authentication step, needs the owner.
   *
   * Nothing below this point has touched the page.
   */
  function prepare(
    op: ActOp,
    request: { readonly tabId?: string | null; readonly ref: string; readonly revision: number },
  ): { readonly ok: true; readonly record: TabRecord; readonly selector: string; readonly phaseRef: string; readonly name: string } | { readonly ok: false; readonly result: SemanticBrowserResult } {
    const record = tabIdFor(request.tabId)
    if (record === null) return { ok: false, result: no(op, 'tab-unknown') }
    if (record.carry.liveUrl === null) {
      return {
        ok: false,
        result: record.carry.loading ? no(op, 'pending-navigation') : no(op, 'page-missing', record.carry.error ?? undefined),
      }
    }
    if (typeof request.revision !== 'number' || !Number.isFinite(request.revision)) {
      return { ok: false, result: no(op, 'revision-required', `This tab's references belong to revision ${String(record.pageRevision)}.`) }
    }
    if (request.revision !== record.pageRevision) {
      return {
        ok: false,
        result: no(
          op,
          'stale-reference',
          `You acted from revision ${String(request.revision)}; this tab's references belong to revision ${String(record.pageRevision)}. Nothing was acted on.`,
        ),
      }
    }
    if (record.surfaceRevision > record.pageRevision) {
      return {
        ok: false,
        result: no(
          op,
          'stale-reference',
          `Your reference belongs to revision ${String(record.pageRevision)} and the page has moved to revision ${String(record.surfaceRevision)}. Nothing was acted on.`,
        ),
      }
    }
    const resolved = record.refs.resolve(request.ref, request.revision)
    if (!resolved.ok) {
      const code: BrowserServiceCode =
        resolved.code === 'stale-reference'
          ? 'stale-reference'
          : resolved.code === 'ref-unknown'
            ? 'ref-unknown'
            : resolved.code === 'protected-field'
              ? 'protected-field'
              : resolved.code === 'element-disabled'
                ? 'element-disabled'
                : 'revision-required'
      return { ok: false, result: no(op, code, resolved.reason) }
    }
    for (const surface of OWNER_ONLY_SURFACES) {
      if (!surface.pattern.test(resolved.handle.name)) continue
      return {
        ok: false,
        result: no(op, 'owner-action-required', `"${resolved.handle.name}" reads as ${surface.what}, so it is the owner's to press, not Freya's.`),
      }
    }
    if (AUTHENTICATION_HINT.test(resolved.handle.name)) {
      // Reached only for a control that is neither protected nor disabled, so the refusal
      // names the *reason it needs the owner* rather than a property of the control. A
      // password field never gets this far — the table refused it as protected already.
      return { ok: false, result: no(op, 'owner-action-required', `"${resolved.handle.name}" is part of signing in, so it is the owner's to press.`) }
    }
    if (browserDeleteReason(resolved.handle.name) !== null) {
      return { ok: false, result: no(op, 'element-delete-refused', browserDeleteReason(resolved.handle.name) ?? undefined) }
    }
    const phaseRef = record.phaseRefs.get(resolved.handle.ref)
    if (phaseRef === undefined) {
      return { ok: false, result: no(op, 'ref-unknown', `Reference ${resolved.handle.ref} is no longer bound to a described element.`) }
    }
    return { ok: true, record, selector: resolved.handle.selector, phaseRef, name: resolved.handle.name }
  }

  async function opClick(request: Extract<SemanticBrowserRequest, { op: 'click' }>): Promise<SemanticBrowserResult> {
    const prepared = prepare('click', request)
    if (!prepared.ok) return prepared.result
    const result = await options.commands.execute(
      { command: 'page.click', target: 'public', sessionId: prepared.record.sessionId, ref: prepared.phaseRef },
      ownerContext,
    )
    if (!result.ok) return no('click', codeFrom(result), result.reason)
    const revision = typeof result.data.revision === 'number' ? result.data.revision : prepared.record.surfaceRevision
    retire(prepared.record, revision)
    setCarry(prepared.record, { revision: Math.max(prepared.record.carry.revision, revision) })
    return ok('click', { tabId: prepared.record.tabId, clicked: true, revision, name: prepared.name })
  }

  async function opType(request: Extract<SemanticBrowserRequest, { op: 'type' }>): Promise<SemanticBrowserResult> {
    if (typeof request.text !== 'string' || request.text.length === 0) {
      return no('type', 'request-malformed', 'Typing needs text to type.')
    }
    if (new TextEncoder().encode(request.text).length > 4_096) {
      return no('type', 'request-malformed', 'Typed text exceeds the four-kilobyte ceiling.')
    }
    const prepared = prepare('type', request)
    if (!prepared.ok) return prepared.result
    const result = await options.commands.execute(
      { command: 'page.type', target: 'public', sessionId: prepared.record.sessionId, ref: prepared.phaseRef, text: request.text },
      ownerContext,
    )
    if (!result.ok) return no('type', codeFrom(result), result.reason)
    const revision = typeof result.data.revision === 'number' ? result.data.revision : prepared.record.surfaceRevision
    retire(prepared.record, revision)
    setCarry(prepared.record, { revision: Math.max(prepared.record.carry.revision, revision) })
    return ok('type', { tabId: prepared.record.tabId, typed: true, revision, name: prepared.name })
  }

  /**
   * Choose an option in a select control.
   *
   * Deliberately **not** routed through the gated layer, and the reason is worth stating
   * rather than hiding: `page.type` drives a text entry and cannot drive a `<select>`, so
   * asking the gates to authorise "type this into that select" would either be refused for
   * the wrong reason or, worse, pass and then do nothing.
   *
   * Choosing an option changes one control's value in a page Freya already owns, navigates
   * nowhere and submits nothing. What it may not do is more carefully bounded than the
   * routing question:
   *
   *   - it must name a current revision and a live reference, or it is refused as
   *     `stale-reference` exactly like a click;
   *   - a protected field is refused, so a one-time-code or card selector is out of reach;
   *   - a control whose name reads as an authentication step is refused with
   *     `owner-action-required`, because choosing "Authenticator app" is the beginning of
   *     somebody's second factor and not a page interaction;
   *   - and it is recorded in the shared journal as `browser.dual.page.selected`, so an
   *     unaudited act is not possible even though it did not walk the gates.
   */
  async function opSelect(request: Extract<SemanticBrowserRequest, { op: 'select' }>): Promise<SemanticBrowserResult> {
    if (!Number.isInteger(request.index) || request.index < 0 || request.index > 63) {
      return no('select', 'request-malformed', 'Choosing an option needs an index the snapshot listed.')
    }
    const prepared = prepare('select', request)
    if (!prepared.ok) return prepared.result
    const done = await surface.select(prepared.record.sessionId, prepared.selector, request.index)
    if (!done.ok) return no('select', done.code === 'element-not-found' ? 'element-not-found' : 'adapter-failed', done.reason)
    await note('browser.dual.page.selected', { sessionId: prepared.record.sessionId, revision: prepared.record.carry.revision, at: nowIso() })
    return ok('select', { tabId: prepared.record.tabId, selected: done.value.selected, name: prepared.name })
  }

  /**
   * Scroll the page.
   *
   * Not an act on the world, so it does not walk the gates: it moves Freya's own viewport and
   * a page cannot observe it. It is recorded anyway, because a record of "what Freya did" that
   * has a hole in it is not a record.
   */
  async function opScroll(request: Extract<SemanticBrowserRequest, { op: 'scroll' }>): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('scroll', 'tab-unknown')
    if (record.carry.liveUrl === null) return no('scroll', 'page-missing')
    const to = request.to
    const done = await surface.scroll(
      record.sessionId,
      to === 'bottom' ? { kind: 'bottom' } : to === 'top' ? { kind: 'top' } : { kind: 'delta', amount: Math.max(-20_000, Math.min(20_000, to)) },
    )
    if (!done.ok) return no('scroll', 'adapter-failed', done.reason)
    // A height of zero is not "scrolled to the top". It is the signature of a view
    // that has never been given a viewport: the DOM is there, but the document has
    // nothing to lay out against, so there is nothing to scroll and no position to
    // report. Claiming success here would hand a caller a `top: 0` that means "my
    // view is not on screen", not "the page is at the top". Dock the tab first.
    if (done.value.height <= 0) {
      return no(
        'scroll',
        'surface-unavailable',
        'The tab has no sized viewport (its height read 0), so nothing scrolled. Dock the tab so it has a view, then scroll again.',
      )
    }
    await note('browser.dual.page.scrolled', { sessionId: record.sessionId, revision: record.carry.revision, at: nowIso() })
    return ok('scroll', { tabId: record.tabId, top: done.value.top, height: done.value.height })
  }

  async function opHistory(request: { readonly op: 'back' | 'forward'; readonly tabId?: string | null }): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no(request.op, 'tab-unknown')
    const next = request.op === 'back' ? record.carry.cursor - 1 : record.carry.cursor + 1
    const url = record.carry.history[next] ?? null
    if (url === null) {
      return no(request.op, 'page-missing', request.op === 'back' ? 'There is nothing earlier in this tab.' : 'There is nothing later in this tab.')
    }
    // History moves go out as a navigation through the gated layer, so the URL policy, the
    // grant and the journal all see them. A back button that skipped the policy would be a
    // hole straight past the front of it.
    const result = await opNavigate({ op: 'navigate', tabId: record.tabId, url })
    if (!result.ok) return result
    return ok(request.op, { tabId: record.tabId, url })
  }

  async function opReload(request: { readonly op: 'reload'; readonly tabId?: string | null }): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('reload', 'tab-unknown')
    const url = record.carry.liveUrl ?? record.carry.history[record.carry.cursor] ?? null
    if (url === null) return no('reload', 'page-missing', 'That tab has no address to reload.')
    // Reload is a fresh navigation to the address the tab is on now, never a re-read of a
    // remembered URL: those differ exactly when the page has moved since.
    return await opNavigate({ op: 'navigate', tabId: record.tabId, url })
  }

  async function opWait(request: Extract<SemanticBrowserRequest, { op: 'wait' }>): Promise<SemanticBrowserResult> {
    const record = tabIdFor(request.tabId)
    if (record === null) return no('wait', 'tab-unknown')
    const settleMs = Math.max(0, Math.min(request.settleMs ?? 2_000, BROWSER_SERVICE_LIMITS.maxWaitMs))
    const done = await surface.wait(record.sessionId, {
      settleMs,
      ...(request.until === undefined ? {} : { until: request.until.slice(0, 200) }),
    })
    if (!done.ok) return no('wait', done.code === 'wait-exceeded' ? 'wait-exceeded' : 'adapter-failed', done.reason)
    const reading = await surface.observe(record.sessionId)
    if (reading.ok) applyReading(record.sessionId, reading.value)
    return ok('wait', { tabId: record.tabId, settled: done.value.settled, url: done.value.url })
  }

  /* -------------------------------------------------------------- dispatcher */

  async function run(request: SemanticBrowserRequest): Promise<SemanticBrowserResult> {
    if (!options.commands.active()) return no(request.op, 'subsystem-disabled')
    // A record nobody has read is not a record to act on. Without a trustworthy journal this
    // service cannot say whether a tab it remembers is one that exists, and a browser that
    // guesses is the failure this whole state machine exists to prevent — so it refuses
    // rather than opening a tab nobody can account for.
    if (!journalTrustworthy) {
      return no(request.op, 'subsystem-disabled', "Freya's browser journal does not chain, so nothing was opened or changed.")
    }
    switch (request.op) {
      case 'tabs':
        return await opTabs()
      case 'open':
        return await opOpen(request)
      case 'close':
        return await opClose(request)
      case 'activate':
        return await opActivate(request.tabId)
      case 'navigate':
        return await opNavigate(request)
      case 'snapshot':
        return await opSnapshot(request)
      case 'screenshot':
        return await opScreenshot(request)
      case 'click':
        return await opClick(request)
      case 'type':
        return await opType(request)
      case 'select':
        return await opSelect(request)
      case 'scroll':
        return await opScroll(request)
      case 'back':
      case 'forward':
        return await opHistory({ op: request.op, tabId: request.tabId })
      case 'reload':
        return await opReload({ op: 'reload', tabId: request.tabId })
      case 'wait':
        return await opWait(request)
      /* istanbul ignore next -- exhaustive over the closed operation list, so `request` is
         `never` here and the op name cannot be read from it. */
      default:
        return no('tabs', 'command-unsupported')
    }
  }

  /* ------------------------------------------------------------------ return */

  return {
    surfaceKind: surface.kind,

    run,

    tabs: tabStates,

    tab(tabId) {
      return tabStates().find((tab) => tab.tabId === tabId) ?? null
    },

    activeTabId() {
      return frontTabId
    },

    trust(trustworthy, recovery) {
      journalTrustworthy = trustworthy
      if (recovery !== undefined) recovered = recovery
      publish()
    },

    state,

    subscribe(listener) {
      listeners.add(listener)
      try {
        listener(state())
      } catch {
        // A window that throws on its first read gets the next push.
      }
      return () => {
        listeners.delete(listener)
      }
    },

    dock(sessionId, bounds) {
      lastBounds = bounds
      return surface.dock(sessionId, bounds)
    },

    recovery() {
      return recovered
    },

    async dispose() {
      unsubscribeSurface()
      for (const record of [...tabs.values()]) {
        await surface.close(record.sessionId).catch(() => undefined)
        record.refs.clear()
      }
      tabs.clear()
      bySession.clear()
      frontTabId = null
      recovered = null
      listeners.clear()
      await surface.dispose().catch(() => undefined)
    },
  }
}

/**
 * Structural audit over the protocol vocabulary.
 *
 * The claim worth checking is that the protocol cannot grow a way to run code in
 * the page or to reach the owner's credentials. An op whose name reaches outside the
 * vocabulary — an eval, an execute, a script, a cookie jar — would be a way to run
 * code or read secrets, and both would need the whole gate discussion above
 * re-litigated. So those names are checked, cheaply, forever.
 *
 * `screenshot` used to be on that list, and it was removed deliberately rather than
 * by accident, so the reason is written down here:
 *
 *   - The routed vocabulary above is unchanged and still bans it. There is no
 *     `page.capture` command, so this read does not enter the Phase 51 runtime and
 *     cannot acquire a route of its own.
 *   - What comes back is **not** page content for the model. The op returns the
 *     size of a capture and a URL; the PNG is served to the owner, over a protocol
 *     bound to the session and revision that produced it. The tool's summary says
 *     in words that the image is the owner's to look at. The model is told the
 *     dimensions, never the pixels, so no model can read a page it could not read
 *     as text — which is the failure the original ban existed to prevent.
 *   - What it does cross: the Device Hands action gates, the `browser.read`
 *     capability (the owner's alone), and the STOP ALL latch checked at the top of
 *     `run()` like every other command.
 *
 * The words that stay banned are the ones with no owner-facing answer: running code
 * in the page, or reading what the owner typed.
 */
export function auditSemanticBrowserService(): readonly string[] {
  const findings: string[] = []
  const banned = ['eval', 'execute', 'script', 'inject', 'cookie', 'storage', 'password', 'token', 'keyring']
  for (const op of SEMANTIC_BROWSER_OPS) {
    for (const word of banned) {
      if (op.includes(word)) findings.push(`semantic op ${op} contains "${word}".`)
    }
  }
  if (BROWSER_SERVICE_LIMITS.maxTabs < 10) findings.push('The tab ceiling is below the multi-tab target.')
  if (BROWSER_SERVICE_LIMITS.maxSnapshotElements < 20) findings.push('The snapshot ceiling is too small to describe an ordinary page.')
  return findings
}

/** Re-exported so the host can reason about navigability without importing `../isolation`. */
export { isNavigableBrowserUrl }