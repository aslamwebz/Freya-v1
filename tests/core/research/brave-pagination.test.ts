// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BraveSearchProvider } from '../../../core/research/providers/brave'
import type { HttpTransport } from '../../../core/research/transport'

describe('Brave search bounded pagination', () => {
  it('sends a bounded page offset without widening the ten-result request cap', async () => {
    const urls: string[] = []
    const transport: HttpTransport = {
      get: async (url) => {
        urls.push(url)
        return {
          url,
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({
            web: {
              results: Array.from({ length: 10 }, (_, index) => ({
                title: `Result ${index}`,
                url: `https://example.com/${index}`,
                description: 'Snippet',
              })),
            },
          })),
        }
      },
    }
    const provider = new BraveSearchProvider({
      env: { BRAVE_SEARCH_API_KEY: 'test-key', FREYA_ALLOW_WEB_SEARCH: '1' },
      transport,
    })

    const results = await provider.search('cats', {
      signal: new AbortController().signal,
      limit: 999,
      offset: 999,
    })

    expect(results).toHaveLength(10)
    const requested = new URL(urls[0]!)
    expect(requested.searchParams.get('count')).toBe('10')
    expect(requested.searchParams.get('offset')).toBe('9')
    expect(requested.searchParams.get('q')).toBe('cats')
  })

  it('omits offset zero so the first provider request remains canonical', async () => {
    let requested = ''
    const transport: HttpTransport = {
      get: async (url) => {
        requested = url
        return {
          url,
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ web: { results: [] } })),
        }
      },
    }
    const provider = new BraveSearchProvider({
      env: { BRAVE_SEARCH_API_KEY: 'test-key', FREYA_ALLOW_WEB_SEARCH: '1' },
      transport,
    })

    await provider.search('cats', {
      signal: new AbortController().signal,
      limit: 10,
      offset: 0,
    })

    expect(new URL(requested).searchParams.has('offset')).toBe(false)
  })
})
