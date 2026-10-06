import { VOICE_LIMITS, type VoiceOption } from '../../core/voice/types'

/**
 * Speech output in the window.
 *
 * `speechSynthesis` is an operating-system facility that Chromium exposes here,
 * which is why this build can genuinely read an answer aloud without a network,
 * a credential or an endpoint. It is also a fairly thin API with some sharp
 * edges, and this file is where the edges are.
 *
 * ## The edges, and what each one would cost if ignored
 *
 * **It needs a user gesture on some platforms.** Chrome historically refused to
 * speak without one. Freya's answers come from a turn the owner started, so in
 * practice the gesture exists — but a queued utterance arriving after the gesture
 * has expired can be dropped silently, and a dropped utterance means Core's
 * `speaking` never clears. So *every* utterance is given its own `resume()`, and
 * `onerror` is treated as a failure to report rather than as silence.
 *
 * **`cancel()` truncates mid-word.** That is exactly what barge-in and STOP ALL
 * want and exactly what a polite "stop" does not, so both exist: `stop` pauses at
 * the boundary the platform chooses, `cancel` cuts now.
 *
 * **`speak()` is not a promise.** The API has no completion callback, so playback
 * completion is inferred from `onend`. An utterance that never fires `onend` would
 * wedge the indicator, so a watchdog timer ends it and reports a failure — which
 * is truthful, because an utterance that did not finish did not finish.
 *
 * ## What it never does
 *
 * It never fetches anything. There is no URL in this file, no `fetch`, and no
 * credential, because there is nothing to authenticate to.
 */

/** The subset of `SpeechSynthesisUtterance` this file touches. */
interface PlatformUtterance {
  text: string
  rate: number
  pitch: number
  volume: number
  voice: unknown
  onend: (() => void) | null
  onerror: ((event: unknown) => void) | null
  addEventListener(type: string, listener: () => void): void
}

/** The subset of `SpeechSynthesis` this file touches. */
interface PlatformSynthesis {
  speak(utterance: PlatformUtterance): void
  cancel(): void
  pause(): void
  resume(): void
  getVoices(): readonly unknown[]
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  speaking: boolean
}

function platformSynthesis(): PlatformSynthesis | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as { speechSynthesis?: PlatformSynthesis }).speechSynthesis
  return candidate ?? null
}

/** Longer than any sensible answer, and short enough to notice a wedge. */
const UTTERANCE_WATCHDOG_MS = VOICE_LIMITS.maxSpeechCharacters * 100

export type PlaybackReport = 'completed' | 'failed'

export interface PlayRequest {
  utteranceId: string
  text: string
  voiceId: string | null
  rate: number
  pitch: number
}

/**
 * The window's speech output.
 *
 * One utterance at a time, and it says so. Core queues and orders, so a second
 * simultaneous utterance would mean two windows had both been told to speak and
 * Core's ordering had been bypassed — which is worth refusing rather than
 * layering over.
 */
export class WindowSpeechOutput {
  private current: { utteranceId: string; utterance: PlatformUtterance } | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private readonly report: (utteranceId: string, outcome: PlaybackReport) => void
  private readonly synthesiser = platformSynthesis()

  constructor(report: (utteranceId: string, outcome: PlaybackReport) => void) {
    this.report = report
  }

  /**
   * What this platform actually offers.
   *
   * Feature-detected rather than assumed, and the voice list is read on demand
   * because Chromium populates it asynchronously on first load — an empty array on
   * the first read is the normal case, not a missing engine.
   */
  capabilities(): { available: boolean; voices: VoiceOption[]; detail: string } {
    const synthesis = this.synthesiser
    if (synthesis === null) {
      return {
        available: false,
        voices: [],
        detail: 'This window has no speech output, so Freya does not read replies aloud.',
      }
    }
    const voices = this.voiceOptions()
    if (voices.length === 0) {
      return {
        // "No voices yet" is not "no engine". Chromium installs voices after first
        // paint on some platforms, so this reports itself as still waiting rather
        // than as broken — and `voiceschanged` re-reports when they land.
        available: false,
        voices: [],
        detail:
          'The window can reach the platform speech engine, which has not reported any voices yet.',
      }
    }
    return {
      available: true,
      voices,
      detail: `The platform speech engine, with ${voices.length} voice${voices.length === 1 ? '' : 's'} available. Audio never leaves this machine.`,
    }
  }

