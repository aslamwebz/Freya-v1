import type { ToolSource } from './types'
import { MIND_TOOL_LIMITS } from './limits'
import { sanitiseUntrustedText } from './text'

/** Narrow one unknown row to a bounded, linkable source. Or null. */
export function toSource(row: unknown, rank: number, retrievedAt: string): ToolSource | null {
  if (typeof row !== 'object' || row === null) return null
  const record = row as Record<string, unknown>

  const url = record['url']
  if (typeof url !== 'string') return null
  const safeUrl = safeHttpUrl(url)
  if (safeUrl === null) return null

  const title = typeof record['title'] === 'string' ? record['title'] : safeUrl
  const snippet = typeof record['snippet'] === 'string' ? record['snippet'] : ''
  const domain = typeof record['sourceDomain'] === 'string' ? record['sourceDomain'] : safeUrl

  // The media addresses go through the same `http`-only gate as the page URL. A
  // `data:` or `javascript:` "thumbnail" is remote input wearing an image's clothes,
  // and a card is exactly the place where it would be handed to something that renders.
  const mediaUrl = optionalHttpUrl(record['mediaUrl'])
  const thumbnailUrl = optionalHttpUrl(record['thumbnailUrl'])
  const vertical = typeof record['vertical'] === 'string' ? record['vertical'] : undefined
  // Runtime as the provider stated it — never derived from the title or the URL.
  // SearXNG reports a video's length as `metadata.duration`, so that is read before
  // assuming the row has no runtime to print.
  const metadata = typeof record['metadata'] === 'object' && record['metadata'] !== null
    ? record['metadata'] as Record<string, unknown>
    : undefined
  const statedDuration = [record['duration'], metadata?.duration].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  const duration = statedDuration ?? null

  return {
    title: sanitiseUntrustedText(title, MIND_TOOL_LIMITS.maxTitleChars),
    url: safeUrl,
    sourceDomain: sanitiseUntrustedText(domain, MIND_TOOL_LIMITS.maxTitleChars),
    snippet: sanitiseUntrustedText(snippet, MIND_TOOL_LIMITS.maxSnippetChars),
    rank,
    retrievedAt,
    ...(mediaUrl === null ? {} : { mediaUrl }),
    ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
    ...(vertical === undefined ? {} : { vertical }),
    duration,
  }
}

/** An address that is either absent or an ordinary web address. Never invented. */
function optionalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return safeHttpUrl(value)
}

/**
 * Only `http` and `https` may reach a transcript.
 *
 * A search result is remote input, and `javascript:` or `data:` in a `url` field
 * is the oldest trick there is. Anything that does not parse as an ordinary web
 * URL is dropped rather than sanitised, because there is no honest version of a
 * `javascript:` URL.
 */
function safeHttpUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // Bounded, because a 10k-character URL in a footer helps nobody.
  return parsed.toString().slice(0, 300)
}

/** Bound the sources a tool reported, in order, dropping what cannot be cited. */
export function boundSources(sources: readonly ToolSource[]): ToolSource[] {
  const out: ToolSource[] = []
  for (const source of sources) {
    if (out.length >= MIND_TOOL_LIMITS.maxResultsPerTool) break
    if (typeof source !== 'object' || source === null) continue
    const url = safeHttpUrl(source.url)
    if (url === null) continue
    // The media fields survive the bound, re-gated rather than trusted: this is the
    // last pass over a source before it is stored on a message, and a source that
    // reached here from a provider has already been through `toSource` but not
    // through anybody who checked the addresses again.
    const mediaUrl = optionalHttpUrl(source.mediaUrl)
    const thumbnailUrl = optionalHttpUrl(source.thumbnailUrl)
    out.push({
      title: sanitiseUntrustedText(source.title, MIND_TOOL_LIMITS.maxTitleChars),
      url,
      sourceDomain: sanitiseUntrustedText(source.sourceDomain, MIND_TOOL_LIMITS.maxTitleChars),
      snippet: sanitiseUntrustedText(source.snippet, MIND_TOOL_LIMITS.maxSnippetChars),
      rank: out.length + 1,
      retrievedAt: source.retrievedAt ?? null,
      ...(mediaUrl === null ? {} : { mediaUrl }),
      ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
      ...(typeof source.vertical === 'string' ? { vertical: source.vertical } : {}),
      duration: typeof source.duration === 'string' ? source.duration : null,
    })
  }
  return out
}
