// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SemanticSnapshot } from '../../../core/browser/service'
import { auditSemanticBrowserService, SEMANTIC_BROWSER_OPS } from '../../../core/browser/service'
import { auditBrowserTables, BROWSER_COMMANDS } from '../../../core/browser/types'
import { harness, ScriptedSurfacePage, type Harness } from './service-harness'

/**
 * The Semantic Browser Protocol, and the nine states the browser workspace has to tell apart.
 *
 * The first nine `describe` blocks are the reproduction and the fix for the bug this whole
 * change exists for: a browser tab that reported itself open, reported no URL, and rendered
 * as an empty panel indistinguishable from a working one. Each block is one of those states,
 * and each asserts on the state a *window* would be handed — not on an internal field.
 */

const URL_A = 'https://alpha.example.com/contact'
const URL_B = 'https://beta.example.com/'
const URL_C = 'https://gamma.example.com/'

async function snapshotOf(h: Harness, tabId?: string): Promise<SemanticSnapshot> {
  const result = await h.ok({ op: 'snapshot', ...(tabId === undefined ? {} : { tabId }) })
  return result.data.snapshot as SemanticSnapshot
}

async function openAll(h: Harness, urls: readonly string[]): Promise<readonly string[]> {
  const ids: string[] = []
  for (const url of urls) {
    const opened = await h.ok({ op: 'open', url, createdBy: 'user', activate: false })
    ids.push(String(opened.data.tabId))
  }
  return ids
}

/* --------------------------------------------------------- 1. valid handoff */

describe('1 — a handoff session with a valid URL becomes a real visible page', () => {
  it('reports ready, with the address and the title a window can draw', async () => {
    const h = harness()
    const opened = await h.ok({ op: 'open', url: URL_A, createdBy: 'freya' })
    const tab = h.service.tabs().find((candidate) => candidate.tabId === opened.data.tabId)
    expect(tab?.status).toBe('ready')
    expect(tab?.url).toBe(URL_A)
    expect(tab?.liveUrl).toBe(URL_A)
    expect(tab?.createdBy).toBe('freya')
    expect(tab?.surface).toBe('embedded')
  })

  it('is described through the gates, not around them', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    await h.ok({ op: 'snapshot' })
    expect(h.authority.actionKeys()).toEqual(['browser.navigate', 'browser.read-text'])
  })

  it('reports no reason while it is working', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const state = h.state()
    expect(state.runtimeStatus).toBe('active')
    expect(state.reason).toBeNull()
    expect(state.available).toBe(true)
  })
})

/* --------------------------------------------------------- 2. pending handoff */

describe('2 — a pending session with no URL is an explicit pending state', () => {
  it('is creating, not ready, and not failed', async () => {
    const h = harness()
    const opened = await h.ok({ op: 'open', url: null, createdBy: 'user' })
    const tab = h.service.tabs().find((candidate) => candidate.tabId === opened.data.tabId)
    expect(tab?.status).toBe('creating')
    expect(tab?.url).toBeNull()
    expect(tab?.error).toBeNull()
  })

  it('says so in the state a window reads, as a distinct status', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: null, createdBy: 'user' })
    expect(h.state().sessions[0]?.status).toBe('creating')
  })

  it('refuses to act on it, as pending rather than as a missing tab', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: null, createdBy: 'user' })
    await h.refused({ op: 'snapshot' }, 'page-missing')
    await h.refused({ op: 'click', ref: 'r1', revision: 1 }, 'page-missing')
  })

  it('becomes ready the moment it is given an address, without changing its tab id', async () => {
    const h = harness()
    const opened = await h.ok({ op: 'open', url: null, createdBy: 'user' })
    await h.ok({ op: 'navigate', tabId: String(opened.data.tabId), url: URL_A })
    const tab = h.service.tabs().find((candidate) => candidate.tabId === opened.data.tabId)
    expect(tab?.status).toBe('ready')
    expect(tab?.tabId).toBe(opened.data.tabId)
  })
})

/* -------------------------------------------------------- 3. failed session */

