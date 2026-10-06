// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { ScriptedSttAdapter } from '../../../core/voice/stt'
import { VOICE_LIMITS } from '../../../core/voice/types'
import type {
  ConversationCommandOutcome,
  VoiceCommandOutcome,
  VoiceProjection,
} from '../../../core/protocol/conversation'
import { StandInStt, StandInTts, voiceOptions } from './fixture'
import { buildLocalWakeGate } from '../../../core/voice/wake'

/**
 * Voice, end to end through Core.
 *
 * Six properties, and each of them is a promise this file can fail:
 *
 *   1. **The microphone is off until somebody presses something.** No hydration,
 *      no preference, no start-up path.
 *   2. **A spoken sentence is a typed sentence.** Same command, same Mind, same
 *      Governor, one model call — never two.
 *   3. **Only a final transcript executes.** Interim text is display-only.
 *   4. **STOP ALL is a real stop.** Capture, transcription, submission and speech
 *      all stop, and resuming does not reopen anything.
 *   5. **Audio never becomes a fact.** Sizes and lengths, never samples and never
 *      words.
 *   6. **Failures are named.** An absent engine, a timeout, malformed audio and a
 *      refused permission are four different answers.
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

async function started(overrides: Partial<CoreOptions> = {}): Promise<Core> {
  const c = createCore(voiceOptions(dir, { providers: [new FakeModelProvider()], ...overrides }))
  core = c
  await c.start()
  return c
}

/** Turn the microphone on and clear the permission gate, as a press would. */
async function ready(c: Core): Promise<void> {
  await c.handleCommand({ command: 'voice.mic.enable', requestId: 'mic-on' })
  await c.handleCommand({
    command: 'voice.permission.report',
    requestId: 'perm',
    payload: { outcome: 'granted' },
  })
}

async function capture(c: Core, requestId = 'v1'): Promise<string> {
  const result = await c.handleCommand({ command: 'voice.capture.start', requestId })
  const voice = result.voice as VoiceCommandOutcome
  if (voice.operation !== 'capture-started') throw new Error('capture did not start')
  return (voice as { sessionId: string }).sessionId
}

/**
 * A capture payload that passes validation.
 *
 * The defaults are internally consistent on purpose: `durationMs` has to be
 * reachable from `frames / sampleRate`, because `validateAudio` refuses a capture
 * that claims to be longer than its own bytes could be.
 */
function audioPayload(
  sessionId: string,
  overrides: {
    bytes?: number
    frames?: number
    durationMs?: number
    cancelled?: boolean
    format?: string
    codec?: string
    mimeType?: string
    sampleRate?: number
    channels?: number
  } = {},
): Record<string, unknown> {
  const frames = overrides.frames ?? 480
  const byteLength = overrides.bytes ?? frames * 2
  return {
    sessionId,
    bytes: new Uint8Array(byteLength),
    durationMs: overrides.durationMs ?? 30,
    cancelled: overrides.cancelled === true,
    format: overrides.format ?? 'pcm-s16le',
    codec: overrides.codec ?? 'pcm_s16le',
    mimeType: overrides.mimeType ?? 'audio/pcm',
    sampleRate: overrides.sampleRate ?? VOICE_LIMITS.sampleRate,
    channels: overrides.channels ?? VOICE_LIMITS.channels,
  }
}

async function endCapture(
  c: Core,
  sessionId: string,
  overrides: Parameters<typeof audioPayload>[1] = {},
): Promise<VoiceCommandOutcome> {
  const result = await c.handleCommand({
    command: 'voice.capture.end',
    requestId: 'v2',
    payload: audioPayload(sessionId, overrides),
  })
  return result.voice as VoiceCommandOutcome
}

/* ------------------------------------------------------------------ the mic */

