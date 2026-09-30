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
  readonly id = 'fake'
  readonly kind = 'fake' as const
  readonly live = false

  /** Call count, so a test can prove a denial never reached a provider. */
  calls = 0

  constructor(private readonly model = 'fake-echo-1') {}

  status(): ProviderStatus {
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: this.model,
      detail: 'Deterministic local provider. No network, no cost.',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    this.calls += 1
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: this.model,
      // Deterministic: the same prompt always yields the same answer.
      text: `fake-echo: ${request.prompt}`,
      inputTokens: countTokens(request.prompt),
      outputTokens: countTokens(request.prompt),
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
