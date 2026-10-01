import { withResearchAbort } from './async'
import { ResearchError, safeResearchError } from './errors'
import type { SearchProvider, SearchResult } from './types'
import { normalizeSourceUrl } from './url-policy'

export function validateSearchQuery(query: string): string {
  if (typeof query !== 'string' || query.length > 512 || !query.trim()) throw new ResearchError('invalid_query')
  return query.trim()
}

export function boundedSearchLimit(limit = 10): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 10
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
    results.push({
      title: row.title.trim().slice(0, 512), url,
      snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, 2048) : '',
      sourceDomain: new URL(url).hostname, rank: results.length + 1,
      publishedAt, retrievedAt,
    })
  }
  return results
}

export interface SearcherOptions { provider: SearchProvider; now?: () => Date }
export class Searcher {
  private readonly provider: SearchProvider
  private readonly now: () => Date
  constructor(options: SearcherOptions) {
    this.provider = options.provider
    this.now = options.now ?? (() => new Date())
  }

  async searchWeb(query: string, options: { signal?: AbortSignal; limit?: number } = {}): Promise<SearchResult[]> {
    const validated = validateSearchQuery(query)
    const limit = boundedSearchLimit(options.limit)
    try {
      return await withResearchAbort(options.signal, 10000, async (signal) => {
        const status = this.provider.status()
        if (!status.ready) throw new ResearchError(status.reason === 'disabled' ? 'disabled' : 'unconfigured')
        const data = await this.provider.search(validated, { signal, limit })
        return normalizeSearchResults(data, limit, this.now().toISOString())
      })
    } catch (error) { throw safeResearchError(error, 'provider_error') }
  }
}
