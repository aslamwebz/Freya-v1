import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import { withResearchAbort } from '../async'
import { ResearchError } from '../errors'
import type { HttpGetOptions, HttpGetResult, HttpTransport } from '../transport'

/**
 * A transport that can only ever reach this machine's loopback interface.
 *
 * ## Why this exists and why it is separate
 *
 * `SafeHttpTransport` fetches pages Freya did not choose, from addresses a remote
 * party influenced, so it refuses everything that is not a public destination:
 * `assertPublicUrl` rejects loopback (`127.0.0.0/8`), rejects `localhost` by name,
 * and rejects *any* explicit port. That is SSRF protection and it is load-bearing.
 *
 * A locally-running metasearch daemon is the opposite case: an address the owner
 * configured, on their own machine, speaking to a process they installed. It is
 * not reachable by anything on the internet, so the public-address rule protects
 * nothing here and simply forbids the call.
 *
 * So this is a **narrower** policy, not a wider one, and it is deliberately not
 * expressed as a relaxation of `assertPublicUrl`:
 *
 *   - `http:` only. A loopback service has no certificate to verify, so there is
 *     no TLS story to get wrong; pretending otherwise would be the actual risk.
 *   - the host must be a loopback *literal* or `localhost` — never a name that
 *     resolves, so there is no DNS step and no rebinding window.
 *   - no credentials in the URL, and no redirect is ever followed, so a loopback
 *     service cannot bounce this at the open internet.
 *   - a fixed bound on bytes and time, as everywhere else.
 *
 * It is a distinct class with a distinct name on purpose: reaching the internet
 * still means `SafeHttpTransport`, and nothing in this file makes that reachable.
 */

/** Loopback literals, plus the one name that resolves to them by definition. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * Refuse anything that is not plain HTTP to loopback.
 *
 * Kept separate from `assertPublicUrl` rather than parameterised into it so that
 * adding loopback support can never become a flag on the public path.
 */
export function assertLoopbackUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > 2048) throw new ResearchError('invalid_url')
  if ([...input].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new ResearchError('invalid_url')
  }
  let url: URL
  try { url = new URL(input) } catch { throw new ResearchError('invalid_url') }
  if (url.protocol !== 'http:') throw new ResearchError('unsafe_url')
  if (url.username || url.password) throw new ResearchError('unsafe_url')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  // A name is accepted only when it is literally `localhost`. Anything else that
  // is not an IP would need resolving, and resolving is what opens the rebinding
  // hole this transport exists to avoid.
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(`[${host}]`)) throw new ResearchError('unsafe_url')
  if (isIP(host) && !isLoopbackLiteral(host)) throw new ResearchError('unsafe_url')
  return url
}

/** 127.0.0.0/8 and ::1 only. Not 0.0.0.0, not any other reserved block. */
function isLoopbackLiteral(host: string): boolean {
  if (isIP(host) === 4) return host.startsWith('127.')
  return host === '::1'
}

export class LoopbackHttpTransport implements HttpTransport {
  async get(input: string, options: HttpGetOptions): Promise<HttpGetResult> {
    const url = assertLoopbackUrl(input)
    // Redirects are never followed here at all: a loopback service has no
    // legitimate reason to send this request to another host, so a redirect is
    // either a bug or an attempt to use this as a proxy.
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.min(Math.floor(options.maxBytes), 8 * 1024 * 1024)
      : 2 * 1024 * 1024
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(Math.floor(options.timeoutMs), 15000)
      : 10000

    return withResearchAbort(options.signal, timeoutMs, async (signal) => {
      const response = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
        const request = httpRequest(url, {
          method: 'GET',
          agent: false,
          signal,
          // No proxy, no keep-alive, no cookies: this must be a plain local call.
          headers: { 'accept-encoding': 'identity', ...lowerHeaders(options.headers) },
          maxHeaderSize: 16384,
        }, (incoming) => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (typeof value === 'string') headers[key.toLowerCase()] = value
            else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ')
          }
          const chunks: Buffer[] = []
          let bytes = 0
          incoming.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength
            if (bytes > maxBytes) {
              request.destroy()
              reject(new ResearchError('response_too_large'))
              return
            }
            chunks.push(chunk)
          })
          incoming.once('end', () => resolve({
            status: incoming.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks, bytes),
          }))
          incoming.once('error', reject)
        })
        request.once('error', reject)
        request.end()
      })

      if (response.status >= 300 && response.status < 400) throw new ResearchError('too_many_redirects')
      return { url: url.href, status: response.status, headers: response.headers, body: response.body }
    })
  }
}

/** Only presentation headers. Nothing here may carry a credential. */
function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase()
    if (!['accept', 'accept-language', 'user-agent'].includes(name)) continue
    if (/[\r\n]/.test(value)) continue
    out[name] = value
  }
  return out
}