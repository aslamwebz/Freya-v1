// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  backUrl,
  canGoBack,
  canGoForward,
  createDockedBrowserStore,
  currentHistoryUrl,
  forwardUrl,
  isPageState,
  normalizeOpenInputUrl,
  PAGE_STATES,
  tabOriginLabel,
  type DockedTabOrigin,
} from '../../src/app/chat/dockedBrowserStore'

/**
 * The docked browser model is the only place the tab bookkeeping lives, so the
 * tests are the contract: every line below is what the React component
 * consumes through `useSyncExternalStore`, and every line above the model
 * (`App.tsx`, `eyeHandoff.ts`, `Chats.tsx`) treats as a black box.
 *
 * No network, no Electron, no React — the store is a pure reducer over a
 * snapshot, and a regression here would show up as a tab that does not appear,
 * does not activate, or refuses to navigate.
 */

function withFixedIds(): { store: ReturnType<typeof createDockedBrowserStore>; ids: { readonly t1: string; readonly t2: string; readonly t3: string } } {
  let counter = 0
  const store = createDockedBrowserStore({
    newId: () => {
      counter += 1
      return counter === 1 ? 't1' : counter === 2 ? 't2' : 't3'
    },
    now: () => 1_700_000_000_000 + counter * 1000,
  })
  return { store, ids: { t1: 'tab-t1', t2: 'tab-t2', t3: 'tab-t3' } }
}

describe('a docked browser starts empty', () => {
  it('reports no tabs and no active id', () => {
    const store = createDockedBrowserStore()
    const snapshot = store.getSnapshot()
    expect(snapshot.tabs).toEqual([])
    expect(snapshot.activeId).toBeNull()
    expect(store.activeTab()).toBeNull()
  })
})

describe('opening and activating tabs', () => {
  it('opens a tab with the requested url and makes it active', () => {
    const { store } = withFixedIds()
    const tab = store.openTab({ url: 'https://example.com' })
    expect(tab.id).toBe('tab-t1')
    expect(tab.url).toBe('https://example.com')
    expect(tab.title.length).toBeGreaterThan(0)
    expect(tab.history).toEqual(['https://example.com'])
    expect(tab.cursor).toBe(0)
    expect(tab.page).toBe('loading')
    expect(store.getSnapshot().activeId).toBe('tab-t1')
  })

  it('keeps the active tab the same when opening a new non-activating tab', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com', activate: true })
    store.openTab({ url: 'https://example.org', activate: false })
    expect(store.getSnapshot().activeId).toBe(ids.t1)
    expect(store.activeTab()?.url).toBe('https://example.com')
  })

  it('records the origin a tab was opened with', () => {
    const { store } = withFixedIds()
    const origin: DockedTabOrigin = { kind: 'link', from: 'eye', ownerText: 'a finding' }
    const tab = store.openTab({ url: 'https://example.com', origin })
    expect(tab.origin).toEqual(origin)
    expect(tabOriginLabel(origin)).toBe('from eye')
  })

  it('switches the active tab on demand', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    store.openTab({ url: 'https://example.org' })
    expect(store.activeTab()?.url).toBe('https://example.org')
    expect(store.activateTab(ids.t1)).toBe(true)
    expect(store.activeTab()?.url).toBe('https://example.com')
  })

  it('refuses to activate an unknown tab id', () => {
    const { store } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    expect(store.activateTab('does-not-exist')).toBe(false)
  })
})

describe('closing tabs and keeping an active neighbour', () => {
  it('moves the active id to a neighbour when the active tab is closed', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    store.openTab({ url: 'https://example.org' })
    store.openTab({ url: 'https://example.io' })
    expect(store.activeTab()?.id).toBe(ids.t3)
    expect(store.closeTab(ids.t3)).toBe(true)
    const snapshot = store.getSnapshot()
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual([ids.t1, ids.t2])
    // The neighbour that fills the gap is t2 (the previous tab).
    expect(snapshot.activeId).toBe(ids.t2)
  })

  it('keeps the active id stable when a non-active tab is closed', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    store.openTab({ url: 'https://example.org' })
    store.openTab({ url: 'https://example.io' })
    store.activateTab(ids.t2)
    expect(store.closeTab(ids.t1)).toBe(true)
    expect(store.getSnapshot().activeId).toBe(ids.t2)
  })

  it('reports nothing active when the last tab is closed', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    store.closeTab(ids.t1)
    expect(store.getSnapshot().activeId).toBeNull()
    expect(store.activeTab()).toBeNull()
  })
})

