// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { SafeHttpTransport, type TransportRequest, type TransportResponse } from '../../../core/research/transport'

const nodeRequest = vi.hoisted(() => vi.fn())
vi.mock('node:https', () => ({ request: nodeRequest }))

const signal = () => new AbortController().signal
const options = () => ({ signal: signal(), maxBytes: 8, timeoutMs: 1000 })
function reply(status = 200, headers: Record<string, string> = {}, chunks = ['ok']): TransportResponse {
  return { status, headers, body: (async function* () { for (const chunk of chunks) yield Buffer.from(chunk) })() }
}
describe('bounded transport', () => {
  it('the production request uses pinned lookup with original TLS hostname and verification', async () => {
    let actualUrl: URL | undefined
    let actualOptions: RequestOptions & { rejectUnauthorized?: boolean } = {}
    nodeRequest.mockImplementation((url: URL, opts: RequestOptions, callback: (response: IncomingMessage) => void) => {
      actualUrl = url
      actualOptions = opts
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
      const request = Object.assign(new EventEmitter(), { end: () => { callback(response as unknown as IncomingMessage); response.end('ok') } })
      return request as unknown as ClientRequest
    })
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }])
    const transport = new SafeHttpTransport({ resolver })
    expect((await transport.get('https://example.com/source', options())).body).toEqual(Buffer.from('ok'))
    expect(actualUrl?.hostname).toBe('example.com')
    expect(actualOptions.rejectUnauthorized).toBe(true)
    expect(actualOptions.agent).toBe(false)
    let selected: unknown
    actualOptions.lookup?.('example.com', { all: true }, (_error, addresses) => { selected = addresses })
    expect(selected).toEqual([{ address: '8.8.8.8', family: 4 }])
    expect(resolver).toHaveBeenCalledTimes(1)
  })
  it.each([['ENOTFOUND', 'dns_failed'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'], ['CERT_HAS_EXPIRED', 'tls_failed']])('classifies %s without disclosing internal detail', async (code, want) => {
    const transport = new SafeHttpTransport({ resolver: async () => { throw Object.assign(new Error('private detail'), { code }) } })
    await expect(transport.get('https://example.com', options())).rejects.toMatchObject({ code: want })
  })
  it('rejects cookies before making a request', async () => {
    const request = vi.fn(async () => reply())
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], request })
    await expect(transport.get('https://example.com', { ...options(), headers: { cookie: 'session=test' } })).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).not.toHaveBeenCalled()
  })
  it('pins a vetted DNS answer to the request instead of resolving again', async () => {
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }])
    let pinned: unknown
    const transport = new SafeHttpTransport({ resolver, request: async (request) => { pinned = request.address; return reply() } })
    expect(await transport.get('https://example.com/', options())).toMatchObject({ status: 200, body: Buffer.from('ok') })
    expect(pinned).toEqual({ address: '8.8.8.8', family: 4 })
    expect(resolver).toHaveBeenCalledTimes(1)
  })
  it('rejects the entire DNS set if any answer is private', async () => {
    const request = vi.fn(async () => reply())
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request })
    await expect(transport.get('https://example.com', options())).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).not.toHaveBeenCalled()
  })
  it('validates every redirect before connecting', async () => {
    const request = vi.fn(async () => reply(302, { location: 'http://127.0.0.1/' }))
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], request })
    await expect(transport.get('https://example.com', options())).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('rejects redirects carrying an API credential even to the same host', async () => {
    const request = vi.fn(async () => reply(302, { location: '/next' }))
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], request })
    await expect(transport.get('https://example.com', { ...options(), headers: { 'X-Subscription-Token': 'test-credential' } })).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('stops after three redirects even when a caller raises the limit', async () => {
    const request = vi.fn(async () => reply(302, { location: '/next' }))
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], request })
    await expect(transport.get('https://example.com', { ...options(), redirects: 999 })).rejects.toMatchObject({ code: 'too_many_redirects' })
    expect(request).toHaveBeenCalledTimes(4)
  })
  it('aborts streaming immediately at the byte ceiling', async () => {
    let active: AbortSignal | undefined
    let consumed = 0
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], request: async (request) => {
      active = request.signal
      return { status: 200, headers: {}, body: (async function* () { for (let i = 0; i < 10; i++) { consumed++; yield Buffer.from('12345') } })() }
    } })
    await expect(transport.get('https://example.com', options())).rejects.toMatchObject({ code: 'response_too_large' })
    expect(consumed).toBe(2)
    expect(active?.aborted).toBe(true)
  })
  it('times out a resolver that ignores abort and redacts thrown secrets', async () => {
    const transport = new SafeHttpTransport({ resolver: () => new Promise(() => {}), request: async () => reply() })
    await expect(transport.get('https://example.com', { ...options(), timeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' })
    const failing = new SafeHttpTransport({ resolver: async () => { throw new Error('test-secret') } })
    await expect(failing.get('https://example.com', options())).rejects.toMatchObject({ code: 'network_error', message: 'The network request failed.' })
  })
  it('cancels a stalled stream without accepting late results', async () => {
    const controller = new AbortController()
    let pending: TransportRequest | undefined
    const transport = new SafeHttpTransport({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], request: async (request) => { pending = request; return { status: 200, headers: {}, body: (async function* () { await new Promise(() => {}); yield Buffer.from('late') })() } } })
    const result = transport.get('https://example.com', { ...options(), signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error('private abort reason'))
    await expect(result).rejects.toMatchObject({ code: 'cancelled', message: 'Research was cancelled.' })
    expect(pending?.signal.aborted).toBe(true)
  })
})
