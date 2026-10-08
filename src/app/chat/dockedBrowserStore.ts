/**
 * The browser tab strip's model.
 *
 * ## Why the renderer holds tabs at all
 *
 * It does not hold *pages*. The Browser Service owns the pages, their lifecycle and their
 * sessions; the renderer's job is to mirror that into something a strip can draw and to send
 * intents back. Every field here is a mirror of a service fact, and `sync` is the only place
 * a mirror is written — which is what keeps the two from drifting into "the strip says tab 2
 * is loading while the view behind it shows tab 4".
 *
 * ## The invariant this store exists to hold
 *
 * **A tab's `status` is never inferred.** It is copied from the service, which derives it from
 * the lifecycle machine in `core/browser/service/lifecycle.ts`. In particular a tab is `ready`
 * only when the service says a page is loaded at a navigable URL, so the empty-panel bug —
 * a tab that looked live, had no URL, and rendered blank — is not reachable from this side.
 * A renderer cannot fix that with a placeholder, and this store does not pretend to.
 *
 * ## Framework-free on purpose
 *
 * It carries a `subscribe` so a React shell can mirror it, and the shell is the only thing
 * that ever calls the host bridge. That is what lets the seams in `eyeHandoff.ts` reach the
 * model without rendering anything first.
 */

import type {
  BrowserTabOrigin,
  BrowserTabState,
  BrowserTabLifecycle,
  SemanticElement,
} from '../../../core/browser/service'
import { tabOriginLabel as coreOriginLabel, tabDisplayTitle } from '../../../core/browser/service'

/** Re-exported so a caller does not import the core type and the store type separately. */
export type DockedTabOrigin = BrowserTabOrigin
export type DockedTabStatus = BrowserTabLifecycle

export interface DockedTab {
  readonly id: string
  /** The Browser Service's tab id. Stable for the life of the tab. */
  readonly sessionId: string
  /** The address the tab is meant to be on. Null while creating, failed or closed. */
  readonly url: string | null
  /** Where the page actually landed. Null unless a page is on screen. */
  readonly liveUrl: string | null
  readonly title: string
  readonly status: DockedTabStatus
  readonly revision: number
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly createdBy: 'freya' | 'user'
  readonly origin: DockedTabOrigin
  readonly active: boolean
  /** A code, never a page string. */
  readonly error: string | null
  readonly openedAt: number
}

export interface DockedBrowserSnapshot {
  readonly tabs: readonly DockedTab[]
  readonly activeId: string | null
  readonly status: DockedTabStatus
}

export type DockedBrowserEvent =
  | { readonly kind: 'tab.opened'; readonly tab: DockedTab }
  | { readonly kind: 'tab.closed'; readonly tabId: string }
  | { readonly kind: 'tab.activated'; readonly selectedId: string | null; readonly previousId: string | null }
  | { readonly kind: 'tab.synced'; readonly tabId: string }
  | { readonly kind: 'reset' }

export interface DockedBrowserDeps {
  readonly now?: () => number
}

export function createDockedBrowserStore(deps: DockedBrowserDeps = {}): DockedBrowserStore {
  const now = deps.now ?? (() => Date.now())
  let tabs: DockedTab[] = []
  let activeId: string | null = null
  const listeners = new Set<(snapshot: DockedBrowserSnapshot) => void>()
  let snapshot: DockedBrowserSnapshot = Object.freeze({ tabs: Object.freeze([]), activeId: null, status: 'creating' })

  function publish(): void {
    const active = tabs.find((tab) => tab.id === activeId) ?? null
    snapshot = Object.freeze({
      tabs: Object.freeze(tabs.slice()),
      activeId,
      // The strip shows one lifecycle word for the whole workspace, taken from the front tab.
      // With no tab there is nothing creating and nothing failed: the workspace is simply
      // empty, which is a state of its own and is the reason `no-tab` is not `creating`.
      status: active?.status ?? 'creating',
    })
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A shell that throws on a render must not stop the store from publishing.
      }
    }
  }

  function toTab(state: BrowserTabState): DockedTab {
    return Object.freeze({
      id: state.tabId,
      sessionId: state.sessionId,
      url: state.url,
      liveUrl: state.liveUrl,
      title: tabDisplayTitle(state),
      status: state.status,
      revision: state.revision,
      loading: state.loading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      createdBy: state.createdBy,
      origin: state.origin,
      active: state.active,
      error: state.error,
      openedAt: now(),
    })
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * Mirror the service's tab list.
     *
     * Add, update, remove — keyed on `tabId`, which is stable across every navigation. That
     * is what stops "opening another tab overwrites the previous one": there is nothing to
     * overwrite, because a tab is looked up by an id and a navigation does not change it.
     */
    sync(states: readonly BrowserTabState[], frontTabId: string | null): DockedBrowserSnapshot {
      const seen = new Set<string>()
      tabs = states.map((state) => {
        seen.add(state.tabId)
        return toTab(state)
      })
      activeId = frontTabId !== null && seen.has(frontTabId) ? frontTabId : (tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null)
      publish()
      return snapshot
    },

    /** The front tab, or null. Never "the newest one". */
    activeTab() {
      return tabs.find((tab) => tab.id === activeId) ?? null
    },

    findTab(tabId: string) {
      return tabs.find((tab) => tab.id === tabId) ?? null
    },

    tabs() {
      return snapshot.tabs
    },

    reset() {
      tabs = []
      activeId = null
      publish()
    },
  }
}

export interface DockedBrowserStore {
  getSnapshot(): DockedBrowserSnapshot
  subscribe(listener: (snapshot: DockedBrowserSnapshot) => void): () => void
  sync(states: readonly BrowserTabState[], frontTabId: string | null): DockedBrowserSnapshot
  activeTab(): DockedTab | null
  findTab(tabId: string): DockedTab | null
  tabs(): readonly DockedTab[]
  reset(): void
}

/** One word of provenance for the tab badge. Display only. */
export function tabOriginLabel(origin: DockedTabOrigin): string {
  return coreOriginLabel(origin)
}

/** Turn whatever the owner typed into an address, or into a search. */
export function normalizeOpenInputUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null
  const looksLikeHost = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(trimmed) && !/\s/.test(trimmed)
  if (looksLikeHost) return `https://${trimmed}`
  return null
}

/**
 * What a bare phrase in the address bar becomes.
 *
 * A search, because a person who types "contact us sri lanka" into a browser address bar
 * wants a page, and being handed a refusal would be correct but useless.
 */
export function addressAsQuery(value: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(value.trim().slice(0, 200))}`
}

export type { SemanticElement }

let shared: DockedBrowserStore | null = null

/**
 * The one store the app's browser workspace uses.
 *
 * Module-level on purpose: the split-pane divider, a citation opener and the dock itself all
 * need the same tab list, and three stores would be three truths.
 */
export function sharedDockedBrowserStore(): DockedBrowserStore {
  if (shared === null) shared = createDockedBrowserStore()
  return shared
}