// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MiniMaxSearchProvider } from '../../core/research/providers/minimax'

describe('MiniMax documented coding-plan search', () => {
  it('uses the exact official API, carries exact query plus site constraint and preserves provenance', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ organic: [{ title: 'Result', link: 'https://example.org/page', snippet: 'Found', date: '2026-10-07' }], base_resp: { status_code: 0 } })))
    const provider = new MiniMaxSearchProvider({ env: { MINIMAX_API_KEY: 'secret', MINIMAX_BASE_URL: 'https://api.minimax.io/anthropic', FREYA_ALLOW_WEB_SEARCH: '1' }, fetchImpl: transport })
    const results = await provider.search('my exact query', { signal: new AbortController().signal, limit: 3, site: 'example.org', vertical: 'pages' })
    expect(transport.mock.calls[0]?.[0]).toBe('https://api.minimax.io/v1/coding_plan/search')
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({ q: 'my exact query site:example.org' })
    expect(results[0]?.providerId).toBe('minimax')
    expect(results[0]?.vertical).toBe('pages')
    expect(results[0]?.url).toBe('https://example.org/page')
    expect(JSON.stringify(results)).not.toContain('secret')
  })
  it('refuses unapproved recipients, disabled spend, unsupported verticals and redirects', async () => {
    expect(new MiniMaxSearchProvider({ env: { MINIMAX_API_KEY: 'secret', MINIMAX_BASE_URL: 'https://attacker.example', FREYA_ALLOW_WEB_SEARCH: '1' } }).status().ready).toBe(false)
    expect(new MiniMaxSearchProvider({ env: { MINIMAX_API_KEY: 'secret' } }).status().ready).toBe(false)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }))
    const provider = new MiniMaxSearchProvider({ env: { MINIMAX_API_KEY: 'secret', MINIMAX_BASE_URL: '', FREYA_ALLOW_WEB_SEARCH: '1' }, fetchImpl: transport })
    expect(provider.supports('images')).toBe(false)
    expect(await provider.search('query', { signal: new AbortController().signal, limit: 3, offset: 1 })).toEqual([])
    expect(transport).not.toHaveBeenCalled()
    await expect(provider.search('query', { signal: new AbortController().signal, limit: 3, vertical: 'images' })).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
    await expect(provider.search('query', { signal: new AbortController().signal, limit: 3 })).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('error')
  })
  it('surfaces entitlement refusal without upstream text or secrets', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'secret' } })))
    const provider = new MiniMaxSearchProvider({ env: { MINIMAX_API_KEY: 'secret', MINIMAX_BASE_URL: '', FREYA_ALLOW_WEB_SEARCH: '1' }, fetchImpl: transport })
    await expect(provider.search('query', { signal: new AbortController().signal, limit: 3 })).rejects.toMatchObject({ code: 'invalid_credentials' })
  })
})
