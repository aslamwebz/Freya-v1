import {
  BROWSER_SERVICE_LIMITS,
  type BrowserServiceState,
  type BrowserSurfaceKind,
  type BrowserTabAttribution,
  type BrowserTabOrigin,
  type BrowserTabState,
  isBrowserTabLifecycle,
} from './types'

/**
 * The tab lifecycle, and the two invariants that make it worth having.
 *
 * ## The invariant that fixes the empty panel
 *
 * **A `ready` tab always has a navigable URL.**
 *
 * The bug this file exists for was a browser tab that reported itself open, reported no
 * URL, and therefore rendered as an empty browser panel with no way to tell it apart from a
 * working tab that had nothing loaded yet. The fix is not a nicer empty state in the
 * renderer — the renderer cannot invent information the state does not have. The fix is that
 * the state *cannot be constructed* in the broken shape:
 *
 *   - {@link tabStateFor} derives `ready` only when a page is on screen **and** a navigable
 *     URL came back with it. A page that loaded to nowhere is `failed`, not `ready`.
 *   - {@link browserServiceStateFor} refuses to publish a `ready` session with no URL, and
 *     downgrades it to `failed` with a code rather than passing a lie to the window.
 *
 * ## The invariant that keeps the four empty states apart
 *
 * `creating`, `navigating`, `failed` and `closed` are four different facts, and each one is
 * reachable from a different event. Collapsing them is what produces a single blank box, so
 * {@link tabStateFor} takes the evidence it needs to tell them apart rather than a single
 * `hasUrl` boolean.
 */

/* ------------------------------------------------------------------ helpers */

/** Schemes the Freya Browser will put in a tab's URL slot. Nothing else is navigable. */
const NAVIGABLE_SCHEME = /^https?:$/

/**
 * Whether a string is an address Freya could actually open.
 *
 * The empty string is **not** navigable, and neither is `null`, `'about:blank'`,
 * `'undefined'` or `'null'`. Every one of those has reached a browser tab at some point, and
 * every one of them produces a panel with nothing in it.
 */
export function isNavigableUrl(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false
  const trimmed = candidate.trim()
  if (trimmed === '' || trimmed.length > BROWSER_SERVICE_LIMITS.maxUrlChars) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (!NAVIGABLE_SCHEME.test(parsed.protocol)) return false
  if (parsed.hostname === '') return false
  // Userinfo in a URL is a credential handed to a page as a header. It is never navigable.
  if (parsed.username !== '' || parsed.password !== '') return false
  return true
}

/**
 * Coerce anything a surface reported into a navigable URL, or null.
 *
 * Returns `null` rather than `''` for the empty case, deliberately: `''` is the value that
 * started this bug, and a function whose job is to decide whether a URL is usable should not
 * be able to answer "yes, the empty string is".
 */
export function navigableUrl(candidate: unknown): string | null {
  return isNavigableUrl(candidate) ? candidate.trim() : null
}

/* -------------------------------------------------------------------- events */

/**
 * Everything that can happen to a tab.
 *
 * A union rather than a bag of booleans, because the interesting bugs live in the
 * impossible combinations: `loading: false, url: null, error: null` is three facts that
 * cannot all be true at once, and a boolean bag has no way to say so.
 */
export type TabObservation =
  /** The tab exists; a view has been requested; no URL has been accepted. */
  | { readonly kind: 'creating' }
  /** A navigable URL was accepted and a load is in flight. */
  | { readonly kind: 'navigating'; readonly url: string }
  /** A page is on screen. `url` is where it landed and must be navigable. */
  | { readonly kind: 'ready'; readonly url: string; readonly title: string | null }
  /** A load was attempted and did not produce a page. */
  | { readonly kind: 'failed'; readonly url: string | null; readonly code: string }
  /** The view is gone. Terminal. */
  | { readonly kind: 'closed' }

export interface TabIdentity {
  readonly tabId: string
  readonly sessionId: string
  readonly surface: BrowserSurfaceKind
  readonly origin: BrowserTabOrigin
  readonly createdBy: BrowserTabAttribution
  readonly openedAt: number
}

/** The facts a tab carries that an observation does not supply. */
export interface TabCarry {
  readonly title: string | null
  readonly liveUrl: string | null
  readonly revision: number
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: string | null
  readonly history: readonly string[]
  readonly cursor: number
}

export interface TabTransitionInput extends TabIdentity {
  readonly observation: TabObservation
  readonly active: boolean
  readonly previous?: TabCarry
}

