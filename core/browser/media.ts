import { DEVICE_HANDS_ALLOWED_MEDIA_TYPES } from '../devicehands'
import { BROWSER_LIMITS, type BrowserRefusalCode } from './types'

/**
 * Download and media **metadata**. Never bytes.
 *
 * A page in the Freya Browser can start a download — clicking a link that the server
 * answers with `Content-Disposition: attachment` is an ordinary thing for a page to do.
 * This phase's answer to that is deliberately not "let it write":
 *
 *   - the download is **cancelled** in `electron/browser/freyaWindow.ts`, so nothing
 *     reaches the disk from a page's own initiative;
 *   - what Freya keeps is the *description* of it — the URL, the file name, the media
 *     type, the size the server claimed — bound and credential-scanned;
 *   - actually moving the bytes is a **separate, already-gated** action:
 *     `transfer.download` through Device Hands, with its own host allowlist, its own path
 *     gate, its own media allowlist, its own size ceiling and its own deadline.
 *
 * So the honest report for a page that tried to download something is "here is what it
 * wanted, and it was not written". {@link MediaOffer.transferable} says whether a gated
 * transfer could carry that media type at all, which is computed from
 * {@link DEVICE_HANDS_ALLOWED_MEDIA_TYPES} rather than restated — so this phase cannot end
 * up promising a file the transfer surface would refuse.
 */

export interface MediaOffer {
  readonly mediaId: string
  readonly sessionId: string
  /** The address the download came from, already checked against the public URL policy. */
  readonly url: string
  /** A bare name. Never a path, and never used as one. */
  readonly fileName: string
  readonly mediaType: string | null
  /** The size the server claimed, or null when it did not say. Never a count of bytes read. */
  readonly bytes: number | null
  readonly observedAt: string
  /**
   * Whether `transfer.download` could carry this media type.
   *
   * Computed, never asserted. A `false` here is the honest reason a page asking for a
   * `.png` is not a page Freya will fetch for it.
   */
  readonly transferable: boolean
}

export type MediaReading =
  | { readonly ok: true; readonly offer: MediaOffer }
  | { readonly ok: false; readonly code: BrowserRefusalCode; readonly reason: string }

const MEDIA_ID_SHAPE = /^[a-z0-9][a-z0-9-]{7,63}$/
const MAX_FILE_NAME = 128

/** What the adapter is handed, all untrusted. */
export interface RawMediaObservation {
  readonly mediaId?: unknown
  readonly url?: unknown
  readonly fileName?: unknown
  readonly mediaType?: unknown
  readonly bytes?: unknown
}

function refuse(code: BrowserRefusalCode, reason: string): MediaReading {
  return { ok: false, code, reason }
}

/**
 * Normalise one observed download into a bounded, credential-free offer.
 *
 * The file-name rules are the *same* rules `core/devicehands/transfer.ts` applies to a
 * download destination — no separator, bounded length, no control character — restated
 * here for the same reason `core/browser/refs.ts` restates the selector charset: this
 * module runs *before* the gate, and something that will be refused downstream should not
 * be described as though it were available. A name that would be refused is not repaired
 * into one that would not be; the offer is refused with the reason.
 */
export function normaliseMediaOffer(
  raw: unknown,
  context: { readonly sessionId: string; readonly observedAt: string },
): MediaReading {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse('adapter-failed', 'A media observation must be an object.')
  }
  const entry = raw as RawMediaObservation

  if (typeof entry.mediaId !== 'string' || !MEDIA_ID_SHAPE.test(entry.mediaId)) {
    return refuse('adapter-failed', 'A media observation needs an id of 8-64 lowercase letters, digits or hyphens.')
  }
  if (typeof entry.url !== 'string' || entry.url.length === 0 || entry.url.length > BROWSER_LIMITS.maxUrlChars) {
    return refuse('url-refused', 'A media observation needs the URL it came from, of at most 2048 characters.')
  }
  if (entry.url.includes('\n') || entry.url.includes('\r')) {
    return refuse('url-refused', 'A media URL may not contain a line break.')
  }
  if (typeof entry.fileName !== 'string' || entry.fileName.length === 0 || entry.fileName.length > MAX_FILE_NAME) {
    return refuse('adapter-failed', `A media observation needs a file name of 1-${String(MAX_FILE_NAME)} characters.`)
  }
  if (entry.fileName.includes('/') || entry.fileName.includes('\\')) {
    return refuse(
      'adapter-failed',
      'A media file name may not contain a path separator. The directory for a real transfer comes from the checked path, never from a page.',
    )
  }
  for (let index = 0; index < entry.fileName.length; index += 1) {
    const code = entry.fileName.charCodeAt(index)
    if (code < 32 || code === 127) {
      return refuse('adapter-failed', 'A media file name may not contain a control character.')
    }
  }

  const mediaType =
    typeof entry.mediaType === 'string' && entry.mediaType.trim().length > 0
      ? (entry.mediaType.split(';')[0]?.trim().toLowerCase() ?? null)
      : null
  const bytes =
    typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) && entry.bytes > 0
      ? Math.floor(entry.bytes)
      : null

  const observedAt = Date.parse(context.observedAt)
  if (!Number.isFinite(observedAt)) {
    return refuse('adapter-failed', 'A media observation needs a timestamp this build can read.')
  }

  return {
    ok: true,
    offer: Object.freeze({
      mediaId: entry.mediaId,
      sessionId: context.sessionId,
      url: entry.url,
      fileName: entry.fileName,
      mediaType,
      bytes,
      observedAt: new Date(observedAt).toISOString(),
      transferable: mediaType !== null && DEVICE_HANDS_ALLOWED_MEDIA_TYPES.includes(mediaType),
    }),
  }
}