describe('3 — a session that tried and failed is an explicit failure state', () => {
  it('is failed, with a code and nothing claimed to be on screen', async () => {
    const h = harness({ create: (sessionId) => new ScriptedSurfacePage(sessionId, { alwaysFailNavigate: true }) })
    await h.ready()
    const result = await h.service.run({ op: 'open', url: URL_A, createdBy: 'user' })
    expect(result.ok).toBe(false)
    const tab = h.service.tabs()[0]
    expect(tab?.status).toBe('failed')
    expect(tab?.liveUrl).toBeNull()
    expect(tab?.error).not.toBeNull()
  })

  it('reports failed in the state a window reads', async () => {
    const h = harness({ create: (sessionId) => new ScriptedSurfacePage(sessionId, { alwaysFailNavigate: true }) })
    await h.ready()
    await h.service.run({ op: 'open', url: URL_A, createdBy: 'user' })
    expect(h.state().sessions[0]?.status).toBe('failed')
    expect(h.state().sessions[0]?.errorCode).not.toBeNull()
  })

  it('is failed, not ready, when the page reports a load with no address at all', async () => {
    // The exact original failure, reproduced: the window says it navigated and hands back
    // nothing. Before the fix this became a `ready` session with an empty URL, adopted by the
    // renderer as a tab, and drawn as an empty browser panel.
    const h = harness({ create: (sessionId) => new ScriptedSurfacePage(sessionId, { navigateLandsNowhere: true }) })
    await h.ready()
    const result = await h.service.run({ op: 'open', url: URL_A, createdBy: 'user' })
    expect(result.ok).toBe(false)
    expect(h.service.tabs()[0]?.status).not.toBe('ready')
    expect(h.service.tabs()[0]?.liveUrl).toBeNull()
  })

  it('leaves no empty handoff tab behind, whatever the failure', async () => {
    const h = harness({ create: (sessionId) => new ScriptedSurfacePage(sessionId, { navigateLandsNowhere: true }) })
    await h.ready()
    await h.service.run({ op: 'open', url: URL_A, createdBy: 'user' })
    const state = h.state()
    // One tab, and it is honestly failed. The old build produced one tab that looked ready and
    // had no address, which the renderer drew as an empty browser.
    expect(state.tabCount).toBe(1)
    expect(state.tabs.filter((tab) => tab.status === 'ready' && !tab.liveUrl)).toHaveLength(0)
  })

})

/* ------------------------------------------------- 4. runtime unavailable */

describe('4 — a runtime that is switched off says so', () => {
  it('refuses every operation as disabled, before touching anything', async () => {
    const h = harness({ active: false })
    await h.refused({ op: 'open', url: URL_A, createdBy: 'user' }, 'subsystem-disabled')
    await h.refused({ op: 'snapshot' }, 'subsystem-disabled')
    expect(h.authority.calls).toHaveLength(0)
  })

  it('reports disabled, with a reason, and no sessions', () => {
    const state = harness({ active: false }).state()
    expect(state.runtimeStatus).toBe('disabled')
    expect(state.available).toBe(false)
    expect(state.reason).toBeTruthy()
    expect(state.sessions).toEqual([])
  })

  it('distinguishes a disabled runtime from one with no embedded page', () => {
    expect(harness({ available: false }).state().runtimeStatus).toBe('surfaceUnavailable')
  })
})

/* ---------------------------------------------------- 5. journal untrusted */

