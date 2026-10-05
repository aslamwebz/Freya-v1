import { withResearchAbort } from '../async'
import { ResearchError, safeResearchError } from '../errors'
import { boundedSearchLimit, boundedSearchOffset, validateSearchQuery } from '../searcher'
import type { HttpTransport } from '../transport'
import type { SearchProvider, SearchQueryOptions, SearchResult, SearchVertical } from '../types'
import { normalizeSourceUrl } from '../url-policy'
import { LoopbackHttpTransport } from './loopback'

/**
 * A metasearch provider backed by a locally-running SearXNG daemon.
 *
 * ## What this is for
 *
 * The alternative provider needs a paid API key. That is a poor property for a
 * local-first desktop assistant: without a credential there is no search at all,
 * and "search silently does nothing" is the failure mode this codebase refuses
 * everywhere else. A metasearch daemon aggregates many upstream engines on the
 * owner's own machine, so it needs no account and no key.
 *
 * ## Trust model
 *
 * The daemon is a **separately installed, separately running process**. Freya does
 * not bundle it, link it, or embed it — it speaks HTTP to a loopback address the
 * owner configured. That keeps the AGPL-3.0 daemon at arm's length (nothing of it
 * is redistributed here) and means it can be upgraded or removed without touching
 * Freya. It is optional: this provider is one implementation of the port, not a
 * dependency of it.
 *
 * The trust runs one way only. Freya *asks* the daemon questions; the daemon does
 * the fetching. No URL Freya receives from a result is ever fetched by this
 * provider — everything it returns has been through `normalizeSourceUrl`, so a
 * hostile result cannot steer Freya at an internal address.
 */

export interface SearxngEnv {
  /** Loopback base URL of a running instance, e.g. `http://127.0.0.1:8080`. */
  FREYA_SEARXNG_URL?: string
  /** The explicit decision to let Freya reach the network for answers. */
  FREYA_ALLOW_WEB_SEARCH?: string
}

export interface SearxngProviderOptions {
  env: SearxngEnv
  transport?: HttpTransport
  now?: () => Date
}

/** Which SearXNG category serves each of our verticals. */
const CATEGORY: Readonly<Record<SearchVertical, string>> = {
  web: 'general',
  images: 'images',
  videos: 'videos',
  // Documents are web results that happen to be files. The daemon has no
  // document vertical, so this asks `general` and the caller filters on the
  // content type — asking for a vertical that does not exist would return an
  // error rather than the documents.
  documents: 'general',
}

/** SearXNG's JSON row, read defensively. Everything here is untrusted. */
interface Row {
  readonly [key: string]: unknown
}

export class SearxngSearchProvider implements SearchProvider {
  readonly id = 'searxng'
  readonly #base: string | null
  readonly #enabled: boolean
  readonly #transport: HttpTransport
  readonly #now: () => Date

  constructor(options: SearxngProviderOptions) {
    const configured = options.env.FREYA_SEARXNG_URL?.trim() ?? ''
    this.#base = configured === '' ? null : configured.replace(/\/+$/, '')
    this.#enabled = options.env.FREYA_ALLOW_WEB_SEARCH === '1'
    this.#transport = options.transport ?? new LoopbackHttpTransport()
    this.#now = options.now ?? (() => new Date())
  }

