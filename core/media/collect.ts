import { MEDIA_LIMITS, type MediaItem } from './types'
import type { ToolObservation, ToolSource } from '../mind/tools'

/**
 * Turning what a search returned into something a card can draw.
 *
 * ## Why this is not done by reading the answer
 *
 * The model writes "[1] https://…" and a sentence about what is at that address. An
 * address typed into a sentence is not evidence: it may be truncated, hallucinated, or
 * real but pointing somewhere else now. A card built from prose is a picture of
 * something nobody looked at, drawn with the confidence of something somebody did.
 *
 * So the items come from the observations — the actual `SearchResult` rows the provider
 * returned, carried through the tool — and the text is never consulted. If Freya's
 * answer forgets to mention a result, the result still has its card, which is the
 * correct direction to be wrong in: showing something that was really found, rather
 * than showing something an answer described.
 *
 * ## What it will not do
 *
 * It does not invent a duration, a page count or a byte size. Those appear only when a
 * source stated them, because a card that prints `12:40` for a video whose length was
 * never known is a card that made something up.
 */

/** Verticals that carry something to show, and how each is presented. */
function kindFor(vertical: string | undefined, mediaUrl: string): MediaItem['kind'] | null {
  if (vertical === 'images') return 'image'
  if (vertical === 'videos') return 'video'
  if (vertical === 'documents') return 'document'
  // No vertical recorded: infer only from what the address itself claims, and only
  // for the extensions that are unambiguous. Anything else stays out, because a card
  // of the wrong kind is worse than no card.
  const path = safePath(mediaUrl)
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(path)) return 'image'
  if (/\.(mp4|webm|ogv|mov|m4v)$/i.test(path)) return 'video'
  if (/\.pdf$/i.test(path)) return 'document'
  return null
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Whether an address may become a card.
 *
 * Checked here as well as where sources are built, on purpose. This function hands the
 * address to something that renders it, so it decides for itself rather than trusting
 * that every caller already filtered: `javascript:` is not a picture, and `data:` is a
 * document pretending to be one.
 */
function cardSafeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 2_000) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** A source is only worth a card if it names media that exists. */
function toItem(source: ToolSource): MediaItem | null {
  // A document is usually the page itself rather than a separate media address: a search
  // for a report returns links to the PDF, and there is no "media URL" behind them.
  // Reading `mediaUrl` first and falling back to the source's own address is what lets a
  // document become a card at all — otherwise the documents vertical produces a
  // transcript of links and no cards, which is precisely the case the card exists for.
  const candidate = cardSafeUrl(source.mediaUrl) ?? (source.vertical === 'documents' ? cardSafeUrl(source.url) : null)
  if (candidate === null) return null

  const kind = kindFor(source.vertical, candidate)
  if (kind === null) return null
  const mediaUrl = candidate

  return {
    kind,
    url: mediaUrl,
    page: source.url,
    title: source.title === '' ? mediaUrl : source.title,
    host: source.sourceDomain === '' ? hostOf(mediaUrl) : source.sourceDomain,
    duration: typeof source.duration === 'string' && source.duration !== '' ? source.duration : null,
    bytes: null,
    pages: null,
    // Only an address that is itself plausibly playable is called playable. The
    // alternative — assuming — produces a card with a play badge that does nothing
    // when pressed, which is the exact failure this whole exercise is about.
    playable: kind === 'video' && looksPlayable(mediaUrl),
  }
}

/** Extensions a browser can play without a plugin. */
function looksPlayable(url: string): boolean {
  return /\.(mp4|webm|ogv|m4v)(?:$|[?#])/i.test(safePath(url)) || /\.(mp4|webm|ogv|m4v)(?:$|[?#])/i.test(url)
}

/**
 * Every card this answer earned, in the order they were found.
 *
 * Capped across the whole answer rather than per lookup: a turn that searched twice has
 * not asked for twice as many pictures, and the number that reaches the cap is the
 * number that was asked for.
 *
 * Duplicates by media address are dropped, because the same poster arriving from two
 * searches is one picture and two cards.
 */
export function mediaFromObservations(observations: readonly ToolObservation[]): MediaItem[] {
  const items: MediaItem[] = []
  const seen = new Set<string>()

  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    for (const source of observation.sources) {
      if (items.length >= MEDIA_LIMITS.cardsPerAnswer) return items
      const item = toItem(source)
      if (item === null) continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      items.push(item)
    }
  }

  return items
}