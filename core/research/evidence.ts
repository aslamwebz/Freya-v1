import { createHash } from 'node:crypto'
import type { ReadableDocument } from './browser'
import type { SearchResult } from './types'
import { normalizeSourceUrl } from './url-policy'

export interface ResearchSource {
  sourceId: string
  documentId: string
  url: string
  identityUrl: string
  title: string
  domain: string
  retrievedAt: string
  query: string
  excerpt: string
  truncated: boolean
}

export interface SourceRankingStrategy {
  readonly strategyId: string
  readonly version: string
  readonly kind?: string
  readonly parameters?: Record<string, unknown>
}

export interface SourceRankingOptions {
  readonly strategy?: SourceRankingStrategy | null
}

export interface SelectedSourcesReport {
  readonly sources: SearchResult[]
  readonly strategyUsed: { readonly id: string; readonly version: string } | null
}

/**
 * Select and rank research sources with governed active strategy support.
 *
 * When an active strategy is supplied:
 * - Validates strategy identity and scope.
 * - Applies allowlisted parameters: prioritizeVerifiedDomains, maxSourcesPerDomain.
 * - Enforces source safety and URL normalization.
 * - Falls back to baseline if the strategy is absent, invalid, or unavailable.
 * - Returns both selected sources and the strategy version used for provenance.
 */
export function selectSourcesDetailed(
  results: readonly SearchResult[],
  limit: number,
  options?: SourceRankingOptions,
): SelectedSourcesReport {
  const boundedLimit = Math.max(0, Math.min(24, Math.floor(limit)))
  const seen = new Set<string>()

  // Check if an authorized active strategy for research_source_ranking is supplied
  const strat = options?.strategy
  const isValidStrategy =
    Boolean(strat) &&
    typeof strat?.strategyId === 'string' &&
    typeof strat?.version === 'string' &&
    (strat.kind === undefined ||
      strat.kind === 'research_source_ranking' ||
      strat.kind === 'general')

  if (!isValidStrategy || !strat) {
    // Baseline: host-balanced order
    const hosts = new Set<string>()
    const first: SearchResult[] = []
    const rest: SearchResult[] = []
    for (const result of results.slice(0, 24)) {
      let url: string
      try {
        url = normalizeSourceUrl(result.url)
      } catch {
        continue
      }
      if (seen.has(url)) continue
      seen.add(url)
      const host = new URL(url).hostname
      const row = { ...result, url, sourceDomain: host }
      if (hosts.has(host)) rest.push(row)
      else {
        hosts.add(host)
        first.push(row)
      }
    }
    return {
      sources: [...first, ...rest].slice(0, boundedLimit),
      strategyUsed: null,
    }
  }

  // Active Evolved Strategy:
  // Apply allowlisted parameters safely:
  // - prioritizeVerifiedDomains
  // - maxSourcesPerDomain
  const params = strat.parameters ?? {}
  const prioritizeVerified = Boolean(params['prioritizeVerifiedDomains'])
  const maxPerDomain =
    typeof params['maxSourcesPerDomain'] === 'number'
      ? Math.max(1, Math.floor(params['maxSourcesPerDomain']))
      : 5

  const trustedDomains = Array.isArray(params['trustedDomains'])
    ? (params['trustedDomains'] as string[])
    : [
        'github.com',
        'developer.mozilla.org',
        'wikipedia.org',
        'docs.python.org',
        'nodejs.org',
        'typescriptlang.org',
      ]

  // Pre-normalize valid rows
  const normalizedRows: SearchResult[] = []
  for (const result of results.slice(0, 24)) {
    let url: string
    try {
      url = normalizeSourceUrl(result.url)
    } catch {
      continue
    }
    if (seen.has(url)) continue
    seen.add(url)
    const host = new URL(url).hostname
    normalizedRows.push({ ...result, url, sourceDomain: host })
  }

  // Check if a row belongs to a verified/high-trust domain
  const isVerifiedDomain = (row: SearchResult): boolean => {
    if (row.metadata?.['verified'] === 'true') return true
    const host = row.sourceDomain.toLowerCase()
    return trustedDomains.some((d) => host === d || host.endsWith(`.${d}`))
  }

  // Sort/prioritize according to candidate heuristic
  let orderedRows: SearchResult[]
  if (prioritizeVerified) {
    const verifiedRows = normalizedRows.filter(isVerifiedDomain)
    const regularRows = normalizedRows.filter((r) => !isVerifiedDomain(r))
    orderedRows = [...verifiedRows, ...regularRows]
  } else {
    // Baseline host-balanced ordering: first give each host a chance
    const hosts = new Set<string>()
    const first: SearchResult[] = []
    const rest: SearchResult[] = []
    for (const row of normalizedRows) {
      if (hosts.has(row.sourceDomain)) rest.push(row)
      else {
        hosts.add(row.sourceDomain)
        first.push(row)
      }
    }
    orderedRows = [...first, ...rest]
  }

  // Enforce maxSourcesPerDomain (domain diversity ceiling)
  const selected: SearchResult[] = []
  const domainCounts = new Map<string, number>()

  for (const row of orderedRows) {
    const count = domainCounts.get(row.sourceDomain) ?? 0
    if (count >= maxPerDomain) {
      continue // Skip to enforce domain diversity constraint
    }
    domainCounts.set(row.sourceDomain, count + 1)
    selected.push(row)
    if (selected.length >= boundedLimit) break
  }

  return {
    sources: selected,
    strategyUsed: { id: strat.strategyId, version: strat.version },
  }
}

/** Rank within a host is preserved; first give each host a chance. */
export function selectSources(
  results: readonly SearchResult[],
  limit: number,
  options?: SourceRankingOptions,
): SearchResult[] {
  return selectSourcesDetailed(results, limit, options).sources
}

export function serializeSource(source: ResearchSource): string {
  return JSON.stringify(source)
}

/** Canonical is descriptive identity only: it must never erase retrieval disagreement. */
export function buildSource(
  document: ReadableDocument,
  query: string,
  maxChars: number,
): ResearchSource | null {
  const retrieval = normalizeSourceUrl(document.url)
  let identityUrl = retrieval
  if (document.canonicalUrl) {
    try {
      const canonical = normalizeSourceUrl(document.canonicalUrl)
      if (new URL(canonical).hostname === new URL(retrieval).hostname) identityUrl = canonical
    } catch {
      /* Untrusted canonical declarations cannot invalidate a retrieved source. */
    }
  }
  const text = document.text.trim().slice(0, 24000)
  if (!text) return null
  const hash = createHash('sha256').update(retrieval).digest('hex')
  const source: ResearchSource = {
    sourceId: `source-${hash}`,
    documentId: `document-${hash}`,
    url: document.url,
    identityUrl,
    title: document.title.slice(0, 512),
    domain: new URL(retrieval).hostname,
    retrievedAt: document.retrievedAt.slice(0, 64),
    query: query.slice(0, 512),
    excerpt: text,
    truncated: document.truncated || document.text.trim().length > text.length,
  }
  if (serializeSource(source).length <= maxChars) return source
  source.truncated = true
  let low = 0,
    high = text.length
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    source.excerpt = text.slice(0, length)
    if (serializeSource(source).length <= maxChars) low = length
    else high = length - 1
  }
  source.excerpt = text.slice(0, low)
  return source.excerpt.trim() && serializeSource(source).length <= maxChars ? source : null
}
