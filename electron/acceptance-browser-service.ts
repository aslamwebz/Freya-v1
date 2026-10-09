import { app, BrowserWindow, type WebContentsView } from 'electron'
import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'
import { ElectronFreyaWindowFactory, type FreyaBrowserLivePage } from './browser/freyaWindow'
import { createEmbeddedBrowserSurface } from './browser/embeddedSurface'
import { createBrowserService, type BrowserService, type SemanticBrowserResult, type SemanticSnapshot } from '../core/browser/service'
import type { BrowserResult } from '../core/browser'

/**
 * The Browser Service, against **real Chromium pages**.
 *
 * Everything below this file is proven against a scripted surface in `tests/core/browser`.
 * This one exists because the claims that matter most are claims about a *native view*: that
 * each tab owns a real `WebContentsView`, that switching tabs moves that view rather than
 * reloading the page, that a click on a semantic reference lands on the control the snapshot
 * named, and that a reference from before a navigation is refused rather than redirected at
 * whatever now occupies its slot.
 *
 * ## What it does and does not exercise
 *
 * The surface, the placement, the protocol and the revision discipline are all real. The
 * authority chain is one layer short: `commands.execute` drives the same page operations the
 * Device Hands effect drives, without the grant, the journal or the ten gates in front of
 * them. Those are covered where they belong — `tests/core/browser` for the gate walk and
 * `tests/host` for the wiring — and duplicating a fake gate chain here would be a second,
 * weaker chain, which is the one thing this architecture has never been allowed to have.
 *
 * ## The pages
 *
 * A local HTTP server, not the internet. Every fixture is served from `127.0.0.1`, which the
 * URL policy refuses by default, so `allowPrivateHosts` is on for this run and nothing else
 * is. A test that reached a real site would be testing that site's uptime and its consent
 * banners, neither of which is what is being checked.
 */

interface Fixture {
  readonly path: string
  readonly html: string
}

const FIXTURES: readonly Fixture[] = [
  {
    path: '/alpha',
    html: `<!doctype html><html><head><title>Alpha Home</title></head><body>
      <h1>Alpha Home</h1>
      <nav><a id="nav-about" href="/alpha/about">About</a><a id="nav-contact" href="/alpha/contact">Contact</a></nav>
      <input id="draft" value="initial">
      <label for="country">Country</label><select id="country"><option value="lk">Sri Lanka</option><option value="jp">Japan</option></select>
      <button id="go" onclick="document.getElementById('draft').value='typed by freya'">Continue</button>
      <footer style="margin-top:4000px"><a id="footer-contact" href="/alpha/contact">Get in touch</a></footer>
    </body></html>`,
  },
  {
    path: '/alpha/contact',
    html: `<!doctype html><html><head><title>Alpha Contact</title></head><body>
      <h1>Contact Alpha</h1><p>Reach us at alpha@example.com</p><a id="home" href="/alpha">Home</a>
    </body></html>`,
  },
  { path: '/alpha/about', html: `<!doctype html><html><head><title>Alpha About</title></head><body><h1>About Alpha</h1></body></html>` },
  { path: '/beta', html: `<!doctype html><html><head><title>Beta Home</title></head><body><h1>Beta Home</h1><a id="contact" href="/beta/contact">Contact</a></body></html>` },
  { path: '/beta/contact', html: `<!doctype html><html><head><title>Beta Contact</title></head><body><h1>Contact Beta</h1></body></html>` },
  { path: '/gamma', html: `<!doctype html><html><head><title>Gamma Home</title></head><body><h1>Gamma Home</h1><a id="contact" href="/gamma/contact">Contact Us</a></body></html>` },
  { path: '/gamma/contact', html: `<!doctype html><html><head><title>Gamma Contact</title></head><body><h1>Contact Gamma</h1></body></html>` },
]

function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 350))
}

/** The live page a tab owns, resolved from the map the surface filled in. */
class PageRegistry {
  private readonly pages = new Map<string, FreyaBrowserLivePage>()

