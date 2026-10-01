import { withResearchAbort } from '../async'
import { ResearchError, safeResearchError } from '../errors'
import { boundedSearchLimit, normalizeSearchResults, validateSearchQuery } from '../searcher'
import { SafeHttpTransport, type HttpTransport } from '../transport'
import type { SearchProvider, SearchResult } from '../types'

export interface BraveSearchEnv { BRAVE_SEARCH_API_KEY?: string; FREYA_ALLOW_WEB_SEARCH?: string }
export interface BraveSearchProviderOptions { env: BraveSearchEnv; transport?: HttpTransport; now?: () => Date }

/** Main-only configuration. The credential is a true private field, never a projection. */
export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave'
  readonly #apiKey: string
  readonly #enabled: boolean
  private readonly transport: HttpTransport
  private readonly now: () => Date
  constructor(options: BraveSearchProviderOptions) {
    this.#apiKey = options.env.BRAVE_SEARCH_API_KEY?.trim() ?? ''
    this.#enabled = options.env.FREYA_ALLOW_WEB_SEARCH === '1'
    this.transport = options.transport ?? new SafeHttpTransport()
    this.now = options.now ?? (() => new Date())
  }

  status(): { ready: boolean; reason: string } {
    if (!this.#apiKey) return { ready: false, reason: 'unconfigured' }
    if (!this.#enabled) return { ready: false, reason: 'disabled' }
    return { ready: true, reason: 'ready' }
  }

  async search(query: string, options: { signal: AbortSignal; limit: number }): Promise<SearchResult[]> {
    const validated = validateSearchQuery(query)
    const status = this.status()
    if (!status.ready) throw new ResearchError(status.reason === 'disabled' ? 'disabled' : 'unconfigured')
    const limit = boundedSearchLimit(options.limit)
    try {
      return await withResearchAbort(options.signal, 10000, async (signal) => {
        const url = new URL('https://api.search.brave.com/res/v1/web/search')
        url.searchParams.set('q', validated)
        url.searchParams.set('count', String(limit))
        url.searchParams.set('text_decorations', 'false')
        url.searchParams.set('result_filter', 'web')
        const response = await this.transport.get(url.href, {
          signal, maxBytes: 2097152, timeoutMs: 10000,
          headers: { Accept: 'application/json', 'X-Subscription-Token': this.#apiKey },
        })
        if ([401, 403].includes(response.status)) throw new ResearchError('invalid_credentials')
        if (response.status === 429) throw new ResearchError('rate_limited')
        if (response.status !== 200) throw new ResearchError('provider_error')
        if (response.body.byteLength > 2097152) throw new ResearchError('response_too_large')
        let data: unknown
        try { data = JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown } catch { throw new ResearchError('invalid_response') }
        if (!data || typeof data !== 'object' || !('web' in data) || !data.web || typeof data.web !== 'object' || !('results' in data.web) || !Array.isArray(data.web.results)) throw new ResearchError('invalid_response')
        const redact = (value: unknown): string => typeof value === 'string' ? value.split(this.#apiKey).join('[redacted]') : ''
        const rows: unknown[] = []
        for (const value of data.web.results.slice(0, 100)) {
          if (!value || typeof value !== 'object') continue
          const row = value as Record<string, unknown>
          // A credential in a URL must never become a source URL or citation.
          if (typeof row.url !== 'string' || row.url.includes(this.#apiKey)) continue
          try { if (decodeURIComponent(row.url).includes(this.#apiKey)) continue } catch { continue }
          rows.push({ title: redact(row.title), url: row.url, snippet: redact(row.description), publishedAt: row.page_age })
        }
        return normalizeSearchResults(rows, limit, this.now().toISOString())
      })
    } catch (error) { throw safeResearchError(error, 'provider_error') }
  }
}
