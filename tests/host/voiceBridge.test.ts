// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ElectronCoreHost } from '../../electron/coreHost'
import { HostVoiceOutput } from '../../electron/voiceHost'
import { VOICE_LIMITS } from '../../core/voice/types'

/**
 * The voice lane across the bridge.
 *
 * A preload file is a capability boundary, and most of its important claims are
 * *absences* — no payload field that is not named, no way to send text to be
 * spoken, no permission request that is not a report. An absence over a module
 * that calls `contextBridge` at import time is only checkable against the source,
 * which is what the first block does. The second block then runs the round trip
 * through the real host and Core with no credentials.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-voice-bridge-'))
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

async function preloadSource(): Promise<string> {
  return readFile(join(import.meta.dirname, '..', '..', 'electron', 'preload.ts'), 'utf8')
}

async function startedHost(): Promise<ElectronCoreHost> {
  const instance = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, { voiceTts: new HostVoiceOutput() })
  host = instance
  await instance.start()
  return instance
}

describe('the preload bridge arms', () => {
  it('whitelists the voice commands and nothing wider', async () => {
    const source = await preloadSource()
    for (const command of [
      'voice.status.read',
      'voice.mic.enable',
      'voice.mic.disable',
      'voice.permission.report',
      'voice.capture.start',
      'voice.transcript.interim',
      'voice.capture.end',
      'voice.capture.cancel',
      'voice.submit.set',
      'voice.tts.speak',
      'voice.tts.stop',
      'voice.tts.cancel',
      'voice.tts.settle',
      'voice.tts.voice.read',
      'voice.tts.voice.select',
      'voice.mute.set',
      'voice.wake.arm',
      'voice.wake.disarm',
      'voice.wake.energy',
    ]) {
      expect(source).toContain(`'${command}'`)
    }
    // And nothing that could reconfigure a speech service or name a provider.
    for (const forbidden of [
      'voice.transcriber.configure',
      'voice.endpoint.set',
      'voice.apiKey',
      'speech.provider.select',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('has no function that sends text to be spoken', async () => {
    const source = await preloadSource()
    // `voice.tts.speak` carries a turn id. A bridge function that accepted free text
    // would let a window put any sentence into Freya's mouth, so the check is on the
    // shape of the contract rather than on any one line: the speak arm reads
    // `turnId` and nothing else.
    //
    // Comments are stripped first, because the arm explains itself in prose and that
    // prose legitimately names the field it refuses. Checking the raw text would
    // either fail on a good comment or, worse, tempt somebody into deleting the
    // explanation to make the test pass.
    const arm = source.slice(source.indexOf("case 'voice.tts.speak'"))
    const end = arm.indexOf("case 'voice.tts.cancel'")
    const code = arm
      .slice(0, end)
      .split(/\r?\n/)
      // No `$` on the line comment: `.` does not match a carriage return, so an
      // anchored pattern silently fails to strip anything from a CRLF file — which
      // is exactly the sort of test that passes for the wrong reason.
      .map((line) => line.replace(/\/\/.*/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n')
    expect(code).toContain("string('turnId'")
    expect(code).not.toMatch(/\btext\b/)
    expect(code).not.toMatch(/\bssml\b/)
    // Nor a voice id: which voice reads the answer is Core's setting, so a window
    // cannot pick one here and have it applied to an utterance Core authorised.
    expect(code).not.toMatch(/voiceId/)
  })

  it('checks the audio descriptor against the same allowlist Core uses', async () => {
    const source = await preloadSource()
    // The bridge refuses a hostile declaration before it is structured-cloned into
    // the main process, which is the point of a capability boundary: Core's check is
    // the second lock, not the only one.
    for (const guard of ['VOICE_CODECS', 'VOICE_MIME_TYPES', 'VOICE_SAMPLE_RATES', 'VOICE_CHANNEL_COUNTS']) {
      expect(source).toContain(guard)
    }
    expect(source).toContain('voice audio payload exceeds the capture limit')
  })

  it('treats a permission report as a report, with a closed vocabulary', async () => {
    const source = await preloadSource()
    const arm = source.slice(source.indexOf("case 'voice.permission.report'"))
    const block = arm.slice(0, arm.indexOf("case 'voice.transcript.interim'"))
    expect(block).toContain("outcome !== 'granted'")
    expect(block).toContain("outcome !== 'denied'")
    expect(block).toContain("outcome !== 'revoked'")
  })
})

