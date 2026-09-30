/**
 * The microphone level channel.
 *
 * A real microphone produces audio frames far faster than a UI can usefully
 * re-render. Routing that through React state would mean a re-render per frame,
 * which is how a chat window ends up spending its time in reconciliation while
 * someone is talking to it.
 *
 * So the level is a single mutable number with a subscriber list — read by the
 * presence's own animation loop, which is already running at frame rate, and by
 * nobody else. No component re-renders because someone spoke.
 *
 * It lives outside React entirely, which is the point: the presence already owns
 * one clock, and this feeds it rather than starting a second.
 */

type LevelListener = (level: number) => void

let current = 0
const listeners = new Set<LevelListener>()

/**
 * Publish a level, 0..1.
 *
 * Called from the audio callback, so it must stay cheap and must not throw into
 * the audio thread: a subscriber that throws is dropped rather than allowed to
 * break the capture.
 */
export function publishMicLevel(level: number): void {
  const clamped = level < 0 ? 0 : level > 1 ? 1 : level
  current = clamped
  for (const listener of [...listeners]) {
    try {
      listener(clamped)
    } catch {
      listeners.delete(listener)
    }
  }
}

/** The latest level. Read by the presence loop, once per frame. */
export function micLevel(): number {
  return current
}

/**
 * Subscribe to level changes.
 *
 * Returns a disposer. A presence that unmounts must not be left in the list,
 * because a leaked listener in a per-frame path is a leak that costs CPU forever.
 */
export function subscribeMicLevel(listener: LevelListener): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Reset to silence.
 *
 * Called when the microphone closes, so the level decays from where it actually
 * was rather than jumping to zero and looking like a cut.
 */
export function clearMicLevel(): void {
  publishMicLevel(0)
}