  status(): { ready: boolean; reason: string } {
    if (this.#base === null) return { ready: false, reason: 'unconfigured' }
    if (!this.#enabled) return { ready: false, reason: 'disabled' }
    return { ready: true, reason: 'ready' }
  }

  supports(vertical: SearchVertical): boolean {
    // Every vertical maps onto a category this daemon serves. The `documents`
    // case is a filter over `general` rather than a separate category, which is
    // why it is honest to claim support here.
    return Object.hasOwn(CATEGORY, vertical)
  }

  async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
    const validated = validateSearchQuery(query)
    const status = this.status()
    if (status.ready === false) throw new ResearchError(status.reason === 'disabled' ? 'disabled' : 'unconfigured')
    const vertical = options.vertical ?? 'web'
    if (!this.supports(vertical)) throw new ResearchError('unconfigured')
    const limit = boundedSearchLimit(options.limit)
    void boundedSearchOffset(options.offset) // the daemon has no offset; bounded for parity

    try {
      return await withResearchAbort(options.signal, 20000, async (signal) => {
        const url = new URL(`${this.#base}/search`)
        url.searchParams.set('q', validated)
        url.searchParams.set('format', 'json')
        url.searchParams.set('categories', CATEGORY[vertical])
        url.searchParams.set('language', 'en')

        const response = await this.#transport.get(url.href, {
          signal,
          // A metasearch answer is a page of merged results plus its per-engine
          // error report, so this is larger than a single provider's page. Still
          // bounded, and still small enough that a runaway response cannot
          // exhaust memory.
          maxBytes: 4 * 1024 * 1024,
          timeoutMs: 20000,
          headers: { Accept: 'application/json' },
        })

        if (response.status === 429) throw new ResearchError('rate_limited')
        if (response.status === 401 || response.status === 403) throw new ResearchError('invalid_credentials')
        if (response.status !== 200) throw new ResearchError('provider_error')

        let parsed: unknown
        try { parsed = JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown } catch {
          throw new ResearchError('invalid_response')
        }
        return normalizeRows(parsed, vertical, limit, this.#now().toISOString())
      })
    } catch (error) {
      throw safeResearchError(error, 'provider_error')
    }
  }
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

/** Keep a URL only if it is a real public destination we are willing to cite. */
function citation(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try { return normalizeSourceUrl(value.trim()) } catch { return null }
}

/**
 * A media URL is *not* a citation.
 *
 * `img_src` and `thumbnail_src` frequently point at a CDN or a cache, and some are
 * data URIs. They are carried for display and are deliberately not run through
 * `normalizeSourceUrl`: the page a human opens is `url`, and holding a
 * normalised-away CDN host would only invite someone to cite it.
 */
function media(value: unknown, maximum = 2048): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('data:')) return null
  if (trimmed.length > maximum) return null
  try {
    const url = new URL(trimmed)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function normalizeRows(payload: unknown, vertical: SearchVertical, limit: number, retrievedAt: string): SearchResult[] {
  if (payload === null || typeof payload !== 'object') throw new ResearchError('invalid_response')
  const rows = (payload as Row).results
  if (!Array.isArray(rows)) throw new ResearchError('invalid_response')

  const results: SearchResult[] = []
  const seen = new Set<string>()
  // The daemon merges many engines and will happily return hundreds of rows for
  // one query. We walk more than we keep so dedupe and the limit both still have
  // material to work with, but the walk itself stays bounded.
  for (const value of rows.slice(0, 200)) {
    if (results.length >= limit) break
    if (value === null || typeof value !== 'object') continue
    const row = value as Row
    const url = citation(row.url)
    // A result with no title is not something a person can recognise in a list.
    const title = text(row.title, 512).trim()
    if (url === null || title === '') continue
    if (seen.has(url)) continue

    const mediaUrl = vertical === 'images' ? media(row.img_src) : null
    const thumbnailUrl = media(row.thumbnail_src) ?? media(row.img_src)
    // A video row's `iframe` is the embeddable player; some engines put it in
    // `iframe_src` instead. Neither is a citation.
    const embed = vertical === 'videos' ? media(row.iframe_src) ?? media(row.iframe) : null
    const pageUrl = citation(row.url) === url ? citation(row.purl) : null

    // An image vertical that produced no image is not an image result. Dropping
    // it here is what keeps a broken row out of the transcript instead of
    // rendering as a broken thumbnail.
    if (vertical === 'images' && mediaUrl === null && thumbnailUrl === null) continue

    seen.add(url)
    results.push({
      title,
      url,
      snippet: text(row.content, 2048),
      sourceDomain: new URL(url).hostname,
      rank: results.length + 1,
      publishedAt: normaliseDate(row.publishedDate ?? row.published_at),
      retrievedAt,
      vertical,
      mediaUrl: mediaUrl ?? embed,
      thumbnailUrl,
      pageUrl: pageUrl === url ? null : pageUrl,
      metadata: readMetadata(row, vertical),
    })
  }
  return results
}

/** Only a real ISO-ish date survives; anything else is `null`, not a guess. */
function normaliseDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/**
 * Engine-reported extras worth keeping, so a panel can show duration or
 * dimensions without a second request. Unknown keys are dropped rather than
 * passed through: this object crosses into a projection, and an arbitrary key
 * from an arbitrary engine is not something to carry.
 */
function readMetadata(row: Row, vertical: SearchVertical): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  const take = (key: string, maximum: number): void => {
    const value = row[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim().slice(0, maximum)
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value)
  }
  if (vertical === 'videos') {
    take('duration', 32)
    take('author', 200)
    take('viewCount', 16)
    take('publishedDate', 64)
  } else if (vertical === 'images') {
    take('resolution', 32)
    take('width', 8)
    take('height', 8)
  }
  return out
}