  /** Re-report when the platform's voice list changes. Returns a disposer. */
  watchVoices(onChange: () => void): () => void {
    const synthesis = this.synthesiser
    if (synthesis === null) return () => {}
    synthesis.addEventListener('voiceschanged', onChange)
    return () => synthesis.removeEventListener('voiceschanged', onChange)
  }

  /**
   * Play one utterance, reporting exactly once when it ends.
   *
   * `completed` means the platform said the utterance finished. `failed` covers
   * every other ending — an error event, a watchdog expiry, being asked to stop or
   * cancel — because the alternative is a Core state that never resolves.
   */
  play(request: PlayRequest): void {
    const synthesis = this.synthesiser
    if (synthesis === null || request.text.trim().length === 0) {
      this.report(request.utteranceId, 'failed')
      return
    }
    if (this.current !== null) {
      // Core is the queue. Two windows both speaking would mean Core's ordering was
      // bypassed, so the newer utterance is refused rather than layered on top.
      this.report(request.utteranceId, 'failed')
      return
    }

    const UtteranceCtor = (window as unknown as { SpeechSynthesisUtterance?: new (text: string) => PlatformUtterance })
      .SpeechSynthesisUtterance
    if (UtteranceCtor === undefined) {
      this.report(request.utteranceId, 'failed')
      return
    }

    const utterance = new UtteranceCtor(request.text)
    utterance.rate = request.rate
    utterance.pitch = request.pitch
    utterance.volume = 1
    const voice = this.findVoice(request.voiceId)
    if (voice !== null) utterance.voice = voice

    let settled = false
    const settle = (outcome: PlaybackReport): void => {
      if (settled) return
      settled = true
      if (this.watchdog !== null) {
        clearTimeout(this.watchdog)
        this.watchdog = null
      }
      if (this.current?.utteranceId === request.utteranceId) this.current = null
      this.report(request.utteranceId, outcome)
    }

    utterance.onend = () => settle('completed')
    utterance.onerror = () => settle('failed')
    this.current = { utteranceId: request.utteranceId, utterance }

    try {
      // Resumed before every utterance: the platform pauses itself under some
      // conditions, and a paused queue is a queue that never reports.
      synthesis.resume()
      synthesis.speak(utterance)
    } catch {
      settle('failed')
      return
    }

    this.watchdog = setTimeout(() => {
      // An utterance that has not ended in far longer than its text could take has
      // wedged. Stopping it and saying so is the truthful outcome; leaving the
      // indicator lit forever is not.
      try {
        synthesis.cancel()
      } catch {
        /* nothing further to do */
      }
      settle('failed')
    }, Math.min(UTTERANCE_WATCHDOG_MS, 120_000))
  }

  /** Finish at a boundary. */
  stop(): void {
    this.cancel()
  }

  /** Cut off mid-word. */
  cancel(): void {
    try {
      this.synthesiser?.cancel()
    } catch {
      /* already gone */
    }
    this.settleCurrent('failed')
  }

  /** Whether anything is playing right now. */
  get speaking(): boolean {
    return this.current !== null
  }

  private settleCurrent(outcome: PlaybackReport): void {
    const current = this.current
    if (current === null) return
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
    this.current = null
    this.report(current.utteranceId, outcome)
  }

  private voiceOptions(): VoiceOption[] {
    const synthesis = this.synthesiser
    if (synthesis === null) return []
    const options: VoiceOption[] = []
    for (const raw of synthesis.getVoices()) {
      const voice = raw as { voiceURI?: unknown; name?: unknown; lang?: unknown; default?: unknown }
      const voiceId = typeof voice.voiceURI === 'string' && voice.voiceURI.length > 0 ? voice.voiceURI : null
      const label = typeof voice.name === 'string' && voice.name.length > 0 ? voice.name : null
      if (voiceId === null || label === null) continue
      options.push({
        voiceId,
        label,
        // Reported, never guessed: a null language is honest about the platform
        // not saying, and a made-up BCP-47 tag would be a fabrication.
        language: typeof voice.lang === 'string' && voice.lang.length > 0 ? voice.lang : null,
        isDefault: typeof voice.default === 'boolean' ? voice.default : null,
      })
    }
    // Bounded, so a platform reporting thousands of entries cannot produce an
    // unbounded IPC message.
    return options.slice(0, 200)
  }

  private findVoice(voiceId: string | null): unknown {
    const synthesis = this.synthesiser
    if (synthesis === null) return null
    if (voiceId === null) return null
    for (const raw of synthesis.getVoices()) {
      const voice = raw as { voiceURI?: unknown }
      if (voice.voiceURI === voiceId) return raw
    }
    return null
  }
}
