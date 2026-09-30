import type { ModelProvider, ModelRequest, ModelResult } from './provider'
import type { ProviderStatus } from '../protocol/core-protocol'

/**
 * A deterministic provider for tests and for the deliberate "ask Freya
 * something" path.
 *
 * It never uses a network and never spends money, which makes it the only
 * provider Phase 1 is willing to leave enabled.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id: string = 'fake'
  readonly kind = 'fake' as const
  readonly live = false

  /** Call count, so a test can prove a denial never reached a provider. */
  calls = 0

  /** The last usage reported. A test seam, not part of any provider contract. */
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  constructor(private readonly model = 'fake-echo-1') {}

  status(): ProviderStatus {
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: this.model,
      detail:
        'Developer echo provider. Returns your prompt back. Not intelligence, and never a production provider.',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    this.calls += 1
    const inputTokens = countTokens(request.prompt)
    const outputTokens = countTokens(request.prompt)
    this.lastUsage = { inputTokens, outputTokens }
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: this.model,
      // Deterministic: the same prompt always yields the same answer.
      text: `[developer echo provider — not intelligence] ${request.prompt}`,
      inputTokens,
      outputTokens,
    }
  }
}

/**
 * A provider that always fails, used to prove that a provider failure is
 * contained rather than fatal.
 */
export class FailingModelProvider implements ModelProvider {
  readonly id: string = 'failing'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0

  /**
   * Reports `configured`, not `faulted`, so the gateway will route to it and
   * the throw path is genuinely exercised. A provider that reports `faulted` is
   * never selected at all, which is a different and separately tested path.
   */
  status(): ProviderStatus {
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: 'failing-model',
      detail: 'Always fails. Used to prove failures are contained.',
      liveEnabled: false,
    }
  }

  async complete(_request: ModelRequest): Promise<ModelResult> {
    this.calls += 1
    throw new Error('provider is unavailable')
  }
}

/**
 * Answers normally but reports no token usage whatsoever.
 *
 * The dangerous provider: if unreported usage were read as zero, this one would
 * hand out unlimited inference for free.
 */
export class SilentModelProvider extends FakeModelProvider {
  override readonly id = 'silent'

  override status(): ProviderStatus {
    return { ...super.status(), id: this.id, model: 'silent-model' }
  }

  override async complete(request: ModelRequest): Promise<ModelResult> {
    const result = await super.complete(request)
    return { ...result, providerId: this.id, inputTokens: null, outputTokens: null }
  }
}

/**
 * Accepts the call and never answers.
 *
 * Models a provider that hangs. The reservation is already durable by the time
 * this is reached, which is what makes a crash mid-flight charge the grant.
 */
export class HangingModelProvider extends FakeModelProvider {
  override readonly id = 'hanging'

  override status(): ProviderStatus {
    return { ...super.status(), id: this.id, model: 'hanging-model' }
  }

  override complete(_request: ModelRequest): Promise<ModelResult> {
    return new Promise<ModelResult>(() => {
      /* never settles */
    })
  }
}

/** Reports itself unusable, so the gateway declines to route to it. */
export class FaultedModelProvider extends FailingModelProvider {
  override readonly id = 'faulted'

  override status(): ProviderStatus {
    return {
      id: this.id,
      kind: this.kind,
      status: 'faulted',
      model: null,
      detail: 'Reports itself unusable.',
      liveEnabled: false,
    }
  }
}

/** A rough token count for the fake provider only. Never used as a budget. */
function countTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
