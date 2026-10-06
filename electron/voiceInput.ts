import type { VoiceSettings } from '../core/voice/settings'
import type { CapturedAudio, SttRequest, SttResult, VoiceSttAdapter } from '../core/voice/types'
import { VOICE_LIMITS } from '../core/voice/types'
import { SttUnavailableError } from '../core/voice/stt'

/** PCM is a wire format, not an upload container. Make a bounded WAV in memory. */
export function pcmWav(audio: CapturedAudio): Uint8Array<ArrayBuffer> {
  if (audio.bytes.length > VOICE_LIMITS.maxAudioBytes || audio.bytes.length % 2) throw new Error('Invalid bounded PCM audio.')
  const wav = new Uint8Array(44 + audio.bytes.length)
  const view = new DataView(wav.buffer)
  const label = (offset: number, text: string): void => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i) }
  label(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, audio.channels, true)
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * audio.channels * 2, true)
  view.setUint16(32, audio.channels * 2, true); view.setUint16(34, 16, true); label(36, 'data')
  view.setUint32(40, audio.bytes.length, true); wav.set(audio.bytes, 44)
  return wav
}

export async function boundedVoiceResponse(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw new Error(`Speech provider returned HTTP ${response.status}.`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Speech provider returned no content.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('Speech provider response exceeded the limit.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export class HostVoiceInput implements VoiceSttAdapter {
  readonly streaming = false
  get id(): string { return this.settings().inputProvider }
  get kind(): 'provider' | 'local' { return this.settings().inputProvider === 'nanogpt' ? 'provider' : 'local' }
  get availability(): 'available' | 'configuration-required' {
    return (this.kind === 'local' ? this.localReady() : this.settings().remoteAudioEnabled && !!this.key()) ? 'available' : 'configuration-required'
  }
  get detail(): string {
    if (this.kind === 'local') return this.localReady() ? 'Local Whisper Base English on CPU, loaded when you speak. Audio stays on this machine.' : 'Local Whisper is not installed.'
    return !this.settings().remoteAudioEnabled ? 'NanoGPT speech recognition requires remote-audio opt-in.' : !this.key() ? 'Configure the protected NanoGPT key in Provider settings.' : 'Short speech recordings are sent to NanoGPT. No audio is stored by Freya.'
  }
  constructor(private readonly settings: () => VoiceSettings, private readonly key: () => string | undefined, private readonly fetchImpl: typeof fetch = fetch, private readonly localReady: () => boolean = () => true) {}

  async transcribe(request: SttRequest): Promise<SttResult> {
    const config = this.settings()
    const local = config.inputProvider === 'local-whisper'
    if (!local && !config.remoteAudioEnabled) throw new SttUnavailableError('configuration-required', 'Remote audio consent is required; opt in before transcription.')
    if (!local && !this.key()) throw new SttUnavailableError('configuration-required', 'No protected NanoGPT credential is configured.')
    request.signal.throwIfAborted()
    const body = new FormData()
    body.set('file', new Blob([pcmWav(request.audio)], { type: 'audio/wav' }), 'utterance.wav')
    if (!local) body.set('model', config.inputModel)
    else { body.set('language', 'en'); body.set('temperature', '0.0'); body.set('temperature_inc', '0.0') }
    body.set('response_format', local ? 'verbose_json' : 'json')
    try {
      const response = await this.fetchImpl(local ? 'http://127.0.0.1:8080/inference' : 'https://nano-gpt.com/api/v1/audio/transcriptions', {
        method: 'POST', body, redirect: 'error', signal: request.signal,
        headers: local ? {} : { Authorization: `Bearer ${this.key()}` },
      })
      const bytes = await boundedVoiceResponse(response, 64 * 1024)
      request.signal.throwIfAborted()
      const result: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (!result || typeof result !== 'object' || typeof (result as { text?: unknown }).text !== 'string') throw new Error('Speech provider returned no transcript.')
      const recognized = result as { text: string; segments?: { text?: unknown; no_speech_prob?: unknown; avg_logprob?: unknown }[] }
      const text = local && Array.isArray(recognized.segments)
        ? recognized.segments.filter(segment => typeof segment.text === 'string' && typeof segment.no_speech_prob === 'number' && segment.no_speech_prob < 0.6 && typeof segment.avg_logprob === 'number' && segment.avg_logprob >= -1).map(segment => segment.text as string).join('').trim()
        : recognized.text
      return { text: text.slice(0, VOICE_LIMITS.maxTranscriptCharacters), engine: config.inputProvider }
    } catch (error) {
      if (request.signal.aborted) throw new Error('Transcription cancelled.', { cause: error })
      // Never echo provider response bodies or exception strings containing secrets.
      if (error instanceof Error && /^Speech provider /.test(error.message)) throw error
      throw new Error(local ? 'Local recognition failed. Start the whisper.cpp server on port 8080.' : 'NanoGPT recognition failed. Check the connection, selected speech model and provider key.', { cause: error })
    }
  }
}



