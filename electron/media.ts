import { SafeHttpTransport } from '../core/research/transport'
import { safeVideoEmbed } from '../core/media/collect'
import { sniffMediaKind } from '../core/media/sniff'
import { MEDIA_LIMITS } from '../core/media/types'

/**
 * Fetching the bytes a media card is drawn from.
 *
 * ## Why this lives in the main process
 *
 * A card is a picture of something a third party put on the internet, and a window is
 * not where that should be fetched. If the renderer fetched it, the renderer would be
 * making a request whose address came from a search result, which is precisely the
 * shape of request that turns a search result into a way to reach a machine on the
 * owner's own network. So the address never travels outward from a window: the window
 * names what it wants to see, the main process decides whether it may, and the bytes
 * come back as a `data:` URL that cannot phone anywhere.
 *
 * `SafeHttpTransport` is the same guard the page reader uses — public destinations
 * only, loopback and explicit ports refused, one DNS answer pinned to the connection —
 * because a poster is exactly as much of a remote document as an article is.
 *
 * ## What comes back
 *
 * A verdict, not bytes: either the body was an image of a drawable format, or it was
 * not and nothing is returned. `Content-Type` is recorded but never believed, and an
 * HTML error page from a `.jpg` URL is rejected on its bytes.
 */
export interface MediaFetchResult {
  readonly ok: boolean
  /** Present only when `ok`. A `data:` URL, so the renderer never re-fetches it. */
  readonly dataUrl: string | null
  readonly bytes: number
  /** What the body actually is, or `null` when it was not anything drawable. */
  readonly format: string | null
  /** What the server claimed, kept for the record and never used to decide. */
  readonly claimedType: string | null
  readonly reason: string | null
}

const transport = new SafeHttpTransport()

/**
 * What this process says it is when it fetches a picture.
 *
 * Not decoration. Wikimedia — the largest free picture library there is — answers 403
 * to a request with no `User-Agent`, and hosts in general are far more willing to serve
 * a browser than an anonymous socket. Naming the product honestly is both more useful
 * to an operator reading their logs and more likely to be answered than silence.
 */
const USER_AGENT = 'Freya/0.1 (+https://github.com/freya; media preview fetch)'

/**
 * Fetch one image and, if it really is one, return it as a `data:` URL.
 *
 * Bounded in three ways: a ceiling on the body, a ceiling on the time, and a refusal
 * to guess. A body that arrives as text — an error page, a sign-in wall, a redirect
 * notice — returns `ok: false` with the reason, and the card that wanted it shows
 * nothing rather than showing a lie.
 */