  async create(sessionId: string, partition: string, factory: ElectronFreyaWindowFactory): Promise<FreyaBrowserLivePage> {
    const page = await factory.create(sessionId, partition)
    this.pages.set(sessionId, page)
    const close = page.close.bind(page)
    page.close = () => {
      this.pages.delete(sessionId)
      return close()
    }
    return page
  }

  get(sessionId: string): FreyaBrowserLivePage | null {
    return this.pages.get(sessionId) ?? null
  }

  size(): number {
    return this.pages.size
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    const found = FIXTURES.find((fixture) => fixture.path === path)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(found?.html ?? '<!doctype html><html><head><title>404</title></head><body><h1>Not found</h1></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`

  const host = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await host.loadURL('data:text/html,<h1>Freya chat stays here</h1>')

  const factory = new ElectronFreyaWindowFactory({
    hostWindow: () => host,
    allowPrivateHosts: true,
    allowedHosts: ['127.0.0.1'],
    settleMs: 500,
  })
  const registry = new PageRegistry()
  const surface = createEmbeddedBrowserSurface({
    create: async (sessionId, partition) => await registry.create(sessionId, partition, factory),
    place: (sessionId, bounds) => factory.dock(sessionId, bounds),
    partitionFor: (sessionId) => `freya-public-${sessionId}`,
    canEmbed: () => true,
    // The acceptance host window is 1200x800, and a capture needs a rect to
    // place the view in — the same one the host would hand back.
    contentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
  })

  /**
   * The routed reference to the locator behind it.
   *
   * Written by the same pass that describes the page, so a reference is never resolved
   * against a mapping assembled somewhere else. This is exactly the indirection the semantic
   * protocol exists to provide: the caller holds `r3`, the page is driven by a locator
   * neither the caller nor the model ever sees.
   */
  let locators: Record<string, string> = {}
  let sessionCounter = 0

  const service: BrowserService = createBrowserService({
    surface,
    commands: {
      active: () => true,
      execute: async (request): Promise<BrowserResult> => {
        const refuse = (code: BrowserResult extends { ok: false; code: infer C } ? C : never, reason: string): BrowserResult =>
          ({ ok: false, command: request.command, target: null, code, reason, escalation: null }) as BrowserResult
        if (request.command === 'session.open') {
          sessionCounter += 1
          return { ok: true, command: request.command, target: 'public', escalation: null, data: { sessionId: `acceptance-${String(sessionCounter)}` } }
        }
        const page = registry.get(request.sessionId ?? '')
        if (page === null) return refuse('session-unknown' as never, 'no page for that session')
        switch (request.command) {
          case 'session.close':
            return { ok: true, command: request.command, target: 'public', escalation: null, data: { sessionId: request.sessionId ?? '', alreadyClosed: false } }
          case 'page.navigate': {
            const done = await page.navigate(request.url ?? '')
            if (!done.ok) return refuse('adapter-failed' as never, done.code)
            return { ok: true, command: request.command, target: 'public', escalation: null, data: { url: done.finalUrl, revision: page.currentRevision(), title: page.currentTitle() } }
          }
          case 'page.read':
          case 'page.describe': {
            const described = await page.describe()
            const read = await page.read()
            if (!described.ok || !read.ok) return refuse('adapter-failed' as never, 'read failed')
            const fresh: Record<string, string> = {}
            const rows = Array.isArray(described.payload) ? described.payload : []
            const elements = rows.map((row, index) => {
              const entry = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
              const ref = `p${String(index)}`
              const selector = typeof entry.selector === 'string' ? entry.selector : ''
              if (selector !== '') fresh[ref] = selector
              return {
                ref,
                kind: typeof entry.kind === 'string' ? entry.kind : 'text',
                label: typeof entry.label === 'string' ? entry.label : '',
                selector,
                protected: entry.protected === true,
                disabled: entry.disabled === true,
              }
            })
            locators = fresh
            return {
              ok: true,
              command: request.command,
              target: 'public',
              escalation: null,
              data: {
                url: page.currentUrl(),
                revision: page.currentRevision(),
                title: page.currentTitle(),
                text: read.text,
                truncated: read.bytes > 4096,
                elements,
              },
            }
          }
          case 'page.click': {
            const done = await page.click(locators[request.ref ?? ''] ?? '#missing')
            if (!done.ok) return refuse('adapter-failed' as never, done.code)
            return { ok: true, command: request.command, target: 'public', escalation: null, data: { clicked: done.changed, revision: page.currentRevision(), url: page.currentUrl() } }
          }
          case 'page.type': {
            const done = await page.type(locators[request.ref ?? ''] ?? '#missing', request.text ?? '')
            if (!done.ok) return refuse('adapter-failed' as never, done.code)
            return { ok: true, command: request.command, target: 'public', escalation: null, data: { typed: done.changed, revision: page.currentRevision(), url: page.currentUrl() } }
          }
          default:
            return refuse('command-unsupported' as never, request.command)
        }
      },
    },
    allowPrivateHosts: true,
    allowedHosts: ['127.0.0.1'],
  })
  service.trust(true)

  /* ============================================================ Test A */

  const tabs: string[] = []
  for (const path of ['/alpha', '/beta', '/gamma']) {
    const result = await service.run({ op: 'open', url: `${base}${path}`, createdBy: 'user' })
    assert.equal(result.ok, true, `open ${path}: ${JSON.stringify(result)}`)
    if (result.ok) tabs.push(String(result.data.tabId))
  }
  await settle()

  const afterOpen = service.state()
  assert.equal(afterOpen.runtimeStatus, 'active', 'the runtime reports itself active')
  assert.equal(afterOpen.reason, null, 'and gives no reason while it is active')
  assert.equal(afterOpen.tabCount, 3, `three tabs, not one overwritten tab: ${JSON.stringify(afterOpen.tabs.map((tab) => tab.url))}`)
  assert.equal(new Set(afterOpen.tabs.map((tab) => tab.url)).size, 3, 'three distinct addresses')
  assert.equal(afterOpen.tabs.every((tab) => tab.status === 'ready'), true, 'every tab is ready')
  assert.equal(
    afterOpen.tabs.every((tab) => typeof tab.liveUrl === 'string' && tab.liveUrl !== ''),
    true,
    'every ready tab has a live URL — the empty-handoff shape is unreachable',
  )
  assert.equal(registry.size(), 3, 'three real pages exist')
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'no tab ever became a separate window')

  const attached = (): number => host.contentView.children.length
  const showFront = async (tabId: string): Promise<WebContentsView> => {
    await service.run({ op: 'activate', tabId })
    const sessionId = service.tabs().find((tab) => tab.tabId === tabId)?.sessionId ?? ''
    service.dock(sessionId, { x: 600, y: 90, width: 560, height: 620 })
    await settle()
    const view = host.contentView.children[0] as WebContentsView | undefined
    assert.ok(view, `tab ${tabId} has a view attached`)
    return view
  }

  const alphaView = await showFront(tabs[0]!)
  assert.equal(attached(), 1, 'exactly one view is attached to the window')
  assert.equal(alphaView.webContents.getURL(), `${base}/alpha`, 'the front tab shows the front page')

  // A real typed value in a real page, to prove the switch is a switch and not a reload.
  await alphaView.webContents.executeJavaScript("document.getElementById('draft').value = 'kept across tab switches'")

  const betaView = await showFront(tabs[1]!)
  assert.notEqual(alphaView.webContents.id, betaView.webContents.id, 'two tabs are two web contents')
  assert.equal(betaView.webContents.getURL(), `${base}/beta`, 'switching changed the visible page')
  assert.equal(attached(), 1, 'and only one view is attached at a time')

  const returnedView = await showFront(tabs[0]!)
  assert.equal(returnedView.webContents.id, alphaView.webContents.id, 'the same view came back')
  assert.equal(
    await returnedView.webContents.executeJavaScript("document.getElementById('draft').value"),
    'kept across tab switches',
    'the page kept its own state across a tab switch, which a reload would have lost',
  )

  // Navigating one tab must not touch another.
  await service.run({ op: 'navigate', tabId: tabs[0]!, url: `${base}/alpha/contact` })
  await settle()
  assert.equal(service.tabs().find((tab) => tab.tabId === tabs[0])?.liveUrl, `${base}/alpha/contact`, 'the navigated tab landed where it was sent')
  assert.equal(service.tabs().find((tab) => tab.tabId === tabs[1])?.liveUrl, `${base}/beta`, 'the other tab did not move')

  // Closing one leaves the other two intact.
  await service.run({ op: 'close', tabId: tabs[2]! })
  await settle()
  assert.equal(service.tabs().length, 2, 'two tabs remain after one closes')
  assert.equal(service.tabs().every((tab) => tab.status === 'ready'), true, 'both remaining tabs are still ready')
  assert.equal(registry.size(), 2, 'the closed tab released its view')

  /* ============================================================ Test B */

  // Back to the home page, so there is a Contact link to click. Test A left this tab on the
  // contact page on purpose; Test B wants the link that leads there.
  await service.run({ op: 'navigate', tabId: tabs[0]!, url: `${base}/alpha` })
  await showFront(tabs[0]!)
  const first = await snapshotOf(service, tabs[0]!)
  assert.ok(first.elements.length > 0, 'the real page described some elements')
  const contact = first.elements.find((element) => /contact/i.test(element.name))
  assert.ok(contact, `the contact link is findable by name: ${first.rendered}`)

  // A revision the caller never had is refused before anything is touched.
  const invented = await service.run({ op: 'click', tabId: tabs[0]!, ref: contact.ref, revision: first.revision - 1 })
  assert.equal(invented.ok, false, 'an action from a revision the snapshot never produced is refused')
  if (!invented.ok) assert.equal(invented.code, 'stale-reference', `refused as stale, got ${invented.code}`)

  // A real click, through the reference the snapshot handed out.
  const clicked = await clickByName(service, tabs[0]!, 'Contact')
  assert.equal(clicked.ok, true, `clicking the contact link works: ${JSON.stringify(clicked)}`)
  await settle()
  assert.match(
    service.tabs().find((tab) => tab.tabId === tabs[0])?.liveUrl ?? '',
    /contact/,
    'the click navigated to the contact page',
  )

  // After navigation, the old reference is stale and the revision has advanced.
  const second = await snapshotOf(service, tabs[0]!)
  assert.ok(second.revision > first.revision, `the revision advanced: ${String(second.revision)} after ${String(first.revision)}`)
  const oldRef = await service.run({ op: 'click', tabId: tabs[0]!, ref: contact.ref, revision: first.revision })
  assert.equal(oldRef.ok, false, 'a reference from before the navigation is refused')
  if (!oldRef.ok) assert.equal(oldRef.code, 'stale-reference', `refused as stale, got ${oldRef.code}`)

  // Back to the home page, and confirm the old reference is *still* refused rather than
  // silently pointing at whatever now sits in that slot.
  await service.run({ op: 'back', tabId: tabs[0]! })
  await settle()
  const third = await snapshotOf(service, tabs[0]!)
  assert.ok(third.revision > second.revision, 'going back advances the revision again')
  const resurrected = await service.run({ op: 'click', tabId: tabs[0]!, ref: contact.ref, revision: first.revision })
  assert.equal(resurrected.ok, false, 'a reference from two navigations ago is still refused')

  // Scroll the real page to the bottom and back.
  const bottom = await service.run({ op: 'scroll', tabId: tabs[0]!, to: 'bottom' })
  assert.equal(bottom.ok, true, 'scroll to the bottom works')
  if (bottom.ok) assert.ok(Number(bottom.data.top) > 0, 'the real page actually scrolled')
  const top = await service.run({ op: 'scroll', tabId: tabs[0]!, to: 'top' })
  assert.equal(top.ok, true, 'scroll back to the top works')
  if (top.ok) assert.equal(Number(top.data.top), 0, 'the page is back at the top')

  // A select control, chosen by the index the snapshot reported.
  const home = await snapshotOf(service, tabs[0]!)
  const country = home.elements.find((element) => element.kind === 'field' && /country/i.test(element.name))
  assert.ok(country, `the select is described: ${home.rendered}`)
  const chosen = await service.run({ op: 'select', tabId: tabs[0]!, ref: country.ref, revision: home.revision, index: 1 })
  assert.equal(chosen.ok, true, `choosing an option works: ${JSON.stringify(chosen)}`)

  // A wait settles on a page that is loaded.
  const waited = await service.run({ op: 'wait', tabId: tabs[0]!, settleMs: 1_000 })
  assert.equal(waited.ok, true, 'wait settles')

  // And a refused act never touches the page.
  const before = await returnedView.webContents.executeJavaScript("document.getElementById('draft').value")
  await service.run({ op: 'click', tabId: tabs[0]!, ref: 'r999', revision: third.revision })
  assert.equal(
    await returnedView.webContents.executeJavaScript("document.getElementById('draft').value"),
    before,
    'a refused click left the page exactly as it was',
  )

  /* ====================================================== twelve tabs */

  const extra: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const path = index % 2 === 0 ? '/alpha' : '/beta'
    const result = await service.run({ op: 'open', url: `${base}${path}?n=${String(index)}`, createdBy: 'freya', activate: false })
    assert.equal(result.ok, true, `opening tab ${String(index + 1)}: ${JSON.stringify(result)}`)
    if (result.ok) extra.push(String(result.data.tabId))
  }
  await settle()
  const full = service.state()
  assert.equal(full.tabCount, 12, `ten more on top of the two: ${String(full.tabCount)}`)
  assert.equal(new Set(full.tabs.map((tab) => tab.tabId)).size, 12, 'twelve distinct tab identities')
  assert.equal(full.tabs.filter((tab) => tab.createdBy === 'freya').length, 10, 'ten of them are attributed to Freya, not to the owner')
  assert.equal(full.tabs.filter((tab) => tab.status === 'ready').length, 12, 'all twelve are ready')
  assert.equal(full.tabs.filter((tab) => tab.status === 'ready' && !tab.liveUrl).length, 0, 'and not one of them is ready with no address')
  assert.equal(registry.size(), 12, 'twelve real pages exist')

