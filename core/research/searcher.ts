import { withResearchAbort } from './async'
import { ResearchError, safeResearchError } from './errors'
import type { SearchProvider, SearchResult, SearchVertical } from './types'
import { normalizeSourceUrl } from './url-policy'
import { videoDurationConstraint, matchesVideoDuration } from './video-duration'

export function validateSearchQuery(query: string): string {
  if (typeof query !== 'string' || query.length > 512 || !query.trim()) throw new ResearchError('invalid_query')
  return query
}

export function boundedSearchLimit(limit = 10): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 10
}

/**
 * Providers that support pagination receive only a small page index. Ten pages
 * at ten results each is enough for Freya's Eye to collect 100 results without
 * ever weakening the low-level ten-results-per-request boundary.
 */
export function boundedSearchOffset(offset = 0): number {
  return Number.isFinite(offset) ? Math.max(0, Math.min(9, Math.floor(offset))) : 0
}

/** Rebuild provider data, including when a replacement provider is malformed. */
export function normalizeSearchResults(data: unknown, limit: number, retrievedAt: string): SearchResult[] {
  if (!Array.isArray(data)) throw new ResearchError('invalid_response')
  const results: SearchResult[] = []
  const seen = new Set<string>()
  // Bounded work, even for a faulty in-process provider; network bodies have a separate byte ceiling.
  for (const value of data.slice(0, 100)) {
    if (results.length >= boundedSearchLimit(limit)) break
    if (value === null || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    if (typeof row.url !== 'string' || typeof row.title !== 'string' || !row.title.trim()) continue
    let url: string
    try { url = normalizeSourceUrl(row.url) } catch { continue }
    if (seen.has(url)) continue
    seen.add(url)
    let publishedAt: string | null = null
    if (typeof row.publishedAt === 'string' && row.publishedAt.length <= 64 && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(row.publishedAt)) {
      const date = new Date(row.publishedAt)
      if (Number.isFinite(date.getTime())) publishedAt = date.toISOString()
    }
    // Narrowed here, at the boundary, rather than trusted from the provider.
    const vertical = verticalOf(row.vertical)
    const mediaUrl = optionalUrl(row.mediaUrl)
    const thumbnailUrl = optionalUrl(row.thumbnailUrl)
    const pageUrl = optionalUrl(row.pageUrl)
    const metadata = stringMap(row.metadata)
    results.push({
      title: row.title.trim().slice(0, 512), url,
      snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, 2048) : '',
      sourceDomain: new URL(url).hostname, rank: results.length + 1,
      publishedAt, retrievedAt,
      ...(typeof row.providerId === 'string' && /^[a-z0-9_-]{1,64}$/.test(row.providerId) ? { providerId: row.providerId } : {}),
      // Narrowed rather than passed through, and **omitted when empty**.
      //
      // This is the single place every provider's rows cross, so anything it does
      // not check is unchecked forever, and anything it does not need should not
      // be there: a web result has no image, and emitting `mediaUrl: null` would
      // widen the shape every existing result comparison and every projection
      // consumer sees, for a field that carries no information. Absence is the
      // honest representation of "this vertical has no media".
      ...(vertical === 'web' ? {} : { vertical }),
      ...(mediaUrl === null ? {} : { mediaUrl }),
      ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
      ...(pageUrl === null ? {} : { pageUrl }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    })
  }
  return results
}

const VERTICALS: readonly SearchVertical[] = ['web', 'images', 'videos', 'documents', 'audio', 'pages']

/** An unknown or absent vertical is `web`, which is what every provider meant before. */
function verticalOf(value: unknown): SearchVertical {
  return typeof value === 'string' && (VERTICALS as readonly string[]).includes(value)
    ? (value as SearchVertical)
    : 'web'
}

/**
 * A media or page URL, or null.
 *
 * Deliberately *not* run through `normalizeSourceUrl`: `url` is already the
 * citation and has been through it, while these are CDN and embed addresses that
 * are carried for display. What is checked here is only that they are http(s)
 * and bounded, so nothing non-http and nothing unbounded reaches a panel.
 */
function optionalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2048) return null
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Only short string values, and only a bounded number of them. */
function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 12) break
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)) continue
    if (typeof entry !== 'string' || entry.length === 0) continue
    out[key] = entry.slice(0, 256)
    count += 1
  }
  return out
}

export interface SearcherOptions { provider: SearchProvider; now?: () => Date }
export class Searcher {
  private readonly provider: SearchProvider
  private readonly now: () => Date
  constructor(options: SearcherOptions) {
    this.provider = options.provider
    this.now = options.now ?? (() => new Date())
  }

  async searchWeb(query: string, options: { signal?: AbortSignal; limit?: number; offset?: number; site?: string; vertical?: SearchVertical } = {}): Promise<SearchResult[]> {
    const validated = validateSearchQuery(query)
    const limit = boundedSearchLimit(options.limit)
    const offset = boundedSearchOffset(options.offset)
    const vertical = options.vertical ?? 'web'
    try {
      return await withResearchAbort(options.signal, 10000, async (signal) => {
        const status = this.provider.status()
        if (!status.ready) throw new ResearchError(status.reason === 'disabled' ? 'disabled' : 'unconfigured')
        // A provider that *declares* it cannot serve the requested vertical must
        // be refused rather than answered with the wrong kind of result. Ten web
        // links in reply to a request for images is the silent downgrade this
        // prevents.
        //
        // An absent `supports` is not treated as a refusal: it means the provider
        // predates the field and serves the web vertical, and it will throw from
        // its own `search` if it truly cannot answer. Second-guessing it here
        // would refuse every existing provider that has not been updated yet.
        if (this.provider.supports !== undefined && !this.provider.supports(vertical)) {
          throw new ResearchError('unconfigured')
        }
        const site = options.site?.toLowerCase().replace(/^www\./, '')
        if (site && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(site)) throw new ResearchError('invalid_query')
        const effectiveQuery = site && !validated.includes(`site:${site}`) ? `${validated} site:${site}` : validated
        const data = await this.provider.search(effectiveQuery, { signal, limit, offset, vertical })
        return normalizeSearchResults(data, limit, this.now().toISOString())
          .filter((row) => !site || row.sourceDomain === site || row.sourceDomain.endsWith(`.${site}`))
          .filter((row) => { const duration = vertical === 'videos' ? videoDurationConstraint(validated) : null; return !duration || matchesVideoDuration(row.metadata?.duration, duration) })
      })
    } catch (error) { throw safeResearchError(error, 'provider_error') }
  }
}
