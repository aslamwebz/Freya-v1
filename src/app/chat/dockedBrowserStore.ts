/**
 * Docked browser tab model.
 *
 * The default browser surface lives beside Chat. Each loaded tab owns a distinct,
 * isolated native page which remains alive while switching or hiding the dock.
 * This store tracks the selected page, provenance and per-tab navigation history.
 *
 * The store is intentionally framework-free: it carries a `subscribe` so a React
 * shell can mirror it, and the shell is the only place that ever calls the host
 * bridge. Keeping the tab bookkeeping separate from the React component is what
 * lets the seams in `eyeHandoff.ts` (which need to open a tab) reach the model
 * without having to render anything first.
 */

export type DockedTabOrigin =
  | { readonly kind: 'manual'; }
  | {
      readonly kind: 'link'
      readonly from: 'chat' | 'eye' | 'media' | 'citation'
      readonly ownerText: string
      readonly mediaKind?: 'video' | 'image' | 'pdf' | 'document' | 'page' | 'audio'
    }
  | { readonly kind: 'handoff'; readonly fromSession: string }

export interface DockedTab {
  readonly id: string
  readonly title: string
  readonly url: string | null
  /** The URL the embedded window is currently displaying for this tab. */
  readonly sessionId?: string
  readonly liveUrl: string | null
  /** History of URLs the user has visited in this tab. Most-recent last. */
  readonly history: readonly string[]
  readonly cursor: number
  readonly revision: number
  readonly page: 'absent' | 'loading' | 'ready' | 'failed' | 'closed'
  readonly origin: DockedTabOrigin
  readonly openedAt: number
}

export interface DockedBrowserSnapshot {
  readonly tabs: readonly DockedTab[]
  readonly activeId: string | null
}

export type DockedBrowserEvent =
  | { readonly kind: 'tab.opened'; readonly tab: DockedTab }
  | { readonly kind: 'tab.closed'; readonly tabId: string }
  | { readonly kind: 'tab.activated'; readonly selectedId: string; readonly previousId: string | null }
  | { readonly kind: 'tab.navigated'; readonly tabId: string; readonly url: string; readonly title: string; readonly revision: number }
  | { readonly kind: 'tab.failed'; readonly tabId: string; readonly revision: number; readonly reason: string }
  | { readonly kind: 'tab.replaced'; readonly tabId: string; readonly url: string; readonly title: string; readonly revision: number }
  | { readonly kind: 'history.push'; readonly tabId: string; readonly url: string; readonly cursor: number }
  | { readonly kind: 'history.move'; readonly tabId: string; readonly cursor: number }

export interface DockedBrowserDeps {
  readonly now?: () => number
  readonly newId?: () => string
}

const PAGE_STATE_VALUES = ['absent', 'loading', 'ready', 'failed', 'closed'] as const
type PageState = (typeof PAGE_STATE_VALUES)[number]

function defaultTitle(url: string | null): string {
  if (url === null) return 'New tab'
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '') || url
  } catch {
    return url.length > 32 ? `${url.slice(0, 32)}…` : url
  }
}

function normaliseUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null
  const looksLikeHost = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(trimmed) && !/\s/.test(trimmed)
  if (looksLikeHost) return `https://${trimmed}`
  return null
}

function clampCursor(cursor: number, historyLength: number): number {
  if (historyLength === 0) return -1
  if (cursor < 0) return 0
  if (cursor >= historyLength) return historyLength - 1
  return cursor
}

export interface OpenTabInput {
  readonly url?: string | null
  readonly title?: string | null
  readonly origin?: DockedTabOrigin
  readonly activate?: boolean
}

export interface DockedBrowserStore {
  getSnapshot(): DockedBrowserSnapshot
  subscribe(listener: (snapshot: DockedBrowserSnapshot) => void): () => void
  openTab(input?: OpenTabInput): DockedTab
  closeTab(tabId: string): boolean
  activateTab(tabId: string): boolean
  recordNavigation(tabId: string, params: { readonly url: string; readonly title?: string; readonly revision: number }): boolean
  recordFailure(tabId: string, params: { readonly revision: number; readonly reason: string }): boolean
  recordPageReplaced(tabId: string, params: { readonly url: string; readonly title?: string; readonly revision: number }): boolean
  recordHistory(tabId: string, params: { readonly url: string; readonly cursor: number }): boolean
  recordHistoryMove(tabId: string, params: { readonly cursor: number }): boolean
  /** Convenience for callers that have a tab id from somewhere else. */
  findTab(tabId: string): DockedTab | null
  activeTab(): DockedTab | null
  bindSession(tabId: string, sessionId: string): boolean
  reset(): void
}

function freshTabId(newId: () => string): string {
  return `tab-${newId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}`
}