describe('A — the microphone is off', () => {
  it('starts off, on every start-up', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    const voice = c.voice()
    expect(voice.micEnabled).toBe(false)
    expect(voice.state).toBe('permission-required')
    expect(voice.capturing).toBe(false)
    // Not one byte of audio and not one capture event before a person asked.
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('voice.capture.started')
  })

  it('returns to off after a restart', async () => {
    await ready(await started({ voiceStt: new StandInStt() }))
    expect(core!.voice().micEnabled).toBe(true)
    await core!.stop('restart')

    // The second process reads the same journal and reaches the same answer.
    const again = createCore(voiceOptions(dir, { providers: [new FakeModelProvider()], voiceStt: new StandInStt() }))
    core = again
    await again.start()
    expect(again.voice().micEnabled).toBe(false)
  })

  it('refuses a capture while it is off, in its own words', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await c.handleCommand({
      command: 'voice.permission.report',
      requestId: 'p',
      payload: { outcome: 'granted' },
    })
    const result = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v1' })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/microphone is off/i)
  })

  it('reports a build with no capture path as unsupported, and cannot be argued with', async () => {
    const c = await started({ voiceCaptureSupported: false })
    expect(c.voice().state).toBe('unsupported')
    const on = await c.handleCommand({ command: 'voice.mic.enable', requestId: 'm' })
    expect(on.ok).toBe(false)
    const capture_ = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v' })
    expect(capture_.ok).toBe(false)
  })

  it('turns off again and releases an open capture', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    await capture(c)
    await c.handleCommand({ command: 'voice.mic.disable', requestId: 'off' })
    expect(c.voice().micEnabled).toBe(false)
    expect(c.voice().capturing).toBe(false)
  })
})

/* -------------------------------------------------------------- permission */

describe('B — the permission lifecycle', () => {
  it('asks for nothing by itself and starts in permission-required', async () => {
    const c = await started()
    expect(c.voice().permission).toBe('unknown')
    expect(c.voice().state).toBe('permission-required')
  })

  it('refuses a capture until the platform reports granted', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await c.handleCommand({ command: 'voice.mic.enable', requestId: 'm' })
    const refused = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v' })
    expect(refused.ok).toBe(false)
    expect(refused.refusal?.reason).toMatch(/not been requested/i)
  })

  it('says permission-denied distinctly from permission-required', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    await c.handleCommand({
      command: 'voice.permission.report',
      requestId: 'p',
      payload: { outcome: 'denied' },
    })
    expect(c.voice().state).toBe('permission-denied')
    const refused = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v' })
    expect(refused.refusal?.reason).toMatch(/was denied/i)
  })

  it('ends an open capture when permission is revoked underneath it', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    await capture(c)
    expect(c.voice().capturing).toBe(true)

    await c.handleCommand({
      command: 'voice.permission.report',
      requestId: 'p',
      payload: { outcome: 'revoked' },
    })

    // The device is going away whether or not this process noticed, so the session
    // is closed here rather than left to fail later with an empty buffer.
    expect(c.voice().capturing).toBe(false)
    expect(c.voice().permission).toBe('revoked')
  })

  it('records the permission category and nothing else', async () => {
    const c = await started()
    await ready(c)
    await c.stop('test')
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).toContain('"category":"microphone"')
    expect(raw).not.toContain('audio')
  })
})

/* ------------------------------------------------------ interim and final */

describe('C — interim never executes', () => {
  it('accepts interim text and keeps it out of the conversation', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)

    await c.handleCommand({
      command: 'voice.transcript.interim',
      requestId: 'i1',
      payload: { sessionId, text: 'what is the wea' },
    })
    await c.handleCommand({
      command: 'voice.transcript.interim',
      requestId: 'i2',
      payload: { sessionId, text: 'what is the weather like' },
    })

    // Displayed, bounded, and inert.
    expect(c.voice().interim).toBe('what is the weather like')
    const projection = await c.conversation()
    expect(projection.messages).toEqual([])
    expect(provider.calls).toBe(0)
  })

  it('bounds interim text rather than accepting a screenful of nonsense', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    await c.handleCommand({
      command: 'voice.transcript.interim',
      requestId: 'i1',
      payload: { sessionId, text: 'x'.repeat(50_000) },
    })
    expect(c.voice().interim.length).toBeLessThanOrEqual(VOICE_LIMITS.maxInterimCharacters)
  })

  it('refuses interim text for a session that is not open', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const result = await c.handleCommand({
      command: 'voice.transcript.interim',
      requestId: 'i1',
      payload: { sessionId: 'made-up', text: 'hello' },
    })
    const voice = result.voice as Extract<VoiceCommandOutcome, { operation: 'interim' }>
    expect(voice.accepted).toBe(false)
    expect(voice.reason).toMatch(/no recording/i)
  })

  it('publishes interim and final as different kinds', async () => {
    const c = await started({ voiceStt: new StandInStt('the final words') })
    await ready(c)
    const seen: string[] = []
    c.onVoiceTranscript((fragment) => seen.push(fragment.kind))
    const sessionId = await capture(c)
    await c.handleCommand({
      command: 'voice.transcript.interim',
      requestId: 'i1',
      payload: { sessionId, text: 'partial' },
    })
    await endCapture(c, sessionId)
    expect(seen).toEqual(['interim', 'final'])
    expect(c.voice().finalTranscript).toBe('the final words')
  })
})

