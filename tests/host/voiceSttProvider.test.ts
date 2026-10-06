// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_STT_MODEL,
  NANOGPT_TRANSCRIPTIONS_URL,
  NanoGptSttAdapter,
  createVoiceSttFromEnv,
  pcmToWav,
} from '../../electron/voiceSttProvider'
import type { CapturedAudio, SttRequest } from '../../core/voice/types'

function audio(bytes = new Uint8Array([0, 0, 1, 0])): CapturedAudio {
  return {
    format: 'pcm-s16le',
    sampleRate: 16_000,
    channels: 1,
    bytes,
    durationMs: bytes.byteLength / 2 / 16_000 * 1000,
  }
}

function request(sample = audio(), signal = new AbortController().signal): SttRequest {
  return {
    sessionId: 'voice-session-1',
    audio: sample,
    signal,
    timeoutMs: 10_000,
  }
}

describe('hosted voice STT', () => {
  it('is opt-in even when a credential already exists', () => {
    const adapter = createVoiceSttFromEnv({ NANOGPT_API_KEY: 'secret' })
    expect(adapter.kind).toBe('provider')
    expect(adapter.availability).toBe('configuration-required')
    expect(adapter.detail).toContain('Audio stays on this device')
  })

  it('refuses truthfully when enabled without a credential', () => {
    const adapter = createVoiceSttFromEnv({ FREYA_ALLOW_REMOTE_STT: '1' })
    expect(adapter.availability).toBe('configuration-required')
    expect(adapter.detail).toContain('NANOGPT_API_KEY')
  })

  it('uses a bounded default paid transcription model', () => {
    const adapter = createVoiceSttFromEnv({
      FREYA_ALLOW_REMOTE_STT: '1',
      NANOGPT_API_KEY: 'secret',
    })
    expect(adapter).toBeInstanceOf(NanoGptSttAdapter)
    expect(adapter.availability).toBe('available')
    expect(adapter.detail).toContain(DEFAULT_REMOTE_STT_MODEL)
    expect(adapter.detail).not.toContain('secret')
  })

  it('refuses an invalid model id before any network request exists', () => {
    const adapter = createVoiceSttFromEnv({
      FREYA_ALLOW_REMOTE_STT: '1',
      NANOGPT_API_KEY: 'secret',
      FREYA_STT_MODEL: 'bad model with spaces',
    })
    expect(adapter.availability).toBe('configuration-required')
  })

  it('sends an in-memory WAV to the one fixed endpoint and returns only text', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const transport: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      seenInit = init
      return new Response(JSON.stringify({ text: 'hello Freya' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const adapter = new NanoGptSttAdapter({
      apiKey: 'top-secret',
      model: 'Whisper-Large-V3',
      transport,
    })
    const result = await adapter.transcribe(request())

    expect(seenUrl).toBe(NANOGPT_TRANSCRIPTIONS_URL)
    expect(seenInit?.method).toBe('POST')
    expect(seenInit?.redirect).toBe('error')
    const headers = new Headers(seenInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer top-secret')

    const form = seenInit?.body
    expect(form).toBeInstanceOf(FormData)
    const data = form as FormData
    expect(data.get('model')).toBe('Whisper-Large-V3')
    const file = data.get('file')
    expect(file).not.toBeNull()
    expect(typeof file).not.toBe('string')
    const wav = new Uint8Array(await (file as Blob).arrayBuffer())
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE')
    expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe('data')

    expect(result).toEqual({
      text: 'hello Freya',
      engine: 'openai/Whisper-Large-V3',
    })
  })

  it('never includes the credential in provider failures', async () => {
    const adapter = new NanoGptSttAdapter({
      apiKey: 'never-print-me',
      transport: async () => new Response('denied', { status: 401 }),
    })
    let message = ''
    try {
      await adapter.transcribe(request())
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('401')
    expect(message).not.toContain('never-print-me')
    expect(message).not.toContain('denied')
  })

  it('honours cancellation before a byte can leave the process', async () => {
    let calls = 0
    const adapter = new NanoGptSttAdapter({
      apiKey: 'secret',
      transport: async () => {
        calls += 1
        return new Response(JSON.stringify({ text: 'should not happen' }), { status: 200 })
      },
    })
    const controller = new AbortController()
    controller.abort(new Error('STOP ALL'))
    await expect(adapter.transcribe(request(audio(), controller.signal))).rejects.toThrow('STOP ALL')
    expect(calls).toBe(0)
  })

  it('builds a valid PCM WAV header without changing the samples', () => {
    const samples = new Uint8Array([1, 2, 3, 4])
    const wav = pcmToWav(audio(samples))
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(samples.byteLength)
    expect([...wav.subarray(44)]).toEqual([...samples])
  })
})
