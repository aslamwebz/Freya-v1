// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { FakeVoiceSynthesizer, FakeVoiceTranscriber } from '../../core/voice/service'
import { VOICE_LIMITS, type CapturedAudio, type VoiceTranscriber } from '../../core/voice/types'
import type { VoiceCommandOutcome } from '../../core/protocol/conversation'
import type { ConversationCommandOutcome } from '../../core/protocol/conversation'

/**
 * Voice.
 *
 * Two properties, and they are the whole of it:
 *
 *   1. **Transcription is not cognition.** A microphone produces text and nothing
 *      else. No test in this file can end with a model call caused by audio.
 *   2. **Local only, and honestly so.** With no engine configured the answer is
 *      "unavailable" — never a fallback that reaches a network, and never a
 *      microphone button that looks live and silently does nothing.
 */

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-voice-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function options(overrides: Partial<CoreOptions> = {}): CoreOptions {
  return {
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    ...overrides,
  }
}

async function started(overrides: Partial<CoreOptions> = {}): Promise<Core> {
  const c = createCore(options(overrides))
  core = c
  await c.start()
  return c
}

async function beginCapture(c: Core, requestId = 'v1'): Promise<string> {
  const result = await c.handleCommand({ command: 'voice.capture.start', requestId })
  const voice = result.voice as VoiceCommandOutcome
  if (voice.operation !== 'capture-started') throw new Error('capture did not start')
  return (voice as { sessionId: string }).sessionId
}

async function endCapture(
  c: Core,
  sessionId: string,
  options_: { bytes?: number; durationMs?: number; cancelled?: boolean } = {},
): Promise<VoiceCommandOutcome> {
  const result = await c.handleCommand({
    command: 'voice.capture.end',
    requestId: 'v2',
    payload: {
      sessionId,
      audio: new Uint8Array(options_.bytes ?? 1024),
      durationMs: options_.durationMs ?? 100,
      cancelled: options_.cancelled === true,
    },
  })
  return result.voice as VoiceCommandOutcome
}

describe('A — a capture begins', () => {
  it('opens a session and reports that the microphone is open', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    expect(c.voice().capturing).toBe(false)

    await beginCapture(c)

    // Presence reads `capturing` from here, so this is what makes Freya look like
    // she is listening rather than a local flag the window set for itself.
    const voice = c.voice()
    expect(voice.capturing).toBe(true)
    expect(voice.sessionId).not.toBeNull()
  })

  it('allows only one session at a time', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    await beginCapture(c)
    const second = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v1b' })
    // Two open microphones interleaving is not a state anything can reason about.
    expect(second.ok).toBe(false)
    expect(second.refusal?.reason).toMatch(/already in progress/i)
  })
})

describe('B — a capture ends', () => {
  it('returns a transcript to the composer and spends nothing', async () => {
    const provider = new FakeModelProvider()
    const transcriber = new FakeVoiceTranscriber('what is the weather like')
    const c = await started({ providers: [provider], voiceTranscriber: transcriber })

    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId, { bytes: 2048, durationMs: 250 })

    expect(outcome.operation).toBe('capture-ended')
    expect((outcome as { text: string }).text).toBe('what is the weather like')
    expect(transcriber.calls).toBe(1)
    // The whole point: a transcript, not a turn.
    expect(provider.calls).toBe(0)
    expect(c.status().sessionUsage.calls).toBe(0)
    expect(c.status().durableUsage.calls).toBe(0)
  })

  it('leaves the transcript in the composer rather than sending it', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber('a question') })
    const sessionId = await beginCapture(c)
    await endCapture(c, sessionId)

    // Nothing entered the conversation. A Send is still required, and it is the
    // only thing that can authorise cognition.
    const projection = await c.conversation()
    expect(projection.messages).toEqual([])
    expect(projection.conversations).toEqual([])
  })
})

describe('C — transcription alone', () => {
  it('cannot reach a provider however many times it runs', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceTranscriber: new FakeVoiceTranscriber() })

    for (let i = 0; i < 3; i += 1) {
      const sessionId = await beginCapture(c, `v${i}`)
      await endCapture(c, sessionId)
    }

    expect(provider.calls).toBe(0)
    expect(c.status().activeProviderCalls).toBe(0)
  })

  it('never creates a grant', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    const sessionId = await beginCapture(c)
    await endCapture(c, sessionId)

    // A grant is a division of a finite allowance, and a microphone press is not
    // an authorisation to spend one.
    const { ownerAuthority } = await import('../../core/testing')
    expect(ownerAuthority(c).grants()).toHaveLength(0)
  })
})

