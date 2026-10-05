import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_LIMITS } from '../../core/voice/types'
import { createVoiceMirror, resetVoiceMirror, voiceMirror } from '../../src/platform/voiceClient'
import { absentVoiceProjection } from '../core/voice/fixture'

/**
 * The renderer's voice client.
 *
 * Four properties, and each one is a security claim rather than a convenience:
 *
 * 1. **Core decides.** Every capture asks before it opens anything.
 * 2. **An unreachable host is a resolved refusal**, not a rejected promise — so a
 *    window that reloads mid-call produces a sentence rather than a console error.
 * 3. **Interim text is never submitted**, because no method on this client takes a
 *    transcript as an argument to anything that reaches the conversation.
 * 4. **A transcript is not a turn.** `endCapture` reports `turnId` explicitly so a
 *    surface cannot confuse "there are words" with "the words were sent".
 */

let listeners: ((projection: unknown) => void)[] = []
let fragments: ((fragment: unknown) => void)[] = []
let submitted: { command: string; payload: unknown }[] = []

beforeEach(() => {
  listeners = []
  fragments = []
  submitted = []
  resetVoiceMirror()
  window.freyaHost = {
    coreVoice: vi.fn(async () => absentVoiceProjection()),
    onCoreVoice: (handler: (projection: unknown) => void) => {
      listeners.push(handler)
      return () => {
        listeners = listeners.filter((entry) => entry !== handler)
      }
    },
    onCoreVoiceTranscript: (handler: (fragment: unknown) => void) => {
      fragments.push(handler)
      return () => {
        fragments = fragments.filter((entry) => entry !== handler)
      }
    },
    coreSubmit: (async (command: string, payload?: unknown) => {
      submitted.push({ command, payload })
      return { requestId: 'r', ok: true }
    }) as never,
  } as never
})

afterEach(() => {
  resetVoiceMirror()
  delete window.freyaHost
})

describe('a push-to-talk press', () => {
  it('asks Core before anything else, and sends the mic command first', async () => {
    const mirror = createVoiceMirror()
    await mirror.micEnable()
    await mirror.startCapture()
    expect(submitted.map((entry) => entry.command)).toEqual(['voice.mic.enable', 'voice.capture.start'])
  })

  it('reports the session Core actually issued, not one it invented', async () => {
    const mirror = createVoiceMirror()
    ;(window.freyaHost!.coreSubmit as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
      requestId: 'r',
      ok: true,
      voice: { operation: 'capture-started', sessionId: 'core-said-so', startedAt: 'now' },
    })) as never

    const outcome = await mirror.startCapture()
    expect(outcome).toEqual({ ok: true, sessionId: 'core-said-so', reason: null })
  })

  it('surfaces a refusal as a sentence', async () => {
    const mirror = createVoiceMirror()
    ;(window.freyaHost!.coreSubmit as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
      requestId: 'r',
      ok: false,
      voice: { operation: 'refused', reason: 'the microphone is off; turn it on first' },
    })) as never

    const outcome = await mirror.startCapture()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/microphone is off/i)
  })
})

describe('an unreachable host', () => {
  it('resolves with a refusal rather than rejecting', async () => {
    delete window.freyaHost
    const mirror = createVoiceMirror()
    // A rejected promise here becomes an unhandled rejection in a React effect —
    // a console error instead of a microphone button that explains itself.
    await expect(mirror.micEnable()).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/cannot reach/i),
    })
    await expect(mirror.startCapture()).resolves.toMatchObject({ ok: false })
  })

  it('publishes a null projection rather than a stale one', async () => {
    const mirror = createVoiceMirror()
    await mirror.attach()
    expect(mirror.projection).not.toBeNull()
    delete window.freyaHost
    await mirror.refresh()
    expect(mirror.projection).toBeNull()
  })
})

