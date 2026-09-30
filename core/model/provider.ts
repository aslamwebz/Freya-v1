import type { ProviderStatus } from '../protocol/core-protocol'

/**
 * The model provider contract.
 *
 * Providers are the only thing in Freya that can spend money or reach a
 * network. They hold no authority: a provider cannot decide that a call should
 * happen, and it cannot see anything except the single request the gateway
 * hands it.
 *
 * Credentials live in provider configuration inside Core. A provider never
 * returns its configuration, and nothing in the audit path records it.
 */

export interface ModelRequest {
  /** Echoed back in the result so a caller can correlate without a closure. */
  requestId: string
  prompt: string
  maxOutputTokens: number
  model: string | null
}

export interface ModelResult {
  requestId: string
  /** Which provider answered. Known only after the call. */
  providerId: string
  model: string
  text: string
  /** Null when the provider did not report them. Never estimated. */
  inputTokens: number | null
  outputTokens: number | null
}

export interface ModelProvider {
  readonly id: string
  readonly kind: 'fake' | 'nanogpt'
  /** Whether this provider would spend real money or use a network. */
  readonly live: boolean
  /** Current readiness, for the status projection. */
  status(): ProviderStatus
  /** Perform one call. Reached only through the Model Gateway. */
  complete(request: ModelRequest): Promise<ModelResult>
}