describe('5 — an untrustworthy journal says so and opens nothing', () => {
  it('reports journalUntrusted, which is not the same refusal as disabled', () => {
    const state = harness({ journalTrustworthy: false }).state()
    expect(state.runtimeStatus).toBe('journalUntrusted')
    expect(state.journalTrustworthy).toBe(false)
    expect(state.reason).toContain('journal')
  })

  it('refuses an open rather than creating a tab nobody can trust', async () => {
    const h = harness({ journalTrustworthy: false })
    await h.refused({ op: 'open', url: URL_A, createdBy: 'user' }, 'subsystem-disabled')
    expect(h.service.tabs()).toHaveLength(0)
  })

  it('refuses even a read, because a record nobody has read is not a record to act on', async () => {
    const h = harness({ journalTrustworthy: false })
    await h.refused({ op: 'open', url: URL_A, createdBy: 'user' }, 'subsystem-disabled')
    expect(h.authority.calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------ 6. no sessions */

describe('6 — no sessions is a normal, ready, empty workspace', () => {
  it('reports active with zero tabs and no reason', () => {
    const state = harness().state()
    expect(state.runtimeStatus).toBe('active')
    expect(state.tabCount).toBe(0)
    expect(state.sessions).toEqual([])
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBeNull()
    expect(state.reason).toBeNull()
  })

  it('is not confused with a runtime that cannot open one', () => {
    // The distinction the previous projection could not make: both are `available: false`.
    const empty = harness().state()
    const unavailable = harness({ active: false }).state()
    expect(empty.available).toBe(true)
    expect(unavailable.available).toBe(false)
    expect(empty.runtimeStatus).toBe('active')
    expect(unavailable.runtimeStatus).toBe('disabled')
  })

  it('lists zero tabs without complaining', async () => {
    const h = harness()
    const listed = await h.ok({ op: 'tabs' })
    expect(listed.data.count).toBe(0)
    expect(listed.data.activeTabId).toBeNull()
  })
})

/* ------------------------------------------- 7. url changes after creation */

describe('7 — a session whose address changes updates its tab, and keeps its identity', () => {
  it('moves the same tab to the new address', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    const tab = h.service.tab(String(tabId))
    expect(tab?.url).toBe(URL_C)
    expect(tab?.liveUrl).toBe(URL_C)
    expect(tab?.status).toBe('ready')
  })

  it('does not mint a second tab, because identity is the tab id and not the address', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    expect(h.service.tabs()).toHaveLength(1)
  })

  it('retires every reference the old address minted', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const before = await snapshotOf(h, String(tabId))
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    await h.refused({ op: 'click', tabId: String(tabId), ref: before.elements[0]?.ref ?? 'r1', revision: before.revision }, 'stale-reference')
  })

  it('reloads the address the tab is on now, never a remembered one', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    await h.ok({ op: 'reload', tabId: String(tabId) })
    expect(h.service.tab(String(tabId))?.liveUrl).toBe(URL_C)
  })

  it('refuses an address the URL policy will not open, without moving the tab', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.refused({ op: 'navigate', tabId: String(tabId), url: 'http://192.168.0.1/' }, 'url-refused')
    expect(h.service.tab(String(tabId))?.liveUrl).toBe(URL_A)
  })

  it('refuses a script address outright', async () => {
    const h = harness()
    await h.refused({ op: 'open', url: 'javascript:alert(1)', createdBy: 'user' }, 'url-refused')
    expect(h.service.tabs()).toHaveLength(0)
  })
})

/* ------------------------------------------------------ 8. closed session */

describe('8 — a closed session closes its tab and releases its view', () => {
  it('removes the tab', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'close', tabId: String(tabId) })
    expect(h.service.tabs()).toHaveLength(0)
  })

  it('releases the surface view, so no page runs with nothing owning it', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const sessionId = h.service.tab(String(tabId))?.sessionId ?? ''
    expect(h.pages.has(sessionId)).toBe(true)
    await h.ok({ op: 'close', tabId: String(tabId) })
    expect(h.pages.has(sessionId)).toBe(false)
  })

  it('closes the session in the routed runtime, so the journal records it', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'close', tabId: String(tabId) })
    expect(h.journal.types).toContain('browser.dual.session.closed')
  })

  it('moves the front tab to a neighbour rather than to nothing', async () => {
    const h = harness()
    const ids = await openAll(h, [URL_A, URL_B])
    await h.ok({ op: 'activate', tabId: String(ids[0]) })
    await h.ok({ op: 'close', tabId: String(ids[0]) })
    expect(h.service.activeTabId()).toBe(String(ids[1]))
  })

  it('refuses to act on a tab that is gone', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'close', tabId: String(tabId) })
    await h.refused({ op: 'snapshot', tabId: String(tabId) }, 'tab-unknown')
  })
})