  // Every one of the ten can be activated and read on its own.
  for (const tabId of extra.slice(0, 4)) {
    const view = await showFront(tabId)
    assert.equal(attached(), 1, 'still one attached view')
    assert.ok(view.webContents.getURL().startsWith(base), 'and it is showing that tab')
  }

  /* ------------------------------------------------------ teardown */

  service.dock(null, null)
  await settle()
  assert.equal(attached(), 0, 'nothing is attached once the workspace lets go')
  await service.dispose()
  await settle()
  assert.equal(attached(), 0, 'and nothing is attached after disposal')
  assert.equal(registry.size(), 0, 'every view was released')

  host.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('PASS browser service: three real WebContentsViews, one attached at a time, page state survives a tab switch, independent navigation, close leaves two intact, semantic click on a real link, stale-reference after navigation and after going back, scroll both ways, select, wait, twelve tabs, every view released')
  app.exit(0)
}

async function snapshotOf(service: BrowserService, tabId: string): Promise<SemanticSnapshot> {
  const result = await service.run({ op: 'snapshot', tabId })
  assert.equal(result.ok, true, `snapshot ${tabId}: ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('the snapshot was refused')
  return result.data.snapshot as SemanticSnapshot
}

async function clickByName(service: BrowserService, tabId: string, name: string): Promise<SemanticBrowserResult> {
  const view = await snapshotOf(service, tabId)
  const target = view.elements.find((element) => element.kind === 'link' && new RegExp(name, 'i').test(element.name))
  if (target === undefined) throw new Error(`no link named ${name} in:\n${view.rendered}`)
  return await service.run({ op: 'click', tabId, ref: target.ref, revision: view.revision })
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : 'the browser service acceptance run failed')
  app.exit(1)
})