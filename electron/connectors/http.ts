/**
 * THE BOUNDED HTTP CLIENT — the only network door a connector adapter uses.
 *
 * Every request is bounded in every dimension: a host allowlist, a timeout, a
 * response-size ceiling, a method allowlist and a redirect policy. An unbounded
 * connector is an exfiltration channel, and this file is where that is made
 * structural rather than a promise.
 *
 * The `Authorization` header is set here and never read back. A token never
 * appears in an error, a log line or a returned value.
 */

import { RelayAdapterError, RelayTransientError } from '../../core/relay/adapters'
import { CONNECTOR_LIMITS } from '../../core/connectors/types'

export interface FetchLike {
  (input: string, init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
    redirect: 'manual'
  }): Promise<{
    ok: boolean
    status: number
    headers: { get(name: string): string | null }
    text(): Promise<string>
  }>
}

export interface BoundedRequest {
  url: string
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  token: string
  /** Hosts this request may reach. Empty means none. */
  allowedHosts: readonly string[]
  body?: unknown
  timeoutMs?: number
}

const MAX_RESPONSE_BYTES = 1_000_000

/**
 * Perform one bounded JSON request.
 *
 * A host outside the allowlist, a non-2xx response, a timeout, an oversized
 * body or a non-JSON body are all closed failures. A 429 is a transient
 * failure, which is the one class Relay retries.
 */
export async function fetchJson(fetchImpl: FetchLike, request: BoundedRequest): Promise<unknown> {
  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    throw new RelayAdapterError('the connector built an invalid request URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new RelayAdapterError('the connector may only reach https endpoints')
  }
  if (request.allowedHosts.length === 0 || !request.allowedHosts.includes(parsed.hostname)) {
    throw new RelayAdapterError('the connector may not reach that host')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? CONNECTOR_LIMITS.requestTimeoutMs)
  timeout.unref?.()
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(parsed.toString(), {
      method: request.method,
      headers: {
        authorization: `Bearer ${request.token}`,
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
      redirect: 'manual',
    })
  } catch (error) {
    throw new RelayTransientError(
      error instanceof Error && error.name === 'AbortError'
        ? 'the connector request timed out'
        : 'the connector request could not be completed',
    )
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 429) throw new RelayTransientError('the connector reported a rate limit')
  if (response.status >= 500) throw new RelayTransientError('the connector reported a server error')
  if (!response.ok) throw new RelayAdapterError(`the connector refused the request (${response.status})`)

  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new RelayAdapterError('the connector response was too large')
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new RelayAdapterError('the connector returned a non-JSON response')
  }
}
