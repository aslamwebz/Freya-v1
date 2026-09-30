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
 *
 * Every call is cancellable, and the cancellation is a required argument rather
 * than an option. A provider that cannot be aborted is a provider that keeps
 * spending after the owner has said stop, so the shape of this interface is what
 * makes "stop" mean something.
 */

/**
 * A provider role.
 *
 * A closed union, and the set is controlled by Core's Context Compiler rather
 * than by whatever the renderer typed. A renderer can supply the *content* of a
 * user message; it cannot choose a role, and in particular cannot present its
 * own text as an assistant turn or as system instructions.
 */
export type ModelMessageRole = 'system' | 'user' | 'assistant'

export interface ModelMessage {
  readonly role: ModelMessageRole
  readonly content: string
}

export interface ModelRequest {
  /** Echoed back in the result so a caller can correlate without a closure. */
  requestId: string
  /**
   * The compiled instruction set, in provider order.
   *
   * Canonical. Identity, history and the current turn arrive here already
   * assembled by Core's Context Compiler, so a provider never has to know how
   * Freya is built, and never has to parse one long string to recover the
   * structure the user actually had.
   */
  messages: readonly ModelMessage[]
  /**
   * The same content flattened into one string, for providers that take a
   * single prompt.
   *
   * Derived from `messages` by the gateway, never authored separately, so the
   * two cannot disagree about what was said.
   */
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

/** What the gateway hands a provider alongside the request. */
export interface ModelCallOptions {
  /**
   * Aborted when the owner stops everything, when Core shuts down, and by
   * nothing else.
   *
   * Only the Model Gateway holds the controller, so a provider, a model, and a
   * model-written agent all *hold* this signal and none of them can fire it. A
   * provider that wants to stop cannot; it can only be stopped.
   *
   * A provider MUST check `signal.aborted` before anything that costs money or
   * touches a network, and MUST hand the signal to any transport it uses, so
   * that an abort reaches work already in flight as well as work not yet begun.
   */
  signal: AbortSignal
}

export interface ModelProvider {
  readonly id: string
  readonly kind: 'fake' | 'nanogpt'
  /** Whether this provider would spend real money or use a network. */
  readonly live: boolean
  /** Current readiness, for the status projection. */
  status(): ProviderStatus
  /**
   * Perform one call. Reached only through the Model Gateway.
   *
   * Throws {@link ModelRequestCancelled} when `options.signal` is aborted. It
   * must never retry on its own: a cancelled request is finished, and a second
   * attempt would be a second paid call the owner did not ask for.
   */
  complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult>
}

/**
 * Thrown when a request is aborted before it can finish.
 *
 * Cancellation is deliberately not modelled as failure. The two have opposite
 * accounting consequences: a cancelled request may never have reached a provider
 * at all, while a failed one probably did and may have been billed. A caller
 * that collapsed the two would report work that was never paid for.
 */
export class ModelRequestCancelled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelRequestCancelled'
  }
}

export function isModelRequestCancelled(error: unknown): boolean {
  return error instanceof ModelRequestCancelled
}

/**
 * Throw immediately if the call has already been cancelled.
 *
 * The first statement of every cancellable call in this codebase. It is a
 * function rather than a habit because the window it closes is exactly the one
 * that matters: the gateway can check the signal, and the provider can check it
 * again, and the second check is the last thing standing between an abort and a
 * paid request.
 */
export function throwIfAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw new ModelRequestCancelled(message)
}

/**
 * Flatten compiled messages into one prompt.
 *
 * The result is a *serialisation*, not the truth: `ModelRequest.messages` is
 * canonical and `prompt` exists for providers that only accept a string. Role
 * prefixes are included so a flattened transcript still reads as a transcript
 * rather than as one undifferentiated wall of text.
 */
export function flattenMessages(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) =>
      message.role === 'user' ? message.content : `[${message.role}] ${message.content}`,
    )
    .join('\n\n')
}
