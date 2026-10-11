import {
  IMAGE_MIME_TYPES,
  type ImageMimeType,
  FILE_MIME_TYPES,
  type FileMimeType,
  type ModelAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type ModelMessage,
  type ModelRequest,
  type ModelFinishReason,
  TRUNCATION_FINISH_REASON,
  type ModelResult,
  type ModelCatalogEntry,
} from '../../shared/contracts/model'
export {
  IMAGE_MIME_TYPES,
  FILE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  TRUNCATION_FINISH_REASON,
} from '../../shared/contracts/model'
export type {
  ModelMessageRole,
  ImageMimeType,
  FileMimeType,
  ModelTextPart,
  ModelImagePart,
  ModelFilePart,
  ModelContentPart,
  ModelAttachment,
  ModelMessage,
  ModelRequest,
  ModelFinishReason,
  ModelResult,
  ModelCatalogEntry,
} from '../../shared/contracts/model'
import type { ProviderStatus } from '../../shared/contracts/model'

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

export function readReasoningEfforts(raw: unknown): readonly string[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const capabilities = record.capabilities as { reasoning?: { efforts?: unknown } } | undefined
  const value = record.reasoning_efforts ?? record.supported_reasoning_efforts ?? capabilities?.reasoning?.efforts
  if (!Array.isArray(value)) return undefined
  const efforts = value.filter((item): item is string => typeof item === 'string' && /^[a-z0-9_-]{1,32}$/i.test(item))
  return [...new Set(efforts)].slice(0, 16)
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
