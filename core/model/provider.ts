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

/**
 * Narrow a remote `finish_reason` to {@link ModelFinishReason}, or null.
 *
 * Takes `unknown` on purpose, for the same reason `validateModelAttachments`
 * does: this is a field off a network response, and a value typed as
 * already-correct is a value nobody re-checks at the boundary.
 *
 * `null` means *the provider did not say*, which is different from `other`
 * (it said something unrecognised) and different again from `stop` (it said it
 * finished). Absence is never upgraded to a favourable answer.
 */
export function readFinishReason(raw: unknown): ModelFinishReason | null {
  if (typeof raw !== 'string' || raw === '') return null
  switch (raw) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return raw
    default:
      return 'other'
  }
}

/** The one finish reason that means the answer did not get to finish. */
export const TRUNCATION_FINISH_REASON: ModelFinishReason = 'length'

/**
 * Whether a finish reason is the one that means "cut off".
 *
 * Exactly one reason qualifies, and the exclusion of `tool_calls` is deliberate
 * rather than incidental: a turn that stopped to request a tool is a turn that
 * did what it was asked to do, and calling that truncation would make every
 * tool-using turn look broken.
 *
 * Null and `other` are both "not truncation", because neither is a claim about
 * the output budget. An unreported reason is not evidence of a cut-off answer.
 */
export function isTruncationReason(reason: ModelFinishReason | null | undefined): boolean {
  return reason === TRUNCATION_FINISH_REASON
}

/**
 * Whether a finished result was truncated.
 *
 * Structural, so the same question can be asked of a provider result and of a
 * cognition outcome that carries the same two fields forward. An explicit
 * `truncated` wins when present; otherwise it is derived from the reason, which
 * is what makes a provider that reports only `finish_reason` still answer
 * correctly.
 */
