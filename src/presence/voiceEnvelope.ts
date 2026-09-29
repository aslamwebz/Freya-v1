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
 */

const now = () => performance.now() / 1000

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

class VoiceEnvelope {
  private phrase: { kind: 'user' | 'ai'; start: number; duration: number; said: boolean } | null = null
  private user = 0
  private ai = 0
  private morph = 0
  private quietSince = 0
  private spoke = false

  /** You are speaking. */
  simulateUser(): void {
    this.phrase = { kind: 'user', start: now(), duration: 2.6, said: false }
  }

  /** Freya is answering. Starts with a beat of silence, the way a pause reads. */
  simulateReply(): void {
    this.phrase = { kind: 'ai', start: now() + 0.7, duration: 3.4, said: false }
  }

  get active(): boolean {
    return this.phrase !== null
  }

  /**
   * Advance the envelope and return the levels for this frame.
   * Fast attack, slow release, so a level reads as a voice rather than a meter.
   */
  sample(time: number): VoiceLevels {
    let user = 0
    let ai = 0

    if (this.phrase) {
      const elapsed = time - this.phrase.start
      const k = elapsed / this.phrase.duration
      if (this.phrase.kind === 'user') {
        if (k >= 1) {
          this.phrase = null
          // You stopped talking. Freya answers.
          this.simulateReply()
        } else if (k >= 0) {
          user = Math.max(user, speech(time * 1.3) * Math.sqrt(Math.sin(k * Math.PI)))
        }
      } else if (k < 0) {
        ai = 0.12 + 0.08 * Math.sin(time * 14) // thinking shimmer
      } else if (k >= 1) {
        this.phrase = null
      } else {
        ai = speech(time * 1.1 + 3) * Math.pow(Math.sin(k * Math.PI), 0.4)
      }
    }

    // Speech detection without a device: a sustained level counts as speaking,
    // and a pause longer than the tail means the turn has ended.
    if (user > 0.12) {
      this.spoke = true
      this.quietSince = time
    } else if (this.spoke && time - this.quietSince > 1.3 && !this.phrase) {
      this.spoke = false
      this.simulateReply()
    }

    this.user += (user - this.user) * (user > this.user ? 0.5 : 0.12)
    this.ai += (ai - this.ai) * (ai > this.ai ? 0.4 : 0.1)

    const level = Math.max(this.user, this.ai)
    const target = Math.min(1, Math.max(0, (level - 0.04) / 0.24))
    this.morph += (target - this.morph) * (target > this.morph ? 0.2 : 0.045)

    return { user: this.user, ai: this.ai, morph: this.morph }
  }
}

export const voiceEnvelope = new VoiceEnvelope()