export function createDockedBrowserStore(deps: DockedBrowserDeps = {}): DockedBrowserStore {
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => `d${Math.random().toString(36).slice(2, 12)}`)
  let tabs: DockedTab[] = []
  let activeId: string | null = null
  const listeners = new Set<(snapshot: DockedBrowserSnapshot) => void>()

  let snapshot: DockedBrowserSnapshot = Object.freeze({ tabs: Object.freeze([]), activeId: null })
  const snapshotView = (): DockedBrowserSnapshot => snapshot

  const publish = (): void => {
    snapshot = Object.freeze({ tabs: Object.freeze(tabs.map(clone)), activeId })
    const view = snapshot
    for (const listener of [...listeners]) listener(view)
  }

  const clone = (tab: DockedTab): DockedTab => ({ ...tab, history: Object.freeze([...tab.history]) })

  function openTab(input: OpenTabInput = {}): DockedTab {
    const url = typeof input.url === 'string' ? normaliseUrl(input.url) : null
    const title = input.title ?? defaultTitle(url)
    const id = freshTabId(newId)
    const history = url === null ? [] : [url]
    const tab: DockedTab = {
      id,
      title,
      url,
      liveUrl: null,
      history: Object.freeze(history),
      cursor: history.length === 0 ? -1 : 0,
      revision: 0,
      page: url === null ? 'absent' : 'loading',
      origin: input.origin ?? { kind: 'manual' },
      openedAt: now(),
    }
    tabs = [...tabs, tab]
    if (input.activate !== false) activeId = id
    publish()
    return tab
  }

  function closeTab(tabId: string): boolean {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return false
    const next = tabs.slice()
    next.splice(index, 1)
    tabs = next
    if (activeId === tabId) {
      activeId = next[index]?.id ?? next[index - 1]?.id ?? null
    }
    publish()
    return true
  }

  function activateTab(tabId: string): boolean {
    const exists = tabs.some((tab) => tab.id === tabId)
    if (!exists) return false
    if (activeId === tabId) return true
    activeId = tabId
    publish()
    return true
  }

  function patch(tabId: string, mutate: (tab: DockedTab) => DockedTab): boolean {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return false
    const updated = mutate(tabs[index]!)
    const next = tabs.slice()
    next[index] = updated
    tabs = next
    publish()
    return true
  }

  return {
    getSnapshot: snapshotView,

    subscribe(listener) {
      listeners.add(listener)
      listener(snapshotView())
      return () => {
        listeners.delete(listener)
      }
    },

    openTab,
    closeTab,
    activateTab,

    findTab(tabId) {
      return tabs.find((tab) => tab.id === tabId) ?? null
    },

    activeTab() {
      return tabs.find((tab) => tab.id === activeId) ?? null
    },

    bindSession(tabId, sessionId) {
      return patch(tabId, (tab) => ({ ...tab, sessionId }))
    },

    recordNavigation(tabId, params) {
      return patch(tabId, (tab) => ({
        ...tab,
        url: params.url,
        liveUrl: params.url,
        title: params.title ?? tab.title,
        revision: params.revision,
        page: 'ready',
      }))
    },

    recordFailure(tabId, params) {
      return patch(tabId, (tab) => ({
        ...tab,
        revision: params.revision,
        page: 'failed',
      }))
    },

    recordPageReplaced(tabId, params) {
      return patch(tabId, (tab) => {
        const nextHistory = tab.history[tab.cursor] === params.url ? tab.history : Object.freeze([...tab.history.slice(0, tab.cursor + 1), params.url].slice(-64))
        const cursor = nextHistory.length - 1
        return {
          ...tab,
          url: params.url,
          title: params.title ?? tab.title,
          liveUrl: params.url,
          revision: params.revision,
          history: nextHistory,
          cursor,
          page: 'ready',
        }
      })
    },

    recordHistory(tabId, params) {
      return patch(tabId, (tab) => ({
        ...tab,
        history: Object.freeze([...tab.history.slice(0, tab.cursor + 1), params.url].slice(-64)),
        cursor: clampCursor(params.cursor, tab.history.length + 1),
      }))
    },

    recordHistoryMove(tabId, params) {
      return patch(tabId, (tab) => ({
        ...tab,
        cursor: clampCursor(params.cursor, tab.history.length),
        url: tab.history[clampCursor(params.cursor, tab.history.length)] ?? tab.url,
      }))
    },

    reset() {
      tabs = []
      activeId = null
      publish()
    },
  }
}

/**
 * The kind of source that opened a tab.
 *
 * Surfaced as `data-origin` on the tab badge so the eye can see what is a manual
 * navigation, a citation, a media preview, or a deliberate handoff from the
 * authenticated browser. It is for display only — the host bridge does not see it.
 */
export function tabOriginLabel(origin: DockedTabOrigin): string {
  switch (origin.kind) {
    case 'manual':
      return 'manual'
    case 'link':
      return `from ${origin.from}`
    case 'handoff':
      return 'handoff'
  }
}

export function canGoBack(tab: DockedTab): boolean {
  return tab.cursor > 0
}

export function canGoForward(tab: DockedTab): boolean {
  return tab.cursor >= 0 && tab.cursor < tab.history.length - 1
}

export function currentHistoryUrl(tab: DockedTab): string | null {
  if (tab.cursor < 0 || tab.cursor >= tab.history.length) return null
  return tab.history[tab.cursor] ?? null
}

export function backUrl(tab: DockedTab): string | null {
  if (tab.cursor <= 0) return null
  return tab.history[tab.cursor - 1] ?? null
}

export function forwardUrl(tab: DockedTab): string | null {
  if (tab.cursor < 0) return null
  if (tab.cursor >= tab.history.length - 1) return null
  return tab.history[tab.cursor + 1] ?? null
}

export const PAGE_STATES: readonly PageState[] = PAGE_STATE_VALUES

export function isPageState(value: unknown): value is PageState {
  return typeof value === 'string' && (PAGE_STATE_VALUES as readonly string[]).includes(value)
}

export function normalizeOpenInputUrl(value: string): string | null {
  return normaliseUrl(value)
}