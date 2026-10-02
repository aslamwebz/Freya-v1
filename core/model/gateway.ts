import {
  flattenMessages,
  isModelRequestCancelled,
  ModelRequestCancelled,
  type ModelCallOptions,
  type ModelCatalogEntry,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from './provider'
import { accumulateAttempt, accumulateReported, accumulateUsage, emptyUsage } from './usage'
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
 *
 * It also owns **cancellation**, which is the other half of the job. A durable
 * STOP latch stops the *next* request, and on its own that is not enough: a
 * provider call that has already gone out keeps going, and keeps costing, until
 * it finishes. So the gateway keeps a registry of what it is executing right
 * now, holds an `AbortController` for each one, and refuses to open the door to a
 * provider at all while a stop is latched.
 *
 *      Core / Security
 *            │
 *            ▼
 *        ModelGateway ──► contact gate + cognition epoch
 *            │                  │
 *            ▼                  ▼
 *      active registry    AbortControllers
 *            │                  │
 *            └────────┬─────────┘
 *                     ▼
 *                 Providers
 *
 * Only this module holds the controllers. Core can ask for everything to stop
 * and Core can ask for it to start again; nothing else can, and in particular no
 * provider, no model and no model-written agent.
 */

/** A permit the Governor issued. There is no way to obtain one otherwise. */
export interface GatewayPermit {
  requestId: string
  correlationId: string
  /** The grant that authorised this, or null for a grantless user turn. */
  grantId: string | null
  providerId: string
  maxOutputTokens: number
  model: string | null
  /**
   * The compiled instruction set, when a Mind assembled one.
   *
   * Optional so a plain user turn still works unchanged; when present it is the
   * canonical content and `prompt` below is derived from it rather than authored
   * beside it.
   */
  messages?: readonly ModelMessage[]
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
  /**
   * A request that was aborted, as distinct from one that failed.
   *
   * `providerContacted` is explicit rather than inferred, because the difference
   * is the whole accounting question: a request refused at the door cost
   * nothing, and one aborted after the provider had it was very probably
   * billed for whatever it had already generated.
   */
  cancelled(record: {
    requestId: string
    providerId: string
    reason: string
    providerContacted: boolean
  }): Promise<void>
}

export interface ModelGatewayOptions {
  providers: readonly ModelProvider[]
  recorder: GatewayRecorder
  now?: () => Date
  /**
   * Called when the number of executing requests changes.
   *
   * A function rather than an event a subscriber can miss, because the live
   * count is a fact Core publishes and the registry changes in both directions
   * on paths that never touch the journal. Without it, the count a renderer
   * last saw would be a count from whenever the last event happened to arrive.
   */
  onActivityChange?: () => void
}

/** One request the gateway is executing. Never leaves this module. */
interface ActiveCall {
  /** Registry key. An internal sequence, not the request id: two requests may
   *  legally carry the same id, and they are still two calls. */
  slot: number
  requestId: string
  grantId: string | null
  /** The cognition generation this request was authorised under. */
  epoch: number
  controller: AbortController
  /**
   * Whether the provider has been handed this request.
   *
   * Set synchronously immediately before the call and never inferred afterwards,
   * so a cancellation always knows whether the provider had it.
   */
  contacted: boolean
  /** True only while provider.complete() itself is still unresolved. */
  providerInFlight: boolean
  /** Why the owner stopped everything, when they did. */
  cancellationReason: string | null
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>()
  private readonly recorder: GatewayRecorder
  private readonly now: () => Date
  private readonly onActivityChange: () => void

  /**
   * What this gateway is executing *right now*.
   *
   * The only in-process record of live provider work in Freya, and the source
   * of `CoreStatus.activeProviderCalls`. A durable journal is history: it can say
   * a request was started, and it can say nothing about whether that request is
   * still running, because a Core that died mid-call leaves a start with no
   * finish forever. Presence must not be derived from it.
   */
  private readonly active = new Map<number, ActiveCall>()
  private nextSlot = 0

  /**
   * The cognition generation, and the contact gate.
   *
   * `epoch` increases every time the gate is closed. A request captures the
   * generation it was authorised under and may only contact a provider while
   * that is still the current one, which is what closes the window between "the
   * Governor allowed this" and "the provider is asked": if a stop lands in
   * between, the generation has moved on and the request is refused.
   */
  private epoch = 0
  private gateOpen = true
  private gateReason: string | null = null

  /**
   * Session usage. An attempt is counted when the provider is actually asked,
   * and whatever it reported is accumulated on top — never substituted for the
   * total.
   */
  private sessionUsage: ModelUsage = emptyUsage()

  constructor(options: ModelGatewayOptions) {
    this.recorder = options.recorder
    this.now = options.now ?? (() => new Date())
    this.onActivityChange = options.onActivityChange ?? (() => {})
    for (const provider of options.providers) {
      this.providers.set(provider.id, provider)
    }
  }

  /**
   * Usage for this Core session.
   *
   * A provider call that is still in flight has not reported its final token
   * usage yet, so the visible total is necessarily a lower bound until it
   * settles. The durable projection applies the same rule to replayed unfinished
   * starts after a crash.
   */
  usage(): ModelUsage {
    return {
      ...this.sessionUsage,
      unknownUsageCalls: this.sessionUsage.unknownUsageCalls + this.activeCallCount(),
    }
  }

  statuses(): ProviderStatus[] {
    return [...this.providers.values()].map((provider) => provider.status())
  }

  /**
   * How many provider requests are executing in this process at this instant.
   *
   * Zero whenever nothing is being spent, which is what makes an idle Freya
   * provably idle rather than merely quiet.
   */
  activeCallCount(): number {
    let count = 0
    for (const call of this.active.values()) {
      if (call.providerInFlight) count += 1
    }
    return count
  }

  /**
   * The contact gate is runtime authority, not UI state.
   *
   * Core and the Cognition Service read this so a gate closed by STOP ALL (or by
   * a failed attempt to persist STOP ALL) is reflected as deny-all before a
   * request can reach provider selection. The reason is diagnostic only; it
   * grants no authority and cannot reopen the gate.
   */
  gateStatus(): { open: boolean; reason: string | null } {
    return { open: this.gateOpen, reason: this.gateReason }
  }

  /**
   * Stop everything, now.
   *
   * Closes the contact gate, moves the cognition generation on, and aborts every
   * request in flight. Returns how many were aborted.
   *
   * Cancelled work is *gone*, not paused. Nothing here restarts a request, and
   * only {@link resume} — reachable from an explicit owner command and nothing
   * else — will let a new one begin.
   */
  cancelAll(reason: string): number {
    const gateChanged = this.gateOpen
    this.gateOpen = false
    this.gateReason = reason
    this.epoch += 1
    if (gateChanged) this.onActivityChange()
    let aborted = 0
    for (const call of [...this.active.values()]) {
      call.cancellationReason = reason
      call.controller.abort(new ModelRequestCancelled(reason))
      aborted += 1
    }
    return aborted
  }

  /**
   * Abort exactly one request, by request id.
   *
   * This is the everyday "stop generating this answer" path, and it is
   * deliberately nothing like {@link cancelAll}:
   *
   *   - the contact gate stays **open**, so Freya can still think about the next
   *     message;
   *   - the cognition generation does not move, so nothing else is affected;
   *   - no other request is touched, aborted or refunded;
   *   - an already-spent reservation stays spent, and usage accounting is exactly
   *     the conservative cancellation accounting used for a STOP ALL.
   *
   * STOP ALL stops Freya's *authority* to think. This stops one *answer*. A
   * button that latched a security stop would make the security control
   * unusable, and one that silently refunded the call would make it dishonest.
   *
   * Returns how many requests were aborted: 0 when the id is not currently
   * executing, which is the normal case for a double-click.
   */
  cancelRequest(requestId: string, reason: string): number {
    let aborted = 0
    for (const call of this.active.values()) {
      if (call.requestId !== requestId) continue
      call.cancellationReason = reason
      call.controller.abort(new ModelRequestCancelled(reason))
      aborted += 1
    }
    return aborted
  }

  /** Whether a request id is currently tracked by the gateway. */
  hasActiveRequest(requestId: string): boolean {
    for (const call of this.active.values()) {
      if (call.requestId === requestId) return true
    }
    return false
  }

  /**
   * Whether this exact request is currently inside provider.complete().
   *
   * Deliberately narrower than activeCallCount(): a conversation projection must
   * not become "generating" because some other conversation happens to be using a
   * provider, and a request waiting at the pre-contact gate is not paid provider
   * execution yet.
   */
  isProviderRequestInFlight(requestId: string): boolean {
    for (const call of this.active.values()) {
      if (call.requestId === requestId) return call.providerInFlight
    }
    return false
  }

  /**
   * Re-open the contact gate after an explicit owner resume.
   *
   * It restores permission and nothing else. No request is restarted, no
   * reservation is returned, and no cancelled result is replayed: the only thing
   * this changes is whether a *new* request may begin.
   */
  resume(): void {
    if (this.gateOpen) return
    this.gateOpen = true
    this.gateReason = null
    this.onActivityChange()
  }

  /**
   * Wait for in-flight requests to leave the registry, up to a bound.
   *
   * Used by shutdown so that a cancelled request can still record its terminal
   * event before the event fabric is closed. Bounded on purpose: a provider that
   * ignores its signal must not be able to hang the application, so this reports
   * `false` rather than waiting forever.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.active.size > 0) {
      if (Date.now() >= deadline) return false
      await sleep(2)
    }
    return true
  }

  /** The provider a request should use: an explicit choice, else the first ready one. */
  private resolve(requestedModel: string | null): ModelProvider | null {
    for (const provider of this.providers.values()) {
      if (provider.status().status !== 'configured') continue
      if (requestedModel !== null && !providerCanServe(provider, requestedModel)) continue
      return provider
    }
    return null
  }

  /**
   * Read the model catalogue, without exposing a provider.
   *
   * A metadata read, not a spend: it never touches the recorder, never enters
   * the active registry, and cannot make `activeCallCount` move — an idle Freya
   * stays idly zero even mid-list, because nothing is being billed. It is
   * reached only when Core asks on behalf of an explicit owner command. The
   * answer says honestly which states cannot produce a catalogue rather than
   * returning an empty list that would look like "NanoGPT has no models".
   */
  async readModelCatalog(): Promise<
    | { ok: true; providerId: string; defaultModel: string | null; models: readonly ModelCatalogEntry[] }
    | { ok: false; reason: string }
  > {
    const listable = [...this.providers.values()].filter(
      (provider) => typeof provider.listModels === 'function',
    )
    if (listable.length === 0) {
      return { ok: false, reason: 'no registered provider can list models' }
    }
    const states = listable.map((provider) => provider.status())
    const usable = listable.filter(
      (provider) => provider.status().status === 'configured' || provider.status().status === 'disabled',
    )
    if (usable.length === 0) {
      const worst = states[0]?.detail ?? 'the provider is not configured'
      return { ok: false, reason: `no configured provider can list models — ${worst}` }
    }
    // The *first* provider that can list. Provider order is Core's decision at
    // construction, so this follows the same rule as `resolve` follows for turns.
    const provider = usable[0] as ModelProvider
    try {
      const models = await provider.listModels!({ signal: AbortSignal.timeout(15_000) })
      return {
        ok: true,
        providerId: provider.id,
        defaultModel: provider.status().model,
        models,
      }
    } catch (error) {
      // The provider's message is already free of credentials — the key travels
      // only in a header the fetch transport never echoes into an error.
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'the model catalogue could not be read',
      }
    }
  }

  /**
   * Whether some configured provider could serve `model` right now.
   *
   * The same question `resolve` will ask when a turn arrives, answered without
   * making a turn. Core uses it to refuse an unusable selection visibly at the
   * moment it is chosen, rather than letting it fail later as a spent attempt.
   */
  canServeModel(model: string): boolean {
    for (const provider of this.providers.values()) {
      if (provider.status().status !== 'configured') continue
      if (providerCanServe(provider, model)) return true
    }
    return false
  }

  /**
   * Perform one call under a permit.
   *
   * There is no retry. A failed paid call must not silently become two paid
   * calls, so a failure is recorded once and returned — and a cancelled one is
   * recorded once and never re-attempted.
   */
  async execute(permit: GatewayPermit, prompt: string, signal?: AbortSignal): Promise<ModelResult> {
    const call = this.beginCall(permit)
    const abort = () => {
      call.cancellationReason = 'the request was cancelled'
      call.controller.abort(new ModelRequestCancelled(call.cancellationReason))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    // Derived once, from the compiled messages, so the two request shapes cannot
    // drift apart and a provider cannot be shown something the caller did not.
    const flattened = permit.messages ? flattenMessages(permit.messages) : prompt
    let provider: ModelProvider | null = null
    try {
      // First refusal point. Nothing durable has been said about a provider yet,
      // so a request that arrives into an open stop costs nothing and says
      // nothing.
      this.assertContactable(call)

      provider = this.resolve(permit.model)
      if (provider === null) {
        const reason =
          permit.model === null
            ? 'no configured provider can serve this request'
            : `no configured provider can serve model "${permit.model}"`
        await this.recorder.failed({ requestId: permit.requestId, providerId: permit.providerId, reason })
        throw new ProviderUnavailableError(reason)
      }

      // The permit's model wins when there is one: an owner selection that reached
      // this point *is* the request, and silently replacing it with the provider's
      // default would make the selector a lie. Without a selection, the provider's
      // own configured model answers, as it always has.
      const model = permit.model ?? provider.status().model ?? 'unknown'

      // `started` is written here, immediately before the provider is asked. It
      // is the gateway saying "I am about to spend something", which is why the
      // only thing that can follow it without a provider having been contacted
      // is a cancellation that withdraws it.
      await this.recorder.started({
        requestId: permit.requestId,
        grantId: permit.grantId,
        providerId: provider.id,
        model,
        maxOutputTokens: permit.maxOutputTokens,
        startedAt: this.now().toISOString(),
      })

      // Second refusal point, and the one that matters most. A stop that lands
      // while the event above is being written is caught here rather than
      // becoming a request that was stopped a moment too late to matter.
      this.assertContactable(call)

      // An attempt is an attempt even if the provider never answers, so the call
      // is counted here — after the last possible refusal, so nothing is
      // counted that was never asked for — and the reported figures are added
      // when they arrive.
      this.sessionUsage = accumulateAttempt(this.sessionUsage)

      const request: ModelRequest = {
        requestId: permit.requestId,
        // The Mind's compiled packet when there is one, otherwise the single user
        // prompt this has always sent. The flattened form is derived here, so a
        // provider that only takes a string and one that takes messages are
        // looking at the same content.
        messages: permit.messages ?? [{ role: 'user', content: flattened }],
        prompt: flattened,
        maxOutputTokens: permit.maxOutputTokens,
        model,
      }
      const options: ModelCallOptions = { signal: call.controller.signal }

      // Contacted, and the provider holds the signal from this line on. There is
      // deliberately no `await` between marking the contact and making it: the
      // mark and the call are one step, so it cannot be wrong about whether a
      // provider was asked.
      call.contacted = true
      call.providerInFlight = true
      // This is the exact transition from "authorised/queued inside the
      // gateway" to "the provider has been handed the request". Presence and
      // usage become live only here, not when execute() merely begins.
      this.onActivityChange()
      const result = await provider.complete(request, options)
      this.markProviderSettled(call)
      this.assertContactable(call)

      this.sessionUsage = accumulateUsage(this.sessionUsage, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
      await this.recorder.completed({
        requestId: permit.requestId,
        providerId: provider.id,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
      return result
    } catch (error) {
      // Whether the provider returned or rejected, the live external work is
      // over before we write its terminal event. Keep historical "contacted"
      // separate from "in flight" so Presence and temporary usage uncertainty
      // do not linger while the journal is being updated.
      this.markProviderSettled(call)
      const providerId = provider?.id ?? permit.providerId
      if (isModelRequestCancelled(error) || call.controller.signal.aborted) {
        return this.settleCancellation(call, providerId, error)
      }
      // A provider that was reached and then failed has almost certainly
      // consumed inference before the error — a timeout is not free work, and a
      // stream that dies after the first hundred tokens is not nothing. The only
      // honest record of that is `unknown`, so the call stays counted and its
      // usage is declared a gap rather than left looking like zero.
      //
      // Gated on contact, because a request that never found a provider cannot
      // have been billed, and declaring a gap there would invent a cost out of
      // nothing.
      if (call.contacted) {
        this.sessionUsage = accumulateReported(this.sessionUsage, {
          inputTokens: null,
          outputTokens: null,
        })
      }

      // Contained: the Core stays alive, the failure is durable, and there is
      // exactly one attempt.
      const reason = error instanceof Error ? error.message : 'unknown provider failure'
      await this.recorder.failed({ requestId: call.requestId, providerId, reason })
      // Marked, because this is the path where a provider *was* reached and the
      // caller has to be able to tell that from a request that never got that
      // far. The two have opposite billing consequences and nothing else about
      // the error reveals which one it was.
      throw markProviderContact(error instanceof Error ? error : new Error(reason), call.contacted)
    } finally {
      signal?.removeEventListener('abort', abort)
      this.endCall(call)
    }
  }

  /**
   * One cancelled request, recorded once.
   *
   * The accounting is the point. A request the provider never saw is not a call
   * and must not be counted as one; a request that was aborted with the provider
   * already working is almost certainly a lower bound rather than a total, and
   * says so. It is never reported as zero just because it was cancelled — the
   * money may well already have been spent.
   */
  private async settleCancellation(
    call: ActiveCall,
    providerId: string,
    error: unknown,
  ): Promise<never> {
    const reason =
      call.cancellationReason ??
      (error instanceof Error ? error.message : 'the request was cancelled')

    if (call.contacted) {
      this.sessionUsage = accumulateReported(this.sessionUsage, {
        inputTokens: null,
        outputTokens: null,
      })
    }
    await this.recorder.cancelled({
      requestId: call.requestId,
      providerId,
      reason,
      providerContacted: call.contacted,
    })
    throw markProviderContact(new ModelRequestCancelled(reason), call.contacted)
  }

  /**
   * Refuse a request that is not allowed to reach a provider.
   *
   * Three conditions, all of which must hold: the gate is open, the cognition
   * generation has not moved since this request arrived, and nobody has aborted
   * it. The first two are the race; the third is the ordinary in-flight cancel.
   */
  private assertContactable(call: ActiveCall): void {
    if (call.controller.signal.aborted) {
      throw new ModelRequestCancelled(
        call.cancellationReason ?? 'the request was cancelled before the provider was contacted',
      )
    }
    if (!this.gateOpen || call.epoch !== this.epoch) {
      const reason = this.gateReason ?? 'cognition is stopped'
      call.cancellationReason = reason
      throw new ModelRequestCancelled(reason)
    }
  }

  private beginCall(permit: GatewayPermit): ActiveCall {
    this.nextSlot += 1
    const call: ActiveCall = {
      slot: this.nextSlot,
      requestId: permit.requestId,
      grantId: permit.grantId,
      epoch: this.epoch,
      controller: new AbortController(),
      contacted: false,
      providerInFlight: false,
      cancellationReason: null,
    }
    this.active.set(call.slot, call)
    return call
  }

  private markProviderSettled(call: ActiveCall): void {
    if (!call.providerInFlight) return
    call.providerInFlight = false
    this.onActivityChange()
  }

  private endCall(call: ActiveCall): void {
    this.active.delete(call.slot)
  }
}

/** Carried by every error the gateway throws, so contact is explicit. */
export interface ProviderContact {
  /** True when a provider was reached before the failure. */
  readonly providerContacted: boolean
}

function markProviderContact<T extends object>(error: T, contacted: boolean): T & ProviderContact {
  Object.defineProperty(error, 'providerContacted', {
    value: contacted,
    enumerable: false,
    configurable: true,
  })
  return error as T & ProviderContact
}

/**
 * Whether a provider was reached before this failure.
 *
 * Both paths fail, and they must be told apart by something structural: a
 * provider that was contacted may have been billed for work it never finished
 * reporting, while a request that never found a provider was never billed at
 * all. `providerContacted` is written by the gateway on the way out, so callers
 * do not have to know which error type the gateway chose to throw.
 *
 * Defaults to `true` for anything unrecognised, because the cost of guessing
 * wrong in the other direction is a paid request recorded as free.
 */
export function wasProviderContacted(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'providerContacted' in error) {
    return (error as ProviderContact).providerContacted === true
  }
  return true
}

/**
 * Whether a provider serves a named model.
 *
 * A provider that can answer the question answers it; one that cannot is held to
 * the only thing it does know — the model its own status names. That default is
 * deliberately narrow: a provider without a catalogue gets exactly one usable
 * id, and a request naming any other is refused at the door rather than sent
 * off to fail downstream.
 */
function providerCanServe(provider: ModelProvider, model: string): boolean {
  if (provider.servesModel) return provider.servesModel(model)
  return provider.status().model === model
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
    // Structurally: nothing was reached, so nothing can have been billed.
    markProviderContact(this, false)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
