export interface SearchResult {
  title: string
  url: string
  snippet: string
  sourceDomain: string
  rank: number
  publishedAt: string | null
  retrievedAt: string
}

export interface SearchProvider {
  readonly id: string
  status(): { ready: boolean; reason: string }
  search(query: string, options: { signal: AbortSignal; limit: number }): Promise<SearchResult[]>
}