/* ------------------------------------------------ 9. multiple sessions */

describe('9 — many sessions make many tabs, not one overwritten tab', () => {
  it('opens ten and keeps ten distinct tabs', async () => {
    const h = harness({ maxTabs: 12 })
    const urls = Array.from({ length: 10 }, (_unused, index) => `https://site${String(index + 1)}.example.com/`)
    const ids = await openAll(h, urls)
    expect(ids).toHaveLength(10)
    expect(new Set(ids).size).toBe(10)
    expect(h.service.tabs()).toHaveLength(10)
  })

  it('gives every tab the address it was opened with', async () => {
    const h = harness({ maxTabs: 12 })
    const urls = Array.from({ length: 10 }, (_unused, index) => `https://site${String(index + 1)}.example.com/`)
    await openAll(h, urls)
    expect(h.service.tabs().map((tab) => tab.url).sort()).toEqual([...urls].sort())
  })

  it('opens ten real pages, one view each', async () => {
    const h = harness({ maxTabs: 12 })
    const urls = Array.from({ length: 10 }, (_unused, index) => `https://site${String(index + 1)}.example.com/`)
    await openAll(h, urls)
    expect(h.pages.size).toBe(10)
    expect(new Set([...h.pages.keys()]).size).toBe(10)
  })

  it('identifies one active tab and switches between them', async () => {
    const h = harness({ maxTabs: 12 })
    const ids = await openAll(h, [URL_A, URL_B, URL_C])
    await h.ok({ op: 'activate', tabId: String(ids[1]) })
    expect(h.service.activeTabId()).toBe(String(ids[1]))
    expect(h.service.tabs().filter((tab) => tab.active)).toHaveLength(1)
  })

  it('keeps a navigation in one tab out of every other', async () => {
    const h = harness({ maxTabs: 12 })
    const ids = await openAll(h, [URL_A, URL_B, URL_C])
    await h.ok({ op: 'navigate', tabId: String(ids[0]), url: 'https://alpha.example.com/contact-us' })
    expect(h.service.tab(String(ids[0]))?.liveUrl).toBe('https://alpha.example.com/contact-us')
    expect(h.service.tab(String(ids[1]))?.liveUrl).toBe(URL_B)
    expect(h.service.tab(String(ids[2]))?.liveUrl).toBe(URL_C)
  })

  it('closes one and leaves the other nine intact', async () => {
    const h = harness({ maxTabs: 12 })
    const ids = await openAll(h, Array.from({ length: 10 }, (_unused, index) => `https://site${String(index + 1)}.example.com/`))
    await h.ok({ op: 'close', tabId: String(ids[4]) })
    const remaining = h.service.tabs()
    expect(remaining).toHaveLength(9)
    expect(remaining.every((tab) => tab.status === 'ready')).toBe(true)
  })

  it('describes the selected tab, and only that one', async () => {
    const h = harness({ maxTabs: 12 })
    const ids = await openAll(h, [URL_A, URL_B])
    await h.ok({ op: 'activate', tabId: String(ids[0]) })
    const described = await snapshotOf(h)
    expect(described.tabId).toBe(String(ids[0]))
    expect(described.url).toBe(URL_A)
  })

  it('refuses an eleventh tab rather than silently dropping one', async () => {
    const h = harness({ maxTabs: 10 })
    await openAll(h, Array.from({ length: 10 }, (_unused, index) => `https://site${String(index + 1)}.example.com/`))
    await h.refused({ op: 'open', url: 'https://eleven.example.com/', createdBy: 'user' }, 'tab-budget')
    expect(h.service.tabs()).toHaveLength(10)
  })

  it('lists every tab with its identity, state and address', async () => {
    const h = harness({ maxTabs: 12 })
    await openAll(h, [URL_A, URL_B])
    const listed = await h.ok({ op: 'tabs' })
    const rows = listed.data.tabs as { tabId: string; url: string | null; status: string; createdBy: string }[]
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.tabId !== '' && row.createdBy === 'user')).toBe(true)
  })
})

