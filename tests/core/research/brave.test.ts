// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BraveSearchProvider } from '../../../core/research/providers/brave'
import type { HttpGetOptions, HttpTransport } from '../../../core/research/transport'

const env = { BRAVE_SEARCH_API_KEY: 'offline-fixture-credential', FREYA_ALLOW_WEB_SEARCH: '1' }
const opts = () => ({ signal: new AbortController().signal, limit: 5 })
function transport(body: unknown, status = 200): HttpTransport {
  return { get: async (url) => ({ url, status, headers: {}, body: Buffer.from(JSON.stringify(body)) }) }
}
describe('Brave adapter', () => {
  it.each([ [{}, 'unconfigured'], [{ BRAVE_SEARCH_API_KEY: 'offline-fixture-credential' }, 'disabled'] ] as const)('requires key and explicit opt-in', async (configuration, code) => {
    const get = vi.fn(async (url: string) => ({ url, status: 200, headers: {}, body: Buffer.from('{}') }))
    const brave = new BraveSearchProvider({ env: configuration, transport: { get } })
    expect(brave.status()).toEqual({ ready: false, reason: code })
    await expect(brave.search('query', opts())).rejects.toMatchObject({ code })
    expect(get).not.toHaveBeenCalled()
  })
  it('uses the official endpoint and translates bounded known fields only', async () => {
    let requestUrl = ''
    let requestOptions: HttpGetOptions | undefined
    const brave = new BraveSearchProvider({ env, now: () => new Date('2026-10-01T00:00:00Z'), transport: { get: async (url, options) => {
      requestUrl = url; requestOptions = options
      return { url, status: 200, headers: {}, body: Buffer.from(JSON.stringify({ type: 'search', web: { type: 'search', results: [null, { title: 'News', url: 'https://example.com/article?utm_source=search', description: 'A snippet', page_age: '2026-09-30T00:00:00Z', vendor_secret: env.BRAVE_SEARCH_API_KEY }, { title: 'duplicate', url: 'https://example.com/article' }] } })) }
    } } })
    const results = await brave.search('space & science', { ...opts(), limit: 100 })
    const url = new URL(requestUrl)
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(url.searchParams.get('q')).toBe('space & science')
    expect(url.searchParams.get('count')).toBe('10')
    expect(requestOptions).toMatchObject({ timeoutMs: 10000, maxBytes: 2097152, headers: { 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY } })
    expect(results).toEqual([{ title: 'News', url: 'https://example.com/article', snippet: 'A snippet', sourceDomain: 'example.com', rank: 1, publishedAt: '2026-09-30T00:00:00.000Z', retrievedAt: '2026-10-01T00:00:00.000Z' }])
    expect(JSON.stringify(brave)).not.toContain(env.BRAVE_SEARCH_API_KEY)
  })
  it.each([[401, 'invalid_credentials'], [403, 'invalid_credentials'], [429, 'rate_limited'], [500, 'provider_error']])('classifies HTTP %i without echoing error bodies', async (status, code) => {
    const brave = new BraveSearchProvider({ env, transport: transport({ message: env.BRAVE_SEARCH_API_KEY }, status as number) })
    const error = await brave.search('query', opts()).catch((error: unknown) => error)
    expect(error).toMatchObject({ code })
    expect(JSON.stringify(error)).not.toContain(env.BRAVE_SEARCH_API_KEY)
    expect(String(error)).not.toContain(env.BRAVE_SEARCH_API_KEY)
  })
  it.each([null, {}, { web: { results: 'bad' } }])('rejects invalid vendor shapes', async (body) => {
    await expect(new BraveSearchProvider({ env, transport: transport(body) }).search('query', opts())).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('redacts credentials echoed in known response fields', async () => {
    const brave = new BraveSearchProvider({ env, transport: transport({ web: { results: [{ title: env.BRAVE_SEARCH_API_KEY, description: `Echo ${env.BRAVE_SEARCH_API_KEY}`, url: 'https://example.com' }] } }) })
    const results = await brave.search('query', opts())
    expect(JSON.stringify(results)).not.toContain(env.BRAVE_SEARCH_API_KEY)
    expect(results[0]?.snippet).toBe('Echo [redacted]')
  })
  it('drops source URLs that contain percent-encoded credentials', async () => {
    const brave = new BraveSearchProvider({ env, transport: transport({ web: { results: [{ title: 'Echo', url: 'https://example.com/offline%2Dfixture%2Dcredential' }] } }) })
    expect(await brave.search('query', opts())).toEqual([])
  })
  it('does not contact transport for blank, overlong or already-cancelled requests', async () => {
    const get = vi.fn(transport({ web: { results: [] } }).get)
    const brave = new BraveSearchProvider({ env, transport: { get } })
    await expect(brave.search(' ', opts())).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(brave.search('x'.repeat(513), opts())).rejects.toMatchObject({ code: 'invalid_query' })
    const controller = new AbortController(); controller.abort('test-private')
    await expect(brave.search('query', { signal: controller.signal, limit: 5 })).rejects.toMatchObject({ code: 'cancelled' })
    expect(get).not.toHaveBeenCalled()
  })
})
