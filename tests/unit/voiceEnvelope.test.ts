import { describe, expect, it } from 'vitest'
import { VoiceEnvelope } from '../../src/presence/voiceEnvelope'

/**
 * The envelope owns its clock, so a test can hand it one and step it. That is
 * what makes the whole turn-taking behaviour — speak, pause, Freya answers —
 * deterministic rather than a race against `performance.now()`.
 */
function fakeClock(start = 0) {
  let t = start
  const envelope = new VoiceEnvelope(() => t)
  return {
    envelope,
    now: () => t,
    /** Step in frames, returning every level produced. */
    run: (seconds: number, frames = 60) => {
      const levels = []
      for (let i = 0; i < Math.round(seconds * frames); i += 1) {
        t += 1 / frames
        levels.push(envelope.sample())
      }
      return levels
    },
  }
}

describe('voice envelope', () => {
  it('is silent when nothing is happening', () => {
    const { envelope, run } = fakeClock()
    const peak = run(2).reduce((max, l) => Math.max(max, l.user + l.ai), 0)
    expect(peak).toBe(0)
    expect(envelope.active).toBe(false)
  })

  it('rises above silence while the user is speaking and decays afterwards', () => {
    const { envelope, run } = fakeClock()
    envelope.simulateUser()
    expect(envelope.active).toBe(true)

    const speaking = run(2.4)
    const peak = speaking.reduce((max, l) => Math.max(max, l.user), 0)
    expect(peak).toBeGreaterThan(0.4)

    const settled = run(3.0)
    const after = settled[settled.length - 1]!
    expect(after.user).toBeLessThan(peak)
  })

  it('hands the turn to Freya when the user stops talking', () => {
    const { envelope, run } = fakeClock()
    envelope.simulateUser()
    // Past the 2.6s phrase, the envelope has handed over.
    run(3.0)

    const duringReply = envelope.sample()
    expect(duringReply.ai).toBeGreaterThan(0)
    expect(duringReply.user).toBeLessThan(0.2)
  })

  it('returns to silence once the reply has finished', () => {
    const { envelope, run } = fakeClock()
    envelope.simulateUser()
    run(3.0)
    run(3.2)
    // Settle frame by frame: the release is slow by design, and a single
    // large time jump is explicitly clamped so a stalled frame cannot
    // teleport the level.
    const settled = run(4.0)
    const quiet = settled[settled.length - 1]!
    expect(quiet.ai).toBeLessThan(0.05)
    expect(quiet.morph).toBeLessThan(0.1)
  })

  it('erodes the rings only while there is a level, and releases slowly', () => {
    const { envelope, run } = fakeClock()
    envelope.simulateUser()

    let peak = 0
    for (const level of run(2.2)) peak = Math.max(peak, level.morph)
    expect(peak).toBeGreaterThan(0.3)

    // The release is deliberately slower than the attack, so the rings settle
    // rather than snapping back.
    let releasePeak = 0
    for (const level of run(1.2)) releasePeak = Math.max(releasePeak, level.morph)
    expect(releasePeak).toBeLessThan(peak)
  })
})