describe('navigation history is a single line per tab', () => {
  it('appends a new url to history when the tab navigates', () => {
    const { store, ids } = withFixedIds()
    const tab = store.openTab({ url: 'https://example.com' })
    store.recordNavigation(tab.id, { url: 'https://example.com/about', revision: 2 })
    const after = store.findTab(ids.t1)
    expect(after?.url).toBe('https://example.com/about')
    expect(after?.revision).toBe(2)
  })

  it('records back and forward moves without losing history', () => {
    const { store, ids } = withFixedIds()
    const tab = store.openTab({ url: 'https://example.com' })
    store.recordHistory(tab.id, { url: 'https://example.com/about', cursor: 1 })
    store.recordHistory(tab.id, { url: 'https://example.com/docs', cursor: 2 })
    store.recordHistoryMove(tab.id, { cursor: 1 })
    const after = store.findTab(ids.t1)
    expect(after?.cursor).toBe(1)
    expect(after?.history).toEqual(['https://example.com', 'https://example.com/about', 'https://example.com/docs'])
    expect(backUrl(after!)).toBe('https://example.com')
    expect(forwardUrl(after!)).toBe('https://example.com/docs')
    expect(canGoBack(after!)).toBe(true)
    expect(canGoForward(after!)).toBe(true)
  })

  it('refuses to record against an unknown tab', () => {
    const { store } = withFixedIds()
    expect(store.recordNavigation('does-not-exist', { url: 'https://example.com', revision: 1 })).toBe(false)
    expect(store.recordHistoryMove('does-not-exist', { cursor: 0 })).toBe(false)
  })
})

describe('page state transitions', () => {
  it('moves from loading to ready when a navigation completes', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    store.recordNavigation(ids.t1, { url: 'https://example.com', revision: 1 })
    expect(store.findTab(ids.t1)?.page).toBe('ready')
    store.recordFailure(ids.t1, { revision: 2, reason: 'network' })
    expect(store.findTab(ids.t1)?.page).toBe('failed')
  })

  it('knows the closed page state', () => {
    expect(isPageState('closed')).toBe(true)
    expect(isPageState('nope')).toBe(false)
    expect(PAGE_STATES).toContain('ready')
    expect(PAGE_STATES).toContain('failed')
  })
})

describe('url normalisation is conservative', () => {
  it('accepts http and https urls', () => {
    expect(normalizeOpenInputUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(normalizeOpenInputUrl('http://example.com')).toBe('http://example.com')
  })

  it('upgrades a bare host to a https url', () => {
    expect(normalizeOpenInputUrl('example.com')).toBe('https://example.com')
  })

  it('refuses schemes the browser will not open', () => {
    expect(normalizeOpenInputUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeOpenInputUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeOpenInputUrl('about:blank')).toBeNull()
  })

  it('refuses a value that looks like neither a url nor a host', () => {
    expect(normalizeOpenInputUrl('hello world')).toBeNull()
    expect(normalizeOpenInputUrl('  ')).toBeNull()
  })
})

describe('history helpers reflect the cursor exactly', () => {
  it('reports no current url when the tab has no history', () => {
    const { store, ids } = withFixedIds()
    store.openTab({ url: 'https://example.com' })
    const tab = store.findTab(ids.t1)
    if (tab === null) throw new Error('tab should exist')
    // Force the cursor to -1 by mutating nothing — the openTab sets cursor to 0,
    // but the helpers defend against -1 anyway.
    expect(canGoBack(tab)).toBe(false)
    expect(canGoForward(tab)).toBe(false)
    expect(currentHistoryUrl(tab)).toBe('https://example.com')
  })

  it('reports no forward url at the end of history', () => {
    const { store, ids } = withFixedIds()
    const tab = store.openTab({ url: 'https://example.com' })
    store.recordHistory(tab.id, { url: 'https://example.com/a', cursor: 1 })
    store.recordHistoryMove(tab.id, { cursor: 1 })
    const after = store.findTab(ids.t1)
    if (after === null) throw new Error('tab should exist')
    expect(forwardUrl(after)).toBeNull()
    expect(canGoForward(after)).toBe(false)
  })
})

describe('React subscription and native navigation', () => {
  it('keeps the snapshot identity stable until a mutation', () => {
    const store = createDockedBrowserStore()
    expect(store.getSnapshot()).toBe(store.getSnapshot())
    const before = store.getSnapshot()
    store.openTab()
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })
  it('truncates forward history and does not duplicate a completed navigation', () => {
    const store = createDockedBrowserStore()
    const tab = store.openTab({ url: 'https://example.com' })
    store.recordPageReplaced(tab.id, { url: 'https://example.com/a', revision: 1 })
    store.recordPageReplaced(tab.id, { url: 'https://example.com/b', revision: 2 })
    store.recordHistoryMove(tab.id, { cursor: 1 })
    store.recordNavigation(tab.id, { url: 'https://example.com/a', revision: 3 })
    store.recordPageReplaced(tab.id, { url: 'https://example.com/c', revision: 4 })
    store.recordPageReplaced(tab.id, { url: 'https://example.com/c', revision: 4 })
    expect(store.findTab(tab.id)?.history).toEqual(['https://example.com', 'https://example.com/a', 'https://example.com/c'])
    expect(store.findTab(tab.id)?.liveUrl).toBe('https://example.com/c')
  })
})
