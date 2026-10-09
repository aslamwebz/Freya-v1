import type { BrowserSurfacePort, OpenSurfaceTabRequest, ScrollRequest, SurfaceBounds, SurfaceElement, SurfaceReading, SurfaceScreenshot, SurfaceSnapshot, SurfaceTabReading } from '../../core/browser/service'
import type { FreyaBrowserLivePage } from './freyaWindow'
import type { ScreenshotResource } from './screenshotResource'

/**
 * The embedded surface: one real `WebContentsView` per tab.
 *
 * ## What "embedded" means here
 *
 * Every tab owns a **separate native view**, created once and kept for as long as the tab is
 * open. Switching tabs changes which view is attached to the window, not which page is
 * loaded — so a tab switch cannot reload a page, lose its scroll position, or lose the state a
 * person typed into a form. This is the whole reason the dock is not an `<iframe>`: a
 * cross-origin page in an iframe is a page Freya cannot navigate, cannot read a title from,
 * and cannot put a revision on.
 *
 * ## The rules this surface inherits rather than re-decides
 *
 * Sandbox, no Node, every permission denied, no private or local address, no downloads, no
 * popups — all of that lives in `./freyaWindow` and is enforced per view. This file does not
 * restate any of it, because a second copy of a security rule is a second rule that can drift.
 * What this file owns is **placement**: which view is attached, where, and when it goes away.
 *
 * ## Placement
 *
 * Only the front tab is ever attached. Unattached views are kept but hidden, because a view
 * that is still a child of the window content view keeps painting, keeps receiving input, and
 * covers whatever is behind it. A hidden tab is therefore *removed from the view tree* and
 * re-added when it comes to the front, which is also why `dock` is the only place that touches
 * `contentView` and why it takes exactly one session id.
 */

export interface EmbeddedSurfaceOptions {
  /**
   * Creates the native view for one session. The surface never constructs one itself, so a
   * test can hand it a scripted page and assert on placement without Electron.
   */
  readonly create: (sessionId: string, partition: string) => Promise<FreyaBrowserLivePage>
  /** Attach/detach the native view. Null session id means "hide whatever is attached". */
  readonly place: (sessionId: string | null, bounds: SurfaceBounds | null) => boolean
  /** The partition for a session. Must be non-persistent; the surface asserts it. */
  readonly partitionFor: (sessionId: string) => string
  /** Whether the host window can hold a view at all. False in a headless test. */
  readonly canEmbed: () => boolean
  /**
   * Where captured PNG bytes go after a screenshot, so the renderer can fetch
   * them. Optional, so the test harness can omit it; without it, screenshots
   * return a `mediaUrl` that 404s, which is a fair signal that the host
   * has not been wired up.
   */
  readonly screenshotResource?: ScreenshotResource
  /**
   * The rect a tab occupies when the host has not been told a smaller one.
   *
   * A capture has to place the view somewhere, and `capturePage` returns a
   * 0x0 image for a view that was never attached at all. The rect is asked for
   * on every screenshot rather than remembered, because the window may have been
   * resized, moved to another display, or fullscreened since the last one.
   */
  readonly contentBounds: () => SurfaceBounds | null
  readonly now?: () => Date
  readonly settleMs?: number
}

interface LiveTab {
  readonly page: FreyaBrowserLivePage
  readonly detach: () => void
  readonly createdBy: 'freya' | 'user'
}