/* ------------------------------------------------- the canonical turn path */

describe('D — a final transcript is a typed sentence', () => {
  it('waits in the composer by default and spends nothing', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt('what is the weather like') })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>

    expect(outcome.text).toBe('what is the weather like')
    expect(outcome.turnId).toBeNull()
    expect(provider.calls).toBe(0)
    expect(c.status().sessionUsage.calls).toBe(0)
    const projection = await c.conversation()
    expect(projection.messages).toEqual([])
  })

  it('enters the same conversation path when the owner turned auto-submit on', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt('what is the weather like') })
    await ready(c)
    await c.handleCommand({
      command: 'voice.submit.set',
      requestId: 's',
      payload: { enabled: true },
    })

    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>

    expect(outcome.turnId).not.toBeNull()
    // Exactly one model call: the same one typed text would have caused.
    expect(provider.calls).toBe(1)
    const projection = await c.conversation()
    const user = projection.messages.find((message) => message.role === 'user')
    expect(user?.content).toBe('what is the weather like')
    expect(user?.turnId).toBe(outcome.turnId)
  })

  it('spends nothing extra merely because voice is switched on', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt() })
    await ready(c)
    await c.handleCommand({ command: 'voice.submit.set', requestId: 's', payload: { enabled: true } })

    expect(provider.calls).toBe(0)
    expect(c.status().activeProviderCalls).toBe(0)
    expect(c.status().sessionUsage.calls).toBe(0)
  })

  it('still goes through the Governor, and a denial is reported as one', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt('please do a thing') })
    await ready(c)
    await c.handleCommand({ command: 'voice.submit.set', requestId: 's', payload: { enabled: true } })
    await c.handleCommand({ command: 'security.stopAll', requestId: 'stop' })

    const outcome = (await c.handleCommand({
      command: 'voice.capture.start',
      requestId: 'v',
    })).voice as VoiceCommandOutcome
    // Refused at the door while stopped, so there is nothing to submit.
    expect(outcome.operation).toBe('refused')
    expect(provider.calls).toBe(0)
  })

  it('a transcript never becomes a grant', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    await endCapture(c, sessionId)
    const { ownerAuthority } = await import('../../../core/testing')
    expect(ownerAuthority(c).grants()).toHaveLength(0)
  })
})

/* ------------------------------------------------------------ audio bounds */

