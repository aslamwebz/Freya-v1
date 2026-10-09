// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createVoiceSttFromEnv } from '../../electron/voiceSttProvider'
import type { CapturedAudio } from '../../core/voice/types'

const live = process.env.FREYA_STT_LIVE === '1'

describe.skipIf(!live)('live hosted speech recognition', () => {
  it('reaches the configured paid transcription provider with a bounded WAV', async () => {
    const adapter = createVoiceSttFromEnv(process.env)
    expect(adapter.availability, adapter.detail).toBe('available')

    // One second of silence is enough to prove the real transport, multipart body,
    // authentication and provider response path without checking a changing model's
    // interpretation of speech. Physical-microphone recognition remains a desktop
    // acceptance test because GitHub runners do not have the owner's microphone.
    const sample: CapturedAudio = {
      format: 'pcm-s16le',
      sampleRate: 16_000,
      channels: 1,
      bytes: new Uint8Array(16_000 * 2),
      durationMs: 1_000,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('live STT probe timed out')), 60_000)
    try {
      const result = await adapter.transcribe({
        sessionId: 'live-stt-probe',
        audio: sample,
        signal: controller.signal,
        timeoutMs: 60_000,
      })
      expect(result.engine).toMatch(/^openai\//)
      expect(typeof result.text).toBe('string')
    } finally {
      clearTimeout(timer)
    }
  }, 90_000)
})
