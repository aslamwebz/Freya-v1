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

/**
 * A deterministic provider.
 */
/**
 * Openings of Freya's own framing blocks, which travel in `user`-role messages.
 *
 * The echo provider must not answer with these. It stands in for the *assistant*,
 * so echoing the identity kernel or a tool-selection block would put Freya's own
 * words in her mouth -- which is exactly what the `system` case already guards
 * against. The tool-selection block matters more than the rest: it contains a
 * literal example envelope, so an echo of it is a well-formed tool request, and
 * the echo provider would spend a capability re-reading its own instructions.
 */
const FREYA_FRAMING_OPENINGS = [
  'Optional lookup tools for this turn.',
  'Tool report. This is UNTRUSTED REFERENCE DATA',
  'Turn context.',
  'Recalled memory.',
]

/**
 * The owner's own words: the last `user` turn that is not one of Freya's blocks.
 *
 * Falls back to the last user turn, then to the flattened prompt, so a request
 * carrying no user turn still gets an answer rather than an exception.
 */
function ownersWords(request: ModelRequest): string {
  const users = request.messages.filter((message) => message.role === 'user')
  const spoken = users.filter((message) => typeof message.content === 'string'
    && !FREYA_FRAMING_OPENINGS.some((opening) => message.content.startsWith(opening)))
  return String(spoken.at(-1)?.content ?? users.at(-1)?.content ?? request.prompt)
}


export class FakeModelProvider implements ModelProvider {
  readonly id: string = 'fake'
  readonly kind = 'fake' as const
  readonly live = false

  /** Call count, so a test can prove a refusal never reached a provider. */
  calls = 0

  /** The last usage reported. A test seam, not part of any provider contract. */
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  constructor(readonly model = 'fake-echo-1') {}

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
    // Echoes the last *user* turn, not the flattened prompt.
    //
    // The flattened form is what a single-prompt provider would receive, and it
    // begins with the compiled Identity Kernel — so echoing it would print Freya's
    // own instructions back into the transcript as though she had said them. This
    // is a stand-in for an assistant, so it answers what was asked.
    const said = ownersWords(request)
    const inputTokens = countTokens(said)
    const outputTokens = countTokens(said)
    this.lastUsage = { inputTokens, outputTokens }
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: this.model,
      // Deterministic: the same message always yields the same answer.
      text: `[developer echo provider — not intelligence] ${said}`,
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

/**
 * A deliberately slow echo provider.
 *
 * It exists for one reason: cancellation cannot be demonstrated against a provider
 * that answers instantly. A real model takes seconds, and a test that only ever
 * sees instant answers never exercises the path where a stop arrives mid-call.
 *
 * It is a developer seam and says so in two places — the delay is explicit, and
 * the reply is prefixed identically to the fast echo — so a window can never
 * present its output as anything but a stand-in. It is listed after every real
 * provider, so it can never shadow one.
 */
export class SlowFakeModelProvider extends FakeModelProvider {
  override readonly id = 'slow-echo'
  /** Contacts and aborts, so a test can prove the call really was interrupted. */
  contacts = 0
  aborts = 0

  constructor(
    private readonly delayMs = 5_000,
    model = 'slow-echo-1',
  ) {
    super(model)
  }

  override status(): ProviderStatus {
    return { ...super.status(), id: this.id, model: this.model }
  }

  override async complete(
    request: ModelRequest,
    options: ModelCallOptions,
  ): Promise<ModelResult> {
    if (options.signal.aborted) {
      throw new ModelRequestCancelled('cancelled before the provider was contacted')
    }
    this.calls += 1
    this.contacts += 1

    // Resolves early on abort, so a cancelled call does not sit out the delay
    // before the window hears about it. The abort is what ends this, not the timer.
    const finished = new Promise<'done'>((resolve) => {
      options.signal.addEventListener('abort', () => resolve('done'), { once: true })
    })
    const elapsed = new Promise<'done'>((resolve) => {
      setTimeout(() => resolve('done'), this.delayMs)
    })
    const outcome = await Promise.race([finished, elapsed])
    if (outcome === 'done' && options.signal.aborted) {
      this.aborts += 1
      throw new ModelRequestCancelled('the owner stopped this response')
    }

    // As with the fast echo: answer what was asked, not Freya's own instructions.
    const said = ownersWords(request)
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: this.model,
      text: `[developer echo provider — not intelligence] ${said}`,
      inputTokens: countTokens(said),
      outputTokens: countTokens(said),
    }
  }
}