export function isTruncationSignal(
  result: { finishReason?: ModelFinishReason | null; truncated?: boolean },
): boolean {
  if (typeof result.truncated === 'boolean') return result.truncated
  return isTruncationReason(result.finishReason)
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
 * Settle a provider's finish facts into both fields, once.
 *
 * The gateway runs this on the way out so every caller above it — Cognition, the
 * Mind, the transcript — reads one answer rather than re-deriving truncation from
 * a field that may or may not be present. It only ever *adds* the two fields: the
 * text, the model, the token counts and the ids are returned untouched, so a
 * normally-finished answer carries exactly the bytes it always did.
 */
export function resolveFinish<T extends ModelResult>(result: T): T & {
  readonly finishReason: ModelFinishReason | null
  readonly truncated: boolean
} {
  const finishReason = result.finishReason ?? null
  return { ...result, finishReason, truncated: isTruncationReason(finishReason) }
}

export type ModelAttachmentErrorCode =
  /** `type` was absent, not a string, or not one of `image` / `file`. */
  | 'unknown_part_type'
  /** A recognised part whose fields are missing, mistyped, or not base64. */
  | 'malformed_part'
  /** A well-formed part declaring a MIME type outside the allowlist. */
  | 'mime_not_allowed'
  /** One part's decoded payload exceeds {@link MAX_ATTACHMENT_BYTES}. */
  | 'payload_too_large'
  /** More parts than {@link MAX_ATTACHMENTS_PER_MESSAGE}. */
  | 'too_many_attachments'
  /** The message's parts together exceed {@link MAX_MESSAGE_ATTACHMENT_BYTES}. */
  | 'message_payload_too_large'

/**
 * Thrown when a message carries something that cannot be forwarded.
 *
 * A dedicated class with a `code`, because "the attachment was bad" and "the
 * model refused the prompt" are different facts about different events and a
 * caller that collapses them reports a user error as a provider failure. It is
 * thrown *before* the request is built, so a refused attachment costs nothing.
 */
export class ModelAttachmentError extends Error {
  readonly code: ModelAttachmentErrorCode
  /** Which part of which message, when known. Null when the failure is the list itself. */
  readonly partIndex: number | null
  /** The MIME type that was declared, when the failure was about one. */
  readonly mimeType: string | null

  constructor(
    code: ModelAttachmentErrorCode,
    message: string,
    details: { partIndex?: number | null; mimeType?: string | null } = {},
  ) {
    super(message)
    this.name = 'ModelAttachmentError'
    this.code = code
    this.partIndex = details.partIndex ?? null
    this.mimeType = details.mimeType ?? null
  }
}

/**
 * Standard base64: the alphabet, with padding only at the end.
 *
 * Checked explicitly because the alternative — letting `Buffer.from` try and
 * then ignoring what it produced — is how invalid input becomes silently
 * truncated bytes in a request the provider was billed for.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/** Decoded length of an already-validated base64 string, exactly. */
function decodedByteLength(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return (encoded.length / 4) * 3 - padding
}

/**
 * Narrow untrusted input to {@link ModelAttachment}[], or refuse it.
 *
 * Takes `unknown` on purpose. The shape of an attachment is exactly the kind of
 * thing that arrives from a bridge, a file drop, or a tool result, and a
 * validator that is typed as already-correct is a validator that will be skipped
 * at the one boundary that matters. Every rejection is a
 * {@link ModelAttachmentError}; nothing is dropped.
 *
 * The size check is made against the *encoded* length, before any decode.
 * Base64 expands by 4/3, so the decoded length is known from the string length
 * alone — checking afterwards would mean allocating a multi-megabyte buffer for
 * every oversized attachment in order to learn it was oversized. The check
 * therefore uses the encoding as an upper bound on the decoding: a payload
 * within `MAX_ATTACHMENT_BYTES` can never encode to something this rejects.
 */
export function validateModelAttachments(input: unknown): readonly ModelAttachment[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    throw new ModelAttachmentError('malformed_part', 'message attachments must be a list of parts')
  }
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ModelAttachmentError(
      'too_many_attachments',
      `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments, got ${input.length}`,
    )
  }

  const validated: ModelAttachment[] = []
  let totalBytes = 0

  for (const [index, raw] of input.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ModelAttachmentError('malformed_part', `attachment ${index} is not an object`, {
        partIndex: index,
      })
    }
    const part = raw as Record<string, unknown>
    const type = part['type']
    if (typeof type !== 'string') {
      throw new ModelAttachmentError(
        'unknown_part_type',
        `attachment ${index} has no string "type"`,
        { partIndex: index },
      )
    }
    if (type !== 'image' && type !== 'file') {
      throw new ModelAttachmentError(
        'unknown_part_type',
        `attachment ${index} has unknown type "${type}"; only "image" and "file" are content parts`,
        { partIndex: index },
      )
    }

    const mimeType = part['mimeType']
    if (typeof mimeType !== 'string') {
      throw new ModelAttachmentError(
        'malformed_part',
        `attachment ${index} has no string "mimeType"`,
        { partIndex: index },
      )
    }
    const allowed: readonly string[] = type === 'image' ? IMAGE_MIME_TYPES : FILE_MIME_TYPES
    if (!allowed.includes(mimeType)) {
      throw new ModelAttachmentError(
        'mime_not_allowed',
        `attachment ${index} declares "${mimeType}"; a ${type} part must be one of ${allowed.join(', ')}`,
        { partIndex: index, mimeType },
      )
    }

    const data = part['data']
    if (typeof data !== 'string' || data === '') {
      throw new ModelAttachmentError(
        'malformed_part',
        `attachment ${index} has no base64 "data" payload`,
        { partIndex: index, mimeType },
      )
    }
    if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      throw new ModelAttachmentError(
        'malformed_part',
        `attachment ${index} "data" is not standard base64`,
        { partIndex: index, mimeType },
      )
    }

    /**
     * Bounded *before* decoding, on the encoded length, which upper-bounds the
     * decoding. See the note above: this is what keeps an oversized attachment
     * from costing a buffer allocation on its way to being refused.
     */
    if (decodedByteLength(data) > MAX_ATTACHMENT_BYTES) {
      throw new ModelAttachmentError(
        'payload_too_large',
        `attachment ${index} is larger than the ${MAX_ATTACHMENT_BYTES} byte per-attachment limit`,
        { partIndex: index, mimeType },
      )
    }

    totalBytes += decodedByteLength(data)
    if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new ModelAttachmentError(
        'message_payload_too_large',
        `a message carries at most ${MAX_MESSAGE_ATTACHMENT_BYTES} bytes of attachments`,
        { partIndex: index, mimeType },
      )
    }

    const filename = part['filename']
    if (filename !== undefined && typeof filename !== 'string') {
      throw new ModelAttachmentError(
        'malformed_part',
        `attachment ${index} has a non-string "filename"`,
        { partIndex: index, mimeType },
      )
    }
    if (typeof filename === 'string' && (filename.trim().length === 0 || filename.length > 255 || Array.from(filename).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\'))) {
      throw new ModelAttachmentError('malformed_part', `attachment ${index} has an invalid filename`, { partIndex: index, mimeType })
    }
    if (type === 'file' && typeof filename !== 'string') {
      throw new ModelAttachmentError(
        'malformed_part',
        `a file attachment requires a "filename"; attachment ${index} has none`,
        { partIndex: index, mimeType },
      )
    }

    validated.push(
      type === 'image'
        ? {
            type: 'image',
            mimeType: mimeType as ImageMimeType,
            data,
            ...(typeof filename === 'string' ? { filename } : {}),
          }
        : {
            type: 'file',
            mimeType: mimeType as FileMimeType,
            data,
            filename: filename as string,
          },
    )
  }

  return validated
}

