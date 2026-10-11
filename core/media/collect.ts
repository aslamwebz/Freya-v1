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
  if (vertical === 'audio') return 'audio'
  if (vertical === 'pages') return 'page'
  // No vertical recorded: infer only from what the address itself claims, and only
  // for the extensions that are unambiguous. Anything else stays out, because a card
  // of the wrong kind is worse than no card.
  const path = safePath(mediaUrl)
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(path)) return 'image'
  if (/\.(mp4|webm|ogv|mov|m4v)$/i.test(path)) return 'video'
  if (/\.(mp3|m4a|ogg|wav|flac)$/i.test(path)) return 'audio'
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

/**
 * Hosted players are the one deliberate exception to "renderer gets data bytes".
 * They stay inside the preview modal and are restricted to well-known video
 * player origins; an arbitrary search-result URL can never become an iframe.
 *
 * Exported because it is also the last gate on the way *out* of durable storage:
 * the Vault conversation store re-checks every media item it hands a projection,
 * and an embed that outlived this function's copy of the code must still name a
 * player host the modal would have allowed in the first place.
 */
export function safeVideoEmbed(value: string | null): string | null {
  if (value === null) return null
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    const allowed =
      host === 'www.youtube.com' ||
      host === 'youtube.com' ||
      host === 'www.youtube-nocookie.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'player.vimeo.com' ||
      host === 'www.dailymotion.com' ||
      host === 'dailymotion.com'
    return allowed ? parsed.toString() : null
  } catch {
    return null
  }
}

/** The video id of a watch/short URL on a host the embed allowlist already names. */
function playerVideoId(address: string): { host: 'youtube' | 'vimeo' | 'dailymotion'; id: string } | null {
  let id = /(?:youtube\.com\/(?:watch\?[^#]*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{8,})/i.exec(address)?.[1]
  if (id !== undefined) return { host: 'youtube', id }
  id = /vimeo\.com\/(?:video\/)?(\d{6,})/i.exec(address)?.[1]
  if (id !== undefined) return { host: 'vimeo', id }
  id = /dailymotion\.com\/(?:video\/|embed\/video\/)([A-Za-z0-9_-]{5,})/i.exec(address)?.[1]
  if (id !== undefined) return { host: 'dailymotion', id }
  return null
}

/**
 * The canonical embed for a known player host, derived from the watch URL.
 *
 * This is a deterministic rewrite of an address the provider returned — the video
 * id is read out of a URL the source itself supplied, and the embed host is one the
 * in-modal allowlist already names — not a metadata value invented for a card.
 * Providers whose rows give the watch page but no `iframe` field (the common case
 * for the largest video index) would otherwise never embed, and every result would
 * fall back to a poster and an "unavailable" note.
 */
function canonicalVideoEmbed(address: string): string | null {
  const player = playerVideoId(address)
  if (player === null) return null
  if (player.host === 'youtube') return `https://www.youtube.com/embed/${player.id}`
  if (player.host === 'vimeo') return `https://player.vimeo.com/video/${player.id}`
  return `https://www.dailymotion.com/embed/video/${player.id}`
}

/**
 * The still a known player host serves for a video id, used when the search provider
 * named no thumbnail of its own. Like the embed above, it is an address derived from
 * a URL the provider returned, and it still travels the same fetch-and-sniff path as
 * every other poster: if the bytes are not an image, the card simply does not draw.
 */
function canonicalVideoPoster(address: string): string | null {
  const player = playerVideoId(address)
  return player !== null && player.host === 'youtube' ? `https://i.ytimg.com/vi/${player.id}/hqdefault.jpg` : null
}

/** A source is only worth a card if it names media that exists. */
export function mediaFromSource(source: ToolSource): MediaItem | null {
  const page = cardSafeUrl(source.url)
  if (page === null) return null

  const media = cardSafeUrl(source.mediaUrl)
  const thumbnail = cardSafeUrl(source.thumbnailUrl)
  const vertical = source.vertical

  let kind: MediaItem['kind'] | null = null
  let mediaUrl: string | null = null
  let thumbnailUrl: string | null = null
  let embedUrl: string | null = null

  if (vertical === 'images') {
    kind = 'image'
    mediaUrl = media ?? thumbnail
    thumbnailUrl = thumbnail ?? mediaUrl
  } else if (vertical === 'videos') {
    kind = 'video'
    const direct = media !== null && looksPlayable(media) ? media : null
    // An embed comes from the provider's own player field when it named one, or from
    // the canonical player for a watch URL on an already-allowlisted host.
    embedUrl = direct === null
      ? (safeVideoEmbed(media) ?? canonicalVideoEmbed(media ?? '') ?? canonicalVideoEmbed(page))
      : null
    // The human-openable result page stays the canonical video address when the
    // provider supplied an iframe. The iframe itself is kept separately.
    mediaUrl = direct ?? page
    thumbnailUrl = thumbnail ?? canonicalVideoPoster(media ?? '') ?? canonicalVideoPoster(page)
  } else if (vertical === 'documents') {
    kind = 'document'
    // Document indexes commonly return the PDF as the result URL itself.
    mediaUrl = media ?? page
  } else if (media !== null) {
    kind = kindFor(undefined, media)
    mediaUrl = media
    thumbnailUrl = kind === 'image' ? (thumbnail ?? media) : thumbnail
  }

  if (kind === null || mediaUrl === null) return null
  // Images and videos must have something drawable in the transcript. Documents
  // deliberately use a labelled card and fetch their bytes only after a click.
  if ((kind === 'image' || kind === 'video') && thumbnailUrl === null) return null

  return {
    kind,
    url: mediaUrl,
    ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
    ...(embedUrl === null ? {} : { embedUrl }),
    page,
    title: source.title === '' ? mediaUrl : source.title,
    host: source.sourceDomain === '' ? hostOf(page) : source.sourceDomain,
    duration: typeof source.duration === 'string' && source.duration !== '' ? source.duration : null,
    bytes: null,
    pages: null,
    playable: kind === 'video' && media !== null && looksPlayable(media),
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
    if (process.env.FREYA_MEDIA_TRACE === '1') {
      for (const source of observation.sources) {
        const traced = {
          title: source.title.slice(0, 40),
          url: safePlace(source.url),
          vertical: source.vertical ?? null,
          statedMedia: safePlace(source.mediaUrl ?? undefined),
          statedPoster: safePlace(source.thumbnailUrl ?? undefined),
        }
        console.error(`[media.collect] source ${JSON.stringify(traced)}`)
      }
    }
    for (const source of observation.sources) {
      if (items.length >= MEDIA_LIMITS.cardsPerAnswer) return items
      const item = mediaFromSource(source)
      if (process.env.FREYA_MEDIA_TRACE === '1') {
        console.error(`[media.collect] item ${item === null ? 'DROPPED' : JSON.stringify({
          kind: item.kind,
          host: item.host,
          hasPoster: item.thumbnailUrl !== undefined,
          hasEmbed: item.embedUrl !== undefined,
          duration: item.duration,
        })}`)
      }
      if (item === null) continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      items.push(item)
    }
  }

  return items
}
/** Never trace a model-supplied string: only whether a bounded http url was there. */
function safePlace(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname.slice(0, 60) : null
  } catch {
    return null
  }
}