/* ------------------------------------------- semantic control and references */

describe('semantic snapshots and references', () => {
  it('describes the page as references in document order, with names', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    expect(snapshot.revision).toBeGreaterThan(0)
    expect(snapshot.url).toBe(URL_A)
    expect(snapshot.elements.map((element) => element.ref)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(snapshot.elements.some((element) => element.name === 'Contact')).toBe(true)
  })

  it('carries the page text and a rendering a caller can read without re-formatting it', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, { text: 'Contact us at the address below.' }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    expect(snapshot.text).toContain('Contact us')
    expect(snapshot.rendered).toContain('revision:')
    expect(snapshot.rendered).toContain('[r2] link "Contact"')
  })

  it('marks truncated text rather than handing back a fragment with no marker', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, { text: 'x'.repeat(9_000) }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.rendered).toContain('the page text was cut')
  })

  it('clicks a reference through the gated path, not around it', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    const contact = snapshot.elements.find((element) => element.name === 'Contact')
    await h.ok({ op: 'click', ref: contact?.ref ?? 'r2', revision: snapshot.revision })
    expect(h.authority.actionKeys()).toEqual(['browser.navigate', 'browser.read-text', 'browser.click'])
  })

  it('hands the gated layer a locator it already trusts, not a raw selector from the caller', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.ok({ op: 'click', ref: 'r2', revision: snapshot.revision })
    const last = h.authority.calls.at(-1)
    expect(last?.input.selector).toBe('#contact')
    expect(Object.keys(last?.input ?? {})).toContain('url')
  })

  it('refuses a selector in place of a reference', async () => {
    // The caller is not allowed to aim the browser; it is only allowed to point at something a
    // snapshot handed it.
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: '#continue', revision: snapshot.revision }, 'ref-unknown')
  })

  it('refuses a protected field', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, {
      elements: [{ kind: 'field', label: 'Password', selector: '#pw', protected: true }],
    }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    expect(snapshot.elements[0]?.protected).toBe(true)
    await h.refused({ op: 'click', ref: 'r1', revision: snapshot.revision }, 'protected-field')
  })

  it('refuses a disabled element rather than reporting an act that could not happen', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, {
      elements: [{ kind: 'button', label: 'Buy', selector: '#buy', disabled: true }],
    }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: 'r1', revision: snapshot.revision }, 'element-disabled')
  })

  it('refuses a destructive-sounding control while Freya is in no-delete mode', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, {
      elements: [{ kind: 'button', label: 'Delete account', selector: '#del' }],
    }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: 'r1', revision: snapshot.revision }, 'element-delete-refused')
    expect(h.pages.get('freya-0001')?.calls).not.toContain('click:#del')
  })

  it('refuses an authentication control with owner_action_required', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, {
      elements: [{ kind: 'button', label: 'Sign in with authenticator app', selector: '#mfa' }],
    }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: 'r1', revision: snapshot.revision }, 'owner-action-required')
  })

  it('reports a gate refusal as the gate refusing, and not as the page failing', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    h.authority.refuseWith = 'approval-required'
    await h.refused({ op: 'click', ref: 'r2', revision: snapshot.revision }, 'authority-refused')
  })

  it('reports a page that did nothing as not done, rather than as a success', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, { clickChanges: false }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: 'r2', revision: snapshot.revision }, 'adapter-failed')
  })

  it('types into a field through the gated path', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.ok({ op: 'type', ref: 'r4', revision: snapshot.revision, text: 'hello' })
    expect(h.authority.actionKeys().at(-1)).toBe('browser.type-text')
  })

  it('needs text before it will ask for a keystroke', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'type', ref: 'r4', revision: snapshot.revision, text: '' }, 'request-malformed')
    expect(h.authority.calls).toHaveLength(2)
  })

  it('chooses a listed option, and refuses one that was not listed', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, {
      elements: [{ kind: 'field', label: 'Country', selector: '#country', options: ['Sri Lanka', 'Japan'] }],
    }) })
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    const chosen = await h.ok({ op: 'select', ref: 'r1', revision: snapshot.revision, index: 0 })
    expect(chosen.data.selected).toBe('Sri Lanka')
    await h.refused({ op: 'select', ref: 'r1', revision: snapshot.revision, index: 9 }, 'adapter-failed')
  })

  it('scrolls to the bottom and back, and records both', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const bottom = await h.ok({ op: 'scroll', to: 'bottom' })
    expect(bottom.data.top).toBe(4_000)
    const top = await h.ok({ op: 'scroll', to: 'top' })
    expect(top.data.top).toBe(0)
    expect(h.journal.types).toContain('browser.dual.page.scrolled')
  })

  it('refuses a scroll rather than reporting a sized-nowhere viewport as success', async () => {
    const h = harness()
    const opened = await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const sessionId = h.service.tab(String(opened.data.tabId))!.sessionId
    // An embedded view that was never docked has no viewport, so the document
    // reports a height of 0. That is not "the page is at the top".
    h.page(sessionId).scrollHeight = 0
    await h.refused({ op: 'scroll', to: 'bottom' }, 'surface-unavailable')
  })

  it('waits for a settle, and reports the address it settled on', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const waited = await h.ok({ op: 'wait', settleMs: 500 })
    expect(waited.data.url).toBe(URL_A)
  })

  it('moves back and forward through history', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    expect(h.service.tab(String(tabId))?.canGoBack).toBe(true)
    await h.ok({ op: 'back', tabId: String(tabId) })
    expect(h.service.tab(String(tabId))?.liveUrl).toBe(URL_A)
    expect(h.service.tab(String(tabId))?.canGoForward).toBe(true)
    await h.ok({ op: 'forward', tabId: String(tabId) })
    expect(h.service.tab(String(tabId))?.liveUrl).toBe(URL_C)
  })

  it('refuses to go back when there is nothing earlier', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    await h.refused({ op: 'back', tabId: String(tabId) }, 'page-missing')
  })
})

