import { describe, expect, it } from 'vitest'

import { mediaFromObservations } from '../../../core/media/collect'
import { MEDIA_LIMITS, type MediaItem } from '../../../core/media/types'
import type { ToolObservation, ToolSource } from '../../../core/mind/tools'

/**
 * What Freya is allowed to put a card in the transcript for.
 *
 * The interesting cases are all refusals: an answer that mentions a URL nobody searched
 * for, a search result with no media, a duplicated picture, a video whose length was
 * never stated. Each of those is a place where a card could become a picture of
 * something that was never found.
 */
function source(over: Partial<ToolSource> = {}): ToolSource {
  return {
    title: 'A result',
    url: 'https://example.org/page',
    sourceDomain: 'example.org',
    snippet: 'a snippet',
    rank: 1,
    retrievedAt: null,
    ...over,
  }
}

function ok(sources: readonly ToolSource[]): ToolObservation {
  return {
    kind: 'ok',
    tool: 'web_search',
    capability: 'search.web',
    summary: 'Read 1 result.',
    sources,
  }
}

describe('collecting cards from what a search returned', () => {
  it('makes one card per image a search actually returned', () => {
    const items = mediaFromObservations([ok([
      source({ mediaUrl: 'https://cdn.example/a.jpg', vertical: 'images' }),
      source({ mediaUrl: 'https://cdn.example/b.png', vertical: 'images', rank: 2 }),
    ])])

    expect(items).toHaveLength(2)
    expect(items[0]?.kind).toBe('image')
    expect(items[1]?.url).toBe('https://cdn.example/b.png')
    // The card says where it came from, which is the citation the answer may forget.
    expect(items[0]?.page).toBe('https://example.org/page')
    expect(items[0]?.host).toBe('example.org')
  })

  it('returns nothing for a lookup that found only web pages', () => {
    const items = mediaFromObservations([ok([source({ url: 'https://example.org/article' })])])
    expect(items).toEqual([])
  })

  it('returns nothing when the lookup failed or was refused', () => {
    // A refused lookup has no results, so it cannot have found a picture. Rendering a
    // card here would be inventing a result out of a refusal.
    const denied: ToolObservation = {
      kind: 'denied',
      tool: 'web_search',
      capability: 'search.web',
      reason: 'not permitted',
    }
    const failed: ToolObservation = {
      kind: 'failed',
      tool: 'web_search',
      capability: 'search.web',
      reason: 'the provider could not be reached',
    }
    expect(mediaFromObservations([denied, failed])).toEqual([])
  })

  it('marks a video playable only when its address is one a browser can play', () => {
    const [playable, embedOnly] = mediaFromObservations([
      ok([
        source({
          mediaUrl: 'https://cdn.example/clip.mp4',
          thumbnailUrl: 'https://cdn.example/clip-poster.jpg',
          vertical: 'videos',
        }),
        source({
          url: 'https://www.youtube.com/watch?v=abc',
          mediaUrl: 'https://www.youtube.com/embed/abc',
          thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
          vertical: 'videos',
          rank: 2,
        }),
      ]),
    ]) as MediaItem[]

    expect(playable?.playable).toBe(true)
    // A watch page is not a video file. The card still appears — it is still something
    // found — but it must not promise a player.
    expect(embedOnly?.playable).toBe(false)
  })

  it('keeps a video poster separate from the video address', () => {
    const items = mediaFromObservations([ok([
      source({
        url: 'https://www.youtube.com/watch?v=abc',
        mediaUrl: 'https://www.youtube.com/embed/abc',
        thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
        vertical: 'videos',
      }),
    ])])

    expect(items[0]).toMatchObject({
      kind: 'video',
      url: 'https://www.youtube.com/watch?v=abc',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      embedUrl: 'https://www.youtube.com/embed/abc',
      playable: false,
    })
  })

  it('refuses arbitrary iframe hosts from becoming in-Chat players', () => {
    const items = mediaFromObservations([ok([
      source({
        url: 'https://example.org/watch/abc',
        mediaUrl: 'https://evil.example/embed/abc',
        thumbnailUrl: 'https://cdn.example/poster.jpg',
        vertical: 'videos',
      }),
    ])])

    expect(items[0]?.kind).toBe('video')
    expect(items[0]?.embedUrl).toBeUndefined()
    expect(items[0]?.url).toBe('https://example.org/watch/abc')
  })

  it('never invents a duration, a page count or a size', () => {
    const items = mediaFromObservations([ok([
      source({
        mediaUrl: 'https://cdn.example/clip.mp4',
        thumbnailUrl: 'https://cdn.example/clip-poster.jpg',
        vertical: 'videos',
      }),
    ])])
    expect(items[0]?.duration).toBeNull()
    expect(items[0]?.pages).toBeNull()
    expect(items[0]?.bytes).toBeNull()
  })

  it('keeps a duration the source actually stated', () => {
    const items = mediaFromObservations([ok([
      source({
        mediaUrl: 'https://cdn.example/clip.mp4',
        thumbnailUrl: 'https://cdn.example/clip-poster.jpg',
        vertical: 'videos',
        duration: '12:40',
      }),
    ])])
    expect(items[0]?.duration).toBe('12:40')
  })

  it('shows one card for a picture two searches both returned', () => {
    const items = mediaFromObservations([
      ok([source({ mediaUrl: 'https://cdn.example/a.jpg', vertical: 'images' })]),
      ok([source({ mediaUrl: 'https://cdn.example/a.jpg', vertical: 'images', rank: 1 })]),
    ])
    expect(items).toHaveLength(1)
  })

  it('caps the cards for the whole answer, not for each lookup', () => {
    const many = (from: number) =>
      Array.from({ length: 8 }, (_, index) =>
        source({ mediaUrl: `https://cdn.example/${String(from + index)}.jpg`, vertical: 'images', rank: from + index }))
    const items = mediaFromObservations([ok(many(0)), ok(many(100))])

    expect(items.length).toBe(MEDIA_LIMITS.cardsPerAnswer)
  })

  it('ignores a media address that is not an ordinary web address', () => {
    // `toSource` already refuses these, and this is the second gate: a `data:` "image"
    // is remote input wearing an image's clothes, and a card hands it to a renderer.
    const items = mediaFromObservations([ok([
      source({ mediaUrl: 'javascript:alert(1)', vertical: 'images' }),
      source({ mediaUrl: 'data:text/html,<script>alert(1)</script>', vertical: 'images', rank: 2 }),
    ])])
    expect(items).toEqual([])
  })

  it('refuses a media address with no vertical and an unhelpful name', () => {
    // Nothing to go on, so nothing is claimed. A card of a guessed kind is worse than
    // no card, because it looks like something that was found.
    const items = mediaFromObservations([ok([
      source({ mediaUrl: 'https://cdn.example/asset?id=9f2c1', vertical: undefined }),
    ])])
    expect(items).toEqual([])
  })

  it('falls back to the address when a source carries no vertical but says what it is', () => {
    const items = mediaFromObservations([ok([
      source({ mediaUrl: 'https://cdn.example/a.png', vertical: undefined }),
    ])])
    expect(items[0]?.kind).toBe('image')
  })
})
  it('makes a card for a document the search returned as a plain link', () => {
    // The documents vertical has no media URL behind its rows: a search for a report
    // returns links to the PDF and nothing else. Without falling back to the source's own
    // address, every document search produced a paragraph of links and no cards.
    const items = mediaFromObservations([ok([
      source({
        url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=OJ:L_202401689',
        sourceDomain: 'eur-lex.europa.eu',
        title: 'Regulation (EU) 2024/1689',
        vertical: 'documents',
      }),
    ])])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'document',
      url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=OJ:L_202401689',
      page: 'https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=OJ:L_202401689',
      host: 'eur-lex.europa.eu',
    })
    // A document is not playable and never claims a runtime.
    expect(items[0]?.playable).toBe(false)
    expect(items[0]?.duration).toBeNull()
  })

  it('does not turn an ordinary web link into a card', () => {
    // The fallback is for the documents vertical only. A web result that happens to end
    // in .pdf is a link in a sentence, not a document Freya was asked to fetch.
    const items = mediaFromObservations([ok([
      source({ url: 'https://example.org/paper.pdf', vertical: 'web' }),
    ])])
    expect(items).toEqual([])
  })

