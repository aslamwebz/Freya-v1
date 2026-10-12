import { readNativeToolCalls, serialiseToolDefinitions, serialiseToolFields } from './tool-transport'
import {
  throwIfAborted,
  readReasoningEfforts,
  ModelRequestCancelled,
  readFinishReason,
  resolveFinish,
  validateModelAttachments,
  type ModelAttachment,
  type ModelCallOptions,
  type ModelCatalogEntry,
  type ModelCatalogOptions,
  type ModelMessage,
  type ModelMessageRole,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from './provider'
import type { ProviderStatus } from '../../shared/contracts/model'
import { assertProviderBaseUrl, assertProviderRedirectTarget, checkProviderBaseUrl } from './provider-endpoint'

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
  /**
   * The base URL is where the key will be sent, so it is checked here and not only
   * at the point of entry.
   *
   * `NANOGPT_BASE_URL` reaches this function from three places — a launch
   * environment, a `.env` file, and the persisted provider config — and the third of
   * those is reachable from a renderer. Validating only at the boundary that writes
   * it would leave this function trusting a value that anything with write access to
   * `provider.json`, or anything that set the variable before launch, could aim at
   * an arbitrary host.
   *
   * A URL that fails the policy yields `null`, which is the same result as an absent
   * configuration: the provider reports `unconfigured` and the gateway will not
   * select it. That is the truthful outcome — the provider cannot be reached as
   * configured — and it fails closed, because an unconfigured provider cannot be
   * called at all.
   *
   * The non-throwing form is used deliberately. Throwing here would propagate out of
   * provider construction and take down `Core.start()` for a bad *setting*, which
   * would mean one mistyped URL makes the whole application unlaunchable. A setting
   * that cannot be honoured disables the thing it configures.
   */
  const approved = checkProviderBaseUrl(baseUrl)
  if (!approved.ok) return null
  return {
    apiKey,
    // The path is preserved because it is part of the endpoint (`/api/v1`), but it
    // comes from the parsed URL rather than from string surgery on the raw input.
    baseUrl: `${approved.url!.origin}${approved.url!.pathname}`.replace(/\/+$/, ''),
    model,
    liveEnabled: env.FREYA_ALLOW_LIVE_MODEL === '1',
  }
}

/** A catalogue is display metadata with a bound; a megabyte of ids is not a list. */
const MAX_CATALOG_ENTRIES = 2_000

/** Model ids that are not this shape are refused rather than rendered. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/

/**
 * How much of a provider error body reaches the thrown error.
 *
 * The server's own diagnostic is the useful part — `"This model only supports
 * tool_choice=\"auto\""` names the fix, and `code`/`param` name the field. But
 * the body is remote input, it may echo the request back, and it may be long
 * enough to drown the status line it is attached to. 300 characters is enough
 * for a sentence and a code and nowhere near enough to carry a payload back out.
 */
const MAX_ERROR_DETAIL_CHARS = 300

/**
 * A non-2xx chat completion, with the server's own explanation attached.
 *
 * Structured rather than interpolated into a bare `Error` because `code` and
 * `param` are what make an upstream failure actionable — "invalid_image_input"
 * on `messages` is a fact, while "nanogpt responded 400" is a rumour.
 */
export class NanoGptResponseError extends Error {
  readonly status: number
  /** The server's `error.code`, when it sent one. */
  readonly code: string | null
  /** The server's `error.param` — the field it objected to. */
  readonly param: string | null

  constructor(status: number, message: string, code: string | null, param: string | null) {
    super(message)
    this.name = 'NanoGptResponseError'
    this.status = status
    this.code = code
    this.param = param
  }
}

