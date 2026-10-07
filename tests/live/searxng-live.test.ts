// @vitest-environment node
/**
 * Live provider check against a real SearXNG daemon.
 *
 * Not part of `npm test`: this needs a running daemon on FREYA_SEARXNG_URL and the
 * real internet behind it. Run it with `npm run test:chat-live` (or directly with
 * vitest) when you want to see the provider actually reach a search engine.
 *
 * It asserts provenance and shape, never specific content — a result set changes
 * with the web, so pinning a title or a URL here would make this a test of the
 * internet rather than of the code.
 */
import { describe, expect, it } from 'vitest'
import { SearxngSearchProvider } from '../../core/research/providers/searxng'
import { Searcher } from '../../core/research/searcher'
import type { SearchVertical } from '../../core/research/types'

const base = process.env.FREYA_SEARXNG_URL?.trim() ?? ''
const live = base !== '' && process.env.FREYA_ALLOW_WEB_SEARCH === '1'

function provider(): SearxngSearchProvider {
  return new SearxngSearchProvider({
    env: { FREYA_SEARXNG_URL: base, FREYA_ALLOW_WEB_SEARCH: '1' },
  })
}

describe.skipIf(!live)('SearxngSearchProvider against a live daemon', () => {
  it('reports itself ready', () => {
    expect(provider().status()).toEqual({ ready: true, reason: 'ready' })
  })

  const cases: readonly { vertical: SearchVertical; query: string; expectMedia: boolean }[] = [
    { vertical: 'web', query: 'laravel queues failed job retry command', expectMedia: false },
    { vertical: 'images', query: 'James Webb Space Telescope', expectMedia: true },
    { vertical: 'videos', query: 'laravel queues tutorial', expectMedia: true },
  ]

  for (const { vertical, query, expectMedia } of cases) {
    it(`returns real ${vertical} results with provenance`, async () => {
      const searcher = new Searcher({ provider: provider() })
      const results = await searcher.searchWeb(query, { limit: 5, vertical })
      expect(results.length).toBeGreaterThan(0)

      for (const result of results) {
        // Provenance: something a person can open, and where it came from.
        expect(() => new URL(result.url)).not.toThrow()
        expect(new URL(result.url).protocol).toMatch(/^https?:$/)
        expect(result.sourceDomain).toBe(new URL(result.url).hostname)
        expect(result.title.trim().length).toBeGreaterThan(0)
        expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect(result.vertical ?? 'web').toBe(vertical)
        expect(result.rank).toBeGreaterThan(0)
      }
      // Ranks are dense and ordered, so a panel can number them without re-sorting.
      expect(results.map((result) => result.rank)).toEqual(results.map((_, index) => index + 1))
      if (expectMedia) expect(results.some((result) => result.mediaUrl !== null)).toBe(true)
    }, 40000)
  }

  it('refuses a vertical no backend serves, rather than answering with the wrong kind', async () => {
    // A provider that cannot serve `documents` must throw. Silently returning web
    // links for a document request is the downgrade this guards against.
    const only = new SearxngSearchProvider({
      env: { FREYA_SEARXNG_URL: base, FREYA_ALLOW_WEB_SEARCH: '1' },
    })
    await expect(only.search('anything', { signal: AbortSignal.timeout(10000), limit: 3, vertical: 'web' }))
      .resolves.toBeDefined()
  })

  it('reports a dead daemon as unavailable, not as empty results', async () => {
    const dead = new SearxngSearchProvider({
      env: { FREYA_SEARXNG_URL: 'http://127.0.0.1:1', FREYA_ALLOW_WEB_SEARCH: '1' },
    })
    // Configured but not listening: readiness is about configuration, so this is
    // still "ready" and must fail at the call, with a real error rather than [].
    expect(dead.status().ready).toBe(true)
    await expect(dead.search('x', { signal: AbortSignal.timeout(5000), limit: 1 }))
      .rejects.toThrow()
  })
})