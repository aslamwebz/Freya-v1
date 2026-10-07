// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SearxngSearchProvider } from '../../../core/research/providers/searxng'
import type { HttpTransport } from '../../../core/research/transport'

/**
 * Row shapes captured from a real SearXNG daemon, where the engines disagree
 * about which field carries a video's poster and none of them is guaranteed.
 *
 * The regression: a video row's still lived in `thumbnail`, which the provider
 * never read — so Bing and DuckDuckGo video rows carried no `thumbnailUrl`, and
 * `mediaFromObservations` (which refuses to draw a video card with no poster)
 * dropped every one of them. A video search answered with prose and no cards.
 */
const BING_VIDEO_ROW = {
  title: 'Queues in Laravel: Main Things You Need to Know',
  url: 'https://www.youtube.com/watch?v=D5tr7r2_i7E',
  content: 'A walkthrough of the queue basics.',
  img_src: '',
  thumbnail: 'https://th.bing.com/th/id/OVP.poster?w=354&h=199',
  thumbnail_src: null,
  iframe_src: null,
  length: '12:18',
  author: 'Laravel Daily',
  publishedDate: null,
  engines: ['bing videos'],
}

const DDG_VIDEO_ROW = {
  title: 'Building a Video Processing Pipeline',
  url: 'https://www.youtube.com/watch?v=c9m5mZqSb1o',
  content: 'Second engine, same shape.',
  img_src: '',
  thumbnail: 'https://external.duckduckgo.com/iu/?u=poster',
  thumbnail_src: null,
  iframe_src: 'https://www.youtube.com/embed/c9m5mZqSb1o',
  length: '28:13',
}

const SEPIA_VIDEO_ROW = {
  title: 'Laravel AI SDK Full Review',
  url: 'https://tube.example.org/videos/watch/42',
  content: 'A PeerTube row: iframe but no known player host.',
  img_src: '',
  thumbnail: 'https://tube.example.org/lazy-static/thumbnails/poster.webp',
  thumbnail_src: null,
  iframe_src: 'https://tube.example.org/videos/embed/42',
  length: 599,
}

function rowsTransport(rows: readonly unknown[]): HttpTransport {
  return {
    get: async (url: string) => ({
      url,
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ results: rows })),
    }),
  }
}

function providerWith(rows: readonly unknown[], get: ReturnType<typeof vi.fn> | undefined = undefined): SearxngSearchProvider {
  const transport = rowsTransport(rows)
  return new SearxngSearchProvider({
    env: { FREYA_SEARXNG_URL: 'http://127.0.0.1:8899', FREYA_ALLOW_WEB_SEARCH: '1' },
    transport: get === undefined ? transport : { get: get as HttpTransport['get'] },
  })
}

const opts = () => ({ signal: new AbortController().signal, limit: 10, vertical: 'videos' as const })

describe('SearxngSearchProvider video rows', () => {
  it('reads the poster out of `thumbnail`, the field the video engines actually fill', async () => {
    const results = await providerWith([BING_VIDEO_ROW]).search('laravel queues tutorial', opts())
    expect(results).toHaveLength(1)
    expect(results[0]!.thumbnailUrl).toBe('https://th.bing.com/th/id/OVP.poster?w=354&h=199')
  })

  it('carries the engine-stated runtime as metadata.duration, and an embed when named', async () => {
    const results = await providerWith([BING_VIDEO_ROW, DDG_VIDEO_ROW]).search('laravel queues tutorial', opts())
    expect(results[0]!.metadata?.duration).toBe('12:18')
    expect(results[0]!.mediaUrl).toBeNull()
    expect(results[1]!.mediaUrl).toBe('https://www.youtube.com/embed/c9m5mZqSb1o')
  })

  it('keeps a numeric engine length as metadata rather than dropping the row', async () => {
    const results = await providerWith([SEPIA_VIDEO_ROW]).search('laravel review', opts())
    expect(results[0]!.metadata?.duration).toBe('599')
  })

  it('does not treat an empty image field on a video row as a thumbnail', async () => {
    const rows = [{ title: 'No poster anywhere', url: 'https://www.youtube.com/watch?v=zZzZzZzZ12', img_src: '', thumbnail: '', thumbnail_src: null, iframe_src: null }]
    const results = await providerWith(rows).search('q', opts())
    expect(results).toHaveLength(1)
    expect(results[0]!.thumbnailUrl).toBeNull()
    expect(results[0]!.mediaUrl).toBeNull()
  })

  it('only reaches the transport for configured, opted-in calls', async () => {
    const get = vi.fn(rowsTransport([]).get)
    const provider = new SearxngSearchProvider({
      env: { FREYA_SEARXNG_URL: 'http://127.0.0.1:8899' },
      transport: { get: get as HttpTransport['get'] },
    })
    expect(provider.status()).toEqual({ ready: false, reason: 'disabled' })
    await expect(provider.search('query', opts())).rejects.toMatchObject({ code: 'disabled' })
    expect(get).not.toHaveBeenCalled()
  })
})
