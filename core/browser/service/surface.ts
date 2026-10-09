import type { BrowserSurfaceKind } from './types'
import { BROWSER_SERVICE_LIMITS } from './types'

/**
 * Where pages come from.
 *
 * One port, two implementations today or soon: the **embedded** surface is Freya's own
 * Electron `WebContentsView` per tab, and the **relay** surface is a paired Chrome or Edge
 * extension driving tabs that already exist in the person's browser. Nothing above this
 * interface knows the difference, which is the whole reason the two can be swapped without
 * Core needing a second opinion about what a browser is.
 *
 * ## What the port deliberately does *not* have
 *
 * No raw Electron object, no `webContents`, no `session`, no `BrowserWindow`, no DOM node.
 * A port that leaks its implementation is a port a second implementation cannot satisfy, and
 * the second implementation is the one that has to cope with a person's real, signed-in,
 * already-considerably-more-powerful browser. Everything crossing this boundary is a string,
 * a number, a boolean or a plain object of those.
 *
 * ## Views are the surface's business
 *
 * `dock` and `release` exist because the embedded surface has a native view that has to be
 * positioned in window coordinates, and the relay surface has nothing to position. A surface
 * with no native view returns `false` from `dock` and the caller treats that as "nothing to
 * show here", which is a fact about the surface rather than a failure of the request.
 */

/** One tab's live facts, as a surface reports them. */
export interface SurfaceTabReading {
  readonly sessionId: string
  /** Where the page is. Null before anything loaded. Never `''`. */
  readonly url: string | null
  readonly title: string | null
  /** The surface's own monotonic page counter for this tab. Never decreases. */
  readonly revision: number
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** A code, never an exception message and never a stack. */
  readonly error: string | null
}

export type SurfaceReading<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * A page capture: the visible pixels as PNG bytes, plus the surface's own facts
 * about the moment of capture so a caller can decide whether the bytes are still
 * the page it is looking at.
 */
export interface SurfaceScreenshot {
  /**
   * The captured pixels. PNG-encoded, bounded by the surface at or below
   * {@link BROWSER_SERVICE_LIMITS.maxScreenshotBytes}. The bytes cross the IPC
   * boundary as a `Buffer` and are returned to the model as a base64
   * `data:image/png` URL when the protocol is asked for the image as an asset.
   */
  readonly png: Uint8Array
  /** A path the renderer can fetch to display the bytes (a `freya-browser://` URL). */
  readonly mediaUrl: string
  /** Width of the captured image, in pixels. */
  readonly width: number
  /** Height of the captured image, in pixels. */
  readonly height: number
  /** Surface's own revision at the moment of capture. May be older than the tab's live revision. */
  readonly revision: number
  /** The page URL at the moment of capture, never empty. */
  readonly url: string
  /** The page title at the moment of capture, may be empty. */
  readonly title: string
}

/** Where a scroll should end up. Both forms are bounded by the surface. */
export type ScrollRequest =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'top' }
  | { readonly kind: 'delta'; readonly amount: number }
  /** A fraction of the scrollable height, 0 at the top and 1 at the bottom. */
  | { readonly kind: 'fraction'; readonly amount: number }

/** One element, as a surface reads it. Carries an accessible name, never a value. */
export interface SurfaceElement {
  readonly kind: 'link' | 'button' | 'field' | 'heading' | 'text'
  readonly name: string
  /** The surface's own locator for the element. Never crosses the IPC boundary. */
  readonly selector: string
  readonly disabled: boolean
  readonly protected: boolean
  readonly destructive: boolean
  readonly options?: readonly string[]
}

/** Everything one snapshot reads in a single pass, so a snapshot is not three round trips. */
export interface SurfaceSnapshot {
  readonly url: string
  readonly title: string | null
  readonly revision: number
  /** Page prose, already bounded by the surface. */
  readonly text: string
  readonly truncated: boolean
  readonly elements: readonly SurfaceElement[]
}

export interface SurfaceBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Whether an address observed from the page should replace a window's cached address.
 *
 * The page is the witness for where it is; a window's address is a cache updated by
 * navigation events, and an event can be missed — a click dispatched in an isolated world
 * can commit a navigation whose `did-navigate` never arrives, leaving the tab reporting the
 * address it *used to* be on. This is the rule that reconciles the two after an act: the
 * observation wins when it is a real, different http(s) address, and nothing moves when it
 * is empty, equal to what is already held, or a scheme this browser does not navigate to.
 */
export function shouldAdoptPageAddress(cached: string | null, observed: unknown): observed is string {
  if (typeof observed !== 'string' || observed === '' || observed === cached) return false
  return /^https?:/iu.test(observed)
}

export interface OpenSurfaceTabRequest {
  readonly sessionId: string
  readonly url: string
  /** Freya or the owner. A surface may use this to decide how loudly to report a failure. */
  readonly createdBy: 'freya' | 'user'
}

export interface BrowserSurfacePort {
  readonly kind: BrowserSurfaceKind
  /** Whether this surface can be used at all right now. */
  available(): boolean
  /** The live tab ids this surface holds. For diagnostics and for the tab list. */
  openTabs(): readonly string[]

