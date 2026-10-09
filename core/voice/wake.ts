import { VOICE_LIMITS, type WakeAvailability, type WakeGate } from './types'

/**
 * Hands-free wake.
 *
 * ## What this is, stated precisely
 *
 * A **local speech-activity gate**, and deliberately only that.
 *
 * The gate itself does not recognise words. When the owner explicitly arms
 * hands-free, the renderer keeps a tiny bounded in-memory pre-roll. Sustained
 * local speech asks Core for one ordinary wake capture; the configured STT then
 * transcribes that single clip, and Core's voice-attention layer decides whether
 * it began with the wake phrase "Freya" or belongs to an already-open follow-up
 * window.
 *
 * That distinction matters: local VAD is the cheap sensor, STT is hearing, and
 * Core owns the address/attention decision. This module never claims that energy
 * alone heard a name and never creates a conversation turn.
 *
 * ## Why that is still worth shipping
 *
 * It is off by default, it is never armed without an explicit owner command, it
 * disarms itself after fifteen minutes whether or not anything happened, and it
 * grants nothing at all when it fires. The capture it triggers then has to satisfy
 * every ordinary precondition: the microphone has to be enabled, permission has to
 * be held, and STOP ALL has to be clear. A wake signal is a hint that somebody is
 * talking, and a hint is not authority.
 *
 * ## Why it is bounded
 *
 * Three bounds, all fixed here rather than negotiated:
 *
 * - **Local pre-filter.** The continuous part is only RMS/VAD plus the bounded
 *   pre-roll. There is no continuous cloud recogniser. When speech fires the gate,
 *   one bounded clip may be sent to the explicitly configured STT provider, and
 *   the Settings surface says that plainly.
 * - **No persistence.** A gate that fired leaves an event carrying a duration and
 *   nothing else. The audio it measured is dropped.
 * - **Self-disarming.** `maxArmedMs` is a ceiling on how long the machine can sit
 *   with an open microphone for a mode nobody is currently using.
 */

/** The default gate. Deterministic, local, and honest about what it measures. */
export const LOCAL_ENERGY_WAKE_GATE: WakeGate = Object.freeze({
  id: 'local-energy-wake',
  availability: 'unavailable' as WakeAvailability,
  detail:
    'Hands-free wake needs a local speech-activity gate, which this build does not have configured. ' +
    'Push-to-talk is unaffected and remains the way to speak to Freya.',
  /**
   * Roughly −34 dBFS after the renderer's perceptual mapping.
   *
   * Low enough for a quiet room, high enough that a fan does not keep the
   * microphone open. It is a *detection* threshold, not a recording sensitivity.
   */
  threshold: 0.14,
  /** Long enough that a cough or a door does not arm it. */
  sustainMs: 480,
  maxArmedMs: VOICE_LIMITS.maxWakeArmedMs,
})

/** The gate a build gets when the host has supplied a working one. */
export function buildLocalWakeGate(): WakeGate {
  return { ...LOCAL_ENERGY_WAKE_GATE, id: 'local-freya-keyword', availability: 'available', detail: 'Standby checks only for “Freya” locally. After “Yes?”, speak normally. Say “stand by” to finish. Turns off after fifteen minutes.' }
}

/**
 * Whether a run of frames crosses the gate.
 *
 * A pure function of the measurements, so the decision is testable without an
 * audio device and without a timer: give it the frame levels and it says whether
 * the gate fires. `sustainedMs` is accumulated by the caller as it goes, because
 * the gate must decide *during* a run rather than after it.
 */
export function crossesWakeThreshold(level: number, gate: WakeGate): boolean {
  if (!Number.isFinite(level)) return false
  return level >= gate.threshold
}

/** A wake gate that cannot be armed, for a build with no local detector. */
export function unavailableWakeGate(reason: string): WakeGate {
  return { ...LOCAL_ENERGY_WAKE_GATE, detail: reason }
}
