// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  BROWSER_SERVICE_CODES,
  BROWSER_SERVICE_LIMITS,
  BROWSER_SERVICE_REASONS,
  BROWSER_TAB_STATES,
  auditBrowserServiceTables,
  BROWSER_RUNTIME_STATUSES,
  type BrowserTabState,
} from '../../../core/browser/service'
import {
  browserServiceStateFor,
  isNavigableUrl,
  navigableUrl,
  resolveTab,
  runtimeStatusFor,
  tabDisplayTitle,
  tabOriginLabel,
  tabStateFor,
  tabStateIsPublishable,
  reconcileTabState,
} from '../../../core/browser/service'
import { foldBrowserState } from '../../../core/browser'

/**
 * The tab lifecycle, in isolation.
 *
 * The whole reason this file exists is the empty browser panel: a tab that reported itself
 * open, reported no URL, and therefore looked identical to a working tab with nothing loaded.
 * Every assertion below is a way that broken shape could come back, refused.
 */

function ready(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return tabStateFor({
    tabId: 'tab-1',
    sessionId: 'freya-0001',
    surface: 'embedded',
    origin: { kind: 'manual' },
    createdBy: 'user',
    openedAt: 0,
    active: true,
    observation: { kind: 'ready', url: 'https://example.com/', title: 'Example' },
    ...overrides,
  })
}

describe('what counts as an address', () => {
  it('accepts http and https with a host', () => {
    expect(isNavigableUrl('https://example.com/')).toBe(true)
    expect(isNavigableUrl('http://example.com/a?b=c#d')).toBe(true)
  })

  it('refuses every shape that has reached a browser tab and rendered nothing', () => {
    // The empty string is the value that started all of this. It must not be an answer.
    for (const candidate of ['', '   ', 'null', 'undefined', 'about:blank', 'data:text/html,x', 'file:///c:/x', 'javascript:1', 'chrome://settings', 'https://', 'https://user:pw@example.com/']) {
      expect(isNavigableUrl(candidate), `${JSON.stringify(candidate)} should not be navigable`).toBe(false)
    }
  })

  it('coerces to null rather than to the empty string', () => {
    expect(navigableUrl(undefined)).toBeNull()
    expect(navigableUrl('')).toBeNull()
    expect(navigableUrl('https://example.com/')).toBe('https://example.com/')
  })
})

describe('a tab that has not navigated yet', () => {
  it('is creating, with no URL and no error — not blank and not broken', () => {
    const tab = tabStateFor({
      tabId: 'tab-1',
      sessionId: 'freya-0001',
      surface: 'embedded',
      origin: { kind: 'manual' },
      createdBy: 'user',
      openedAt: 0,
      active: true,
      observation: { kind: 'creating' },
    })
    expect(tab.status).toBe('creating')
    expect(tab.url).toBeNull()
    expect(tab.liveUrl).toBeNull()
    expect(tab.error).toBeNull()
    expect(tab.loading).toBe(false)
    expect(tabDisplayTitle(tab)).toBe('New tab')
  })

  it('is creating, not failed, and says so in words rather than in an empty panel', () => {
    // The distinction the original bug collapsed: nothing was attempted, so there is nothing
    // to have failed.
    expect(tabDisplayTitle(tabStateFor({
      tabId: 'tab-1', sessionId: 's', surface: 'embedded', origin: { kind: 'manual' },
      createdBy: 'user', openedAt: 0, active: true, observation: { kind: 'creating' },
    }))).toBe('New tab')
  })
})

describe('a tab that is navigating', () => {
  const navigating = tabStateFor({
    tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
    createdBy: 'user', openedAt: 0, active: true,
    previous: { title: 'Old', liveUrl: 'https://old.example/', revision: 3, loading: false, canGoBack: false, canGoForward: false, error: null, history: ['https://old.example/'], cursor: 0 },
    observation: { kind: 'navigating', url: 'https://new.example/' },
  })

  it('reports the address it is going to', () => {
    expect(navigating.status).toBe('navigating')
    expect(navigating.url).toBe('https://new.example/')
    expect(navigating.loading).toBe(true)
  })

  it('clears the old live URL, because the old page is not on screen any more', () => {
    // `liveUrl` is the field a native view is docked against. Leaving the previous address in
    // it is how a view ends up sitting over a page that has already been replaced.
    expect(navigating.liveUrl).toBeNull()
  })

  it('is refused a navigation to something that is not an address at all', () => {
    const refused = tabStateFor({
      tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
      createdBy: 'user', openedAt: 0, active: true,
      observation: { kind: 'navigating', url: '' },
    })
    expect(refused.status).toBe('failed')
    expect(refused.error).toBe('url-required')
  })
})