export async function fetchThumbnail(
  url: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<MediaFetchResult> {
  let response
  try {
    response = await transport.get(url, {
      // An image is decoration. It must never be the reason a turn takes longer.
      timeoutMs: 10_000,
      signal: options.signal ?? new AbortController().signal,
      headers: {
        accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
        'user-agent': USER_AGENT,
      },
      maxBytes: MEDIA_LIMITS.thumbnailBytes,
    })
  } catch (error) {
    return refusal(error)
  }

  const claimed = response.headers['content-type'] ?? null
  if (response.status !== 200) {
    return { ok: false, dataUrl: null, bytes: response.body.length, format: null, claimedType: claimed, reason: `the server answered ${String(response.status)}` }
  }
  if (response.body.length === 0) {
    return { ok: false, dataUrl: null, bytes: 0, format: null, claimedType: claimed, reason: 'the body was empty' }
  }

  const sniffed = sniffMediaKind(response.body)
  if (sniffed === null || !sniffed.startsWith('image/')) {
    // The common case, and the one worth naming: a rate limit or a login wall served
    // from an image URL. The claim is recorded so the mismatch is visible in a log.
    const looksTextual = (claimed ?? '').startsWith('text/')
    return {
      ok: false,
      dataUrl: null,
      bytes: response.body.length,
      format: null,
      claimedType: claimed,
      reason: looksTextual
        ? `the server sent ${claimed ?? 'text'}, not an image`
        : 'the body is not a recognised image',
    }
  }

  const base64 = Buffer.from(response.body).toString('base64')
  return {
    ok: true,
    dataUrl: `data:${sniffed};base64,${base64}`,
    bytes: response.body.length,
    format: sniffed,
    claimedType: claimed,
    reason: null,
  }
}

/**
 * Fetch a direct video only after the owner opens its preview.
 *
 * Hosted watch pages are expected to fail this check and fall back to their poster.
 * That is deliberate: Freya never claims a web page is a playable file, and the
 * renderer never receives an arbitrary remote URL to fetch on its own.
 */
export async function fetchVideoPreview(
  url: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<MediaFetchResult> {
  let response
  try {
    response = await transport.get(url, {
      timeoutMs: 20_000,
      signal: options.signal ?? new AbortController().signal,
      headers: { accept: 'video/mp4,video/webm,video/ogg,*/*;q=0.1', 'user-agent': USER_AGENT },
      maxBytes: MEDIA_LIMITS.videoBytes,
    })
  } catch (error) {
    return refusal(error)
  }

  const claimed = response.headers['content-type'] ?? null
  if (response.status !== 200) {
    return { ok: false, dataUrl: null, bytes: response.body.length, format: null, claimedType: claimed, reason: `the server answered ${String(response.status)}` }
  }
  if (response.body.length === 0) {
    return { ok: false, dataUrl: null, bytes: 0, format: null, claimedType: claimed, reason: 'the body was empty' }
  }

  const sniffed = sniffMediaKind(response.body)
  if (sniffed === null || !sniffed.startsWith('video/')) {
    return {
      ok: false,
      dataUrl: null,
      bytes: response.body.length,
      format: null,
      claimedType: claimed,
      reason: 'the body is not a recognised direct video',
    }
  }

  return {
    ok: true,
    dataUrl: `data:${sniffed};base64,${Buffer.from(response.body).toString('base64')}`,
    bytes: response.body.length,
    format: sniffed,
    claimedType: claimed,
    reason: null,
  }
}

/**
 * Fetch a document's bytes for the PDF renderer.
 *
 * Base64 rather than a path or a URL, because the renderer must not be able to re-fetch
 * what it was given, and a path would hand the window a handle on the filesystem. Capped
 * at the document ceiling, which is generous because a real report is large and small
 * because an unbounded one becomes a denial of service pointed at the owner.
 */
export async function fetchDocumentBytes(
  url: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<{ ok: true; base64: string; bytes: number } | { ok: false; reason: string }> {
  let response
  try {
    response = await transport.get(url, {
      timeoutMs: 20_000,
      signal: options.signal ?? new AbortController().signal,
      headers: { accept: 'application/pdf,*/*;q=0.1', 'user-agent': USER_AGENT },
      maxBytes: MEDIA_LIMITS.documentBytes,
    })
  } catch (error) {
    return { ok: false, reason: describe(error) }
  }

  if (response.status !== 200) {
    return { ok: false, reason: `the server answered ${String(response.status)}` }
  }
  if (sniffMediaKind(response.body) !== 'application/pdf') {
    return { ok: false, reason: 'the body is not a PDF' }
  }
  return { ok: true, base64: Buffer.from(response.body).toString('base64'), bytes: response.body.length }
}

/** Why a fetch was refused, in words that name the reason rather than the class. */
function refusal(error: unknown): MediaFetchResult {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const reason = code.startsWith('ERR_SSRF')
    ? 'that address is not a public destination'
    : code === 'ABORT_ERR'
      ? 'the fetch was stopped'
      : describe(error)
  return { ok: false, dataUrl: null, bytes: 0, format: null, claimedType: null, reason }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'the address could not be fetched'
}
/**
 * The in-window hosted video player.
 *
 * A hosted watch URL cannot simply be iframed from a transcript that ships as a
 * `file://` document: the frame's origin serialises as `null`, and YouTube refuses
 * such embeds with its "player configuration error". So the player is a real
 * Chromium page — a `WebContentsView` layered over the window's content, bounds set
 * to exactly the modal's player placeholder — and the address it loads is still
 * gated by the same allowlist the renderer's collector enforces. The view is one
 * per window, attached on preview open, detached on close or media switch, so
 * switching items stops the previous playback rather than layering players.
 */
export interface EmbedAttachRequest {
  readonly url: unknown
  readonly x: unknown
  readonly y: unknown
  readonly width: unknown
  readonly height: unknown
}

export type EmbedAttachOutcome =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: string }

/** Ceilings for a player's on-screen box, in DIPs. A modal is big; this is bigger. */
const EMBED_BOUNDS = Object.freeze({
  max: 4096,
})

function boundedBounds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(Math.floor(value), EMBED_BOUNDS.max))
}

const embedViews = new WeakMap<object, { view: unknown; url: string }>()

export function attachEmbedView(
  window: {
    isDestroyed(): boolean
    contentView: { addChildView(view: unknown): void; removeChildView(view: unknown): void }
  },
  electronModule: {
    WebContentsView: new (options: Record<string, unknown>) => {
      setBounds(bounds: { x: number; y: number; width: number; height: number }): void
      webContents: { loadURL(url: string): Promise<void>; close(): void; isDestroyed(): boolean }
    }
  },
  request: EmbedAttachRequest,
): EmbedAttachOutcome {
  const allowed = safeVideoEmbed(typeof request.url === 'string' ? request.url : null)
  if (allowed === null) return { ok: false, reason: 'that host is not an in-app player Freya may embed' }
  const x = boundedBounds(request.x)
  const y = boundedBounds(request.y)
  const width = boundedBounds(request.width)
  const height = boundedBounds(request.height)
  if (x === null || y === null || width === null || height === null) {
    return { ok: false, reason: 'the player box was not a bounded rectangle' }
  }
  if (width < 2 || height < 2) return { ok: false, reason: 'the player box is too small to draw' }

  // One player per window: switching media detaches the previous view here, so
  // closing a preview never leaves a video playing behind the transcript.
  detachEmbedView(window)
  const view = new electronModule.WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  view.setBounds({ x, y, width, height })
  window.contentView.addChildView(view)
  embedViews.set(window, { view, url: allowed })
  void view.webContents.loadURL(allowed).catch(() => {
    detachEmbedView(window)
  })
  return { ok: true, width, height }
}

export function detachEmbedView(
  window: {
    isDestroyed(): boolean
    contentView: { addChildView(view: unknown): void; removeChildView(view: unknown): void }
  },
): boolean {
  const attached = embedViews.get(window)
  if (attached === undefined) return false
  embedViews.delete(window)
  try {
    window.contentView.removeChildView(attached.view as never)
    const contents = (attached.view as { webContents?: { isDestroyed(): boolean; close(): void } }).webContents
    if (contents !== undefined && !contents.isDestroyed()) contents.close()
  } catch {
    // A window mid-teardown can refuse the removal; the view dies with it either way.
  }
  return true
}
