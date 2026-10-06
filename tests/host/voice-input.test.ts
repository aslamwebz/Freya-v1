// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HostVoiceInput } from '../../electron/voiceInput'
import { DEFAULT_VOICE_SETTINGS } from '../../core/voice/settings'

describe('production speech recognition', () => {
  it('sends no audio without explicit consent', async () => {
    let uploads = 0
    const adapter = new HostVoiceInput(() => DEFAULT_VOICE_SETTINGS, () => 'secret', async () => { uploads++; throw new Error('network') })
    await expect(adapter.transcribe({ sessionId: 's', audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1, bytes: new Uint8Array(3200), durationMs: 100 }, signal: new AbortController().signal, timeoutMs: 20000 })).rejects.toThrow(/consent|opt.in/i)
    expect(uploads).toBe(0)
  })
  it('converts bounded PCM to WAV and uses the independent STT model', async () => {
    const adapter = new HostVoiceInput(() => ({ ...DEFAULT_VOICE_SETTINGS, remoteAudioEnabled: true }), () => 'protected', async (url, init) => {
      expect(url).toBe('https://nano-gpt.com/api/v1/audio/transcriptions')
      expect(init?.redirect).toBe('error')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer protected')
      const body = init?.body as FormData
      expect(body.get('model')).toBe('Whisper-Large-V3')
      const wav = new Uint8Array(await (body.get('file') as Blob).arrayBuffer())
      expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
      expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000)
      expect(wav.byteLength).toBe(3244)
      return new Response(JSON.stringify({ text: 'Freya, hello' }))
    })
    const result = await adapter.transcribe({ sessionId: 's', audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1, bytes: new Uint8Array(3200), durationMs: 100 }, signal: new AbortController().signal, timeoutMs: 20000 })
    expect(result.text).toBe('Freya, hello')
  })
})

it('keeps local audio on loopback and discards uncertain noise segments', async () => {
  const adapter = new HostVoiceInput(() => ({ ...DEFAULT_VOICE_SETTINGS, inputProvider: 'local-whisper' }), () => 'must-not-send', async (url, init) => {
    expect(url).toBe('http://127.0.0.1:8080/inference')
    expect(init?.headers).toEqual({})
    expect((init?.body as FormData).get('response_format')).toBe('verbose_json')
    return new Response(JSON.stringify({ text: 'Thanks for watching!', segments: [{text:'Thanks for watching!',no_speech_prob:0.85,avg_logprob:-0.2}] }))
  })
  const result = await adapter.transcribe({ sessionId: 's', audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1, bytes: new Uint8Array(3200), durationMs: 100 }, signal: new AbortController().signal, timeoutMs: 20000 })
  expect(result.text).toBe('')
})