describe('a tab that loaded', () => {
  it('is ready, with the address it landed on', () => {
    const tab = ready()
    expect(tab.status).toBe('ready')
    expect(tab.url).toBe('https://example.com/')
    expect(tab.liveUrl).toBe('https://example.com/')
    expect(tab.title).toBe('Example')
    expect(tab.loading).toBe(false)
  })

  it('keeps its history and can say whether it can go back', () => {
    const second = tabStateFor({
      tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
      createdBy: 'user', openedAt: 0, active: true,
      previous: ready().canGoBack ? ready() : { ...ready(), canGoBack: true, history: ['https://example.com/'], cursor: 0 },
      observation: { kind: 'ready', url: 'https://example.com/next', title: null },
    })
    expect(second.canGoBack).toBe(true)
    expect(second.history).toContain('https://example.com/next')
  })

  it('does not grow history when the same address is loaded again', () => {
    const before = ready()
    const after = tabStateFor({
      tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
      createdBy: 'user', openedAt: 0, active: true,
      previous: before,
      observation: { kind: 'ready', url: 'https://example.com/', title: null },
    })
    expect(after.history.length).toBe(before.history.length)
  })

  it('is failed, not ready, when the surface reports a load with no address', () => {
    // THE case. A window said "loaded" and handed back nothing usable. Publishing `ready`
    // here is exactly the bug: a tab that looks live, points nowhere, and renders blank.
    for (const landed of ['', 'about:blank', 'null']) {
      const tab = tabStateFor({
        tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
        createdBy: 'user', openedAt: 0, active: true,
        observation: { kind: 'ready', url: landed, title: 'Something' },
      })
      expect(tab.status, `landed on ${JSON.stringify(landed)}`).toBe('failed')
      expect(tab.liveUrl).toBeNull()
      expect(tab.error).toBe('page-missing')
    }
  })
})

describe('a tab that failed', () => {
  const failed = tabStateFor({
    tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
    createdBy: 'user', openedAt: 0, active: true,
    observation: { kind: 'failed', url: 'https://example.com/', code: 'navigate-failed' },
  })

  it('says what was tried and why it did not happen', () => {
    expect(failed.status).toBe('failed')
    expect(failed.url).toBe('https://example.com/')
    expect(failed.liveUrl).toBeNull()
    expect(failed.error).toBe('navigate-failed')
  })

  it('still shows which site failed, because a blank chip looks like a dead tab', () => {
    expect(tabDisplayTitle(failed)).toBe('example.com')
    expect(tabDisplayTitle({ ...failed, url: null })).toBe('Failed to load')
  })
})

describe('what may cross the boundary', () => {
  it('refuses a ready tab whose live URL is not navigable', () => {
    expect(tabStateIsPublishable({ ...ready(), liveUrl: '' })).toBe(false)
    expect(tabStateIsPublishable({ ...ready(), url: '' })).toBe(false)
    expect(tabStateIsPublishable({ ...ready(), loading: true })).toBe(false)
  })

  it('refuses a non-ready tab that still claims a page is on screen', () => {
    const stale = { ...ready(), status: 'navigating' as const, loading: true }
    expect(tabStateIsPublishable(stale)).toBe(false)
    const repaired = reconcileTabState(stale)
    expect(repaired.status).toBe('failed')
    expect(repaired.liveUrl).toBeNull()
  })

  it('passes every state it should', () => {
    for (const observation of [
      { kind: 'creating' } as const,
      { kind: 'navigating', url: 'https://example.com/' } as const,
      { kind: 'ready', url: 'https://example.com/', title: null } as const,
      { kind: 'failed', url: null, code: 'navigate-failed' } as const,
      { kind: 'closed' } as const,
    ]) {
      const tab = tabStateFor({
        tabId: 'tab-1', sessionId: 'freya-0001', surface: 'embedded', origin: { kind: 'manual' },
        createdBy: 'user', openedAt: 0, active: true, observation,
      })
      expect(tabStateIsPublishable(tab), observation.kind).toBe(true)
    }
  })
})

describe('the runtime status', () => {
  const base = { switchedOn: true, surfaceAvailable: true, journalTrustworthy: true }

  it('is active only when everything is in place', () => {
    expect(runtimeStatusFor(base)).toBe('active')
  })

  it('distinguishes disabled from surfaceUnavailable, which need different repairs', () => {
    expect(runtimeStatusFor({ ...base, switchedOn: false })).toBe('disabled')
    expect(runtimeStatusFor({ ...base, surfaceAvailable: false })).toBe('surfaceUnavailable')
  })

  it('lets an untrustworthy journal outrank both, because nothing is usable without the record', () => {
    expect(runtimeStatusFor({ ...base, switchedOn: false, journalTrustworthy: false })).toBe('journalUntrusted')
    expect(runtimeStatusFor({ ...base, surfaceAvailable: false, journalTrustworthy: false })).toBe('journalUntrusted')
  })

  it('is starting while the stack is still being composed', () => {
    expect(runtimeStatusFor({ ...base, starting: true })).toBe('starting')
  })
})