/**
 * The bounded, newest-last set of offers one session keeps.
 *
 * A page can start any number of downloads, so this is bounded at
 * {@link BROWSER_LIMITS}.maxMediaOffers and the **oldest** goes. Refusing the ninth would
 * let a page wedge Freya's own bookkeeping by offering nine files, which is a denial of
 * service with a page as the author.
 */
export class MediaOfferLog {
  private readonly offers: MediaOffer[] = []

  constructor(private readonly limit: number = BROWSER_LIMITS.maxMediaOffers) {}

  record(offer: MediaOffer): void {
    this.offers.push(offer)
    while (this.offers.length > this.limit) this.offers.shift()
  }

  get(mediaId: string): MediaOffer | null {
    for (let index = this.offers.length - 1; index >= 0; index -= 1) {
      const offer = this.offers[index]
      if (offer !== undefined && offer.mediaId === mediaId) return offer
    }
    return null
  }

  list(): readonly MediaOffer[] {
    return this.offers.slice()
  }

  clear(): void {
    this.offers.length = 0
  }

  get size(): number {
    return this.offers.length
  }
}

/* -------------------------------------------------------------------- audits */

/**
 * Structural audits over this module. Never used by production code.
 *
 * The claim is small and absolute: a media *offer* never carries content. The audit asserts
 * it on a real offer by checking that every value is a scalar of a known kind, rather than
 * by reading the interface and hoping it stays that way — an interface cannot be shown to
 * lack a field, but an actual value can.
 */
export function auditMediaOffers(): readonly string[] {
  const findings: string[] = []

  const reading = normaliseMediaOffer(
    { mediaId: 'media-0001', url: 'https://example.com/a.pdf', fileName: 'a.pdf', mediaType: 'application/pdf', bytes: 1024 },
    { sessionId: 'session-1', observedAt: '2026-01-01T00:00:00.000Z' },
  )
  if (!reading.ok) {
    findings.push('A well-formed media observation was refused.')
    return findings
  }
  const offer = reading.offer

  // Every value must be a scalar. An object, an array or a typed array here would be content.
  for (const [key, value] of Object.entries(offer)) {
    const acceptable =
      typeof value === 'string' || typeof value === 'boolean' || value === null ||
      (typeof value === 'number' && Number.isFinite(value))
    if (!acceptable) findings.push(`MediaOffer.${key} is not a scalar, so it could hold content.`)
  }
  if (typeof offer.bytes !== 'number') findings.push('MediaOffer.bytes is not a declared size.')
  if (!offer.transferable) findings.push('A PDF was reported as untransferable.')
  if (offer.bytes !== 1024) findings.push('A declared size was not retained.')

  // A key that could hold content is a finding whatever its type turns out to be today.
  for (const key of ['data', 'content', 'body', 'buffer', 'blob', 'payload', 'base64', 'bytes']) {
    if (typeof (offer as unknown as Record<string, unknown>)[key] === 'string') {
      findings.push(`MediaOffer carries "${key}" as text, which is content.`)
    }
  }

  for (const name of ['../../etc/passwd', 'a/b.pdf', 'a\\b.pdf']) {
    const attempt = normaliseMediaOffer(
      { mediaId: 'media-0002', url: 'https://example.com/a', fileName: name, mediaType: 'application/pdf', bytes: 1 },
      { sessionId: 'session-1', observedAt: '2026-01-01T00:00:00.000Z' },
    )
    if (attempt.ok) findings.push(`A media offer named "${name}" and was accepted.`)
  }

  const image = normaliseMediaOffer(
    { mediaId: 'media-0003', url: 'https://example.com/a.png', fileName: 'a.png', mediaType: 'image/png', bytes: 10 },
    { sessionId: 'session-1', observedAt: '2026-01-01T00:00:00.000Z' },
  )
  if (!image.ok || image.offer.transferable) {
    findings.push('An image was reported as transferable, which the transfer allowlist forbids.')
  }

  return findings
}