const NO_HISTORY_CARRY: TabCarry = Object.freeze({
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

/** Keep history bounded and the cursor inside it. */
function withHistory(carry: TabCarry, url: string | null): { history: readonly string[]; cursor: number } {
  const history = [...carry.history]
  if (url === null) return { history: Object.freeze(history), cursor: carry.cursor }
  // A same-URL load (a reload, a re-observation) is not a navigation and must not grow
  // history, or the back button walks through the same address ten times.
  if (history[carry.cursor] === url) return { history: Object.freeze(history), cursor: carry.cursor }
  const next = [...history.slice(0, Math.max(0, carry.cursor + 1)), url]
  const trimmed = next.slice(-BROWSER_SERVICE_LIMITS.maxHistoryEntries)
  return { history: Object.freeze(trimmed), cursor: trimmed.length - 1 }
}

/**
 * Derive a tab's state from what was just observed.
 *
 * Pure, total, and the only place a `BrowserTabState` is built. Two reads matter here:
 *
 *   - `navigating` keeps `liveUrl` **null** on purpose. The previous page is no longer on
 *     screen the moment a new load starts, and leaving the old URL in `liveUrl` is how a
 *     renderer docks a view onto a page that has already been replaced.
 *   - `failed` keeps the attempted URL in `url` so the address bar still shows what was
 *     tried, and clears `liveUrl` so nothing claims a page is there. The attempted address
 *     is not navigable-by-observation — it is a note — so the invariant below is scoped to
 *     `ready` and this is stated rather than left implicit.
 */
export function tabStateFor(input: TabTransitionInput): BrowserTabState {
  const previous = input.previous ?? NO_HISTORY_CARRY
  const base = {
    tabId: input.tabId,
    sessionId: input.sessionId,
    origin: input.origin,
    createdBy: input.createdBy,
    active: input.active,
    surface: input.surface,
  } as const

  switch (input.observation.kind) {
    case 'creating': {
      const history = previous.history
      return Object.freeze({
        ...base,
        url: null,
        liveUrl: null,
        title: previous.title,
        status: 'creating' as const,
        revision: previous.revision,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        history,
        cursor: previous.cursor,
      })
    }
    case 'navigating': {
      const url = navigableUrl(input.observation.url)
      if (url === null) {
        // A navigation was announced with something Freya cannot open. That is not a
        // navigation; it is a refusal that arrived wearing one.
        return Object.freeze({
          ...base,
          url: null,
          liveUrl: null,
          title: null,
          status: 'failed' as const,
          revision: previous.revision,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: 'url-required',
          history: previous.history,
          cursor: previous.cursor,
        })
      }
      return Object.freeze({
        ...base,
        url,
        liveUrl: null,
        title: null,
        status: 'navigating' as const,
        revision: previous.revision,
        loading: true,
        canGoBack: previous.canGoBack,
        canGoForward: previous.canGoForward,
        error: null,
        history: previous.history,
        cursor: previous.cursor,
      })
    }
    case 'ready': {
      const url = navigableUrl(input.observation.url)
      if (url === null) {
        // THE invariant. A surface said "loaded" and handed back an address that cannot be
        // opened — an empty string, a `null`, `about:blank`. Publishing `ready` here is
        // exactly the bug: a tab that looks live, points nowhere, and renders blank.
        return Object.freeze({
          ...base,
          url: null,
          liveUrl: null,
          title: null,
          status: 'failed' as const,
          revision: previous.revision,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: 'page-missing',
          history: previous.history,
          cursor: previous.cursor,
        })
      }
      const title = input.observation.title
      const { history, cursor } = withHistory(previous, url)
      return Object.freeze({
        ...base,
        url,
        liveUrl: url,
        title: typeof title === 'string' && title.length > 0 ? title.slice(0, BROWSER_SERVICE_LIMITS.maxTitleChars) : null,
        status: 'ready' as const,
        revision: previous.revision,
        loading: false,
        canGoBack: cursor > 0,
        canGoForward: cursor >= 0 && cursor < history.length - 1,
        error: null,
        history,
        cursor,
      })
    }
    case 'failed': {
      return Object.freeze({
        ...base,
        url: navigableUrl(input.observation.url),
        liveUrl: null,
        title: null,
        status: 'failed' as const,
        revision: previous.revision,
        loading: false,
        canGoBack: previous.canGoBack,
        canGoForward: false,
        error: input.observation.code.slice(0, 64),
        history: previous.history,
        cursor: previous.cursor,
      })
    }
    case 'closed': {
      return Object.freeze({
        ...base,
        url: null,
        liveUrl: null,
        title: null,
        status: 'closed' as const,
        revision: previous.revision,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        history: previous.history,
        cursor: previous.cursor,
      })
    }
    default: {
      // Unreachable for a well-typed caller, and refused rather than defaulted for an
      // ill-typed one. A state machine that guesses is a state machine that lies.
      return Object.freeze({
        ...base,
        url: null,
        liveUrl: null,
        title: null,
        status: 'failed' as const,
        revision: previous.revision,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: 'adapter-failed',
        history: previous.history,
        cursor: previous.cursor,
      })
    }
  }
}

/**
 * Is this tab state safe to publish?
 *
 * The one rule: nothing `ready` without a navigable `liveUrl`, and nothing `ready` that is
 * still claiming to be loading. Everything else is a matter of taste.
 */
export function tabStateIsPublishable(tab: BrowserTabState): boolean {
  if (tab.status === 'ready') {
    return isNavigableUrl(tab.liveUrl) && isNavigableUrl(tab.url) && tab.loading === false
  }
  // A non-ready tab must not keep claiming a page is on screen. This is the second half
  // of the empty-panel fix: `liveUrl` is the field the renderer docks a native view
  // against, so a stale value in it is a view over nothing.
  return tab.liveUrl === null
}

/**
 * Downgrade a tab that fails {@link tabStateIsPublishable}.
 *
 * A refusal should never be able to reach the window as a lie, so an unpublishable tab is
 * reported as `failed` with a code that says what is wrong, rather than dropped. Dropping it
 * would look identical to the tab never having existed.
 */
export function reconcileTabState(tab: BrowserTabState): BrowserTabState {
  if (tabStateIsPublishable(tab)) return tab
  return Object.freeze({
    ...tab,
    url: null,
    liveUrl: null,
    status: 'failed' as const,
    loading: false,
    error: tab.error ?? 'page-missing',
  })
}

/* ------------------------------------------------------------ runtime state */

export interface RuntimeStatusInput {
  readonly switchedOn: boolean
  readonly surfaceAvailable: boolean
  readonly journalTrustworthy: boolean
  /** Populated by the host while it is still composing the browser stack. */
  readonly starting?: boolean
}

/**
 * Derive the one field the renderer branches on.
 *
 * Order matters and is the argument: a runtime that has not been switched on is `disabled`
 * whatever else is true; a runtime that is switched on but has no surface is
 * `surfaceUnavailable` rather than `disabled`, because the difference decides whether the
 * fix is "switch the browser on" or "the browser is installed but its window could not be
 * created"; and a journal that does not chain outranks both, because a browser that cannot
 * account for what it did is not usable at any status.
 */
export function runtimeStatusFor(input: RuntimeStatusInput): BrowserServiceState['runtimeStatus'] {
  if (input.starting === true) return 'starting'
  if (!input.journalTrustworthy) return 'journalUntrusted'
  if (!input.switchedOn) return 'disabled'
  if (!input.surfaceAvailable) return 'surfaceUnavailable'
  return 'active'
}

/**
 * Assemble the state the renderer reads.
 *
 * `reason` is null **exactly** when `runtimeStatus` is `active`. That exactness is the
 * contract a renderer can rely on: if there is a reason, something is wrong, and if nothing
 * is wrong there is no reason to show.
 */
export function browserServiceStateFor(input: {
  readonly status: BrowserServiceState['runtimeStatus']
  readonly publicAvailable: boolean
  readonly journalTrustworthy: boolean
  readonly activeTabId: string | null
  readonly tabs: readonly BrowserTabState[]
  readonly reason: string | null
  readonly recovery?: BrowserServiceState['recovery']
}): BrowserServiceState {
  const active = input.status === 'active'
  const live = input.tabs.map(reconcileTabState).filter((tab) => tab.status !== 'closed')
  const sessions = live
    .map((tab) =>
      Object.freeze({
        sessionId: tab.sessionId,
        status: tab.status,
        url: tab.url,
        title: tab.title,
        createdBy: tab.createdBy,
        surface: tab.surface,
        errorCode: tab.error,
      }),
    )
  return Object.freeze({
    available: active,
    active,
    publicAvailable: input.publicAvailable,
    journalTrustworthy: input.journalTrustworthy,
    runtimeStatus: input.status,
    reason: active ? null : input.reason,
    activeTabId: input.activeTabId,
    tabs: Object.freeze(live),
    sessions: Object.freeze(sessions),
    tabCount: sessions.length,
    recovery: input.recovery ?? null,
  })
}

/* ------------------------------------------------------------------ helpers */

/** The tab a protocol call with no explicit tab id means. Never "the newest one". */
export function activeTabOf(tabs: readonly BrowserTabState[]): BrowserTabState | null {
  return tabs.find((tab) => tab.active && tab.status !== 'closed') ?? null
}

/** Resolve a tab by id, or by "the active one" when no id was given. */
export function resolveTab(tabs: readonly BrowserTabState[], tabId: string | null): BrowserTabState | null {
  if (tabId === null) return activeTabOf(tabs)
  return tabs.find((tab) => tab.tabId === tabId && tab.status !== 'closed') ?? null
}

/** The label the strip shows. Never blank, because a blank chip looks like a dead tab. */
export function tabDisplayTitle(tab: BrowserTabState): string {
  if (tab.title !== null && tab.title.trim() !== '') return tab.title.slice(0, BROWSER_SERVICE_LIMITS.maxTitleChars)
  const url = navigableUrl(tab.liveUrl ?? tab.url)
  if (url === null) {
    if (tab.status === 'creating') return 'New tab'
    if (tab.status === 'navigating') return 'Loading…'
    if (tab.status === 'failed') return 'Failed to load'
    return 'Closed'
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 64)
  }
}

/** One word of provenance for the tab badge. Display only. */
export function tabOriginLabel(origin: BrowserTabOrigin): string {
  switch (origin.kind) {
    case 'manual':
      return 'manual'
    case 'link':
      return `from ${origin.from}`
    case 'handoff':
      return 'handoff'
  }
}

export { isBrowserTabLifecycle }