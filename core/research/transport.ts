import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { withResearchAbort } from './async'
import { ResearchError, safeResearchError } from './errors'
import { assertPublicAddress, assertPublicUrl } from './url-policy'

export interface ResolvedAddress { address: string; family: 4 | 6 }
export interface TransportRequest {
  url: URL
  address: ResolvedAddress
  signal: AbortSignal
  headers: Record<string, string>
}
export interface TransportResponse {
  status: number
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array>
  close?: () => void
}
export interface HttpGetOptions {
  signal: AbortSignal
  maxBytes: number
  timeoutMs: number
  headers?: Record<string, string>
  redirects?: number
}
export interface HttpGetResult { url: string; status: number; headers: Record<string, string>; body: Uint8Array }
export interface HttpTransport { get(url: string, options: HttpGetOptions): Promise<HttpGetResult> }
export interface SafeHttpTransportOptions {
  resolver?: (hostname: string) => Promise<ResolvedAddress[]>
  request?: (request: TransportRequest) => Promise<TransportResponse>
}

function bounded(value: number, maximum: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : maximum
}
function networkFailure(error: unknown): ResearchError {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'EAI_FAIL'].includes(code)) return new ResearchError('dns_failed')
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID'].includes(code)) return new ResearchError('tls_failed')
  return safeResearchError(error, 'network_error')
}

/** Direct Node connection: no proxy, cookies, reusable agent or second DNS lookup. */
function pinnedRequest(input: TransportRequest): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const request = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)(input.url, {
      method: 'GET', agent: false, signal: input.signal, headers: input.headers,
      // Keep the original host for Host/SNI and normal certificate verification.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [input.address])
        else callback(null, input.address.address, input.address.family)
      },
      rejectUnauthorized: true,
      maxHeaderSize: 16384,
    }, (response) => {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') headers[key] = value
        else if (Array.isArray(value)) headers[key] = value.join(', ')
      }
      resolve({ status: response.statusCode ?? 0, headers, body: response, close: () => response.destroy() })
    })
    request.once('error', reject)
    request.end()
  })
}

export class SafeHttpTransport implements HttpTransport {
  private readonly resolver: NonNullable<SafeHttpTransportOptions['resolver']>
  private readonly request: NonNullable<SafeHttpTransportOptions['request']>
  constructor(options: SafeHttpTransportOptions = {}) {
    this.resolver = options.resolver ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family as 4 | 6 })))
    this.request = options.request ?? pinnedRequest
  }

  async get(input: string, options: HttpGetOptions): Promise<HttpGetResult> {
    try {
      return await withResearchAbort(options.signal, bounded(options.timeoutMs, 15000), async (signal) => {
        const maxBytes = bounded(options.maxBytes, 2097152)
        const redirects = options.redirects === 0 ? 0 : bounded(options.redirects ?? 3, 3)
        const headers: Record<string, string> = { 'accept-encoding': 'identity' }
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          const name = key.toLowerCase()
          if (!/^[a-z0-9-]+$/.test(name) || /[\r\n]/.test(value) || ['host', 'cookie', 'cookie2', 'proxy-authorization', 'connection', 'transfer-encoding', 'content-length', 'accept-encoding'].includes(name)) throw new ResearchError('unsafe_url')
          headers[name] = value
        }
        const credentialBearing = Object.keys(headers).some((name) => !['accept', 'accept-language', 'accept-encoding', 'user-agent'].includes(name))
        let url = assertPublicUrl(input)
        for (let count = 0; ; count++) {
          if (signal.aborted) throw new ResearchError('cancelled')
          const host = url.hostname.replace(/^\[|\]$/g, '')
          const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await this.resolver(host)
          if (signal.aborted) throw new ResearchError('cancelled')
          if (!addresses.length) throw new ResearchError('dns_failed')
          for (const address of addresses) {
            assertPublicAddress(address.address)
            if (isIP(address.address) !== address.family) throw new ResearchError('unsafe_url')
          }
          const response = await this.request({ url, address: addresses[0]!, signal, headers })
          const close = (): void => response.close?.()
          signal.addEventListener('abort', close, { once: true })
          try {
            if (signal.aborted) throw new ResearchError('cancelled')
            const responseHeaders: Record<string, string> = {}
            for (const [key, value] of Object.entries(response.headers)) responseHeaders[key.toLowerCase()] = value
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              if (credentialBearing) throw new ResearchError('unsafe_url')
              if (count >= redirects) throw new ResearchError('too_many_redirects')
              const location = responseHeaders.location
              if (!location) throw new ResearchError('network_error')
              url = assertPublicUrl(new URL(location, url).href)
              continue
            }
            if (Number(responseHeaders['content-length']) > maxBytes) throw new ResearchError('response_too_large')
            const chunks: Uint8Array[] = []
            let bytes = 0
            for await (const chunk of response.body) {
              if (signal.aborted) throw new ResearchError('cancelled')
              bytes += chunk.byteLength
              if (bytes > maxBytes) throw new ResearchError('response_too_large')
              chunks.push(chunk)
            }
            if (signal.aborted) throw new ResearchError('cancelled')
            return { url: url.href, status: response.status, headers: responseHeaders, body: Buffer.concat(chunks, bytes) }
          } finally {
            signal.removeEventListener('abort', close)
            close()
          }
        }
      })
    } catch (error) { throw networkFailure(error) }
  }
}
