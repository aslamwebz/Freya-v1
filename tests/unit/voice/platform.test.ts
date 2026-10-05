import { afterEach, describe, expect, it, vi } from 'vitest'
import { canTranscribeLocally, detectRecognitionSupport } from '../../../src/voice/recognition'
import { WindowSpeechOutput } from '../../../src/voice/output'

/**
 * The two platform seams, feature-detected.
 *
 * Both files exist to answer a question from the platform rather than from a
 * constant, and these tests pin the answers so a change in either is visible.
 */

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  delete (window as unknown as Record<string, unknown>).speechSynthesis
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
  vi.restoreAllMocks()
})

describe('speech recognition support', () => {
  it('reports honestly on a platform with no recognition API', () => {
    const support = detectRecognitionSupport()
    expect(support.available).toBe(false)
    expect(support.local).toBe(false)
    expect(support.detail).toMatch(/no browser speech-recognition API/i)
    expect(canTranscribeLocally()).toBe(false)
  })

  it('refuses a cloud recogniser even when the platform has one', () => {
    // The realistic future case: a Chromium that does ship the API. It must still be
    // refused, because the only implementation of it sends audio off this machine,
    // and marking it local would be the single most dishonest line in the file.
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = class {}
    const support = detectRecognitionSupport()
    expect(support.available).toBe(true)
    expect(support.local).toBe(false)
    expect(support.detail).toMatch(/cloud service/i)
    expect(canTranscribeLocally()).toBe(false)
  })

  it('never claims local transcription without an API to do it with', () => {
    ;(window as unknown as Record<string, unknown>).SpeechRecognition = class {}
    expect(canTranscribeLocally()).toBe(false)
  })

  it('does not invoke the constructor it found', () => {
    // A feature detector that calls what it finds is no longer a detector.
    const ctor = vi.fn(function SpeechRecognitionStub() {})
    ;(window as unknown as Record<string, unknown>).SpeechRecognition = ctor
    detectRecognitionSupport()
    expect(ctor).not.toHaveBeenCalled()
  })
})