describe('the state a window reads', () => {
  const withTabs = (tabs: readonly BrowserTabState[]) =>
    browserServiceStateFor({ status: 'active', publicAvailable: true, journalTrustworthy: true, activeTabId: null, tabs, reason: null })

  it('reports ready with zero sessions when there is simply nothing open', () => {
    const state = withTabs([])
    expect(state.runtimeStatus).toBe('active')
    expect(state.available).toBe(true)
    expect(state.reason).toBeNull()
    expect(state.sessions).toEqual([])
    expect(state.tabCount).toBe(0)
  })

  it('never carries a reason while it is active', () => {
    expect(withTabs([ready()]).reason).toBeNull()
    expect(browserServiceStateFor({ status: 'active', publicAvailable: true, journalTrustworthy: true, activeTabId: null, tabs: [], reason: 'stale text' }).reason).toBeNull()
  })

  it('carries a reason whenever it is not active', () => {
    for (const status of BROWSER_RUNTIME_STATUSES) {
      if (status === 'active') continue
      const state = browserServiceStateFor({ status, publicAvailable: false, journalTrustworthy: true, activeTabId: null, tabs: [], reason: 'because' })
      expect(state.reason, status).toBe('because')
      expect(state.available, status).toBe(false)
    }
  })

  it('reports a session with no page as failed rather than as ready', () => {
    const state = withTabs([{ ...ready(), liveUrl: null, url: null }])
    expect(state.sessions[0]?.status).toBe('failed')
    expect(state.sessions[0]?.errorCode).toBe('page-missing')
  })

  it('hides a closed tab from the summary, and reports the count of the ones that remain', () => {
    const state = withTabs([ready(), { ...ready(), status: 'closed', liveUrl: null, url: null }])
    expect(state.sessions).toHaveLength(1)
    expect(state.tabCount).toBe(1)
  })

  it('gives each session enough to diagnose it and no more', () => {
    const state = withTabs([ready()])
    expect(Object.keys(state.sessions[0] ?? {}).sort()).toEqual(
      ['createdBy', 'errorCode', 'sessionId', 'status', 'surface', 'title', 'url'],
    )
  })
})

describe('resolving a tab', () => {
  const tabs = [ready({ tabId: 'a', active: false }), ready({ tabId: 'b', active: true })]

  it('uses the front tab when no id is given, never the newest one', () => {
    expect(resolveTab(tabs, null)?.tabId).toBe('b')
  })

  it('finds a tab by id, and refuses an unknown one', () => {
    expect(resolveTab(tabs, 'a')?.tabId).toBe('a')
    expect(resolveTab(tabs, 'zz')).toBeNull()
  })
})

describe('provenance labels', () => {
  it('distinguishes the four kinds without inventing a fifth', () => {
    expect(tabOriginLabel({ kind: 'manual' })).toBe('manual')
    expect(tabOriginLabel({ kind: 'link', from: 'chat', ownerText: 'x' })).toBe('from chat')
    expect(tabOriginLabel({ kind: 'handoff', fromSession: 'freya-0001' })).toBe('handoff')
  })
})

describe('the journal and the live surface are different vocabularies', () => {
  it('folds a session opened with an attribution into the attribution', () => {
    const state = foldBrowserState([
      { type: 'browser.dual.session.opened', payload: { sessionId: 'freya-0001', target: 'public', createdBy: 'user', at: 'now' } },
    ])
    expect(state.sessions.get('freya-0001')?.createdBy).toBe('user')
  })

  it('defaults to freya when no attribution was recorded, rather than crediting the owner', () => {
    const state = foldBrowserState([
      { type: 'browser.dual.session.opened', payload: { sessionId: 'freya-0002', target: 'public', at: 'now' } },
    ])
    expect(state.sessions.get('freya-0002')?.createdBy).toBe('freya')
  })

  it('never folds a page.replaced with no address into a ready session', () => {
    // The defence in depth: even if something upstream wrote an empty URL into the journal,
    // the fold will not turn it into a page the owner can be shown.
    const state = foldBrowserState([
      { type: 'browser.dual.session.opened', payload: { sessionId: 'freya-0003', target: 'public', at: 'now' } },
      { type: 'browser.dual.page.replaced', payload: { sessionId: 'freya-0003', revision: 4, url: '', at: 'now' } },
    ])
    const entry = state.sessions.get('freya-0003')
    expect(entry?.page).not.toBe('ready')
  })
})

describe('the tables audit', () => {
  it('is clean', () => {
    expect(auditBrowserServiceTables()).toEqual([])
  })

  it('has a reason a person can act on for every refusal code', () => {
    for (const code of BROWSER_SERVICE_CODES) {
      expect(BROWSER_SERVICE_REASONS[code].length, code).toBeGreaterThanOrEqual(24)
    }
  })

  it('can still name four distinct reasons for nothing being on screen', () => {
    // The whole reason the vocabulary has five states: one word per fact.
    expect(BROWSER_TAB_STATES.length).toBe(5)
  })

  it('holds at least ten tabs, which is the multi-tab target', () => {
    expect(BROWSER_SERVICE_LIMITS.maxTabs).toBeGreaterThanOrEqual(10)
  })
})