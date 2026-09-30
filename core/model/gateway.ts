import type { ModelProvider, ModelRequest, ModelResult } from './provider'
import type { ModelUsage, ProviderStatus } from '../protocol/core-protocol'

/**
 * The Model Gateway: the one and only path to a provider.
 *
 * It owns the providers and does not expose them. No accessor returns a
 * provider, so no other module in Freya can reach a provider except by calling
 * `execute`, which requires a permit the Cognition Governor issued.
 *
 * It records what a call cost. It never records the prompt in an audit event,
 * and it never records a credential, a header or a key.
 */

export interface GatewayPermit {
  requestId: string
  correlationId: string
  /** The grant that authorised this, or null for a grantless user turn. */
  grantId: string | null
  providerId: string
  maxOutputTokens: number
  model: string | null
}

export interface GatewayRecord {
  requestId: string
  providerId: string
  model: string
  grantId: string | null
  correlationId: string
  startedAt: string
  finishedAt: string
  success: boolean
  failureReason: string | null
  inputTokens: number | null
  outputTokens: number | null
}

/** Injected so gateway events land on the durable fabric, not on a side channel. */
export interface GatewayRecorder {
  started(record: {
    requestId: string
    grantId: string | null
    providerId: string
    model: string
    maxOutputTokens: number
    startedAt: string
  }): Promise<void>
  completed(record: {
    requestId: string
    providerId: string
    model: string
    inputTokens: number | null
    outputTokens: number | null
  }): Promise<void>
  failed(record: {
    requestId: string
    providerId: string
    reason: string
  }): Promise<void>
}

export interface ModelGatewayOptions {
  providers: readonly ModelProvider[]
  recorder: GatewayRecorder
  now?: () => Date
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>()
  private readonly recorder: GatewayRecorder
  private readonly now: () => Date

  private calls = 0
  private inputTokens: number | null = null
  private outputTokens: number | null = null

  constructor(options: ModelGatewayOptions) {
    this.recorder = options.recorder
    this.now = options.now ?? (() => new Date())
    for (const provider of options.providers) {
      this.providers.set(provider.id, provider)
    }
  }

  /** Usage for this Core session. Never estimated. */
  usage(): ModelUsage {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens }
  }

  statuses(): ProviderStatus[] {
    return [...this.providers.values()].map((provider) => provider.status())
  }

  /** The provider a request should use: an explicit choice, else the first ready one. */
  private resolve(requestedModel: string | null): ModelProvider | null {
    for (const provider of this.providers.values()) {
      if (provider.status().status !== 'configured') continue
      if (requestedModel !== null && provider.status().model !== requestedModel) continue
      return provider
    }
    return null
  }

  /**
   * Perform one call under a permit.
   *
   * There is no retry. A failed paid call must not silently become two paid
   * calls, so a failure is recorded once and returned.
   */
  async execute(permit: GatewayPermit, prompt: string): Promise<ModelResult> {
    const provider = this.resolve(permit.model)
    if (!provider) {
      const reason = 'no configured provider can serve this request'
      await this.recorder.failed({ requestId: permit.requestId, providerId: permit.providerId, reason })
      throw new ProviderUnavailableError(reason)
    }

    const model = provider.status().model ?? permit.model ?? 'unknown'
    await this.recorder.started({
      requestId: permit.requestId,
      grantId: permit.grantId,
      providerId: provider.id,
      model,
      maxOutputTokens: permit.maxOutputTokens,
      startedAt: this.now().toISOString(),
    })

    this.calls += 1

    try {
      const request: ModelRequest = {
        requestId: permit.requestId,
        prompt,
        maxOutputTokens: permit.maxOutputTokens,
        model,
      }
      const result = await provider.complete(request)
      this.addUsage(result.inputTokens, result.outputTokens)
      await this.recorder.completed({
        requestId: permit.requestId,
        providerId: provider.id,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
      return result
    } catch (error) {
      // Contained: the Core stays alive, the failure is durable, and there is
      // exactly one attempt.
      const reason = error instanceof Error ? error.message : 'unknown provider failure'
      await this.recorder.failed({ requestId: permit.requestId, providerId: provider.id, reason })
      throw error instanceof Error ? error : new Error(reason)
    }
  }

  private addUsage(input: number | null, output: number | null): void {
    if (input === null || this.inputTokens === null) this.inputTokens = input
    else this.inputTokens += input
    if (output === null || this.outputTokens === null) this.outputTokens = output
    else this.outputTokens += output
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}
