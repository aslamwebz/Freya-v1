import { useEffect, useState } from 'react'
import type { CoreView, Resource } from '../../ui-v2/state/contract'
import './boot.css'

/**
 * What the boot screen is waiting for, in words.
 *
 * A loading screen has exactly one honest failure mode: pretending to know. A
 * progress bar that fills to 100% on a timer is a promise the boot sequence did
 * not make, and the number on it is invented. So there is no percentage here.
 * There is one line of text naming the step Freya is actually on, derived from
 * Core's own status, and a bar whose width is *elapsed time* — visibly
 * approaching the ceiling rather than pretending to reach an answer.
 *
 * Three states, because they are genuinely different:
 *
 *   - `starting`   — Core is booting. Work is happening.
 *   - `degraded`   — Core reported something that is not `running`. Said as
 *                    Core said it, not softened.
 *   - `waiting`    — no status has arrived at all yet. Not the same as
 *                    "stopped": nothing has reported that it stopped.
 */

/** How long the screen waits before it stops waiting and lets the shell show. */
const BOOT_TIMEOUT_MS = 12_000

/** Never shorter than this, so a fast boot does not flash a loading screen. */
const MIN_VISIBLE_MS = 550

export type BootPhase = 'starting' | 'degraded' | 'waiting'

export interface BootScreenProps {
  /** The Core resource. `loading` means Core has not reported yet. */
  readonly core: Resource<CoreView>
  /**
   * Whether the window is attached to a desktop host.
   *
   * A browser preview has no Core to wait for, so it must not sit behind a boot
   * screen waiting for something that will never arrive — it passes `true` here
   * and leaves on the minimum-visible timer alone.
   */
  readonly attached: boolean
  /** Called once the boot screen may be removed. */
  readonly onDone: () => void
}

function phaseOf(core: Resource<CoreView>, attached: boolean): { phase: BootPhase; line: string } {
  if (!attached) {
    return { phase: 'waiting', line: 'No desktop host is attached to this window.' }
  }
  if (core.status === 'loading') {
    return { phase: 'waiting', line: 'Waiting for Freya Core to answer…' }
  }
  if (core.status === 'ready' || core.status === 'stale') {
    const lifecycle = core.data.lifecycle
    // A Core that is operationally up (degraded or ready) opens the
    // workspace. A Core that is still booting waits. Anything else is a
    // genuine answer that the shell renders on the dashboard.
    if (core.data.operational) {
      return { phase: 'starting', line: lifecycle === 'degraded'
        ? 'Freya Core started in degraded mode. Opening your workspace…'
        : 'Freya Core is running. Opening your workspace…' }
    }
    if (lifecycle === 'booting' || lifecycle === 'starting') return { phase: 'waiting', line: 'Freya Core is starting…' }
    return { phase: 'degraded', line: `Freya Core reports “${lifecycle}”. Opening anyway…` }
  }
  // `unavailable` and `error` both mean Core answered, and the answer was that it
  // cannot serve this window. The shell renders that state truthfully on every
  // panel, so there is nothing to wait for.
  return { phase: 'degraded', line: core.reason }
}

export function BootScreen({ core, attached, onDone }: BootScreenProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const started = performance.now()
    const timer = window.setInterval(() => setElapsed(performance.now() - started), 90)
    return () => window.clearInterval(timer)
  }, [])

  const { phase, line } = phaseOf(core, attached)
  const ready = phase !== 'waiting'
  const sinceStart = elapsed >= MIN_VISIBLE_MS
  const timedOut = elapsed >= BOOT_TIMEOUT_MS
  // Core running is the real signal. The timer is the backstop, and it only
  // applies once Core has had its minimum: a slow machine shows a longer wait
  // rather than a screen that vanishes while Core is still booting.
  const finished = (ready && sinceStart) || timedOut

  useEffect(() => {
    if (!finished) return
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed)
    const timer = window.setTimeout(onDone, remaining)
    return () => window.clearTimeout(timer)
  }, [finished, elapsed, onDone])

  const fill = Math.min(100, (elapsed / BOOT_TIMEOUT_MS) * 100)

  return (
    <div className="freya-boot" data-phase={phase} role="status" aria-live="polite">
      <div className="freya-boot-stage" aria-hidden="true">
        <span className="freya-boot-halo" />
        <span className="freya-boot-sigil">
          <i />
          <i />
          <b />
        </span>
      </div>
      <h1 className="freya-boot-wordmark">FREYA</h1>
      <p className="freya-boot-line">{line}</p>
      <div className="freya-boot-track" aria-hidden="true">
        <span className="freya-boot-fill" style={{ width: `${fill}%` }} data-stalled={timedOut || undefined} />
      </div>
      <small className="freya-boot-foot">Persistent · Evolving · Aligned</small>
    </div>
  )
}
