// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Searcher } from '../../../core/research/searcher'
import { withResearchAbort } from '../../../core/research/async'
import { ResearchError } from '../../../core/research/errors'
import type { SearchProvider, SearchResult } from '../../../core/research/types'

const now = () => new Date('2026-10-01T00:00:00.000Z')
function provider(search: SearchProvider['search'], ready = true, reason = 'ready'): SearchProvider {
  return { id: 'offline', status: () => ({ ready, reason }), search }
}
function result(url = 'https://example.com/a'): SearchResult {
  return { url, title: 'Title', snippet: 'Snippet', sourceDomain: 'untrusted.example', rank: 999, publishedAt: null, retrievedAt: 'untrusted timestamp' }
}
afterEach(() => vi.useRealTimers())
describe('provider neutral searcher', () => {
  it.each(['', '   ', 'x'.repeat(513)])('rejects invalid query before contacting a provider', async (query) => {
    const search = vi.fn(async () => [])
    await expect(new Searcher({ provider: provider(search) }).searchWeb(query)).rejects.toMatchObject({ code: 'invalid_query' })
    expect(search).not.toHaveBeenCalled()
  })
  it('caps per-query results and cleans malformed and duplicate provider data', async () => {
    let limit: number | undefined
    let query: string | undefined
    const searcher = new Searcher({ now, provider: provider(async (q, opts) => {
      query = q; limit = opts.limit
      return [null, {}, result('http://127.0.0.1'), { ...result('https://EXAMPLE.com/a?utm_source=x#frag'), title: 'T'.repeat(900), snippet: 'S'.repeat(9000), secret: 'discard' }, result('https://example.com/a'), ...Array.from({ length: 20 }, (_, i) => result(`https://example.com/${i}`))] as SearchResult[]
    }) })
    const results = await searcher.searchWeb('  public query  ', { limit: 999 })
    expect(query).toBe('public query')
    expect(limit).toBe(10)
    expect(results).toHaveLength(10)
    expect(results[0]).toEqual({ title: 'T'.repeat(512), url: 'https://example.com/a', snippet: 'S'.repeat(2048), sourceDomain: 'example.com', rank: 1, publishedAt: null, retrievedAt: '2026-10-01T00:00:00.000Z' })
    expect(results[1]?.rank).toBe(2)
  })
  it.each(['unconfigured', 'disabled'])('fails %s without provider calls', async (reason) => {
    const search = vi.fn(async () => [])
    await expect(new Searcher({ provider: provider(search, false, reason) }).searchWeb('query')).rejects.toMatchObject({ code: reason })
    expect(search).not.toHaveBeenCalled()
  })
  it('redacts arbitrary provider errors and reconstructs even known errors', async () => {
    const malicious = Object.assign(new ResearchError('rate_limited'), { message: 'test-private', cause: new Error('test-private') })
    const searcher = new Searcher({ provider: provider(async () => { throw malicious }) })
    await expect(searcher.searchWeb('query')).rejects.toMatchObject({ code: 'rate_limited', message: 'The search provider rate limit was reached.' })
    const failing = new Searcher({ provider: provider(async () => { throw new Error('test-private') }) })
    await expect(failing.searchWeb('query')).rejects.toMatchObject({ code: 'provider_error', message: 'The search provider failed.' })
  })
  it('does not admit unknown codes from a mutated provider error', async () => {
    const malicious = Object.assign(new ResearchError('provider_error'), { code: 'private-vendor-detail' })
    const searcher = new Searcher({ provider: provider(async () => { throw malicious }) })
    await expect(searcher.searchWeb('query')).rejects.toMatchObject({ code: 'provider_error', message: 'The search provider failed.' })
  })
  it('sanitizes a provider throwing null as a provider failure', async () => {
    const searcher = new Searcher({ provider: provider(async () => { throw null }) })
    await expect(searcher.searchWeb('query')).rejects.toMatchObject({ code: 'provider_error', message: 'The search provider failed.' })
  })
  it.each([null, undefined])('preserves direct helper rejection with %s', async (reason) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let active: AbortSignal | undefined
    const promise = withResearchAbort(controller.signal, 1000, async (signal) => {
      active = signal
      throw reason
    })
    await expect(promise).rejects.toBe(reason)
    expect(active?.aborted).toBe(true)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([null, undefined])('preserves successful helper resolution with %s', async (value) => {
    await expect(withResearchAbort(undefined, 1000, async () => value)).resolves.toBe(value)
  })
  it('times out after ten seconds even if the provider ignores its signal', async () => {
    vi.useFakeTimers()
    let active: AbortSignal | undefined
    const searcher = new Searcher({ provider: provider(async (_query, opts) => { active = opts.signal; return new Promise(() => {}) }) })
    const promise = searcher.searchWeb('query')
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(10000)
    await rejection
    expect(active?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans abort listeners and ignores late completion after cancellation', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let finish: ((value: SearchResult[]) => void) | undefined
    const searcher = new Searcher({ provider: provider(() => new Promise((resolve) => { finish = resolve })) })
    const promise = searcher.searchWeb('query', { signal: controller.signal })
    const rejection = expect(promise).rejects.toMatchObject({ code: 'cancelled' })
    await Promise.resolve()
    controller.abort('test-private')
    finish?.([result()])
    await rejection
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
