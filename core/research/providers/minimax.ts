import { withResearchAbort } from '../async'
import { ResearchError, safeResearchError } from '../errors'
import { boundedSearchLimit, boundedSearchOffset, normalizeSearchResults, validateSearchQuery } from '../searcher'
import type { SearchProvider, SearchQueryOptions, SearchResult, SearchVertical } from '../types'

export interface MiniMaxSearchEnv { MINIMAX_API_KEY?: string; MINIMAX_BASE_URL?: string; FREYA_ALLOW_WEB_SEARCH?: string }
export interface MiniMaxSearchOptions { env: MiniMaxSearchEnv; fetchImpl?: typeof fetch; now?: () => Date }

/** Official coding-plan Search API: https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP/blob/main/minimax_mcp/server.py
 * Web/page discovery only. This API documents no pagination or media verticals.
 * Credential recipients are fixed; redirects are never followed.
 */
export class MiniMaxSearchProvider implements SearchProvider {
  readonly id = 'minimax'
  readonly #apiKey: string
  readonly #origin: string | null
  readonly #enabled: boolean
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  constructor(options: MiniMaxSearchOptions) {
    this.#apiKey = options.env.MINIMAX_API_KEY?.trim() ?? ''
    this.#enabled = options.env.FREYA_ALLOW_WEB_SEARCH === '1'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    let origin: string | null = null
    try {
      const url = new URL(options.env.MINIMAX_BASE_URL?.trim() || 'https://api.minimax.io')
      if (!url.username && !url.password && !url.search && !url.hash && ['https://api.minimax.io', 'https://api.minimaxi.com'].includes(url.origin)) origin = url.origin
    } catch { /* Invalid host configuration is an unavailable provider. */ }
    this.#origin = origin
  }
  status(): { ready: boolean; reason: string } {
    if (!this.#apiKey || !this.#origin) return { ready: false, reason: 'unconfigured' }
    if (!this.#enabled) return { ready: false, reason: 'disabled' }
    return { ready: true, reason: 'Configured MiniMax coding-plan search; entitlement is checked by the API on each request.' }
  }
  supports(vertical: SearchVertical): boolean { return vertical === 'web' || vertical === 'pages' }
  async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
    const validated = validateSearchQuery(query)
    const status = this.status()
    if (!status.ready) throw new ResearchError(status.reason === 'disabled' ? 'disabled' : 'unconfigured')
    const vertical = options.vertical ?? 'web'
    if (!this.supports(vertical)) throw new ResearchError('provider_error')
    if (boundedSearchOffset(options.offset) > 0) return [] // No undocumented pagination or duplicate paid request.
    const limit = boundedSearchLimit(options.limit)
    const site = options.site
    if (site !== undefined && (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(site) || site.length > 253)) throw new ResearchError('invalid_query')
    try {
      return await withResearchAbort(options.signal, 10_000, async (signal) => {
        const response = await this.fetchImpl(`${this.#origin}/v1/coding_plan/search`, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}`, 'MM-API-Source': 'Freya' }, body: JSON.stringify({ q: site ? `${validated} site:${site}` : validated }) })
        if ([401, 403].includes(response.status)) throw new ResearchError('invalid_credentials')
        if (response.status === 429) throw new ResearchError('rate_limited')
        if (!response.ok || response.status >= 300) throw new ResearchError('provider_error')
        if (!response.body) throw new ResearchError('invalid_response')
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > 2_097_152) { await reader.cancel(); throw new ResearchError('response_too_large') }
            chunks.push(chunk.value)
          }
        } finally { reader.releaseLock() }
        let data: unknown
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ResearchError('invalid_response') }
        if (!data || typeof data !== 'object') throw new ResearchError('invalid_response')
        const result = data as { organic?: unknown; base_resp?: { status_code?: unknown } }
        const code = result.base_resp?.status_code
        if (typeof code === 'number' && code !== 0) throw new ResearchError(code === 1004 || code === 2049 ? 'invalid_credentials' : code === 1002 ? 'rate_limited' : 'provider_error')
        if (!Array.isArray(result.organic)) throw new ResearchError('invalid_response')
        const redact = (value: unknown) => typeof value === 'string' ? value.split(this.#apiKey).join('[redacted]') : ''
        const rows: unknown[] = []
        for (const value of result.organic.slice(0, 100)) {
          if (!value || typeof value !== 'object') continue
          const row = value as Record<string, unknown>
          if (typeof row.link !== 'string' || row.link.includes(this.#apiKey)) continue
          try { if (decodeURIComponent(row.link).includes(this.#apiKey)) continue } catch { continue }
          rows.push({ providerId: this.id, title: redact(row.title), url: row.link, snippet: redact(row.snippet), publishedAt: row.date, vertical })
        }
        const results = normalizeSearchResults(rows, limit, this.now().toISOString())
        return site ? results.filter((row) => row.sourceDomain === site || row.sourceDomain.endsWith(`.${site}`)) : results
      })
    } catch (error) { throw safeResearchError(error, 'provider_error') }
  }
}