describe('transcripts', () => {
  it('never offers interim text to anything that could reach the conversation', async () => {
    const mirror = createVoiceMirror()
    await mirror.pushInterim('s1', 'what is the wea')
    // The only command the interim path may produce.
    expect(submitted.map((entry) => entry.command)).toEqual(['voice.transcript.interim'])
  })

  it('separates turnId from text so a surface cannot confuse them', async () => {
    const mirror = createVoiceMirror()
    ;(window.freyaHost!.coreSubmit as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
      requestId: 'r',
      ok: true,
      voice: {
        operation: 'capture-ended',
        reason: 'completed',
        text: 'a question',
        detail: 'Sent.',
        transcribed: true,
        byteLength: 1024,
        durationMs: 32,
        turnId: 'turn-9',
      },
    })) as never

    const outcome = await mirror.endCapture({ sessionId: 's1', audio: new Uint8Array(1024), durationMs: 32 })
    expect(outcome.text).toBe('a question')
    expect(outcome.turnId).toBe('turn-9')
  })

  it('sends the declared audio format, and there is no way to choose another', async () => {
    const mirror = createVoiceMirror()
    await mirror.endCapture({ sessionId: 's1', audio: new Uint8Array(1024), durationMs: 32 })
    const payload = submitted[0]?.payload as Record<string, unknown>
    expect(payload.format).toBe(VOICE_LIMITS.format)
    expect(payload.codec).toBe('pcm_s16le')
    expect(payload.mimeType).toBe('audio/pcm')
    expect(payload.sampleRate).toBe(VOICE_LIMITS.sampleRate)
    expect(payload.channels).toBe(VOICE_LIMITS.channels)
    // And the signature itself refuses the idea: there is no codec parameter to pass.
    expect(Object.keys(payload)).not.toContain('opus')
  })

  it('keeps the interim string in step with the fragments Core pushes', async () => {
    const mirror = createVoiceMirror()
    const seen: string[] = []
    mirror.subscribeTranscript((fragment) => seen.push(fragment.kind))
    await mirror.attach()

    fragments.forEach((handler) =>
      handler({ sessionId: 's1', kind: 'interim', text: 'what is the', at: 'now' }),
    )
    expect(mirror.interim).toBe('what is the')
    fragments.forEach((handler) =>
      handler({ sessionId: 's1', kind: 'final', text: 'what is the weather like', at: 'now' }),
    )
    expect(seen).toEqual(['interim', 'final'])
    // A final clears the guess, so a stale caption cannot sit under a new recording.
    expect(mirror.interim).toBe('')
  })
})

describe('speak', () => {
  it('names a turn and never a sentence', async () => {
    const mirror = createVoiceMirror()
    await mirror.speak('turn-1')
    const entry = submitted[0]
    expect(entry?.command).toBe('voice.tts.speak')
    expect(entry?.payload).toEqual({ turnId: 'turn-1' })
  })

  it('forwards tuning only when the caller supplied it', async () => {
    const mirror = createVoiceMirror()
    await mirror.speak('turn-1', { rate: 1.2 })
    expect(submitted[0]?.payload).toEqual({ turnId: 'turn-1', rate: 1.2 })
  })
})

describe('wake and permission', () => {
  it('reports an arm refusal instead of pretending to be armed', async () => {
    const mirror = createVoiceMirror()
    ;(window.freyaHost!.coreSubmit as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
      requestId: 'r',
      ok: false,
      voice: { operation: 'refused', reason: 'this build has no speech-activity gate' },
    })) as never
    const outcome = await mirror.armWake()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/speech-activity/i)
  })

  it('reports only the closed permission vocabulary', async () => {
    const mirror = createVoiceMirror()
    await mirror.reportPermission('revoked')
    expect(submitted[0]).toEqual({ command: 'voice.permission.report', payload: { outcome: 'revoked' } })
  })
})

describe('the shared mirror', () => {
  it('is one instance, and resettable', async () => {
    const first = voiceMirror()
    expect(voiceMirror()).toBe(first)
    resetVoiceMirror()
    expect(voiceMirror()).not.toBe(first)
  })

  it('detaches its pushes on reset', async () => {
    const mirror = voiceMirror()
    await mirror.attach()
    expect(listeners.length).toBeGreaterThan(0)
    resetVoiceMirror()
    expect(listeners).toHaveLength(0)
    expect(fragments).toHaveLength(0)
  })
})