/* --------------------------------------------------- revision safety */

describe('revision and stale references', () => {
  it('acts on the revision it was handed', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.ok({ op: 'click', ref: 'r2', revision: snapshot.revision })
  })

  it('refuses an action that named an older revision', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.ok({ op: 'navigate', url: URL_C })
    await h.refused({ op: 'click', ref: 'r2', revision: snapshot.revision - 1 }, 'stale-reference')
  })

  it('refuses an action that named a future revision, rather than guessing', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: 'r2', revision: snapshot.revision + 99 }, 'stale-reference')
  })

  it('refuses an action that named no revision at all', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    await snapshotOf(h)
    const result = await h.service.run({ op: 'click', ref: 'r2', revision: Number.NaN })
    expect(result.ok).toBe(false)
  })

  it('refuses a reference that was never minted for this page', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const snapshot = await snapshotOf(h)
    await h.refused({ op: 'click', ref: 'r99', revision: snapshot.revision }, 'ref-unknown')
  })

  it('refuses a reference the page has moved past, and says which revision it came from', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const first = await snapshotOf(h, String(tabId))
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    const refused = await h.refused({ op: 'click', tabId: String(tabId), ref: 'r2', revision: first.revision }, 'stale-reference')
    expect(refused.reason).toContain(String(first.revision))
  })

  it('refuses a click on a page that navigated on its own, even at the right revision', async () => {
    // The case a revision number alone cannot catch. The page's own counter has moved past
    // the snapshot, so every reference in it names a document the caller never read — and the
    // numbers still agree.
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const snapshot = await snapshotOf(h, String(tabId))
    const sessionId = h.service.tab(String(tabId))?.sessionId ?? ''
    h.page(sessionId).drift('https://alpha.example.com/somewhere-else')
    await h.refused({ op: 'click', tabId: String(tabId), ref: 'r2', revision: snapshot.revision }, 'stale-reference')
  })

  it('gives a caller a fresh snapshot at the page it actually moved to', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const first = await snapshotOf(h, String(tabId))
    const sessionId = h.service.tab(String(tabId))?.sessionId ?? ''
    h.page(sessionId).drift('https://alpha.example.com/moved')
    const second = await snapshotOf(h, String(tabId))
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.url).toBe('https://alpha.example.com/moved')
    expect(second.superseded).toBe(false)
  })

  it('lets a caller continue after taking a fresh snapshot', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const first = await snapshotOf(h, String(tabId))
    await h.ok({ op: 'navigate', tabId: String(tabId), url: URL_C })
    await h.refused({ op: 'click', tabId: String(tabId), ref: 'r2', revision: first.revision }, 'stale-reference')
    const second = await snapshotOf(h, String(tabId))
    expect(second.revision).toBeGreaterThan(first.revision)
    await h.ok({ op: 'click', tabId: String(tabId), ref: 'r2', revision: second.revision })
  })
})