describe('D — only an explicit Send reaches the conversation', () => {
  it('runs one turn from typed text after a transcript', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceTranscriber: new FakeVoiceTranscriber('hello') })

    const sessionId = await beginCapture(c)
    const { text } = await endCapture(c, sessionId) as { text: string }
    expect(provider.calls).toBe(0)

    // The user reads it, and sends it.
    const created = await c.handleCommand({ command: 'conversation.create', requestId: 'c0' })
    const conversation = created.conversation as ConversationCommandOutcome
    if (conversation.operation !== 'created') throw new Error('no conversation')
    const turn = await c.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 't1',
      payload: { conversationId: conversation.conversation.conversationId, text: text ?? '' },
    })

    const outcome = turn.conversation as ConversationCommandOutcome
    expect(outcome.operation).toBe('turn')
    expect(provider.calls).toBe(1)
    // And now the grant exists, because a Send is what created one.
    const { ownerAuthority } = await import('../../core/testing')
    expect(ownerAuthority(c).grants()).toHaveLength(1)
  })
})

describe('E — capture cancellation', () => {
  it('releases the microphone and produces nothing', async () => {
    const transcriber = new FakeVoiceTranscriber()
    const c = await started({ voiceTranscriber: transcriber })

    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId, { cancelled: true })

    expect(outcome.operation).toBe('capture-ended')
    expect((outcome as { reason: string }).reason).toBe('cancelled')
    expect((outcome as { text: string | null }).text).toBeNull()
    // Released, so the window is not left claiming a microphone it does not have.
    expect(c.voice().capturing).toBe(false)
    expect(transcriber.calls).toBe(0)
  })

  it('releases on the explicit abandon path too', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    await beginCapture(c)
    await c.handleCommand({ command: 'voice.capture.cancel', requestId: 'v3' })
    expect(c.voice().capturing).toBe(false)
  })
})

describe('F — STOP ALL', () => {
  it('creates no conversation request from captured audio', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceTranscriber: new FakeVoiceTranscriber() })
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1' })

    // Even if a capture is somehow open, ending it must not become a turn.
    const sessionId = await beginCapture(c).catch(() => null)
    if (sessionId !== null) await endCapture(c, sessionId)

    expect(provider.calls).toBe(0)
    const projection = await c.conversation()
    expect(projection.messages).toEqual([])
    expect(c.status().stopAll.active).toBe(true)
  })

  it('leaves the microphone out of it entirely', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1' })

    // Stopping Freya's authority to think says nothing about the microphone, and
    // the two are separate controls for separate reasons.
    const sessionId = await beginCapture(c)
    expect(sessionId).not.toBeNull()
  })
})

describe('G — voice unavailable', () => {
  it('says so before anyone presses anything', async () => {
    const c = await started()
    const voice = c.voice()
    expect(voice.transcription.available).toBe(false)
    expect(voice.transcription.engine).toBeNull()
    expect(voice.transcription.detail).toMatch(/no local speech-to-text engine/i)
    // Stated as an invariant rather than a setting, because it is not one.
    expect(voice.localOnly).toBe(true)
  })

  it('discards the recording rather than falling back anywhere', async () => {
    const c = await started()
    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId, { bytes: 4096 })

    expect((outcome as { reason: string }).reason).toBe('no-engine')
    expect((outcome as { text: string | null }).text).toBeNull()
    // The expected state on most machines, and the UI says which one this is.
    expect(c.voice().faults.join(' ')).toMatch(/no local speech engine/i)
  })

  it('does not claim a voice for replies without a local synthesis engine', async () => {
    const c = await started()
    const voice = c.voice()
    expect(voice.synthesis.available).toBe(false)
    expect(voice.synthesis.detail).toMatch(/does not speak replies/i)
  })

  it('reports a configured local synthesis engine, and only that', async () => {
    const c = await started({ voiceSynthesizer: new FakeVoiceSynthesizer() })
    const voice = c.voice()
    expect(voice.synthesis.available).toBe(true)
    expect(voice.synthesis.engine).toMatch(/fake|test/i)
    // Still local-only, with synthesis configured. The invariant does not have a
    // setting that turns it off.
    expect(voice.localOnly).toBe(true)
    // And Freya still does not speak unprompted: the projection has no "speaking"
    // field at all, because nothing in this phase initiates playback.
    expect(Object.keys(voice)).not.toContain('speaking')
  })
})

