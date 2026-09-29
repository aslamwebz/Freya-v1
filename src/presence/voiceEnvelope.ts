import type { VoiceLevels } from './pieces/types'

/**
 * The voice envelope.
 *
 * Phase 0 has no speech stack and the desktop host grants no microphone
 * permission, so the level signal is generated locally from a speech-shaped
 * envelope rather than read from a device. Everything downstream of it — the
 * smoothing, the ring erosion, the orb's response bars, the state machine that
 * treats "you stopped talking" as "Freya answers" — is real and is exercised
 * now, so that wiring a real analyser later changes one function.
 *
 * The envelope owns its clock. Taking the time from the caller meant the phrase
 * start and the sample had to agree on which clock they were on, and a single
 * disagreement means the reaction silently never fires.
 */

const defaultNow = () => performance.now() / 1000

/** Syllables inside words inside phrases. */
function speech(x: number): number {
  return Math.min(
    1,
    Math.max(
      0,
      (0.55 + 0.45 * Math.sin(x * 11)) *
        (0.6 + 0.4 * Math.sin(x * 3.7 + 1)) *
        (0.75 + 0.25 * Math.sin(x * 23)) *
        (Math.sin(x * 1.3) > -0.6 ? 1 : 0.15),
    ),
  )
}

interface Phrase {
  kind: 'user' | 'ai'
  start: number
  duration: number
}

/**
 * Smoothing rates, per second.
 *
 * These are time-based rather than per-frame: a level that rises at a different
 * speed on a 30 Hz display than on a 144 Hz one is not a voice, it is a frame
 * counter.
 */
const RATE = {
  userAttack: 24,
  userRelease: 6,
  aiAttack: 16,
  aiRelease: 4.4,
  morphAttack: 6,
  morphRelease: 1.05,
}

const step = (perSecond: number, dt: number) => 1 - Math.exp(-perSecond * dt)

export class VoiceEnvelope {
  private phrase: Phrase | null = null
  private user = 0
  private ai = 0
  private morph = 0
  private quietSince = 0
  private spoke = false
  private lastSample: number | null = null

  constructor(private readonly now: () => number = defaultNow) {}

  /** You are speaking. */
  simulateUser(): void {
    this.phrase = { kind: 'user', start: this.now(), duration: 2.6 }
  }

  /** Freya is answering. Starts after a beat, the way a pause reads. */
  simulateReply(): void {
    this.phrase = { kind: 'ai', start: this.now() + 0.7, duration: 3.4 }
  }

  get active(): boolean {
    return this.phrase !== null
  }

  /**
   * Advance the envelope and return this frame's levels.
   * Fast attack, slow release, so a level reads as a voice rather than a meter.
   */
  sample(): VoiceLevels {
    const time = this.now()
    // A long gap — a backgrounded tab, a stalled frame — must not make the
    // level jump; clamp it and let the smoothing catch up.
    const dt = this.lastSample === null ? 1 / 60 : Math.min(time - this.lastSample, 0.25)
    const attackUser = step(RATE.userAttack, dt)
    const releaseUser = step(RATE.userRelease, dt)
    const attackAi = step(RATE.aiAttack, dt)
    const releaseAi = step(RATE.aiRelease, dt)
    const attackMorph = step(RATE.morphAttack, dt)
    const releaseMorph = step(RATE.morphRelease, dt)

    let user = 0
    let ai = 0

    if (this.phrase) {
      const k = (time - this.phrase.start) / this.phrase.duration
      if (this.phrase.kind === 'user') {
        if (k >= 1) {
          // You stopped talking. Freya answers — once.
          this.spoke = false
          this.simulateReply()
        } else if (k >= 0) {
          user = speech(time * 1.3) * Math.sqrt(Math.sin(k * Math.PI))
        }
      } else if (k < 0) {
        ai = 0.12 + 0.08 * Math.sin(time * 14) // the shimmer of thinking
      } else if (k >= 1) {
        this.phrase = null
      } else {
        ai = speech(time * 1.1 + 3) * Math.pow(Math.sin(k * Math.PI), 0.4)
      }
    }

    // Speech detection without a device: a sustained level counts as speaking,
    // and a pause longer than the tail ends the turn. `spoke` is cleared when
    // the turn is handed over, so a single utterance can never start an
    // unbounded chain of replies.
    if (user > 0.12) {
      this.spoke = true
      this.quietSince = time
    } else if (this.spoke && time - this.quietSince > 1.3 && !this.phrase) {
      this.spoke = false
      this.simulateReply()
    }

    this.user += (user - this.user) * (user > this.user ? attackUser : releaseUser)
    this.ai += (ai - this.ai) * (ai > this.ai ? attackAi : releaseAi)

    const level = Math.max(this.user, this.ai)
    const target = Math.min(1, Math.max(0, (level - 0.04) / 0.24))
    this.morph += (target - this.morph) * (target > this.morph ? attackMorph : releaseMorph)

    this.lastSample = time
    return { user: this.user, ai: this.ai, morph: this.morph }
  }
}

export const voiceEnvelope = new VoiceEnvelope()
