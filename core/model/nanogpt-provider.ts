import {
  throwIfAborted,
  ModelRequestCancelled,
  type ModelCallOptions,
  type ModelCatalogEntry,
  type ModelCatalogOptions,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from './provider'
import type { ProviderStatus } from '../protocol/core-protocol'

/**
 * The NanoGPT provider.
 *
 * **Disabled unless deliberately configured.** There is no fallback provider, no
 * free public default, and no "try it and see". If the configuration is absent
 * the status is `unconfigured` and the gateway will not select it.
 *
 * Two independent conditions must both hold before a live call is possible:
 *
 *   1. `NANOGPT_API_KEY`, `NANOGPT_BASE_URL` and `NANOGPT_MODEL` are present;
 *   2. `FREYA_ALLOW_LIVE_MODEL=1`.
 *
 * Without the second, a configured provider still reports `disabled`. The
 * first is a credential; the second is a decision to spend.
 *
 * The key is read here, held in a closure, and never returned by `status()`,
 * never logged, and never recorded in an event.
 *
 * The base URL is the OpenAI-compatible root — `https://nano-gpt.com/api/v1` —
 * and the endpoints are the standard `GET {base}/models` and
 * `POST {base}/chat/completions`. A base given without the `/v1` suffix is
 * accepted too; the version segment is added only when it is not already there,
 * so the two spellings cannot quietly produce `/v1/v1/...`.
 */

export interface NanoGptConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** The explicit decision to spend inference. Never inferred. */
  liveEnabled: boolean
}

export interface NanoGptEnv {
  NANOGPT_API_KEY?: string | undefined
  NANOGPT_BASE_URL?: string | undefined
  NANOGPT_MODEL?: string | undefined
  FREYA_ALLOW_LIVE_MODEL?: string | undefined
}

/** Read configuration from the environment. Never throws, never guesses. */
export function readNanoGptConfig(env: NanoGptEnv): NanoGptConfig | null {
  const apiKey = env.NANOGPT_API_KEY?.trim()
  const baseUrl = env.NANOGPT_BASE_URL?.trim()
  const model = env.NANOGPT_MODEL?.trim()
  if (!apiKey || !baseUrl || !model) return null
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    liveEnabled: env.FREYA_ALLOW_LIVE_MODEL === '1',
  }
}

/** A catalogue is display metadata with a bound; a megabyte of ids is not a list. */
const MAX_CATALOG_ENTRIES = 2_000