/**
 * Pull `error.message`, `error.code` and `error.param` out of a failed response.
 *
 * This is a debuggability fix, not a formatting one. The endpoint answers, for
 * example, `{"error":{"message":"This model only supports tool_choice=\"auto\"...",
 * "code":"unsupported_parameter","param":"tool_choice"}}` and
 * `{"error":{"message":"Invalid image input...","code":"invalid_image_input","param":"messages"}}`
 * — and every one of those was being discarded in favour of `responded 400`,
 * which is the same answer for an exhausted balance, a bad key, a bad model, and
 * an image the model cannot see.
 *
 * The body is remote input, so it is not trusted beyond being text:
 *
 *   - only `error.message`, `error.code` and `error.param` are read. Nothing
 *     else in the body is surfaced, so a body that echoes the request back
 *     contributes nothing;
 *   - response headers are never read for this, so there is no header echo;
 *   - the configured API key is redacted wherever it appears, and so is any
 *     `Bearer <token>` in case the server reflects one back;
 *   - control characters are stripped and the result is truncated, so a
 *     hostile body cannot forge log lines or smuggle megabytes into a message
 *     that ends up in a turn record.
 *
 * Returns `null` when there is nothing usable to add, in which case the thrown
 * error stays exactly the status line it has always been.
 */
function describeProviderError(body: unknown, apiKey: string): { message: string; code: string | null; param: string | null } | null {
  if (typeof body !== 'object' || body === null) return null
  const error = (body as { error?: unknown }).error

  /**
   * OpenAI-compatible errors nest under `error`; some gateways answer with a
   * bare `{"message": ...}` or a bare string. Read the nested shape first and
   * fall back rather than reporting nothing for a body that did explain itself.
   */
  const record: Record<string, unknown> =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : typeof error === 'string'
        ? { message: error }
        : typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
          ? (body as Record<string, unknown>)
          : {}

  const message = sanitiseErrorField(record['message'], apiKey)
  const code = sanitiseErrorField(record['code'], apiKey)
  const param = sanitiseErrorField(record['param'], apiKey)
  if (message === null && code === null && param === null) return null

  const detail = message ?? code ?? param ?? 'no detail'
  const qualifiers = [
    code === null ? null : `code=${code}`,
    param === null ? null : `param=${param}`,
  ].filter((value): value is string => value !== null)

  return {
    message: qualifiers.length === 0 ? detail : `${detail} (${qualifiers.join(', ')})`,
    code,
    param,
  }
}

