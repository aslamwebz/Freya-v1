import { UnavailableSttAdapter } from '../core/voice/stt'
import {
  VOICE_FORMAT,
  VOICE_LIMITS,
  type CapturedAudio,
  type SttRequest,
  type SttResult,
  type VoiceSttAdapter,
} from '../core/voice/types'

/**
 * Hosted STT is deliberately a main-process-only adapter.
 *
 * The destination is fixed in code rather than supplied by a renderer or a
 * settings field. The API key is attached only to this exact HTTPS endpoint, so
 * enabling speech recognition cannot become a credential-forwarding primitive.
 */
export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'
export const DEFAULT_REMOTE_STT_MODEL = 'gpt-4o-mini-transcribe'

const MAX_PROVIDER_RESPONSE_CHARS = 64 * 1024
const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/

type FetchLike = typeof fetch

/**
 * Build the production speech-input adapter from main-process environment.
 *
 * Remote STT is opt-in even when a key is present. Until both the explicit switch
 * and a credential exist, this returns an honest unavailable adapter and audio
 * never leaves the machine.
 */
export function createVoiceSttFromEnv(
  env: NodeJS.ProcessEnv,
  transport: FetchLike = fetch,
): VoiceSttAdapter {
  if (env.FREYA_ALLOW_REMOTE_STT !== '1') {
    return new UnavailableSttAdapter({
      id: 'remote-stt-disabled',
      kind: 'provider',
      availability: 'configuration-required',
      detail:
        'Hosted speech recognition is off. Audio stays on this device. Set FREYA_ALLOW_REMOTE_STT=1 and provide OPENAI_API_KEY to opt in.',
    })
  }

  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  if (apiKey === '') {
    return new UnavailableSttAdapter({
      id: 'openai-stt-unconfigured',
      kind: 'provider',
      availability: 'configuration-required',
      detail:
        'Hosted speech recognition is enabled, but OPENAI_API_KEY is not configured. The recording will not be sent anywhere.',
    })
  }

  const model = (env.FREYA_STT_MODEL ?? DEFAULT_REMOTE_STT_MODEL).trim()
  if (!MODEL_ID.test(model)) {
    return new UnavailableSttAdapter({
      id: 'openai-stt-invalid-model',
      kind: 'provider',
      availability: 'configuration-required',
      detail:
        'The speech-recognition model id is invalid. Use a bounded provider model id before enabling transcription.',
    })
  }

  return new OpenAiSttAdapter({ apiKey, model, transport })
}

export interface OpenAiSttAdapterOptions {
  readonly apiKey: string
  readonly model?: string
  readonly transport?: FetchLike
}

/**
 * OpenAI-compatible audio transcription using the fixed OpenAI endpoint.
 *
 * Input is the already-validated PCM held by VoiceService. It is wrapped as an
 * in-memory WAV only for the request body: no temporary file is written and no
 * audio or transcript is logged here.
 */
export class OpenAiSttAdapter implements VoiceSttAdapter {
  readonly id = 'openai-stt'
  readonly kind = 'provider' as const
  readonly availability = 'available' as const
  readonly streaming = false
  readonly detail: string

  private readonly apiKey: string
  private readonly model: string
  private readonly transport: FetchLike

  constructor(options: OpenAiSttAdapterOptions) {
    const apiKey = options.apiKey.trim()
    if (apiKey === '') throw new Error('speech provider API key is empty')

    const model = (options.model ?? DEFAULT_REMOTE_STT_MODEL).trim()
    if (!MODEL_ID.test(model)) throw new Error('speech provider model id is invalid')

    this.apiKey = apiKey
    this.model = model
    this.transport = options.transport ?? fetch
    this.detail =
      `Hosted speech recognition is ready with ${model}. Audio leaves this device only after an explicit capture is released for transcription.`
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (request.signal.aborted) {
      throw request.signal.reason ?? new Error('the transcription was cancelled')
    }

    const wav = pcmToWav(request.audio)
    const form = new FormData()
    form.set('model', this.model)
    const fileBytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
    form.set('file', new Blob([fileBytes], { type: 'audio/wav' }), 'freya-capture.wav')

    const response = await this.transport(OPENAI_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
      signal: request.signal,
      redirect: 'error',
    })

    if (!response.ok) {
      throw new Error(`speech provider responded ${response.status}`)
    }

    const raw = await response.text()
    if (raw.length > MAX_PROVIDER_RESPONSE_CHARS) {
      throw new Error('speech provider response exceeded the bounded response size')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('speech provider returned invalid JSON')
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('speech provider returned an invalid transcription envelope')
    }

    const text = (parsed as Record<string, unknown>).text
    if (typeof text !== 'string') {
      throw new Error('speech provider response did not contain transcription text')
    }

    return {
      text,
      engine: `openai/${this.model}`,
    }
  }
}

/**
 * Wrap validated PCM-S16LE in the smallest standard WAV container accepted by
 * hosted transcription APIs. The returned bytes exist in memory only.
 */
export function pcmToWav(audio: CapturedAudio): Uint8Array {
  if (audio.format !== VOICE_FORMAT) throw new Error('speech audio must be pcm-s16le')
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new Error('speech audio sample rate is invalid')
  }
  if (!Number.isInteger(audio.channels) || (audio.channels !== 1 && audio.channels !== 2)) {
    throw new Error('speech audio channel count is invalid')
  }
  if (audio.bytes.byteLength === 0 || audio.bytes.byteLength > VOICE_LIMITS.maxAudioBytes) {
    throw new Error('speech audio byte length is invalid')
  }

  const blockAlign = audio.channels * VOICE_LIMITS.bytesPerSample
  if (audio.bytes.byteLength % blockAlign !== 0) {
    throw new Error('speech audio is not aligned to whole PCM frames')
  }

  const headerBytes = 44
  const output = new Uint8Array(headerBytes + audio.bytes.byteLength)
  const view = new DataView(output.buffer)

  writeAscii(output, 0, 'RIFF')
  view.setUint32(4, 36 + audio.bytes.byteLength, true)
  writeAscii(output, 8, 'WAVE')
  writeAscii(output, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, audio.channels, true)
  view.setUint32(24, audio.sampleRate, true)
  view.setUint32(28, audio.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(output, 36, 'data')
  view.setUint32(40, audio.bytes.byteLength, true)
  output.set(audio.bytes, headerBytes)

  return output
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index)
  }
}