/** Model ids that are not this shape are refused rather than rendered. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/

export interface NanoGptProviderOptions {
  config: NanoGptConfig | null
  /** Injected so tests never touch a network. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class NanoGptProvider implements ModelProvider {
  readonly id = 'nanogpt'
  readonly kind = 'nanogpt' as const
  readonly live = true

  private readonly config: NanoGptConfig | null
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  /**
   * The last catalogue this provider was able to read, as ids.
   *
   * Populated only by `listModels`, which is reached only by an explicit owner
   * command — never by boot, a timer, or a turn. `servesModel` consults it so a
   * selected model that was never listed cannot silently become a paid request
   * the provider would answer with an error at best and a surprise bill at worst.
   */
  private catalogue: Set<string> | null = null

  constructor(options: NanoGptProviderOptions) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /**
   * Join an endpoint path to the configured base.
   *
   * `https://nano-gpt.com/api/v1` is the documented OpenAI-compatible root and
   * gets the path appended directly; a base without the version segment gets
   * `/v1` inserted once. Anything else about the URL is whatever the operator
   * configured — this adds no host, no key, and no guessing.
   */
  private endpoint(path: string): string {
    if (this.config === null) throw new Error('nanogpt provider is not configured')
    const base = this.config.baseUrl
    return base.endsWith('/v1') ? `${base}/${path}` : `${base}/v1/${path}`
  }

  /**
   * Whether this provider would accept `model` on a chat completion.
   *
   * True for the configured default, and for anything the last successful
   * catalogue listed. A provider that has never read its catalogue serves only
   * its own model — "maybe NanoGPT has this id" is not a fact this method may
   * assert, and refusing an unlisted id is the truthful answer that fails
   * visibly at selection time rather than expensively mid-turn.
   */
  servesModel(model: string): boolean {
    if (this.config === null) return false
    if (model === this.config.model) return true
    return this.catalogue !== null && this.catalogue.has(model)
  }

  /**
   * Read the callable text-model catalogue. `GET {base}/models`.
   *
   * Model *ids* are display metadata, not inference: this endpoint spends no
   * credits, so it is reachable whenever a key is configured — including while
   * `FREYA_ALLOW_LIVE_MODEL` is off, which lets someone choose a sensible
   * default before ever enabling spend. It is still a network read, so it is
   * bounded, cancellable, and triggered only by an explicit command. Nothing
   * about this method runs when Freya is idle.
   */
  async listModels(options: ModelCatalogOptions): Promise<readonly ModelCatalogEntry[]> {
    if (this.config === null) throw new Error('nanogpt provider is not configured')
    throwIfAborted(options.signal, 'cancelled before the model catalogue was requested')

    const response = await this.fetchImpl(this.endpoint('models'), {
      method: 'GET',
      signal: options.signal,
      headers: { authorization: `Bearer ${this.config.apiKey}` },
    })
    if (options.signal.aborted) {
      throw new ModelRequestCancelled('the model catalogue request was cancelled')
    }
    if (!response.ok) {
      // The status is safe to record; the body may echo the request.
      throw new Error(`nanogpt models responded ${response.status}`)
    }

    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) {
      throw new Error('nanogpt returned a model catalogue that is not a list')
    }
    const entries: ModelCatalogEntry[] = []
    const seen = new Set<string>()
    for (const raw of body.data) {
      if (typeof raw !== 'object' || raw === null) continue
      const record = raw as { id?: unknown; object?: unknown; owned_by?: unknown }
      if (record.id === undefined || typeof record.id !== 'string') continue
      if (record.object !== undefined && record.object !== 'model') continue
      const id = record.id.trim()
      if (!MODEL_ID_PATTERN.test(id) || id === this.config.model || seen.has(id)) continue
      seen.add(id)
      entries.push({ id, ownedBy: typeof record.owned_by === 'string' ? record.owned_by : null })
      if (entries.length >= MAX_CATALOG_ENTRIES) {
        throw new Error('nanogpt returned more model ids than Freya will list')
      }
    }
    // Recorded only after the whole body parsed: a truncated or refused read
    // must not leave a half catalogue behind that `servesModel` would trust.
    this.catalogue = new Set(entries.map((entry) => entry.id))
    return entries
  }

  status(): ProviderStatus {
    if (this.config === null) {
      return {
        id: this.id,
        kind: this.kind,
        status: 'unconfigured',
        model: null,
        detail: 'Set NANOGPT_API_KEY, NANOGPT_BASE_URL and NANOGPT_MODEL to enable.',
        liveEnabled: false,
      }
    }
    if (!this.config.liveEnabled) {
      return {
        id: this.id,
        kind: this.kind,
        status: 'disabled',
        // A model name is not a secret and is useful to show.
        model: this.config.model,
        detail: 'Configured, but FREYA_ALLOW_LIVE_MODEL is not set. Live inference is off.',
        liveEnabled: false,
      }
    }
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: this.config.model,
      detail: 'Live inference enabled for this session.',
      liveEnabled: true,
    }
  }

  /**
   * One call, cancellable, with a timeout.
   *
   * Two things can end this request, and they are composed rather than raced:
   * the provider's own timeout, and the gateway's signal. Both reach the same
   * internal controller, so `fetch` sees one cancellation and there is exactly
   * one exit. Whichever fired first is reported as the reason, because "the owner
   * stopped everything" and "the provider was too slow" are different facts
   * about different events.
   *
   * There is no retry here and no retry above. An aborted request is finished.
   */
  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    if (this.config === null || !this.config.liveEnabled) {
      // Unreachable via the gateway, which only selects a `configured`
      // provider. Kept so a direct call cannot spend anything.
      throw new Error('nanogpt live inference is not enabled')
    }

    // Before anything that costs money. The gateway has already checked, and
    // this is the check that cannot be skipped: it is the last statement before
    // the request leaves the process.
    throwIfAborted(options.signal, 'cancelled before the provider was contacted')

    const controller = new AbortController()
    let cancelled: ModelRequestCancelled | null = null
    let timedOut = false

    const onExternalAbort = (): void => {
      // Recorded rather than thrown from the listener: an exception here would
      // be raised on whoever happened to be running, not on the request.
      cancelled = new ModelRequestCancelled(
        options.signal.reason instanceof Error
          ? options.signal.reason.message
          : 'the request was cancelled by the owner',
      )
      controller.abort(cancelled)
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('nanogpt request timed out'))
    }, this.timeoutMs)
    // A pending call must not be the reason the process refuses to exit. Shutdown
    // cancels explicitly; this is only the backstop for a call nobody waited for.
    unref(timer)

    try {
      const response = await this.fetchImpl(this.endpoint('chat/completions'), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? this.config.model,
          max_tokens: request.maxOutputTokens,
          // The compiled packet, sent as the structured turns it is. Identity
          // arrives as a system message, history as user/assistant turns, and
          // this provider has no idea any of it was assembled by Freya.
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      })

      if (cancelled !== null) throw cancelled
      if (!response.ok) {
        // The status is safe to record; the body may echo the request.
        throw new Error(`nanogpt responded ${response.status}`)
      }

      const body = (await response.json()) as {
        model?: string
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      return {
        requestId: request.requestId,
        providerId: this.id,
        model: body.model ?? request.model ?? this.config.model,
        text: body.choices?.[0]?.message?.content ?? '',
        inputTokens: typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
        outputTokens:
          typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null,
      }
    } catch (error) {
      // An external cancellation stays a cancellation even though `fetch` sees it
      // as a transport abort, so a stop is never recorded as a provider failure.
      if (cancelled !== null) throw cancelled
      if (options.signal.aborted) {
        throw new ModelRequestCancelled('the request was cancelled by the owner')
      }
      // A provider timeout is a provider failure, not an owner cancellation.
      // Modern fetch implementations may reject with AbortSignal.reason, so the
      // timeout reason itself must not be a ModelRequestCancelled instance.
      if (timedOut) throw new Error('nanogpt request timed out', { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onExternalAbort)
    }
  }
}

/** Do not let a timeout timer hold the Node event loop open. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
}
