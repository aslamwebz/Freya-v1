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

/** Rank within a host is preserved; first give each host a chance. */
export function selectSources(results: readonly SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>()
  const hosts = new Set<string>()
  const first: SearchResult[] = [], rest: SearchResult[] = []
  for (const result of results.slice(0, 24)) {
    let url: string
    try { url = normalizeSourceUrl(result.url) } catch { continue }
    if (seen.has(url)) continue
    seen.add(url)
    const host = new URL(url).hostname
    const row = { ...result, url, sourceDomain: host }
    if (hosts.has(host)) rest.push(row)
    else { hosts.add(host); first.push(row) }
  }
  return [...first, ...rest].slice(0, Math.max(0, Math.min(24, Math.floor(limit))))
}

export function serializeSource(source: ResearchSource): string { return JSON.stringify(source) }

/** Canonical is descriptive identity only: it must never erase retrieval disagreement. */
export function buildSource(document: ReadableDocument, query: string, maxChars: number): ResearchSource | null {
  const retrieval = normalizeSourceUrl(document.url)
  let identityUrl = retrieval
  if (document.canonicalUrl) {
    try {
      const canonical = normalizeSourceUrl(document.canonicalUrl)
      if (new URL(canonical).hostname === new URL(retrieval).hostname) identityUrl = canonical
    } catch { /* Untrusted canonical declarations cannot invalidate a retrieved source. */ }
  }
  const text = document.text.trim().slice(0, 24000)
  if (!text) return null
  const hash = createHash('sha256').update(retrieval).digest('hex')
  const source: ResearchSource = {
    sourceId: `source-${hash}`, documentId: `document-${hash}`,
    url: document.url, identityUrl, title: document.title.slice(0, 512),
    domain: new URL(retrieval).hostname, retrievedAt: document.retrievedAt.slice(0, 64),
    query: query.slice(0, 512), excerpt: text, truncated: document.truncated || document.text.trim().length > text.length,
  }
  if (serializeSource(source).length <= maxChars) return source
  source.truncated = true
  let low = 0, high = text.length
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    source.excerpt = text.slice(0, length)
    if (serializeSource(source).length <= maxChars) low = length
    else high = length - 1
  }
  source.excerpt = text.slice(0, low)
  return source.excerpt.trim() && serializeSource(source).length <= maxChars ? source : null
}