  /**
   * Create the view for one tab.
   *
   * `open` on a session that already exists is a no-op that reports the existing view,
   * because re-creating a view is how a page reloads behind the owner's back.
   */
  open(request: OpenSurfaceTabRequest): Promise<SurfaceReading<SurfaceTabReading>>

  /** Release the view. Idempotent, and safe to call on a session that never opened. */
  close(sessionId: string): Promise<SurfaceReading<{ readonly closed: true }>>

  /**
   * Point a tab at a URL.
   *
   * The surface reports `navigating` immediately and the new page through
   * {@link subscribe}; a caller that needs to know the page landed waits or reads.
   */
  navigate(sessionId: string, url: string): Promise<SurfaceReading<{ readonly accepted: true }>>

  /** Reload the tab where it is. Never re-derives a URL, so it cannot navigate anywhere. */
  reload(sessionId: string): Promise<SurfaceReading<{ readonly accepted: true }>>

  /** The live facts for one tab. Cheap, and never page content. */
  observe(sessionId: string): Promise<SurfaceReading<SurfaceTabReading>>

  /** Everything a semantic snapshot needs, in one bounded pass. */
  snapshot(sessionId: string): Promise<SurfaceReading<SurfaceSnapshot>>

  /** Act on one element by the surface's own locator. */
  click(sessionId: string, selector: string): Promise<SurfaceReading<{ readonly changed: boolean }>>

  /** Type into one element and read the value straight back. */
  type(sessionId: string, selector: string, text: string): Promise<SurfaceReading<{ readonly changed: boolean }>>

  /** Choose an option in a select control, by the index the snapshot reported. */
  select(sessionId: string, selector: string, index: number): Promise<SurfaceReading<{ readonly selected: string | null }>>

  scroll(sessionId: string, request: ScrollRequest): Promise<SurfaceReading<{ readonly top: number; readonly height: number }>>

  /**
   * Capture the visible pixels of a tab as PNG.
   *
   * The surface may refuse (`surface-unavailable`, `tab-unknown`, `page-missing`)
   * or succeed with bytes that are bound by the surface's own ceiling. The bytes
   * are kept by the surface and surfaced later through the URL in
   * {@link SurfaceScreenshot.mediaUrl}, which the renderer fetches when it
   * wants to show the image to the owner.
   */
  screenshot(sessionId: string): Promise<SurfaceReading<SurfaceScreenshot>>

  /**
   * Wait for the tab to stop changing, or for a URL substring to appear.
   *
   * Bounded by `deadlineMs` and refused rather than hung. `until` is a substring of the URL
   * rather than a selector so that waiting cannot itself become an act.
   */
  wait(
    sessionId: string,
    request: { readonly settleMs: number; readonly until?: string },
  ): Promise<SurfaceReading<{ readonly settled: boolean; readonly url: string | null }>>

  /**
   * Position the native view for a tab. Null bounds hide it.
   *
   * Only the active tab is ever docked, so a surface implementation may assume at most one
   * attached view. Returns false when this surface has no native view to place, which is a
   * statement about the surface and not a refusal.
   */
  dock(sessionId: string | null, bounds: SurfaceBounds | null): boolean

  /**
   * Push updates. The replacement for polling.
   *
   * Every tab event the workspace needs to redraw arrives here: opened, navigated, loaded,
   * failed, closed. A caller that has this does not need a timer, and that is the point —
   * an 800 ms poll of a twelve-tab runtime is twelve map walks a second for information that
   * had not changed.
   */
  subscribe(listener: (reading: SurfaceTabReading) => void): () => void

  /** Stop everything. Used on shutdown and when the workspace closes for good. */
  dispose(): Promise<void>
}

/** The bounds a renderer is allowed to ask for: integers inside the host window. */
export function clampSurfaceBounds(
  candidate: unknown,
  viewport: { readonly width: number; readonly height: number },
): SurfaceBounds | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const row = candidate as Record<string, unknown>
  const numbers = (['x', 'y', 'width', 'height'] as const).map((key) => row[key])
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  const [rawX, rawY, rawWidth, rawHeight] = numbers as [number, number, number, number]
  const x = Math.max(0, Math.min(viewport.width, Math.round(rawX)))
  const y = Math.max(0, Math.min(viewport.height, Math.round(rawY)))
  const width = Math.max(0, Math.min(viewport.width - x, Math.round(rawWidth)))
  const height = Math.max(0, Math.min(viewport.height - y, Math.round(rawHeight)))
  // A zero-area rect is the honest way to say "hidden". A view given a zero rect is not
  // hit-testable and not painted, which is exactly what a hidden tab must be.
  if (width <= 0 || height <= 0) return null
  return Object.freeze({ x, y, width, height })
}

/** Bound a text the protocol is about to carry, on a UTF-8 boundary. */
export function boundText(value: string, max: number): string {
  if (value.length <= max) return value
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= max) return value
  let end = max
  while (end > 0) {
    const point = value.charCodeAt(end)
    if (point < 0xd800 || point > 0xdfff) break
    end -= 1
  }
  return `${value.slice(0, end)}…`
}

/** The element ceiling a surface must respect, exported so both sides agree. */
export const MAX_SURFACE_ELEMENTS = BROWSER_SERVICE_LIMITS.maxSnapshotElements