describe('a voice turn through the real host', () => {
  it('refuses everything until the microphone is on and permission is held', async () => {
    const h = await startedHost()
    const start = await h.submit({ command: 'voice.capture.start', requestId: 'v1' })
    expect(start.ok).toBe(false)

    await h.submit({ command: 'voice.mic.enable', requestId: 'm' })
    const stillRefused = await h.submit({ command: 'voice.capture.start', requestId: 'v2' })
    expect(stillRefused.ok).toBe(false)
    expect(stillRefused.refusal?.reason).toMatch(/permission/i)
  })

  it('reports transcription as configuration-required and discards the recording', async () => {
    // The production host supplies speech *output* and no recogniser, because the
    // platform gives this build one and not the other. That asymmetry has to show up
    // as an honest state rather than as silence.
    const h = await startedHost()
    await h.submit({ command: 'voice.mic.enable', requestId: 'm' })
    await h.submit({
      command: 'voice.permission.report',
      requestId: 'p',
      payload: { outcome: 'granted' },
    })
    const started = await h.submit({ command: 'voice.capture.start', requestId: 'v1' })
    const sessionId = (started.voice as { sessionId: string }).sessionId

    const ended = await h.submit({
      command: 'voice.capture.end',
      requestId: 'v2',
      payload: { sessionId, audio: new Uint8Array(1024), durationMs: 32 },
    })
    const voice = ended.voice as { operation: string; reason: string; text: string | null }
    expect(voice.operation).toBe('capture-ended')
    expect(voice.reason).toBe('no-engine')
    expect(voice.text).toBeNull()

    const projection = h.voice()
    expect(projection?.transcription.availability).toBe('configuration-required')
    expect(projection?.transcription.available).toBe(false)
  })

  it('reports speech output as unavailable until a window says otherwise', async () => {
    const h = await startedHost()
    // The host adapter cannot know on its own: it has no audio device, and only the
    // renderer has `speechSynthesis`. So it starts unavailable rather than claiming
    // a capability it has not observed.
    expect(h.voice()?.synthesis.available).toBe(false)
    expect(h.voice()?.synthesis.engine).toBe('desktop-platform-speech')
  })
})

describe('the host speech adapter', () => {
  it('starts unavailable and refuses to speak', async () => {
    const output = new HostVoiceOutput()
    expect(output.availability).toBe('unavailable')
    await expect(
      output.speak({
        utteranceId: 'u1',
        text: 'hello',
        voiceId: null,
        rate: 1,
        pitch: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/no window has reported/i)
  })

  it('becomes available only when a window reports it, and lists its voices', async () => {
    const output = new HostVoiceOutput()
    output.report({
      available: true,
      voices: [{ voiceId: 'v1', label: 'Voice One', language: 'en-GB', isDefault: true }],
      detail: 'The platform speech engine.',
    })
    expect(output.availability).toBe('available')
    expect(await output.voices()).toHaveLength(1)
    expect(output.detail).toBe('The platform speech engine.')
  })

  it('will not resolve an utterance nobody is going to play', async () => {
    // A window that has gone away must not leave Core's `speaking` state latched on
    // an answer nobody can hear, so an abort — not a timeout — is what settles this.
    const output = new HostVoiceOutput()
    const controller = new AbortController()
    const pending = output.speak({
      utteranceId: 'u1',
      text: 'hello',
      voiceId: null,
      rate: 1,
      pitch: 1,
      signal: controller.signal,
    })
    output.report({ available: true, voices: [] })
    controller.abort(new Error('stopped'))
    await expect(pending).rejects.toThrow()
  })

  it('resolves only when Core says the utterance is over', async () => {
    const output = new HostVoiceOutput()
    output.report({ available: true, voices: [] })
    let settled = false
    const pending = output
      .speak({
        utteranceId: 'u1',
        text: 'hello',
        voiceId: null,
        rate: 1,
        pitch: 1,
        signal: new AbortController().signal,
      })
      .then((value) => {
        settled = true
        return value
      })
    await Promise.resolve()
    expect(settled).toBe(false)
    // A settlement for a different utterance must not resolve this one.
    output.settle('u-other', true)
    await Promise.resolve()
    expect(settled).toBe(false)
    output.settle('u1', true)
    await expect(pending).resolves.toMatchObject({ completed: true })
  })

  it('settles everything pending when it stops or cancels', async () => {
    const output = new HostVoiceOutput()
    output.report({ available: true, voices: [] })
    const first = output.speak({
      utteranceId: 'u1',
      text: 'a',
      voiceId: null,
      rate: 1,
      pitch: 1,
      signal: new AbortController().signal,
    })
    await output.stop()
    await expect(first).resolves.toMatchObject({ completed: false })

    const second = output.speak({
      utteranceId: 'u2',
      text: 'b',
      voiceId: null,
      rate: 1,
      pitch: 1,
      signal: new AbortController().signal,
    })
    await output.cancel()
    await expect(second).resolves.toMatchObject({ completed: false })
  })

  it('bears the capture bound Core does', () => {
    // The host never opens a capture, so this is a re-read rather than an assertion
    // about itself — but it is the ceiling both halves agree on, and a bridge that
    // forwarded a larger payload would be refused by Core anyway.
    expect(VOICE_LIMITS.maxAudioBytes).toBeGreaterThan(0)
    expect(VOICE_LIMITS.maxDurationMs).toBeGreaterThan(0)
  })
})