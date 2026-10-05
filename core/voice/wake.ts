import { VOICE_LIMITS, type WakeAvailability, type WakeGate } from './types'

/**
 * Hands-free wake.
 *
 * ## What this is, stated precisely
 *
 * A **local energy gate**. The owner turns it on, the platform measures how loud
 * the room is, and sustained speech-level energy arms an ordinary capture. It is
 * not a wake word. There is no wake-word model in this build, and there is no
 * code path that pretends there is: naming this feature "wake word" would be the
 * one dishonest word in an otherwise honest subsystem.
 *
 * So the projection says `speech-activity wake`, the detail says it responds to
 * sustained local speech rather than to a name, and a person who needs a wake
 * *phrase* learns from the UI that this is not one.
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
 * - **Local only.** The measurement is an RMS of samples already in memory for a
 *   capture that is about to happen anyway. Nothing is transmitted, and there is
 *   no streaming recogniser sitting behind it.
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
  return { ...LOCAL_ENERGY_WAKE_GATE, availability: 'available' }
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