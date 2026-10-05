/**
 * What kind of thing was found.
 *
 * A caller has to be able to tell an image from a video from a document without
 * reading the snippet, both to render the right result shape and to be honest
 * about what Freya actually found. `web` is the default and is never inferred
 * from anything but the category that was asked for.
 */
export type SearchVertical = 'web' | 'images' | 'videos' | 'documents'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  sourceDomain: string
  rank: number
  publishedAt: string | null
  retrievedAt: string
  /**
   * Which vertical produced this row. Optional because a provider that only
   * serves the web vertical has nothing to add; a reader must treat `undefined`
   * as `web` rather than as "unknown".
   */
  readonly vertical?: SearchVertical
  /**
   * The media itself, when the vertical has one: an image URL, or a video's
   * embeddable frame. Never a substitute for `url`, which is always the
   * human-openable source page.
   */
  readonly mediaUrl?: string | null
  readonly thumbnailUrl?: string | null
  /**
   * The page that *hosts* the media, which is not always `url` — some engines
   * return the direct asset as `url` and the containing page separately. Kept so
   * provenance can answer "where did this come from" for a bare image URL.
   */
  readonly pageUrl?: string | null
  /** Engine-reported extras: duration for a video, dimensions for an image. */
  readonly metadata?: Readonly<Record<string, string>>
}

export interface SearchQueryOptions {
  readonly signal: AbortSignal
  readonly limit: number
  readonly offset?: number
  /**
   * Which vertical to ask for. Defaults to `web`.
   *
   * A provider that cannot serve the vertical must say so by throwing rather than
   * answering with the wrong kind of result — a request for images answered with
   * ten web links is the silent downgrade this exists to prevent.
   */
  readonly vertical?: SearchVertical
}

export interface SearchProvider {
  readonly id: string
  status(): { ready: boolean; reason: string }
  /**
   * Which verticals this provider can genuinely serve.
   *
   * Optional so an existing web-only provider keeps working unchanged; absent
   * means "web only", which is what every provider that predates this field
   * actually did.
   */
  supports?(vertical: SearchVertical): boolean
  search(query: string, options: SearchQueryOptions): Promise<SearchResult[]>
}