describe('H — capture bounds', () => {
  it('refuses a recording longer than the limit', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId, {
      durationMs: VOICE_LIMITS.maxDurationMs + 1,
    })
    expect((outcome as { reason: string }).reason).toBe('too-long')
  })

  it('refuses a recording larger than the limit', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId, {
      bytes: VOICE_LIMITS.maxAudioBytes + 1,
    })
    expect((outcome as { reason: string }).reason).toBe('too-large')
  })

  it('treats an empty recording as nothing, not as an error', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId, { bytes: 0, durationMs: 10 })
    expect((outcome as { detail: string }).detail).toMatch(/nothing was recorded/i)
  })

  it('bounds a transcript before it reaches a composer', async () => {
    const absurd = 'x'.repeat(VOICE_LIMITS.maxTranscriptCharacters + 500)
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber(absurd) })
    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId)
    const text = (outcome as { text: string }).text
    // A pathological transcript must not become one enormous request when sent.
    expect(text.length).toBeLessThanOrEqual(VOICE_LIMITS.maxTranscriptCharacters + 1)
  })

  it('refuses an end for a session that is not open', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber() })
    const outcome = await endCapture(c, 'not-a-session')
    expect((outcome as { reason: string }).reason).toBe('cancelled')
    expect((outcome as { text: string | null }).text).toBeNull()
  })
})

describe('the fake engines are honest about being fake', () => {
  it('names itself, so a status line cannot present it as real', async () => {
    const transcriber = new FakeVoiceTranscriber()
    const synthesizer = new FakeVoiceSynthesizer()
    // The id is what a status line shows. A test engine that called itself
    // "whisper" would make an unconfigured machine look configured.
    expect(transcriber.id).toMatch(/fake|test/i)
    expect(synthesizer.id).toMatch(/fake|test/i)
    expect(transcriber.local).toBe(true)
    expect(synthesizer.local).toBe(true)
  })

  it('reads nothing from the audio, so a test asserts a known value', async () => {
    const transcriber = new FakeVoiceTranscriber('fixed')
    const silent: CapturedAudio = {
      format: 'pcm-s16le',
      sampleRate: 16_000,
      channels: 1,
      bytes: new Uint8Array(0),
      durationMs: 0,
    }
    const loud: CapturedAudio = { ...silent, bytes: new Uint8Array(4096).fill(255) }
    // Identical output for silence and for noise: it is a stand-in, not a listener.
    expect((await transcriber.transcribe(silent)).text).toBe('fixed')
    expect((await transcriber.transcribe(loud)).text).toBe('fixed')
  })

  it('surfaces an engine failure truthfully rather than as silence', async () => {
    const broken: VoiceTranscriber = {
      id: 'broken-local',
      local: true,
      transcribe: async () => {
        throw new Error('the local model file is missing')
      },
    }
    const c = await started({ voiceTranscriber: broken })
    const sessionId = await beginCapture(c)
    const outcome = await endCapture(c, sessionId)
    expect((outcome as { reason: string }).reason).toBe('device-lost')
    expect((outcome as { text: string | null }).text).toBeNull()
    expect(c.voice().faults.join(' ')).toMatch(/local model file is missing/i)
  })
})

describe('audio never reaches the journal', () => {
  it('records sizes, not samples', async () => {
    const c = await started({ voiceTranscriber: new FakeVoiceTranscriber('private words') })
    const sessionId = await beginCapture(c)
    const audio = new Uint8Array(2048).fill(7)
    await c.handleCommand({
      command: 'voice.capture.end',
      requestId: 'v2',
      payload: { sessionId, audio, durationMs: 64 },
    })
    await c.stop('test')

    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).toMatch(/"byteLength":2048/)
    expect(raw).not.toContain('private words')
    expect(raw).not.toMatch(/"audio"/)
  })
})
