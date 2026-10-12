/* --------------------------------------------------------------- model */

export type ProviderStatusKind = 'disabled' | 'unconfigured' | 'configured' | 'faulted'

export interface ProviderStatus {
  id: string
  kind: 'fake' | 'nanogpt' | 'minimax' | 'local' | 'openai'
  status: ProviderStatusKind
  /** Never a secret: a shape, not a value. */
  model: string | null
  /** Why it is in this state, in words a person can act on. */
  detail: string
  /** True only when a live external call is possible and permitted. */
  liveEnabled: boolean
}

/**
 * Reported provider usage, accumulated over many calls.
 *
 * The two figures are sums of what providers *said*, and the counter is what
 * makes them honest:
 *
 * - `inputTokens` / `outputTokens` are the totals of the calls that reported
 *   usage. They are a **lower bound** whenever `unknownUsageCalls` is above zero,
 *   because the calls that reported nothing are simply not in the sum.
 * - `unknownUsageCalls` counts the calls that reported no usage, or only part of
 *   it. This is the explicit representation of "we do not know", chosen over
 *   treating an unreported call as zero — which would make an unaccounted call
 *   look like a free one — and over making the whole total null, which would
 *   throw away the calls that *were* accounted for.
 *
 * Nothing here is ever estimated. A caller that needs a true total must check
 * `unknownUsageCalls` first; presenting these two numbers as exact is the bug
 * this shape exists to prevent.
 *
 * This is entirely separate from a grant's *authorisation* budget, which is
 * reserved before a call and never depends on what a provider reports.
 */
export interface ModelUsage {
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  /** Calls whose usage was not fully reported. Makes the totals a lower bound. */
  unknownUsageCalls: number
}

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
export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ModelToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/** Arguments stay raw until the Mind validates them against its registry. */
export interface ModelToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/**
 * The image MIME types a message part may declare.
 *
 * An allowlist, not a `startsWith('image/')` test. The set is exactly what has
 * been verified to survive the configured provider's content-parts parser, so a
 * part carrying anything else is refused locally with a typed error rather than
 * being forwarded as a guess and coming back as an opaque HTTP 400.
 *
 * SVG is deliberately absent: it is an XML document that can carry script, and
 * no part of Freya has a reason to hand one to a model.
 */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

/**
 * The document MIME types a message part may declare.
 *
 * `application/pdf` is the only one verified to work as an OpenAI `file` part on
 * the configured endpoint. It is also the only one worth supporting now: a
 * second document type would need its own verified capability before it could be
 * listed here, and guessing at one would trade a local typed error for a remote
 * one.
 */
export const FILE_MIME_TYPES = ['application/pdf'] as const

export type FileMimeType = (typeof FILE_MIME_TYPES)[number]

/** Text as a content part. Constructed from a message's `content`, never authored directly. */
export interface ModelTextPart {
  readonly type: 'text'
  readonly text: string
}

/**
 * One image, carried inline.
 *
 * `data` is bare base64 — no `data:` prefix, no URL, no filesystem path.
 *
 * An HTTPS `image_url` was verified to work on the configured endpoint and is
 * deliberately *not* accepted here. Turning a renderer-supplied URL into an
 * outbound request is a new egress that no endpoint policy in this codebase
 * covers, and a model lane that could be made to fetch an arbitrary host is a
 * worse trade than a user picking a file. The attachment stays inline, which is
 * also the only form that keeps the send hermetic and the request body
 * inspectable in one place.
 */
export interface ModelImagePart {
  readonly type: 'image'
  readonly mimeType: ImageMimeType
  /** Bare base64. Bounded by {@link MAX_ATTACHMENT_BYTES}; see {@link validateModelAttachments}. */
  readonly data: string
  /** Display name only. Never read by a provider, never trusted as a path. */
  readonly filename?: string
}

/** One document, carried inline as an OpenAI-style `file` part. */
export interface ModelFilePart {
  readonly type: 'file'
  readonly mimeType: FileMimeType
  /** Bare base64. Bounded by {@link MAX_ATTACHMENT_BYTES}; see {@link validateModelAttachments}. */
  readonly data: string
  /** Required: the endpoint uses it to label the part, and an unnamed file is not a file. */
  readonly filename: string
}

/**
 * A discriminated content union, closed on `type`.
 *
 * `text | image | file`, and nothing else. A part whose `type` is not one of
 * these three is not "a part with an unexpected shape" — it is unrecognised
 * input, and {@link validateModelAttachments} refuses it with
 * {@link ModelAttachmentError} rather than skipping it. Skipping is the failure
 * mode that matters: a user attaches a document, the provider silently never
 * sees it, and the answer describes something that was never sent.
 */
export type ModelContentPart = ModelTextPart | ModelImagePart | ModelFilePart

/**
 * The non-text half of {@link ModelContentPart}.
 *
 * Text is not repeated here: it already has its own field on
 * {@link ModelMessage}, and having it in two places would be a second way for
 * `messages` and `prompt` to disagree about what was said.
 */
export type ModelAttachment = ModelImagePart | ModelFilePart