describe('E — audio bounds', () => {
  it('refuses a recording longer than the limit', async () => {
    const stt = new StandInStt()
    const c = await started({ voiceStt: stt })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId, {
      durationMs: VOICE_LIMITS.maxDurationMs + 1,
    })) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect(outcome.reason).toBe('too-long')
    expect(stt.calls).toBe(0)
  })

  it('refuses a recording larger than the limit', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId, {
      bytes: VOICE_LIMITS.maxAudioBytes + 2,
      durationMs: 10,
    })) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect(outcome.reason).toBe('too-large')
  })

  it('refuses a codec outside the allowlist', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId, { codec: 'opus' })) as Extract<
      VoiceCommandOutcome,
      { operation: 'capture-ended' }
    >
    expect(outcome.reason).toBe('malformed')
    expect(outcome.detail).toMatch(/codec/i)
  })

  it('refuses a compressed container even under an allowed codec name', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId, { mimeType: 'audio/webm;codecs=opus' })) as Extract<
      VoiceCommandOutcome,
      { operation: 'capture-ended' }
    >
    expect(outcome.reason).toBe('malformed')
  })

  it('refuses a sample rate or channel count it was not told to expect', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const slow = await capture(c, 'v1')
    expect(((await endCapture(c, slow, { sampleRate: 1 })) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>).reason).toBe('malformed')
    const wide = await capture(c, 'v2')
    expect(((await endCapture(c, wide, { channels: 8 })) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>).reason).toBe('malformed')
  })

  it('refuses a buffer that is not whole sample frames', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId, { bytes: 4095 })) as Extract<
      VoiceCommandOutcome,
      { operation: 'capture-ended' }
    >
    expect(outcome.reason).toBe('malformed')
    expect(outcome.detail).toMatch(/whole number of 16-bit sample frames/i)
  })

  it('refuses a duration the buffer could not produce', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    // 960 bytes at 16 kHz is 30 ms; claiming 30 seconds is a forged measurement.
    const outcome = (await endCapture(c, sessionId, { durationMs: 30_000 })) as Extract<
      VoiceCommandOutcome,
      { operation: 'capture-ended' }
    >
    expect(outcome.reason).toBe('malformed')
  })

  it('treats an empty recording as nothing, not as an error', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId, { bytes: 0 })) as Extract<
      VoiceCommandOutcome,
      { operation: 'capture-ended' }
    >
    expect(outcome.detail).toMatch(/nothing was recorded/i)
  })

  it('bounds a final transcript before it can reach anything', async () => {
    const absurd = 'x'.repeat(VOICE_LIMITS.maxTranscriptCharacters + 500)
    const c = await started({ voiceStt: new StandInStt(absurd) })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect((outcome.text ?? '').length).toBeLessThanOrEqual(VOICE_LIMITS.maxTranscriptCharacters)
  })
})

/* ------------------------------------------------------------- engine fails */

describe('F — engines fail honestly', () => {
  it('discards the recording when no engine is configured', async () => {
    const c = await started()
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect(outcome.reason).toBe('no-engine')
    expect(outcome.text).toBeNull()
    expect(c.voice().state).toBe('degraded')
    expect(c.voice().transcription.availability).toBe('configuration-required')
  })

  it('distinguishes configuration-required from unavailable', async () => {
    const c = await started()
    await ready(c)
    expect(c.voice().transcription.availability).toBe('configuration-required')
    expect(c.voice().transcription.available).toBe(false)
    expect(c.voice().transcription.detail).toMatch(/discarded rather than sent anywhere/i)
  })

  it('names a timeout as a timeout', async () => {
    const stt = new ScriptedSttAdapter({ final: 'never arrives', delayMs: 40 }, { id: 'slow-stt' })
    // A tighter deadline than production's twenty seconds, so the test finishes.
    // The hard ceiling cannot be raised — only lowered — which is why this works.
    const c = await started({ voiceStt: stt, voiceTranscriptionTimeoutMs: 10 })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect(outcome.reason).toBe('timeout')
    expect(outcome.text).toBeNull()
    expect(c.voice().state).toBe('failed')
  })

  it('cannot be given a deadline above the hard limit', async () => {
    // The option exists so a timeout path is testable. If it could *raise* the
    // ceiling it would be an option somebody eventually raises.
    const c = await started({ voiceTranscriptionTimeoutMs: 10 * 60_000 })
    expect(c.voice().limits.transcriptionTimeoutMs).toBe(VOICE_LIMITS.transcriptionTimeoutMs)
  })

  it('surfaces an engine failure as an engine failure', async () => {
    const stt = new ScriptedSttAdapter({ final: 'x', failWith: new Error('the local model file is missing') })
    const c = await started({ voiceStt: stt })
    await ready(c)
    const sessionId = await capture(c)
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect(outcome.reason).toBe('device-lost')
    expect(c.voice().faults.join(' ')).toMatch(/local model file is missing/i)
  })

  it('reaches a transcription that is already running when cancel arrives', async () => {
    // The window releases the button a moment *after* the capture ended, so the
    // engine is already reading. A cancel that could not reach it would leave the
    // flow waiting out the full deadline with no way out.
    let abortedDuringWork = false
    const slow = new ScriptedSttAdapter({ final: 'too late', delayMs: 1_000 }, { id: 'slow-stt' })
    const stt = {
      id: slow.id,
      kind: slow.kind,
      availability: slow.availability,
      detail: slow.detail,
      streaming: false,
      transcribe: async (request: Parameters<typeof slow.transcribe>[0]) => {
        const result = await Promise.race([
          slow.transcribe(request),
          new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => {
                abortedDuringWork = true
                reject(new Error('aborted'))
              },
              { once: true },
            )
          }),
        ])
        return result
      },
    }

    const c = await started({ voiceStt: stt, voiceTranscriptionTimeoutMs: 5_000 })
    await ready(c)
    const sessionId = await capture(c)

    const ending = endCapture(c, sessionId)
    // Give the engine a moment to actually start working before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await c.handleCommand({
      command: 'voice.capture.cancel',
      requestId: 'x',
      payload: { reason: 'the owner changed their mind' },
    })
    const outcome = (await ending) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>

    expect(abortedDuringWork).toBe(true)
    expect(outcome.reason).toBe('cancelled')
    expect(outcome.text).toBeNull()
    expect(c.voice().state).not.toBe('transcribing')
  })
})