/** Reduce one remote field to a short, single-line, secret-free string. Or null. */
function sanitiseErrorField(value: unknown, apiKey: string): string | null {
  if (typeof value !== 'string') return null
  let text = value
  // The key first: it is the one thing that must never leave this function, and
  // redacting it before anything else means no later transformation can undo it.
  if (apiKey !== '') text = text.split(apiKey).join('[redacted]')
  // A reflected bearer token is a credential whether or not it is ours.
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [redacted]')
// Control characters would let a remote body forge a line in a log or a record.
  text = stripControlCharacters(text)
  if (text === '') return null
  return text.length > MAX_ERROR_DETAIL_CHARS
    ? `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : text
}

/**
 * Flatten a remote field to one line: every C0 control and DEL becomes a space.
 *
 * Written as a scan rather than a `/[\u0000-\u001f\u007f]/g` because a regular
 * expression built from control ranges is exactly the kind of thing a linter
 * rightly refuses to let through unreviewed, and "which characters count as
 * control" deserves to be stated as code rather than as a character class
 * someone has to decode to check.
 */
function stripControlCharacters(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : character
  }
  return out.trim()
}

/**
 * Read a failed response's body without ever letting that read become the error.
 *
 * The body is parsed as JSON rather than read as text so that a transport which
 * only implements `json()` — which is every fake in this suite, deliberately — is
 * handled the same as a real `Response`. A body that is not JSON, or a read that
 * fails, yields `null` and the caller keeps the status-only message it had
 * before.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/**
 * One chat message as this API expects it.
 *
 * `content` is either a bare string or the OpenAI content-parts array. Which one
 * it is depends entirely on the message: a message with no attachments keeps the
 * string it has always sent, and only a message that actually carries a payload
 * becomes an array. That is the whole of the compatibility story — text-only
 * request bodies are byte-for-byte what they were before images existed, so no
 * existing assertion about a request has moved.
 */
type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

/**
 * Serialise one compiled turn.
 *
 * Validation happens here, at the boundary that builds a request body, so a
 * malformed attachment is refused before anything is spent and is reported as
 * what it is rather than as an opaque HTTP 400 from the endpoint.
 */
function serialiseMessage(message: ModelMessage): { role: ModelMessageRole; content: string | OpenAiContentPart[] } {
  const attachments = validateModelAttachments(message.attachments)
  // The overwhelmingly common case, and the one every existing test asserts on:
  // a string, not a one-element array. Wrapping it would change every request
  // body in the suite for no benefit the endpoint offers.
  if (attachments.length === 0) return { role: message.role, content: message.content, ...serialiseToolFields(message) }

  const parts: OpenAiContentPart[] = []
  // An empty string is omitted rather than sent as an empty text part, so an
  // attachment-only turn is a clean single-part array.
  if (message.content !== '') parts.push({ type: 'text', text: message.content })
  for (const attachment of attachments) parts.push(toContentPart(attachment))
  return { role: message.role, content: parts, ...serialiseToolFields(message) }
}

/**
 * One attachment as one content part.
 *
 * The shapes are the ones verified against this endpoint: images as
 * `image_url` with a base64 data URL, documents as `file` with `file_data`. A
 * PDF is *not* sent as an `image_url` data URL — that is rejected with
 * `invalid_image_input` — and not every model accepts the `file` part at all, so
 * a model that cannot read one still refuses it server-side with its own
 * explanation rather than being handed something it will misparse.
 */
function toContentPart(attachment: ModelAttachment): OpenAiContentPart {
  return attachment.type === 'image'
    ? {
        type: 'image_url',
        image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
      }
    : {
        type: 'file',
        file: {
          filename: attachment.filename,
          file_data: `data:${attachment.mimeType};base64,${attachment.data}`,
        },
      }
}

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
  private nativeToolModels = new Set<string>()

  supportsNativeTools(model: string): boolean { return this.nativeToolModels.has(model) }

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
   * Send a request to the provider, attaching the API key only to an approved host.
   *
   * This is the boundary that actually holds the property. Everything upstream of it
   * — the bridge check, the config check on load — is an early refusal that produces
   * a better message; a check that existed only there would still be one refactor
   * away from being bypassed, because the value on this line arrives as a plain
   * string from a configuration source the renderer can influence.
   *
   * So the sequence here is deliberate and ordered:
   *
   *   1. Validate the URL that is about to be contacted.
   *   2. Ask `fetch` **not** to follow redirects.
   *   3. Attach the `Authorization` header.
   *   4. On a redirect, validate the new target against the policy before repeating.
   *
   * Step 2 is the one that is easy to get wrong. With the default
   * `redirect: 'follow'`, a provider that answers `302 Location: https://x/` causes
   * the runtime to re-issue the request — and the header with the key in it — to
   * wherever it was told, with no opportunity to object. Hand-following keeps the
   * decision in code where a refusal can be recorded.
   *
   * The header is attached per hop rather than once, so a hop that fails validation
   * is never sent at all. There is no code path that reaches `fetchImpl` with an
   * unvalidated URL and a non-empty `authorization`.
   */
  private async send(url: string, init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
  }): Promise<Response> {
    const MAX_REDIRECTS = 3
    let target = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Re-validated on every hop, including the first. Cheap, and it means a future
      // caller cannot skip it by routing through a different method.
      assertProviderBaseUrl(target)
      const response = await this.fetchImpl(target, {
        method: init.method,
        signal: init.signal,
        redirect: 'manual',
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      const location = response.headers.get('location')
      if (!response.status.toString().startsWith('3') || location === null) return response
      // Validate before resolving against it, so a relative Location cannot walk the
      // request off the approved host by pointing at an absolute URL elsewhere.
      const next = new URL(location, target).href
      assertProviderRedirectTarget(next)
      target = next
    }
    throw new Error('nanogpt redirected too many times')
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

    const response = await this.send(this.endpoint('models'), {
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
    const nativeToolModels = new Set<string>()
    for (const raw of body.data) {
      if (typeof raw !== 'object' || raw === null) continue
      const record = raw as { id?: unknown; object?: unknown; owned_by?: unknown }
      if (record.id === undefined || typeof record.id !== 'string') continue
      if (record.object !== undefined && record.object !== 'model') continue
      const id = record.id.trim()
      if (!MODEL_ID_PATTERN.test(id) || seen.has(id)) continue
      seen.add(id)
      const reasoningEfforts = readReasoningEfforts(raw)
      const capabilities = raw as { supported_parameters?: unknown; capabilities?: { tool_calling?: unknown } }
      if ((Array.isArray(capabilities.supported_parameters) && capabilities.supported_parameters.includes('tools'))
        || capabilities.capabilities?.tool_calling === true) nativeToolModels.add(id)
      entries.push({ id, ownedBy: typeof record.owned_by === 'string' ? record.owned_by : null, ...(reasoningEfforts ? { reasoningEfforts } : {}) })
      if (entries.length >= MAX_CATALOG_ENTRIES) {
        throw new Error('nanogpt returned more model ids than Freya will list')
      }
    }
    // Recorded only after the whole body parsed: a truncated or refused read
    // must not leave a half catalogue behind that `servesModel` would trust.
    this.catalogue = new Set(entries.map((entry) => entry.id))
    this.nativeToolModels = nativeToolModels
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
      const response = await this.send(this.endpoint('chat/completions'), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? this.config.model,
          max_tokens: request.maxOutputTokens,
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
          // The compiled packet, sent as the structured turns it is. Identity
          // arrives as a system message, history as user/assistant turns, and
          // this provider has no idea any of it was assembled by Freya.
          //
          // No key is added here, and none is removed: a text-only turn produces
          // exactly the object it produced before attachments existed.
          messages: request.messages.map(serialiseMessage),
          ...serialiseToolDefinitions(request.tools),
        }),
      })

      if (cancelled !== null) throw cancelled
      if (!response.ok) {
        // The server's own explanation, bounded and stripped of anything that
        // looks like a credential. `responded 400` alone was the same string for
        // a bad key, a bad model, an exhausted balance, and an image this model
        // cannot see — which is to say, for every failure worth diagnosing.
        const detail = describeProviderError(
          await readErrorBody(response),
          this.config.apiKey,
        )
        throw new NanoGptResponseError(
          response.status,
          detail === null
            ? `nanogpt responded ${response.status}`
            : `nanogpt responded ${response.status}: ${detail.message}`,
          detail?.code ?? null,
          detail?.param ?? null,
        )
      }

      const body = (await response.json()) as {
        model?: string
        choices?: { message?: { content?: string; tool_calls?: unknown; reasoning_content?: string; reasoning_details?: unknown }; finish_reason?: unknown }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      /**
       * The finish reason is read here and nowhere else in the provider, and it
       * is read from `choices[0]` rather than inferred from anything about the
       * text.
       *
       * `finish_reason: "length"` is the provider saying the output budget ran
       * out mid-answer, which is a fact about what Freya is about to store as if
       * it were a complete reply. Dropping it here — as this call used to — makes
       * a truncated answer indistinguishable from a finished one, and there is no
       * later hop that could recover it: the text alone cannot tell a model that
       * stopped from a model that was stopped.
       *
       * `readFinishReason` narrows an untrusted field and maps anything
       * unrecognised to `'other'`, so an endpoint that invents a spelling
       * produces "said something else" rather than a silent `stop`.
       */
      const choice = body.choices?.[0]

      return resolveFinish({
        ...readNativeToolCalls(choice?.message?.tool_calls),
        ...(choice?.message?.reasoning_content === undefined ? {} : { reasoningContent: choice.message.reasoning_content }),
        ...(choice?.message?.reasoning_details === undefined ? {} : { reasoningDetails: choice.message.reasoning_details }),
        requestId: request.requestId,
        providerId: this.id,
        model: body.model ?? request.model ?? this.config.model,
        text: choice?.message?.content ?? '',
        inputTokens: typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
        outputTokens:
          typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null,
        finishReason: readFinishReason(choice?.finish_reason),
      })
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
