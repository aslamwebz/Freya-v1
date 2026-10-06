import type { VoiceProjection } from '../../../core/protocol/conversation'
import type { CoreOptions } from '../../../core/index'
import type { SttRequest, VoiceSttAdapter, VoiceTtsAdapter, TtsRequest, VoiceOption } from '../../../core/voice/types'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Voice test fixtures.
 *
 * Two things live here rather than in each test file, and both are there so a
 * test cannot quietly depend on the wrong shape:
 *
 * 1. **A whole `VoiceProjection`.** The projection has thirteen fields and every
 *    one of them is a claim somebody could make to a user. Building one by hand in
 *    each test means a test that forgets `wake.armed` is not testing what it thinks
 *    it is testing.
 * 2. **Adapters that announce themselves.** `stand-in-stt` and `stand-in-tts`
 *    contain the substring every status line already looks for, so a test can
 *    assert that Core reported a stand-in *as* a stand-in rather than as a real
 *    engine.
 */

export function absentVoiceProjection(overrides: Partial<VoiceProjection> = {}): VoiceProjection {
  return {
    state: 'permission-required',
    micEnabled: false,
    permission: 'unknown',
    permissionRequestOpen: false,
    capturing: false,
    sessionId: null,
    interim: '',
    finalTranscript: null,
    finalTranscriptAt: null,
    lastInterruption: null,
    transcription: {
      available: false,
      engine: null,
      kind: 'local',
      availability: 'configuration-required',
      detail: 'no engine',
    },
    synthesis: {
      available: false,
      engine: null,
      kind: 'platform',
      availability: 'unavailable',
      detail: 'no engine',
    },
    speaking: false,
    queued: 0,
    muted: false,
    selectedVoiceId: null,
    autoSubmit: false,
    autoSpeak: false,
    attention: {
      state: 'standby',
      wakePhrase: 'Freya',
      attentiveUntil: null,
      followUpWindowMs: 45_000,
    },
    wake: {
      armed: false,
      available: false,
      gate: 'none',
      kind: 'speech-activity',
      detail: 'no gate',
      maxArmedMs: 0,
    },
    limits: {
      maxDurationMs: 30_000,
      maxAudioBytes: 4 * 1024 * 1024,
      format: 'pcm-s16le',
      maxTranscriptCharacters: 8_000,
      transcriptionTimeoutMs: 20_000,
    },
    faults: [],
    ...overrides,
  }
}

/** An STT stand-in that returns a fixed final string and reads nothing from audio. */
export class StandInStt implements VoiceSttAdapter {
  readonly id = 'stand-in-stt'
  readonly kind = 'local' as const
  readonly availability = 'available' as const
  readonly detail = 'A stand-in used by tests. It recognises nothing.'
  readonly streaming = false
  calls = 0
  lastRequest: SttRequest | null = null

  constructor(private readonly text = 'a stand-in transcript') {}

  async transcribe(request: SttRequest): Promise<{ text: string; engine: string }> {
    this.calls += 1
    this.lastRequest = request
    if (request.signal.aborted) throw request.signal.reason ?? new Error('cancelled')
    return { text: this.text, engine: this.id }
  }
}

/**
 * A TTS stand-in that records what it was asked to say.
 *
 * `hold` keeps an utterance open until released, which is what makes
 * barge-in testable without a real audio device.
 */
export class StandInTts implements VoiceTtsAdapter {
  readonly id = 'stand-in-tts'
  readonly kind = 'platform' as const
  readonly availability = 'available' as const
  readonly detail = 'A stand-in used by tests. It makes no sound.'
  spoken: { utteranceId: string; text: string; voiceId: string | null }[] = []
  stops = 0
  cancels = 0
  /** Resolve to release a held utterance. */
  release: (() => void) | null = null
  hold = false

  async voices(): Promise<VoiceOption[]> {
    return [
      { voiceId: 'voice-one', label: 'Voice One', language: 'en-GB', isDefault: true },
      { voiceId: 'voice-two', label: 'Voice Two', language: 'en-US', isDefault: false },
    ]
  }

  async speak(request: TtsRequest): Promise<{ engine: string; completed: boolean }> {
    this.spoken.push({ utteranceId: request.utteranceId, text: request.text, voiceId: request.voiceId })
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    if (request.signal.aborted) throw new Error('the utterance was cancelled')
    return { engine: this.id, completed: true }
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.hold = false
    this.release?.()
    this.release = null
  }

  async cancel(): Promise<void> {
    this.cancels += 1
    this.hold = false
    this.release?.()
    this.release = null
  }
}

/** Core options for a voice test: an in-memory store and no provider credentials. */
export function voiceOptions(dir: string, overrides: Partial<CoreOptions> = {}): CoreOptions {
  return {
    dataPath: join(dir, 'events.jsonl'),
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    ...overrides,
  }
}

export const TEMP_ROOT = (): string => join(tmpdir(), 'freya-voice')