/* --------------------------------------------------------------- STOP ALL */

describe('G — STOP ALL', () => {
  it('stops the microphone, the transcription, the submission and the speech', async () => {
    const provider = new FakeModelProvider()
    const tts = new StandInTts()
    tts.hold = true
    const c = await started({ providers: [provider], voiceStt: new StandInStt(), voiceTts: tts })
    await ready(c)

    // A capture open at the moment of the stop.
    const sessionId = await capture(c)
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1' })

    const voice = c.voice()
    expect(voice.state).toBe('stopped-by-STOP-ALL')
    expect(voice.capturing).toBe(false)
    expect(voice.speaking).toBe(false)

    // And nothing voice-related can start while it is latched.
    const start = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v' })
    expect(start.ok).toBe(false)
    expect(start.refusal?.reason).toMatch(/stopped/i)
    expect(provider.calls).toBe(0)
    expect(sessionId).not.toBeNull()
  })

  it('drops a final transcript that arrives after the stop', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt('do something') })
    await ready(c)
    await c.handleCommand({ command: 'voice.submit.set', requestId: 's', payload: { enabled: true } })
    const sessionId = await capture(c)
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1' })

    // The window still holds the audio it captured before the stop, and tries.
    const outcome = (await endCapture(c, sessionId)) as Extract<VoiceCommandOutcome, { operation: 'capture-ended' }>
    expect(outcome.reason).toBe('stopped-by-STOP-ALL')
    expect(outcome.text).toBeNull()
    expect(provider.calls).toBe(0)
    expect((await c.conversation()).messages).toEqual([])
  })

  it('records that it cancelled voice, with no bytes', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    await capture(c)
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1' })
    await c.stop('test')

    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).toContain('voice.stopped')
    expect(raw).toContain('"byteLength":0')
  })

  it('does not reopen the microphone on resume', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1' })
    await c.handleCommand({ command: 'security.resume', requestId: 'r1' })

    // Explicitly not cleared: the device is the owner's to reopen, not the latch's.
    expect(c.voice().micEnabled).toBe(true)
    expect(c.voice().state).toBe('ready')
    expect(c.voice().wake.armed).toBe(false)
  })
})

/* --------------------------------------------------------------- speaking */

