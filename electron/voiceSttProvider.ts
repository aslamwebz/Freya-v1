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
 * NanoGPT-backed STT, main-process only.
 *
 * The destination is fixed in code. A renderer can choose a model from a bounded
 * id field, but it can never choose where the existing NanoGPT credential is sent.
 */
export const NANOGPT_TRANSCRIPTIONS_URL = 'https://nano-gpt.com/api/v1/audio/transcriptions'
export const DEFAULT_REMOTE_STT_MODEL = 'Whisper-Large-V3'

const MAX_PROVIDER_RESPONSE_CHARS = 64 * 1024
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,160}$/

type FetchLike = typeof fetch

export interface VoiceSttRuntimeConfig {
  readonly provider: 'off' | 'nanogpt'
  readonly model: string
  readonly remoteEnabled: boolean
}

/**
 * Stable adapter object for the lifetime of Electron.
 *
 * VoiceService keeps the adapter reference it was constructed with. Settings can
 * therefore change provider/model without swapping a privileged object out from
 * under Core: the host updates this delegate, and Core keeps talking to the same
 * narrow port.
 */
export class ConfigurableVoiceSttAdapter implements VoiceSttAdapter {
  private delegate: VoiceSttAdapter

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    config: VoiceSttRuntimeConfig = {
      provider: 'off',
      model: DEFAULT_REMOTE_STT_MODEL,
      remoteEnabled: false,
    },
    private readonly transport: FetchLike = fetch,
  ) {
    this.delegate = createVoiceStt(config, env, transport)
  }

  configure(config: VoiceSttRuntimeConfig): void {
    this.delegate = createVoiceStt(config, this.env, this.transport)
  }

  get id(): string { return this.delegate.id }
  get kind(): VoiceSttAdapter['kind'] { return this.delegate.kind }
  get availability(): VoiceSttAdapter['availability'] { return this.delegate.availability }
  get detail(): string { return this.delegate.detail }
  get streaming(): boolean { return this.delegate.streaming }

  transcribe(request: SttRequest): Promise<SttResult> {
    return this.delegate.transcribe(request)
  }

  stream(
    request: SttRequest,
    onFragment: (fragment: { kind: 'interim' | 'final'; text: string }) => void,
  ): Promise<SttResult> {
    if (!this.delegate.streaming || typeof this.delegate.stream !== 'function') {
      return this.delegate.transcribe(request)
    }
    return this.delegate.stream(request, onFragment)
  }
}

/**
 * Build the speech-input adapter from trusted host configuration.
 *
 * Voice has a separate spend/privacy switch from Chat. Merely configuring NanoGPT
 * for cognition never causes microphone audio to leave the device.
 */
export function createVoiceStt(
  config: VoiceSttRuntimeConfig,
  env: NodeJS.ProcessEnv,
  transport: FetchLike = fetch,
): VoiceSttAdapter {
  if (config.provider === 'off') {
    return unavailable(
      'voice-stt-off',
      'Speech recognition is off. Microphone audio stays on this device.',
    )
  }
  if (!config.remoteEnabled) {
    return unavailable(
      'remote-stt-disabled',
      'NanoGPT speech recognition is selected but remote speech is not enabled. Audio stays on this device.',
    )
  }

  const apiKey = (env.NANOGPT_API_KEY ?? '').trim()
  if (apiKey === '') {
    return unavailable(
      'nanogpt-stt-unconfigured',
      'NanoGPT speech recognition is selected, but the NanoGPT API key is not configured. The recording will not be sent anywhere.',
    )
  }

  const model = (config.model || DEFAULT_REMOTE_STT_MODEL).trim()
  if (!MODEL_ID.test(model)) {
    return unavailable(
      'nanogpt-stt-invalid-model',
      'The speech-recognition model id is invalid. Choose a valid NanoGPT audio model.',
    )
  }

  return new NanoGptSttAdapter({ apiKey, model, transport })
}

/** Backwards-compatible environment construction used by tests and headless probes. */
export function createVoiceSttFromEnv(
  env: NodeJS.ProcessEnv,
  transport: FetchLike = fetch,
): VoiceSttAdapter {
  return createVoiceStt(
    {
      provider: env.FREYA_STT_PROVIDER === 'off' ? 'off' : 'nanogpt',
      model: env.FREYA_STT_MODEL ?? DEFAULT_REMOTE_STT_MODEL,
      remoteEnabled: env.FREYA_ALLOW_REMOTE_STT === '1',
    },
    env,
    transport,
  )
}

function unavailable(id: string, detail: string): VoiceSttAdapter {
  return new UnavailableSttAdapter({
    id,
    kind: 'provider',
    availability: 'configuration-required',
    detail,
  })
}

export interface NanoGptSttAdapterOptions {
  readonly apiKey: string
  readonly model?: string
  readonly transport?: FetchLike
}

/**
 * OpenAI-compatible multipart transcription over NanoGPT.
 *
 * Input is already-validated PCM. It is wrapped as an in-memory WAV for the
 * request body; no temporary audio file, transcript, key or provider response
 * body is written to disk or to the Core journal.
 */
export class NanoGptSttAdapter implements VoiceSttAdapter {
  readonly id = 'nanogpt-stt'
  readonly kind = 'provider' as const
  readonly availability = 'available' as const
  readonly streaming = false
  readonly detail: string

  private readonly apiKey: string
  private readonly model: string
  private readonly transport: FetchLike

  constructor(options: NanoGptSttAdapterOptions) {
    const apiKey = options.apiKey.trim()
    if (apiKey === '') throw new Error('speech provider API key is empty')

    const model = (options.model ?? DEFAULT_REMOTE_STT_MODEL).trim()
    if (!MODEL_ID.test(model)) throw new Error('speech provider model id is invalid')

    this.apiKey = apiKey
    this.model = model
    this.transport = options.transport ?? fetch
    this.detail =
      `NanoGPT speech recognition is ready with ${model}. Audio leaves this device only for an explicitly authorised transcription.`
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

    const response = await this.transport(NANOGPT_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
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

    return { text, engine: `nanogpt/${this.model}` }
  }
}

/** Wrap PCM-S16LE in a standard WAV container, entirely in memory. */
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

  const output = new Uint8Array(44 + audio.bytes.byteLength)
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
  output.set(audio.bytes, 44)
  return output
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index)
  }
}