describe('deriving in-Chat players for known video hosts', () => {
  it('builds the canonical embed for a YouTube watch URL the provider gave no iframe for', () => {
    // The largest video index answers with the watch page and no embed field. The
    // derivation below is a deterministic rewrite of that address, onto a host the
    // allowlist already names — not a player invented out of nothing.
    const items = mediaFromObservations([ok([
      source({
        url: 'https://www.youtube.com/watch?v=D5tr7r2_i7E',
        thumbnailUrl: 'https://th.bing.com/th/id/OVP.poster',
        vertical: 'videos',
      }),
    ])])
    expect(items[0]).toMatchObject({
      kind: 'video',
      url: 'https://www.youtube.com/watch?v=D5tr7r2_i7E',
      embedUrl: 'https://www.youtube.com/embed/D5tr7r2_i7E',
      playable: false,
    })
  })

  it('uses the canonical YouTube still when the provider named no thumbnail', () => {
    // A video with no poster and no embed would be dropped entirely. The canonical
    // still is derived from the id the watch URL carries, and it is fetched and
    // byte-validated like any other poster before it is drawn.
    const items = mediaFromObservations([ok([
      source({
        url: 'https://www.youtube.com/watch?v=tgJEBN6HFag',
        mediaUrl: undefined,
        thumbnailUrl: undefined,
        vertical: 'videos',
      }),
    ])])
    expect(items[0]?.kind).toBe('video')
    expect(items[0]?.thumbnailUrl).toBe('https://i.ytimg.com/vi/tgJEBN6HFag/hqdefault.jpg')
    expect(items[0]?.embedUrl).toBe('https://www.youtube.com/embed/tgJEBN6HFag')
  })

  it('still refuses embeds for hosts outside the allowlist, however the URL is shaped', () => {
    const items = mediaFromObservations([ok([
      source({
        url: 'https://tube.example.org/videos/watch/42',
        thumbnailUrl: 'https://tube.example.org/thumbnails/poster.webp',
        vertical: 'videos',
      }),
    ])])
    expect(items[0]?.kind).toBe('video')
    expect(items[0]?.embedUrl).toBeUndefined()
    // And the card itself still exists: a video with a poster and no player is a
    // truthful result, not a dropped one.
    expect(items[0]?.url).toBe('https://tube.example.org/videos/watch/42')
  })

  it('does not derive anything from a shortened host it cannot verify', () => {
    const items = mediaFromObservations([ok([
      source({
        url: 'https://example.org/v/abc123456',
        vertical: 'videos',
      }),
    ])])
    // No thumbnail anywhere: nothing drawable, so nothing is shown rather than
    // a card pointing at a URL nobody fetched.
    expect(items).toEqual([])
  })
})