/* ------------------------------------------------------------- push, not poll */

describe('state arrives by push', () => {
  it('publishes when a tab is opened, activated and closed', async () => {
    const h = harness()
    const seen: string[] = []
    h.service.subscribe((state) => seen.push(`${String(state.tabCount)}/${String(state.activeTabId)}`))
    const opened = await h.ok({ op: 'open', url: URL_A, createdBy: 'user' })
    const [second] = await openAll(h, [URL_B])
    await h.ok({ op: 'activate', tabId: String(second) })
    await h.ok({ op: 'close', tabId: String(opened.data.tabId) })
    expect(seen.length).toBeGreaterThan(3)
    expect(seen.at(-1)).toBe(`1/${String(second)}`)
  })

  it('publishes when the page navigates by itself, without anybody asking', async () => {
    const h = harness()
    const [tabId] = await openAll(h, [URL_A])
    const seen: number[] = []
    h.service.subscribe((state) => seen.push(state.tabCount))
    const sessionId = h.service.tab(String(tabId))?.sessionId ?? ''
    h.page(sessionId).drift('https://alpha.example.com/contact')
    expect(seen.at(-1)).toBe(1)
    expect(h.service.tab(String(tabId))?.liveUrl).toBe('https://alpha.example.com/contact')
  })

  it('leaves an unpublishable state unpublishable: no session is ever ready with no address', async () => {
    const h = harness()
    await h.ok({ op: 'open', url: null, createdBy: 'user' })
    h.service.subscribe(() => undefined)
    for (const tab of h.service.tabs()) {
      if (tab.status === 'ready') expect(tab.liveUrl).toBeTruthy()
    }
    expect(h.service.tabs().filter((tab) => tab.status === 'ready' && !tab.liveUrl)).toHaveLength(0)
  })
})

/* ------------------------------------------------------------- the audit */

describe('the protocol vocabulary audit', () => {
  it('is clean', () => {
    expect(auditSemanticBrowserService()).toEqual([])
  })

  it('has no way to run code in a page or read what the owner typed', () => {
    for (const op of SEMANTIC_BROWSER_OPS) {
      for (const banned of ['eval', 'execute', 'script', 'inject', 'cookie', 'storage', 'password', 'token', 'keyring']) {
        expect(op.includes(banned), `${op} contains ${banned}`).toBe(false)
      }
    }
  })

  /**
   * `screenshot` is allowed here because the pixels are the owner's, not the
   * model's: the routed command vocabulary still bans a capture command, so this
   * read cannot enter the Phase 51 runtime, and the tool's summary tells the model
   * outright that it has not seen the image. These two are what keep that true,
   * and they are checked in the places that own them — see
   * `browser-tabs-tool.test.ts` for the summary, and `types.ts` for the routed
   * vocabulary's own ban.
   */
  it('still refuses a capture command in the routed vocabulary', () => {
    expect(auditBrowserTables()).toEqual([])
    for (const command of BROWSER_COMMANDS) {
      for (const banned of ['screenshot', 'capture']) {
        expect(command.toLowerCase().includes(banned), `${command} contains ${banned}`).toBe(false)
      }
    }
  })
})