/** The decoded byte count of a part, for reporting and for budget arithmetic. */
export function attachmentByteLength(attachment: ModelAttachment): number {
  return decodedByteLength(attachment.data)
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

/**
 * One callable text model a provider reports about itself.
 *
 * An id and a label — that is the whole of what crosses back. A catalogue entry
 * is display metadata, never a credential, and never an authorisation: being
 * listed only means the provider would send that id to its own endpoint if the
 * owner selected it.
 */
export interface ModelCatalogEntry {
  id: string
  ownedBy: string | null
}

/** What the gateway hands a catalogue read alongside its nothing-else. */
export interface ModelCatalogOptions {
  signal: AbortSignal
}

export interface ModelProvider {
  readonly id: string
  readonly kind: 'fake' | 'nanogpt' | 'minimax' | 'local' | 'openai'
  /** Whether this provider would spend real money or use a network. */
  readonly live: boolean
  /** Current readiness, for the status projection. */
  status(): ProviderStatus
  /**
   * Whether this provider can serve `model` as it now knows it.
   *
   * Optional: a provider with no catalogue answers through its own configured
   * model alone, which is what the gateway falls back to. A provider that does
   * list a catalogue must answer honestly — `true` only for ids it would
   * actually send to the endpoint, never for "probably".
   */
  servesModel?(model: string): boolean
  /**
   * List the callable text models this provider can serve.
   *
   * Optional and command-triggered only: nothing calls it on boot, on a timer,
   * or when idle. A provider without one simply has no catalogue beyond its own
   * configured model. Metadata about model ids is not inference and costs
   * nothing, but it is still a network read, so it is cancellable like every
   * other call this interface makes.
   */
  listModels?(options: ModelCatalogOptions): Promise<readonly ModelCatalogEntry[]>
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
 *
 * ### What a non-text part contributes
 *
 * A placeholder line, and nothing else. An image's pixels and a PDF's bytes are
 * **not** decoded into the flattened string — base64 is not a rendering, and
 * inlining four megabytes of it would produce a prompt that reads as noise to a
 * single-prompt provider while costing the same as sending the image properly.
 *
 * The placeholder names the part, its declared type and its decoded size, and
 * says in the text itself that the content was not included. That last part is
 * the point: a marker like `[image: 2100000 bytes]` would leave a downstream
 * model believing it had been shown the picture. `[image content not included]`
 * is a claim it can actually act on. A provider that wants the real pixels
 * should be reading `ModelRequest.messages`, which is what the wire form does.
 *
 * A message with no attachments flattens to exactly what it always did.
 */
export function flattenMessages(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) => {
      const attachments = validateModelAttachments(message.attachments)
      const body =
        attachments.length === 0
          ? message.content
          : `${message.content}${message.content === '' ? '' : '\n'}${describeAttachments(attachments)}`
      return message.role === 'user' ? body : `[${message.role}] ${body}`
    })
    .join('\n\n')
}

/** The one line per attachment that stands in for the payload in a flattened prompt. */
function describeAttachments(attachments: readonly ModelAttachment[]): string {
  return attachments
    .map((attachment) => {
      const bytes = `${attachmentByteLength(attachment)} bytes`
      return attachment.type === 'image'
        ? `[image content not included: ${attachment.mimeType}, ${bytes}]`
        : `[file content not included: ${attachment.mimeType}, ${attachment.filename}, ${bytes}]`
    })
    .join('\n')
}