describe('H — Freya reads a stored answer and nothing else', () => {
  async function completedTurn(c: Core): Promise<string> {
    const created = await c.handleCommand({ command: 'conversation.create', requestId: 'c0' })
    const conversation = created.conversation as ConversationCommandOutcome
    if (conversation.operation !== 'created') throw new Error('no conversation')
    const turn = await c.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 't1',
      payload: { conversationId: conversation.conversation.conversationId, text: 'hello Freya' },
    })
    const outcome = turn.conversation as ConversationCommandOutcome
    if (outcome.operation !== 'turn') throw new Error('no turn')
    return outcome.turn.turnId
  }

  it('speaks the words of a turn Core already stored', async () => {
    const tts = new StandInTts()
    const c = await started({ voiceTts: tts })
    const turnId = await completedTurn(c)

    const result = await c.handleCommand({
      command: 'voice.tts.speak',
      requestId: 'sp1',
      payload: { turnId },
    })
    expect(result.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(tts.spoken).toHaveLength(1)
    expect(tts.spoken[0]?.text).toMatch(/\S/)
    // Not the question: the answer.
    expect(tts.spoken[0]?.text).not.toBe('hello Freya')
  })

  it('refuses to speak a turn that has no stored answer', async () => {
    const c = await started({ voiceTts: new StandInTts() })
    const result = await c.handleCommand({
      command: 'voice.tts.speak',
      requestId: 'sp1',
      payload: { turnId: 'no-such-turn' },
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/no such turn/i)
  })

  it('does not let a renderer supply the words', async () => {
    const tts = new StandInTts()
    const c = await started({ voiceTts: tts })
    const turnId = await completedTurn(c)

    const result = await c.handleCommand({
      command: 'voice.tts.speak',
      requestId: 'sp1',
      // A renderer that tries to make Freya say something she did not write.
      payload: { turnId, text: 'the vault code is 1234' },
    })
    expect(result.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tts.spoken.map((entry) => entry.text).join(' ')).not.toMatch(/1234/)
  })

  it('mutes, and a muted Freya does not speak', async () => {
    const tts = new StandInTts()
    const c = await started({ voiceTts: tts })
    const turnId = await completedTurn(c)
    await c.handleCommand({ command: 'voice.mute.set', requestId: 'm', payload: { muted: true } })

    const result = await c.handleCommand({
      command: 'voice.tts.speak',
      requestId: 'sp1',
      payload: { turnId },
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/muted/i)
    expect(tts.spoken).toHaveLength(0)
  })

  it('lists the platform voices and refuses one it does not offer', async () => {
    const c = await started({ voiceTts: new StandInTts() })
    const listed = await c.handleCommand({ command: 'voice.tts.voice.read', requestId: 'v1' })
    const voices = (listed.voice as Extract<VoiceCommandOutcome, { operation: 'voices' }>).voices
    expect(voices.map((voice) => voice.voiceId)).toContain('voice-one')

    const invented = await c.handleCommand({
      command: 'voice.tts.voice.select',
      requestId: 'v2',
      payload: { voiceId: 'a-voice-i-made-up' },
    })
    expect(invented.ok).toBe(false)

    const real = await c.handleCommand({
      command: 'voice.tts.voice.select',
      requestId: 'v3',
      payload: { voiceId: 'voice-two' },
    })
    expect(real.ok).toBe(true)
    expect(c.voice().selectedVoiceId).toBe('voice-two')
  })

  it('refuses to speak at all when no output engine is configured', async () => {
    const c = await started()
    await ready(c)
    const result = await c.handleCommand({ command: 'voice.tts.speak', requestId: 'sp', payload: { turnId: 'x' } })
    expect(result.ok).toBe(false)
    expect(c.voice().synthesis.available).toBe(false)
    expect(c.voice().synthesis.detail).toMatch(/does not read replies aloud/i)
  })
})

/* -------------------------------------------------------------- barge-in */

describe('I — barge-in', () => {
  it('cuts playback off and marks it interrupted', async () => {
    const tts = new StandInTts()
    tts.hold = true
    const c = await started({ voiceTts: tts })
    const created = await c.handleCommand({ command: 'conversation.create', requestId: 'c0' })
    const conversation = created.conversation as ConversationCommandOutcome
    if (conversation.operation !== 'created') throw new Error('no conversation')
    const turn = await c.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 't1',
      payload: { conversationId: conversation.conversation.conversationId, text: 'hello' },
    })
    const turnId = (turn.conversation as Extract<ConversationCommandOutcome, { operation: 'turn' }>).turn.turnId

    await c.handleCommand({ command: 'voice.tts.speak', requestId: 's', payload: { turnId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(c.voice().speaking).toBe(true)

    // The person starts talking, so the window cancels playback and begins capture.
    await c.handleCommand({
      command: 'voice.tts.cancel',
      requestId: 'x',
      payload: { reason: 'the owner started speaking' },
    })
    expect(c.voice().speaking).toBe(false)
    expect(c.voice().lastInterruption).toMatch(/started speaking/i)
    expect(tts.cancels).toBeGreaterThan(0)

    // And the text of the answer is untouched: barge-in cuts the *sound*.
    const projection = await c.conversation()
    const answer = projection.messages.find((message) => message.role === 'assistant')
    expect(answer?.content.length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------- wake */

describe('J — hands-free is off', () => {
  it('is not armed on any build that has not configured a gate', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    expect(c.voice().wake.armed).toBe(false)
    expect(c.voice().wake.available).toBe(false)
    expect(c.voice().wake.kind).toBe('speech-activity')

    const armed = await c.handleCommand({ command: 'voice.wake.arm', requestId: 'w' })
    expect(armed.ok).toBe(false)
    expect(armed.refusal?.reason).toMatch(/speech-activity gate/i)
  })

  it('never claims to be a wake word', async () => {
    const c = await started()
    expect(c.voice().wake.detail).not.toMatch(/wake word/i)
    expect(c.voice().wake.detail).toMatch(/speech-activity|speech-activity/i)
  })

  it('grants nothing when a gate does fire', async () => {
    const provider = new FakeModelProvider()
    const c = await started({ providers: [provider], voiceStt: new StandInStt() })
    await ready(c)
    await c.handleCommand({ command: 'voice.wake.energy', requestId: 'e', payload: { level: 0.99, sustainedMs: 5000 } })
    // Not armed, so nothing happened at all.
    expect(c.voice().capturing).toBe(false)
    expect(provider.calls).toBe(0)
  })
})


/* ------------------------------------------- E.V.-style voice attention path */

describe('J2 — Freya wake phrase opens one bounded conversation', () => {
  async function fireWake(c: Core, requestId: string): Promise<VoiceCommandOutcome> {
    const fired = await c.handleCommand({
      command: 'voice.wake.energy',
      requestId: `${requestId}-energy`,
      payload: { level: 0.99, sustainedMs: 600 },
    })
    expect(fired.ok).toBe(true)
    const sessionId = c.voice().sessionId
    expect(sessionId).not.toBeNull()
    return await endCapture(c, sessionId!, { durationMs: 30 })
  }

  it('strips "Freya" and sends the request through the ordinary Conversation/Mind path once', async () => {
    const provider = new FakeModelProvider()
    const c = await started({
      providers: [provider],
      voiceStt: new StandInStt('Freya, check the build'),
      voiceWake: buildLocalWakeGate(),
    })
    await ready(c)
    const armed = await c.handleCommand({ command: 'voice.wake.arm', requestId: 'wake-arm' })
    expect(armed.ok).toBe(true)

    const outcome = await fireWake(c, 'wake-one')
    expect(outcome.turnId).not.toBeNull()
    expect(provider.calls).toBe(1)
    expect(c.voice().attention.state).toBe('attentive')

    const conversation = await c.conversation()
    const owner = conversation.messages.find((message) => message.role === 'user')
    expect(owner?.content).toBe('check the build')
    expect(owner?.content).not.toMatch(/^Freya\b/i)
  })

  it('answers a bare "Freya" with a closed cue and does not spend cognition', async () => {
    const provider = new FakeModelProvider()
    const tts = new StandInTts()
    const c = await started({
      providers: [provider],
      voiceStt: new StandInStt('Freya'),
      voiceTts: tts,
      voiceWake: buildLocalWakeGate(),
    })
    await ready(c)
    await c.handleCommand({ command: 'voice.wake.arm', requestId: 'wake-arm' })

    const outcome = await fireWake(c, 'wake-only')
    expect(outcome.turnId).toBeNull()
    expect(provider.calls).toBe(0)
    expect(c.voice().attention.state).toBe('attentive')
    expect(tts.spoken.map((item) => item.text)).toContain('Yes?')
  })

  it('accepts natural follow-ups inside the attention window and "stand by" closes it', async () => {
    const provider = new FakeModelProvider()
    const tts = new StandInTts()
    const phrases = ['Freya', 'what about the tests?', 'stand by']
    let index = 0
    const stt = {
      id: 'sequence-stt',
      kind: 'local' as const,
      availability: 'available' as const,
      detail: 'sequence STT for voice-attention acceptance',
      streaming: false,
      async transcribe() {
        const text = phrases[index] ?? ''
        index += 1
        return { text, engine: 'sequence-stt' }
      },
    }

    const c = await started({
      providers: [provider],
      voiceStt: stt,
      voiceTts: tts,
      voiceWake: buildLocalWakeGate(),
    })
    await ready(c)
    await c.handleCommand({ command: 'voice.wake.arm', requestId: 'wake-arm' })

    await fireWake(c, 'wake-open')
    expect(c.voice().attention.state).toBe('attentive')
    expect(provider.calls).toBe(0)

    const followUp = await fireWake(c, 'wake-follow-up')
    expect(followUp.turnId).not.toBeNull()
    expect(provider.calls).toBe(1)
    const conversation = await c.conversation()
    expect(
      conversation.messages.some(
        (message) => message.role === 'user' && message.content === 'what about the tests?',
      ),
    ).toBe(true)

    const standby = await fireWake(c, 'wake-standby')
    expect(standby.turnId).toBeNull()
    expect(provider.calls).toBe(1)
    expect(c.voice().attention.state).toBe('standby')
    expect(tts.spoken.map((item) => item.text)).toEqual(expect.arrayContaining(['Yes?', 'Okay.']))
  })
})

describe('J3 — Core Attention, not Voice, decides proactive speech', () => {
  it('speaks a closed deadline cue only when proactive alert speech is enabled', async () => {
    const tts = new StandInTts()
    const c = await started({
      voiceTts: tts,
      voiceProactiveAlerts: true,
    })

    const result = await c.handleCommand({
      command: 'attention.event.ingest',
      requestId: 'attention-deadline',
      payload: {
        kind: 'deadline',
        text: 'Untrusted detail that must never be spoken.',
        severityHint: 'none',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(result.ok).toBe(true)

    await Promise.resolve()
    await Promise.resolve()

    expect(tts.spoken.map((item) => item.text)).toContain('A deadline needs your attention.')
    expect(tts.spoken.map((item) => item.text).join(' ')).not.toContain(
      'Untrusted detail that must never be spoken.',
    )
  })

  it('stays silent when proactive alerts are off even if Attention chooses an expressive outcome', async () => {
    const tts = new StandInTts()
    const c = await started({
      voiceTts: tts,
      voiceProactiveAlerts: false,
    })

    const result = await c.handleCommand({
      command: 'attention.event.ingest',
      requestId: 'attention-deadline-off',
      payload: {
        kind: 'deadline',
        text: 'Do not speak me.',
        severityHint: 'none',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(result.ok).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(tts.spoken).toHaveLength(0)
  })
})

/* -------------------------------------------------------------- the journal */

describe('K — the journal carries metadata and nothing else', () => {
  it('records sizes, engine names and turn references, never audio or words', async () => {
    const stt = new StandInStt('private words spoken aloud')
    const c = await started({ voiceStt: stt })
    await ready(c)
    await c.handleCommand({ command: 'voice.submit.set', requestId: 's', payload: { enabled: true } })
    const sessionId = await capture(c)
    await c.handleCommand({
      command: 'voice.transcript.interim',
      requestId: 'i',
      payload: { sessionId, text: 'private words' },
    })
    await endCapture(c, sessionId, { bytes: 2048 })
    await c.stop('test')

    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).toMatch(/"byteLength":2048/)
    expect(raw).toContain('voice.transcribe.started')
    expect(raw).toContain('voice.submitted')
    // The words themselves are in the encrypted conversation store, not here.
    expect(raw).not.toContain('private words spoken aloud')
    expect(raw).not.toMatch(/"audio"/)
    expect(raw).not.toMatch(/"bytes":\[/)
    expect(raw).not.toMatch(/"interim":"/)
  })

  it('accepts only the named voice payload shapes', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    await ready(c)
    await capture(c)
    await c.handleCommand({ command: 'security.stopAll', requestId: 's' })
    await c.stop('test')

    const raw = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
    for (const event of raw) {
      if (!event.type.startsWith('voice.')) continue
      // A transcript field would be a bug; a length field is the contract.
      for (const forbidden of ['audio', 'bytes', 'transcript', 'text', 'interim', 'content']) {
        expect(Object.keys(event.payload)).not.toContain(forbidden)
      }
    }
  })
})

/* --------------------------------------------------------------- projection */

describe('L — the projection is a mirror', () => {
  it('pushes a move without the window asking', async () => {
    const c = await started({ voiceStt: new StandInStt() })
    const seen: VoiceProjection[] = []
    c.onVoice((projection) => seen.push(projection))
    await ready(c)
    expect(seen.map((projection) => projection.state)).toContain('permission-required')
    expect(seen.map((projection) => projection.state)).toContain('ready')
    expect(c.voice().state).toBe('ready')
  })
})