export function createEmbeddedBrowserSurface(options: EmbeddedSurfaceOptions): BrowserSurfacePort {
  const tabs = new Map<string, LiveTab>()
  const listeners = new Set<(reading: SurfaceTabReading) => void>()
  let attached: string | null = null
  let bounds: SurfaceBounds | null = null
  let disposed = false
  /**
   * While a screenshot is in flight, placement changes from anywhere else (the
   * renderer's panel effect re-sending its dock on every resize frame, for
   * example) must wait: a view detached half-way through `capturePage` is a
   * view whose capture throws, and a capture that throws is an image nobody
   * got. The deferred request is applied when the capture settles, so nothing
   * is lost — it is only ordered after the capture.
   */
  let capturing = false
  let deferred: { readonly sessionId: string | null; readonly next: SurfaceBounds | null } | null = null

  function emit(sessionId: string): void {
    const live = tabs.get(sessionId)
    if (live === undefined) return
    const reading = live.page.reading()
    const view: SurfaceTabReading = {
      sessionId,
      url: reading.url === '' ? null : reading.url,
      title: reading.title,
      revision: reading.revision,
      loading: reading.loading,
      canGoBack: reading.canGoBack,
      canGoForward: reading.canGoForward,
      error: reading.error,
    }
    for (const listener of [...listeners]) {
      try {
        listener(view)
      } catch {
        // A subscriber that throws must not stop the rest of the surface from reporting.
      }
    }
  }

  /** Re-place the front view. Idempotent, and the only place `place` is called. */
  function reattach(): void {
    if (!options.canEmbed()) return
    if (attached === null) {
      options.place(null, null)
      return
    }
    options.place(attached, bounds)
  }

  /** The unchecked core of `dock`: update state and place. Bypasses the capture guard. */
  function placeNow(sessionId: string | null, next: SurfaceBounds | null): boolean {
    bounds = next
    if (!options.canEmbed()) return false
    if (sessionId !== null && !tabs.has(sessionId)) return false
    attached = sessionId
    reattach()
    return true
  }

  async function open(request: OpenSurfaceTabRequest): Promise<SurfaceReading<SurfaceTabReading>> {
    if (disposed) return { ok: false, code: 'surface-unavailable', reason: 'The embedded browser surface has been disposed.' }
    const existing = tabs.get(request.sessionId)
    if (existing !== undefined) {
      // Already open. Re-creating the view is how a page reloads behind the owner's back, so
      // an open is a no-op that reports what is there.
      emit(request.sessionId)
      return { ok: true, value: existing.page.reading() }
    }
    let page: FreyaBrowserLivePage
    try {
      page = await options.create(request.sessionId, options.partitionFor(request.sessionId))
    } catch (error) {
      return {
        ok: false,
        code: 'adapter-failed',
        reason: `The embedded browser could not open a page: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const detach = page.onReading(() => emit(request.sessionId))
    tabs.set(request.sessionId, { page, detach, createdBy: request.createdBy })

    if (request.url !== '') {
      // An address was given, so make the view load it now. A tab opened with no address
      // stays on `about:blank` and reports `creating` — which is a real state with a name,
      // not an empty panel pretending to be a page.
      const landed = await page.navigate(request.url)
      if (!landed.ok) {
        emit(request.sessionId)
        return { ok: false, code: landed.code, reason: `The embedded browser did not load ${request.url}: ${landed.code}.` }
      }
    }
    emit(request.sessionId)
    return { ok: true, value: page.reading() }
  }

  async function close(sessionId: string): Promise<SurfaceReading<{ readonly closed: true }>> {
    const live = tabs.get(sessionId)
    if (live === undefined) return { ok: true, value: Object.freeze({ closed: true }) }
    if (attached === sessionId) {
      attached = null
      reattach()
    }
    live.detach()
    tabs.delete(sessionId)
    // Forget any stashed screenshot for this session. A closed tab cannot be
    // screenshotted again, and a 404 is a clearer answer than stale bytes.
    options.screenshotResource?.drop(sessionId)
    // Release the view for real: `close()` destroys the web contents, clears the partition's
    // storage and cache, and detaches from the window. Anything less leaves a page running
    // with no tab that owns it.
    await live.page.close().catch(() => undefined)
    for (const listener of [...listeners]) {
      try {
        listener({ sessionId, url: null, title: null, revision: live.page.currentRevision(), loading: false, canGoBack: false, canGoForward: false, error: 'closed' })
      } catch {
        // As above.
      }
    }
    return { ok: true, value: Object.freeze({ closed: true }) }
  }

  function readingOf(sessionId: string): SurfaceReading<SurfaceTabReading> {
    const live = tabs.get(sessionId)
    if (live === undefined) {
      return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page. It may have been closed.' }
    }
    const reading = live.page.reading()
    return {
      ok: true,
      value: {
        sessionId,
        url: reading.url === '' ? null : reading.url,
        title: reading.title,
        revision: reading.revision,
        loading: reading.loading,
        canGoBack: reading.canGoBack,
        canGoForward: reading.canGoForward,
        error: reading.error,
      },
    }
  }

  function toSurfaceElement(entry: { readonly kind: string; readonly label: string; readonly selector: string; readonly protected: boolean; readonly disabled: boolean; readonly options?: readonly string[] }): SurfaceElement {
    const kind = entry.kind === 'link' || entry.kind === 'button' || entry.kind === 'field' || entry.kind === 'heading' || entry.kind === 'text' ? entry.kind : 'text'
    return Object.freeze({
      kind,
      name: entry.label,
      selector: entry.selector,
      disabled: entry.disabled,
      protected: entry.protected,
      destructive: /delete|remove|destroy|erase|wipe|terminate|cancel subscription|close account/i.test(entry.label),
      ...(entry.options === undefined || entry.options.length === 0 ? {} : { options: Object.freeze([...entry.options]) }),
    })
  }

  return {
    kind: 'embedded',

    available() {
      return !disposed
    },

    openTabs() {
      return [...tabs.keys()].sort()
    },

    open,

    close,

    async navigate(sessionId, url) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const started = await live.page.navigate(url)
      emit(sessionId)
      if (!started.ok) return { ok: false, code: started.code, reason: `The embedded browser did not navigate: ${started.code}.` }
      return { ok: true, value: Object.freeze({ accepted: true }) }
    },

    async reload(sessionId) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const done = await live.page.reload()
      emit(sessionId)
      if (!done.ok) return { ok: false, code: done.code, reason: `The embedded browser did not reload: ${done.code}.` }
      return { ok: true, value: Object.freeze({ accepted: true }) }
    },

    async observe(sessionId) {
      return readingOf(sessionId)
    },

    async snapshot(sessionId) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const taken = await live.page.snapshot()
      if (!taken.ok || taken.payload === null) {
        return { ok: false, code: taken.code, reason: 'The embedded browser could not read the page, so nothing is described.' }
      }
      const snapshot: SurfaceSnapshot = Object.freeze({
        url: taken.payload.url,
        title: taken.payload.title === '' ? null : taken.payload.title,
        revision: live.page.currentRevision(),
        text: taken.payload.text,
        truncated: taken.payload.truncated === true,
        elements: Object.freeze(taken.payload.elements.map(toSurfaceElement)),
      })
      return { ok: true, value: snapshot }
    },

    async click(sessionId, selector) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const done = await live.page.click(selector)
      emit(sessionId)
      if (!done.ok) return { ok: false, code: done.code, reason: 'The page did not accept the click.' }
      return { ok: true, value: Object.freeze({ changed: done.changed }) }
    },

    async type(sessionId, selector, text) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const done = await live.page.type(selector, text)
      emit(sessionId)
      if (!done.ok) return { ok: false, code: done.code, reason: 'The page did not accept the text.' }
      return { ok: true, value: Object.freeze({ changed: done.changed }) }
    },

    async select(sessionId, selector, index) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const done = await live.page.select(selector, index)
      if (!done.ok) return { ok: false, code: done.code, reason: 'The control did not accept the choice.' }
      return { ok: true, value: Object.freeze({ selected: done.selected }) }
    },

    async scroll(sessionId, request: ScrollRequest) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const done = await live.page.scroll(
        request.kind === 'fraction' ? { kind: 'delta', amount: 0 } : request.kind === 'delta' ? { kind: 'delta', amount: request.amount } : request,
      )
      if (!done.ok) return { ok: false, code: done.code, reason: 'The page did not scroll.' }
      return { ok: true, value: Object.freeze({ top: done.top, height: done.height }) }
    },

    async screenshot(sessionId) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      /**
       * A capture needs a view that is actually on screen. `capturePage` does not
       * fail loudly for a view nobody attached — it returns a 0x0 image, and a
       * caller that accepted that would hand the model an empty PNG as a page.
       * So the tab is docked for the duration of the capture and the docks are
       * checked before anything is captured, not after.
       */
      const captureBounds = bounds ?? options.contentBounds()
      if (captureBounds === null || captureBounds.width < 320 || captureBounds.height < 240) {
        return {
          ok: false,
          code: 'surface-unavailable',
          reason:
            'The embedded browser has no sized view to capture, so there is no screenshot to return. ' +
            'Open the browser panel in Freya, then ask for the screenshot again.',
        }
      }
      // From here until the `finally`, the view must not move: a placement change
      // landing mid-capture is what makes `capturePage` throw (`UnknownVizError`).
      // `dock()` defers anything it is asked while `capturing` is set, and this
      // block applies whatever was deferred after the restore.
      capturing = true
      const wasAttached = attached
      const priorBounds = bounds
      const docked = placeNow(sessionId, captureBounds)
      if (!docked) {
        // A host that cannot place at all (headless test, no window) cannot capture. Surface
        // surfaces that have no native view to place return false from `dock`, and that is
        // the case here too.
        capturing = false
        return { ok: false, code: 'surface-unavailable', reason: 'The embedded browser has no view to capture, so the page is not on screen.' }
      }
      try {
        const taken = await live.page.screenshot()
        if (!taken.ok || taken.payload === null) {
          return { ok: false, code: taken.code, reason: `The embedded browser could not capture the page (${taken.code}), so there is no screenshot to return.` }
        }
        const p = taken.payload
        // The resource store, if the host wired one, holds the bytes behind the URL.
        // Without it, the URL is a 404 — a host that did not register the protocol
        // will see the renderer draw a broken image, which is the right signal.
        if (options.screenshotResource !== undefined) {
          options.screenshotResource.store(sessionId, p.revision, p.png, 'image/png')
        }
        const mediaUrl = `freya-browser://screenshot/${encodeURIComponent(sessionId)}/${String(p.revision)}.png`
        const value: SurfaceScreenshot = Object.freeze({
          png: new Uint8Array(p.png.buffer, p.png.byteOffset, p.png.byteLength),
          mediaUrl,
          width: p.width,
          height: p.height,
          revision: p.revision,
          url: p.url,
          title: p.title,
        })
        return { ok: true, value }
      } finally {
        // Restore whatever was attached before, then apply anything the renderer
        // asked for while the capture held the view. Deferred goes last on
        // purpose: it is the renderer's latest word about where the view belongs.
        placeNow(wasAttached, priorBounds)
        capturing = false
        const pending = deferred
        deferred = null
        if (pending !== null) placeNow(pending.sessionId, pending.next)
      }
    },

    async wait(sessionId, request) {
      const live = tabs.get(sessionId)
      if (live === undefined) return { ok: false, code: 'tab-unknown', reason: 'That tab has no embedded page.' }
      const done = await live.page.wait(request)
      emit(sessionId)
      if (!done.ok) return { ok: false, code: done.code, reason: 'The page did not settle in time.' }
      return { ok: true, value: Object.freeze({ settled: done.settled, url: done.url }) }
    },

    dock(sessionId, next) {
      if (capturing) {
        // A capture holds the view; anything asked now is applied after it
        // settles. Returning true is honest: the request is accepted, only
        // ordered after the capture, which is the ordering that keeps the
        // capture from throwing.
        deferred = { sessionId, next }
        return true
      }
      return placeNow(sessionId, next)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async dispose() {
      disposed = true
      attached = null
      for (const live of [...tabs.values()]) {
        live.detach()
        await live.page.close().catch(() => undefined)
      }
      tabs.clear()
      listeners.clear()
    },
  }
}

/** Exported so the host can build one surface without importing the whole barrel. */
export type { SurfaceElement, SurfaceSnapshot }