/** A stand-in for the platform's speech engine, with the sharp edges included. */
function installSynthesizer(options: { voices?: unknown[]; failSpeak?: boolean } = {}) {
  const events = new Map<string, (() => void)[]>()
  const spoken: { text: string; rate: number; pitch: number; voice: unknown }[] = []
  let cancelled = 0
  let paused = 0
  let resumed = 0
  const utteranceFactory = vi.fn(function SpeechSynthesisUtteranceStub(this: Record<string, unknown>, text: string) {
    this.text = text
  })

  const synthesis = {
    speak(utterance: Record<string, unknown>) {
      if (options.failSpeak === true) throw new Error('the platform refused')
      spoken.push({
        text: String(utterance.text),
        rate: Number(utterance.rate),
        pitch: Number(utterance.pitch),
        voice: utterance.voice,
      })
      // The real API has no completion callback, so the test fires `onend` by hand —
      // which is exactly how the production code has to cope.
      queueMicrotask(() => {
        const onend = utterance.onend as (() => void) | null
        onend?.()
      })
    },
    cancel() {
      cancelled += 1
    },
    pause() {
      paused += 1
    },
    resume() {
      resumed += 1
    },
    getVoices: () => options.voices ?? [],
    addEventListener(type: string, listener: () => void) {
      const list = events.get(type) ?? []
      list.push(listener)
      events.set(type, list)
    },
    removeEventListener(type: string, listener: () => void) {
      events.set(type, (events.get(type) ?? []).filter((entry) => entry !== listener))
    },
    speaking: false,
  }

  ;(window as unknown as Record<string, unknown>).speechSynthesis = synthesis
  ;(window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = utteranceFactory
  return {
    synthesis,
    utteranceFactory,
    spoken,
    get cancelled() {
      return cancelled
    },
    get paused() {
      return paused
    },
    get resumed() {
      return resumed
    },
    fire: (type: string) => {
      for (const listener of events.get(type) ?? []) listener()
    },
  }
}

describe('speech output in the window', () => {
  it('reports no engine on a platform with no speech synthesis', () => {
    const output = new WindowSpeechOutput(() => {})
    const capabilities = output.capabilities()
    expect(capabilities.available).toBe(false)
    expect(capabilities.detail).toMatch(/no speech output/i)
  })

  it('distinguishes "no engine" from "no voices yet"', () => {
    installSynthesizer({ voices: [] })
    const capabilities = new WindowSpeechOutput(() => {}).capabilities()
    // Chromium populates the voice list asynchronously on first load. Reporting
    // that as "broken" would be wrong, so it reports itself as still waiting.
    expect(capabilities.available).toBe(false)
    expect(capabilities.detail).toMatch(/has not reported any voices yet/i)
  })

  it('reports the platform voices it actually found, and a useful count', () => {
    installSynthesizer({
      voices: [
        { voiceURI: 'v1', name: 'Voice One', lang: 'en-GB', default: true },
        { voiceURI: 'v2', name: 'Voice Two', lang: null, default: false },
        // No URI: unusable, and excluded rather than passed on as a blank option.
        { name: 'Nameless', lang: 'en-US' },
      ],
    })
    const capabilities = new WindowSpeechOutput(() => {}).capabilities()
    expect(capabilities.available).toBe(true)
    expect(capabilities.voices.map((voice) => voice.voiceId)).toEqual(['v1', 'v2'])
    expect(capabilities.detail).toMatch(/2 voices/i)
    // A language the platform did not report stays null rather than being guessed.
    expect(capabilities.voices[1]?.language).toBeNull()
  })

  it('resumes before every utterance and reports completion exactly once', async () => {
    const platform = installSynthesizer({ voices: [{ voiceURI: 'v1', name: 'One', lang: 'en' }] })
    const reports: [string, string][] = []
    const output = new WindowSpeechOutput((id, outcome) => reports.push([id, outcome]))

    output.play({ utteranceId: 'u1', text: 'hello', voiceId: null, rate: 1, pitch: 1 })
    await Promise.resolve()
    await Promise.resolve()

    expect(platform.spoken[0]?.text).toBe('hello')
    expect(platform.resumed).toBeGreaterThan(0)
    expect(reports).toEqual([['u1', 'completed']])
  })

  it('refuses a second simultaneous utterance rather than layering two', async () => {
    // No `onend`, so the first stays open. Core is the queue; two windows speaking
    // at once would mean its ordering had been bypassed.
    const platform = installSynthesizer({ voices: [{ voiceURI: 'v1', name: 'One', lang: 'en' }] })
    ;(platform.synthesis.speak as unknown) = (utterance: Record<string, unknown>) => {
      platform.spoken.push({ text: String(utterance.text), rate: 1, pitch: 1, voice: null })
    }
    const reports: [string, string][] = []
    const output = new WindowSpeechOutput((id, outcome) => reports.push([id, outcome]))

    output.play({ utteranceId: 'u1', text: 'first', voiceId: null, rate: 1, pitch: 1 })
    output.play({ utteranceId: 'u2', text: 'second', voiceId: null, rate: 1, pitch: 1 })

    expect(platform.spoken).toHaveLength(1)
    expect(reports).toEqual([['u2', 'failed']])
  })

  it('cancels mid-word and stop drains at a boundary', async () => {
    const platform = installSynthesizer({ voices: [{ voiceURI: 'v1', name: 'One', lang: 'en' }] })
    ;(platform.synthesis.speak as unknown) = (utterance: Record<string, unknown>) => {
      platform.spoken.push({ text: String(utterance.text), rate: 1, pitch: 1, voice: null })
    }
    const reports: [string, string][] = []
    const output = new WindowSpeechOutput((id, outcome) => reports.push([id, outcome]))

    output.play({ utteranceId: 'u1', text: 'a long sentence', voiceId: null, rate: 1, pitch: 1 })
    output.cancel()
    expect(platform.cancelled).toBe(1)
    expect(reports).toEqual([['u1', 'failed']])

    output.play({ utteranceId: 'u2', text: 'another', voiceId: null, rate: 1, pitch: 1 })
    output.stop()
    // A polite stop does not use `cancel`: the platform is left to finish cleanly.
    expect(platform.cancelled).toBe(1)
    expect(platform.paused).toBe(1)
    expect(reports).toContainEqual(['u2', 'failed'])
  })

  it('reports a failure rather than leaving Core speaking forever', async () => {
    const platform = installSynthesizer({ voices: [{ voiceURI: 'v1', name: 'One', lang: 'en' }], failSpeak: true })
    const reports: [string, string][] = []
    const output = new WindowSpeechOutput((id, outcome) => reports.push([id, outcome]))
    output.play({ utteranceId: 'u1', text: 'hello', voiceId: null, rate: 1, pitch: 1 })
    expect(reports).toEqual([['u1', 'failed']])
    expect(platform.spoken).toHaveLength(0)
  })

  it('selects a voice by id and leaves an unknown one to the platform default', () => {
    const platform = installSynthesizer({
      voices: [
        { voiceURI: 'v1', name: 'One', lang: 'en' },
        { voiceURI: 'v2', name: 'Two', lang: 'en' },
      ],
    })
    const output = new WindowSpeechOutput(() => {})
    output.play({ utteranceId: 'u1', text: 'hello', voiceId: 'v2', rate: 1, pitch: 1 })
    expect(platform.spoken[0]?.voice).toMatchObject({ voiceURI: 'v2' })

    output.play({ utteranceId: 'u2', text: 'hello again', voiceId: 'not-a-voice', rate: 1, pitch: 1 })
    // An unknown id is not a failure: no voice is assigned, so the platform picks
    // its own. Refusing to speak because a stale selection survived a restart would
    // be the worse behaviour — the person would hear nothing and be told nothing.
    expect(platform.spoken[1]?.voice ?? null).toBeNull()
  })

  it('re-reports when the platform changes its voice list', () => {
    const platform = installSynthesizer({ voices: [] })
    let changes = 0
    const dispose = new WindowSpeechOutput(() => {}).watchVoices(() => {
      changes += 1
    })
    platform.fire('voiceschanged')
    expect(changes).toBe(1)
    dispose()
    platform.fire('voiceschanged')
    expect(changes).toBe(1)
  })
})