import { SafeHttpTransport } from '../core/research/transport'
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