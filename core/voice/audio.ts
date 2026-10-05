import {
  VOICE_CHANNEL_COUNTS,
  VOICE_CODECS,
  VOICE_FORMAT,
  VOICE_LIMITS,
  VOICE_MIME_TYPES,
  VOICE_SAMPLE_RATES,
  type CapturedAudio,
  type VoiceEndReason,
} from './types'

/**
 * The audio edge.
 *
 * Everything a capture can claim about itself passes through here before a single
 * sample reaches an engine. The function is total and synchronous on purpose: an
 * unbounded buffer that is *checked* somewhere downstream has, by the time it is
 * checked, already been allocated.
 *
 * ## What it refuses, and why each refusal is separate
 *
 * - **Codec and MIME outside the allowlist.** A closed list, because "let the
 *   caller declare its own codec" is a request buffer wearing a label. Anything
 *   compressed would need a decoder, and a decoder in the trusted half is a new
 *   parser for attacker-shaped bytes.
 * - **Sample rate or channel count outside the declared sets.** A declaration of
 *   1 Hz or 64 channels is malformed, not eccentric, and a resampler asked to
 *   honour it will happily allocate.
 * - **Numbers that are not finite non-negative integers.** `NaN`, `Infinity`,
 *   `-1` and `1e400` all pass a naive `>= 0` check somewhere and then produce a
 *   nonsense duration downstream.
 * - **Bytes over the ceiling, or frames that disagree with the bytes.** Two
 *   independent ceilings, because an attacker controls the metadata as well as
 *   the payload and a byte count alone is defeated by claiming more frames than
 *   the buffer holds.
 * - **Duration over the ceiling.** So a capture cannot sit open for an afternoon
 *   while reporting a small buffer.
 *
 * A refusal is a `VoiceEndReason` rather than an exception, because "your
 * recording was too large" is something the window has to be able to *say*.
 */

/** The outcome of validating a capture payload. */
export type AudioValidation =
  | { ok: true; audio: CapturedAudio; frames: number }
  | { ok: false; reason: Extract<VoiceEndReason, 'malformed' | 'too-large' | 'too-long' | 'unsupported'>; detail: string }

/** The maximum sample frames any capture may declare, derived from the byte ceiling. */
export const MAX_AUDIO_FRAMES = Math.floor(
  VOICE_LIMITS.maxAudioBytes / (VOICE_LIMITS.bytesPerSample * VOICE_LIMITS.channels),
)

/**
 * A finite, non-negative, whole number.
 *
 * `Number.isInteger` rejects `NaN`, `Infinity` and `-0` handling is fine, and the
 * upper bound is applied by the caller because the ceiling differs per field.
 */
function isBoundedCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

/**
 * Validate a capture payload and normalise it into `CapturedAudio`.
 *
 * The input is `unknown` on purpose. The caller is a host bridge that received
 * this over IPC from a renderer, and typing the parameter as `CapturedAudio`
 * would be a claim about data this process has not looked at.
 *
 * `declared` carries whatever the sender *said*; `bytes` is the array that
 * actually arrived. They are validated against each other, so a payload cannot
 * pass by describing itself as something small.
 */
export function validateAudio(input: unknown): AudioValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return malformed('the audio payload is not an object')
  }
  const record = input as Record<string, unknown>

  // The only acceptable container. A plain object that happens to carry a
  // `length` is still refused, because nothing downstream would read it.
  const bytes = record.bytes
  if (!(bytes instanceof Uint8Array)) {
    return malformed('the audio payload is not a byte buffer')
  }

  const format = record.format ?? VOICE_FORMAT
  if (format !== VOICE_FORMAT) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `Only ${VOICE_FORMAT} audio is accepted, and this capture declared ${String(format)}.`,
    }
  }

  const codec = record.codec ?? 'pcm_s16le'
  if (typeof codec !== 'string' || !VOICE_CODECS.has(codec)) {
    return malformed('the audio codec is not one this build accepts')
  }

  const mimeType = record.mimeType ?? 'audio/pcm'
  if (typeof mimeType !== 'string' || !VOICE_MIME_TYPES.has(mimeType.toLowerCase())) {
    return malformed('the audio container type is not one this build accepts')
  }

  const sampleRate = record.sampleRate ?? VOICE_LIMITS.sampleRate
  if (!isBoundedCount(sampleRate) || !VOICE_SAMPLE_RATES.has(sampleRate)) {
    return malformed('the declared sample rate is not one this build accepts')
  }

  const channels = record.channels ?? VOICE_LIMITS.channels
  if (!isBoundedCount(channels) || !VOICE_CHANNEL_COUNTS.has(channels)) {
    return malformed('the declared channel count is not one this build accepts')
  }

  const durationMs = record.durationMs ?? 0
  if (!isBoundedCount(durationMs)) {
    return malformed('the reported duration is not a valid measurement')
  }

  const declaredBytes = record.byteLength ?? bytes.byteLength
  if (!isBoundedCount(declaredBytes)) {
    return malformed('the reported byte length is not a valid measurement')
  }
  if (declaredBytes !== bytes.byteLength) {
    // A mismatch means the sender is either confused or lying about its own
    // payload. Either way the arithmetic below would not describe this buffer.
    return malformed('the reported byte length does not describe the audio that arrived')
  }

  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'malformed', detail: 'Nothing was recorded.' }
  }

  if (bytes.byteLength > VOICE_LIMITS.maxAudioBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `That recording is larger than the ${Math.round(VOICE_LIMITS.maxAudioBytes / 1024 / 1024)}MB limit, so it was discarded.`,
    }
  }

  if (durationMs > VOICE_LIMITS.maxDurationMs) {
    return {
      ok: false,
      reason: 'too-long',
      detail: `That recording is longer than the ${Math.round(VOICE_LIMITS.maxDurationMs / 1000)}s limit, so it was discarded.`,
    }
  }

  // Frames derived from the buffer rather than trusted from the payload. An odd
  // length cannot be whole 16-bit samples, so it is malformed rather than padded:
  // padding would silently shift every sample boundary by one byte.
  if (bytes.byteLength % (VOICE_LIMITS.bytesPerSample * channels) !== 0) {
    return malformed('the audio buffer is not a whole number of 16-bit sample frames')
  }
  const frames = Math.floor(bytes.byteLength / (VOICE_LIMITS.bytesPerSample * channels))
  if (frames === 0) {
    return malformed('the audio buffer is too short to hold a sample frame')
  }
  if (frames > MAX_AUDIO_FRAMES) {
    return {
      ok: false,
      reason: 'too-large',
      detail: 'That recording has more sample frames than this build accepts, so it was discarded.',
    }
  }

  // A duration that cannot be produced by this buffer at this sample rate is a
  // forged measurement. Checked last so the cheap refusals fire first.
  const maxPossibleMs = (frames / sampleRate) * 1000
  if (durationMs > maxPossibleMs + 1) {
    return malformed('the reported duration is longer than the audio that arrived could be')
  }

  return { ok: true, frames, audio: { format: VOICE_FORMAT, sampleRate, channels, bytes, durationMs } }
}

function malformed(detail: string): AudioValidation {
  return { ok: false, reason: 'malformed', detail }
}

/**
 * Clip text to a ceiling without cutting a surrogate pair in half.
 *
 * `slice` alone will happily end on a lone high surrogate, and the result is a
 * string that renders as a replacement character in the middle of a sentence. Not
 * a security problem, but it is the kind of artefact that makes a transcript look
 * corrupt when it is merely long.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}