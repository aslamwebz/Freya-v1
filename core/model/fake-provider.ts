import {
  throwIfAborted,
  ModelRequestCancelled,
  type ModelCallOptions,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from './provider'
import type { ProviderStatus } from '../protocol/core-protocol'

/**
 * Deterministic providers for tests, and the one deliberate "ask Freya
 * something" path.
 *
 * They never use a network and never spend money, which makes them the only
 * providers Phase 1 is willing to leave enabled.
 *
 * Every one of them honours the abort signal, including by refusing *before* it
 * is contacted. That is not decoration: if the fakes ignored the signal, a test
 * suite would prove the cancellation path works only against providers that were
 * written to cooperate, and the real one — NanoGPT — would be the untested case.
 */

/** A signal that is never aborted, for the paths that do not care. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal

/**
 * A deterministic provider.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id: string = 'fake'
  readonly kind = 'fake' as const
  readonly live = false

  /** Call count, so a test can prove a refusal never reached a provider. */
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

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    throwIfAborted(options.signal, 'cancelled before the provider was contacted')
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

  async complete(_request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    throwIfAborted(options.signal, 'cancelled before the provider was contacted')
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

  override async complete(
    request: ModelRequest,
    options: ModelCallOptions,
  ): Promise<ModelResult> {
    const result = await super.complete(request, options)
    return { ...result, providerId: this.id, inputTokens: null, outputTokens: null }
  }
}

/**
 * Accepts the call and never answers.
 *
 * Models a provider that hangs. The reservation is already durable by the time
 * this is reached, which is what makes a crash mid-flight charge the grant.
 *
 * It still obeys an abort, unlike a real hang: what it is for is a request that
 * stays outstanding, not one that is unkillable. A provider that ignored the
 * signal would make shutdown hang, which is the bug the drain bound exists to
 * contain rather than the behaviour to reproduce.
 */
export class HangingModelProvider extends FakeModelProvider {
  override readonly id = 'hanging'

  override status(): ProviderStatus {
    return { ...super.status(), id: this.id, model: 'hanging-model' }
  }

  override complete(_request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    return neverAnswers(options.signal)
  }
}

/**
 * Confirms it was contacted, then blocks until it is aborted or released.
 *
 * This is the provider the cancellation tests are built on, because it separates
 * the two things that are otherwise indistinguishable: `contacts` counts the
 * moment work left Freya, and `aborts` counts the moment the signal reached a
 * provider that was already in the middle of answering.
 */
export class BlockingModelProvider extends FakeModelProvider {
  override readonly id = 'blocking'

  /** Times this provider was actually asked to do work. Never a guess. */
  contacts = 0
  /** Times a request reached this provider and was then aborted. */
  aborts = 0
  /** Times a request was refused at the door, before any work was done. */
  refusals = 0
  /** Resolves once at least one request is genuinely in flight. */
  readonly contacted: Promise<void>
  private markContacted!: () => void
  private release: (() => void) | null = null

  constructor(private readonly answer = 'blocked') {
    super('blocking-model')
    this.contacted = new Promise<void>((resolve) => {
      this.markContacted = resolve
    })
  }

  override status(): ProviderStatus {
    return { ...super.status(), id: this.id, model: 'blocking-model' }
  }

  override async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    // The door check, before anything is counted as work.
    if (options.signal.aborted) {
      this.refusals += 1
      throw new ModelRequestCancelled('cancelled before the provider was contacted')
    }
    this.contacts += 1
    this.markContacted()

    const aborted = new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          this.aborts += 1
          reject(new ModelRequestCancelled(cancellationText(options.signal)))
        },
        { once: true },
      )
    })
    const released = new Promise<void>((resolve) => {
      this.release = resolve
    })

    await Promise.race([aborted, released])
    const inputTokens = countTokens(request.prompt)
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: 'blocking-model',
      text: this.answer,
      inputTokens,
      outputTokens: inputTokens,
    }
  }

  /** Let everything currently blocked answer, so the happy path can be tested. */
  releaseAll(): void {
    const release = this.release
    this.release = null
    release?.()
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

/** Stay outstanding until the signal fires, and never answer otherwise. */
function neverAnswers(signal: AbortSignal): Promise<ModelResult> {
  if (signal.aborted) {
    return Promise.reject(new ModelRequestCancelled('cancelled before the provider was contacted'))
  }
  return new Promise<ModelResult>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new ModelRequestCancelled(cancellationText(signal))),
      { once: true },
    )
  })
}

function cancellationText(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : 'the request was cancelled'
}

/** A rough token count for the fake providers only. Never used as a budget. */
function countTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