/**
 * How much *decoded* payload one attachment may carry: 4 MiB.
 *
 * Chosen against the real cost of the thing, not a round number. A screenshot at
 * a typical 2x retina scale is well under 1 MiB; a scanned document page lands
 * around 200 KiB. So 4 MiB is roughly three times what the common case needs,
 * which leaves the ceiling high enough that a legitimate attachment is never
 * refused for being legitimate and low enough that a single turn cannot hand the
 * endpoint a body large enough to time out and be billed as a failure.
 *
 * It is a per-attachment bound on decoded bytes, and it is checked against the
 * *encoded* length before any decoding happens — see
 * {@link validateModelAttachments}.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

/**
 * How many attachments one message may carry: 8.
 *
 * A turn is a conversation, not a file drop. Eight is above the point where a
 * person has stopped attaching things and started uploading a directory, which
 * is the signal that they want a different feature.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8

/**
 * The decoded ceiling across all of one message's attachments: 8 MiB.
 *
 * A per-part bound alone does not bound a request: eight legal 4 MiB parts is
 * 32 MiB of body. This is the bound that actually caps what one turn can cost,
 * and it is the one a caller should assume is real.
 */
export const MAX_MESSAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024

export interface ModelMessage {
  readonly toolCalls?: readonly ModelToolCall[]
  readonly toolCallId?: string
  readonly reasoningContent?: string
  readonly reasoningDetails?: unknown
  readonly role: ModelMessageRole
  readonly content: string
  /**
   * Images and documents carried by this turn.
   *
   * A sibling field rather than a widened `content`, and that is a deliberate
   * choice made from a measurement rather than a preference. Widening `content`
   * to `string | readonly ModelContentPart[]` was tried against this repo and it
   * breaks 4 production call sites plus ~30 test files that read the field as a
   * `string` today — including `FakeEchoProvider`, which is not this change's to
   * touch. Every one of those readers wants the *text*; none of them want a union
   * they must narrow before they can count a token.
   *
   * So the text keeps its field, the payload keeps its own, and the union is the
   * full `ModelContentPart` set that a provider serialises. A message with no
   * `attachments` serialises exactly as it did before this field existed — the
   * same string, not a one-element array — which is what keeps text-only request
   * bodies byte-identical.
   *
   * Optional and absent-means-absent, so every existing construction site of a
   * `ModelMessage` still compiles and still means the same thing.
   */
  readonly attachments?: readonly ModelAttachment[]
}

export interface ModelRequest {
  readonly tools?: readonly ModelToolDefinition[]
  reasoningEffort?: string
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
   *
   * "Flattened" means flattened: a text part becomes its text, and an image or
   * file part becomes a placeholder line that says its content was not included.
   * See {@link flattenMessages} for why the bytes are not inlined and what the
   * placeholder guarantees.
   */
  prompt: string
  maxOutputTokens: number
  model: string | null
}

/**
 * Why a provider stopped generating, as the endpoint reported it.
 *
 * A closed union over the reasons the OpenAI-compatible chat API actually sends,
 * plus `other` for a reason this code does not model. It is deliberately *not* a
 * `string`: the whole point of carrying this fact is that one particular member
 * means "the model ran out of room", and a wide `string` would push that decision
 * to whichever call site happened to remember the spelling. `other` says "a
 * provider said something, and it was not one of these", which is honest and
 * carries no claim.
 *
 * `tool_calls` is here because it is a *normal* reason and the distinction matters
 * more than the similarity: a turn that stopped to ask for a tool has not been
 * cut off, and treating it as truncated would fail every turn in which a model
 * used a lookup.
 */
export type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'other'

/** The one finish reason that means the answer did not get to finish. */
export const TRUNCATION_FINISH_REASON: ModelFinishReason = 'length'

export interface ModelResult {
  readonly toolCalls?: readonly ModelToolCall[]
  readonly toolCallError?: string
  readonly reasoningContent?: string
  readonly reasoningDetails?: unknown
  requestId: string
  /** Which provider answered. Known only after the call. */
  providerId: string
  model: string
  text: string
  /** Null when the provider did not report them. Never estimated. */
  inputTokens: number | null
  outputTokens: number | null
  /**
   * Why the provider stopped, as it reported it. Null when it reported nothing.
   *
   * Optional and additive: a provider written before this field existed still
   * satisfies the interface, and its results still mean exactly what they meant
   * before. Nothing is inferred from the text — an empty string is not evidence
   * of truncation, and a short one is not either.
   */
  readonly finishReason?: ModelFinishReason | null
  /**
   * Whether this answer was cut off by the output budget.
   *
   * Derived from {@link finishReason} and never from the content, by
   * {@link resolveFinish} on the way out of the gateway. Optional here so a
   * provider may state either fact and a consumer can always ask
   * {@link isTruncationSignal} rather than trusting a possibly-absent flag.
   */
  readonly truncated?: boolean
}

/**
 * One callable text model a provider reports about itself.
 *
 * An id and a label — that is the whole of what crosses back. A catalogue entry
 * is display metadata, never a credential, and never an authorisation: being
 * listed only means the provider would send that id to its own endpoint if the
 * owner selected it.
 */
export interface ModelCatalogEntry {
  /** Exact selectable values reported by this provider for this model. */
  reasoningEfforts?: readonly string[]
  providerId?: string
  id: string
  ownedBy: string | null
}
