import { normalizeWindowInfo, windowSpanKey } from './normalize'
import {
  windowObservationLimits,
  type ActiveWindowInfo,
  type ActiveWindowProvider,
  type ActiveWindowReading,
  type WindowObservationOverrides,
  type WindowObservationLimits,
  type WindowSourceSnapshot,
  type WindowSourceStatus,
  type WindowTimer,
} from './types'

/**
 * THE WINDOW OBSERVATION SOURCE — an opt-in reader of window *identity*.
 *
 * It is a lifecycle, not a capability: nothing is observed until `start()`
 * is called on a source somebody constructed, and after `stop()` the source
 * is inert and holds nothing. Between those two acts it keeps at most one
 * observation — the front app/window, as bounded strings — and that
 * observation *expires*: a window state nobody refreshed is a fact about a
 * past instant, and past instants about somebody's screen must not read as
 * present. This file therefore has three jobs, all of them small:
 *
 *  - **drive the provider honestly.** Prefer its event channel when it has
 *    one; otherwise poll at a clamped cadence, and only when a host supplied
 *    a timer. A provider that throws or says `unavailable` is reported, not
 *    fought; a provider that says `unsupported` stops the whole lane, because
 *    retrying a "cannot" is theatre. An injected invalid reading (a lying id,
 *    a future instant worn as a claimed past, no app name) is dropped at the
 *    seam and counted — the source's state never depends on provider good
 *    behaviour.
 *  - **expire, visibly.** `current(now)` returns the held observation only
 *    while it is inside its TTL; crossing the boundary clears it (the strings
 *    stop being held) and the span key with it, so the same window returning
 *    later is a new observation, not a refresh of an old claim.
 *  - **deduplicate to spans.** A window that stays in front is one
 *    observation: unchanged identity re-reads update nothing downstream, so
 *    the subscription fires once per *change*, which is what keeps a bounded
 *    context scope from filling with the same title bar over and over.
 *
 * There is no `screenshot`, no `capture`, no `pixel`, no `hook` in this file
 * — and a test reads this file's text to make sure the vocabulary stays that
 * way. No call here awaits, so no call here can reach a model: keeping window
 * context current costs zero inference, which is the whole Phase 9 budget.
 */

export interface WindowObservationServiceOptions extends WindowObservationOverrides {
  readonly provider: ActiveWindowProvider
  /** The instant source. Injected so tests run on a clock they control. */
  readonly clock?: () => Date
  /**
   * How often to wake. `0` means events only; absent means "events if the
   * provider has them, else the default cadence". A cadence is only honoured
   * when a `timer` is also provided — this lane never self-schedules.
   */
  readonly timer?: WindowTimer | null
  /** Fired once per new observation span, before any admission is attempted. */
  readonly onObservation?: (observation: ActiveWindowInfo) => void
}

/** What the source did, as counters — the "does nothing" claims are measured, not asserted. */
export interface WindowObservationStats {
  readonly started: boolean
  readonly polls: number
  readonly readings: number
  readonly dropped: number
  readonly failures: number
  readonly emitted: number
  readonly expired: number
}

interface HeldObservation {
  readonly info: ActiveWindowInfo
  readonly expiresAtMs: number
}

export class WindowObservationService {
  private readonly provider: ActiveWindowProvider
  private readonly clock: () => Date
  private readonly timer: WindowTimer | null
  private readonly onObservation: ((observation: ActiveWindowInfo) => void) | null
  readonly limits: WindowObservationLimits

  private started = false
  /** The provider said "this build cannot" — a fact that outlives polls. */
  private unsupported = false
  /** The provider could not read *right now* (or threw); transient by wording. */
  private unavailable = false
  private held: HeldObservation | null = null
  private spanKey: string | null = null
  private cancelTimer: (() => void) | null = null
  private unsubscribe: (() => void) | null = null

  private polls = 0
  private readings = 0
  private dropped = 0
  private failures = 0
  private emitted = 0
  private expired = 0

  constructor(options: WindowObservationServiceOptions) {
    this.provider = options.provider
    this.clock = options.clock ?? ((): Date => new Date())
    this.timer = options.timer === undefined ? null : options.timer
    this.onObservation = options.onObservation ?? null
    this.limits = windowObservationLimits(
      { cadenceMs: options.cadenceMs, ttlMs: options.ttlMs },
      typeof options.provider?.subscribe === 'function',
    )
  }

  /** The bounded cadence a wired host would poll at; 0 means events only. */
  get cadenceMs(): number {
    return this.limits.cadenceMs
  }

  /** How long a held observation stays current. */
  get ttlMs(): number {
    return this.limits.ttlMs
  }

  isStarted(): boolean {
    return this.started
  }

  /**
   * Begin observing — the opt-in act itself.
   *
   * Returns the resulting status truthfully: `unsupported` when the provider
   * says this build cannot observe (nothing subscribed, nothing scheduled,
   * nothing read), `unavailable` when it cannot observe *right now* (the
   * lifecycle opens, but no read is attempted until a poll finds the provider
   * able again), and `observed`/`stale` when observation actually began.
   * Starting a started source is a no-op that answers honestly.
   */
  start(): WindowSourceStatus {
    if (this.started) return this.status()
    this.unsupported = false
    this.unavailable = false

    let state: string
    try {
      state = this.provider.availability()
    } catch {
      // A provider that cannot say what it can do is not "unable forever",
      // it is unknown right now: the lane opens and the next poll re-asks.
      state = 'unavailable'
    }
    if (state === 'unsupported') {
      this.unsupported = true
      return this.status()
    }

    this.started = true
    this.unavailable = state !== 'ready'
    if (typeof this.provider.subscribe === 'function') {
      const listener = (reading: ActiveWindowReading): void => {
        this.consume(reading, this.clock())
      }
      this.unsubscribe = this.provider.subscribe(listener)
    }
    if (this.timer !== null && this.limits.cadenceMs > 0) {
      this.cancelTimer = this.timer.schedule(() => this.poll(), this.limits.cadenceMs)
    }
    this.poll()
    return this.status()
  }

  /**
   * Stop observing. Unsubscribes, unschedules, and destroys the held
   * observation — after `stop()` the source has not merely paused, it knows
   * nothing. Returns `disabled` because that is the whole truth.
   */
  stop(): WindowSourceStatus {
    if (this.cancelTimer !== null) {
      this.cancelTimer()
      this.cancelTimer = null
    }
    if (this.unsubscribe !== null) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.started = false
    this.unsupported = false
    this.unavailable = false
    this.held = null
    this.spanKey = null
    return this.status()
  }

  /**
   * One bounded wake of the provider. A disabled source reads nothing; a
   * provider that has become `unsupported` stops the lane (a "cannot" is not
   * worth polling); `unavailable` or a throwing read is reported through
   * `status()` without inventing or destroying anything else.
   */
  poll(now?: Date): void {
    if (!this.started || this.unsupported) return
    this.polls += 1
    const at = now ?? this.clock()
    if (!Number.isFinite(at.getTime())) return

    let state: string
    try {
      state = this.provider.availability()
    } catch {
      this.failures += 1
      this.unavailable = true
      return
    }
    if (state === 'unsupported') {
      this.stop()
      this.unsupported = true
      return
    }
    if (state === 'unavailable') {
      this.unavailable = true
      this.current(at)
      return
    }
    this.unavailable = false

    let reading: ActiveWindowReading
    try {
      reading = this.provider.read(at)
    } catch {
      this.failures += 1
      this.unavailable = true
      return
    }
    this.consume(reading, at)
  }

  /**
   * The held observation while it is current, else null.
   *
   * Crossing the TTL clears the held strings and the span key: an expired
   * window state is not remembered-but-stale, it is forgotten, and the same
   * window coming back is a new span with a new origin — which is also what
   * makes re-admission after expiry possible.
   */
  current(now?: Date): ActiveWindowInfo | null {
    if (!this.started || this.held === null) return null
    const at = now ?? this.clock()
    // An unusable instant judges nothing — and destroys nothing. The store
    // takes the same stance on the same question.
    if (!Number.isFinite(at.getTime())) return null
    if (at.getTime() >= this.held.expiresAtMs) {
      this.held = null
      this.spanKey = null
      this.expired += 1
      return null
    }
    return this.held.info
  }

  status(now?: Date): WindowSourceStatus {
    if (this.unsupported) return 'unsupported'
    if (!this.started) return 'disabled'
    if (this.unavailable) return 'unavailable'
    return this.current(now) === null ? 'stale' : 'observed'
  }

  /**
   * The source's state as data — safe to log, safe to show, controls nothing.
   *
   * It carries status and bounds only, never the observation's words: the
   * private part leaves through `current()` and the subscription alone, under
   * the caller's own eyes and clock.
   */
  snapshot(now?: Date): WindowSourceSnapshot {
    return {
      started: this.started,
      status: this.status(now),
      providerId: this.provider.providerId,
      cadenceMs: this.limits.cadenceMs,
      ttlMs: this.limits.ttlMs,
      lastObservedAt: this.current(now)?.observedAt ?? null,
    }
  }

  stats(): WindowObservationStats {
    return {
      started: this.started,
      polls: this.polls,
      readings: this.readings,
      dropped: this.dropped,
      failures: this.failures,
      emitted: this.emitted,
      expired: this.expired,
    }
  }

  /* -------------------------------------------------------------- private */

  private consume(reading: ActiveWindowReading, now: Date): void {
    if (!this.started || this.unsupported) return
    this.readings += 1

    if (reading.availability === 'unsupported') {
      this.stop()
      this.unsupported = true
      return
    }
    if (reading.availability === 'unavailable' || reading.window === null) {
      // A hole in the moment: the *lane* flag stays with capability and
      // throws, and the held observation simply ages by its own TTL.
      this.current(now)
      return
    }

    const info = normalizeWindowInfo(
      reading.window,
      this.provider.providerId,
      now,
      this.limits,
    )
    if (info === null) {
      this.dropped += 1
      return
    }
    if (now.getTime() >= Date.parse(info.observedAt) + this.limits.ttlMs) {
      // Stale on arrival: a reading that cannot honestly claim to be current
      // now is not an observation, and this lane does not admit echoes.
      this.dropped += 1
      return
    }
    this.unavailable = false

    const fresh = this.current(now)
    const key = windowSpanKey(info)
    if (fresh !== null && this.spanKey === key &&
        now.getTime() < Date.parse(fresh.observedAt) + this.limits.ttlMs) {
      // Keep short refreshes in one span. At the original TTL, emit a fresh
      // observation so the Core admission does not expire under a live source.
      this.held = { info: fresh, expiresAtMs: now.getTime() + this.limits.ttlMs }
      return
    }
    if (fresh !== null && this.spanKey !== null) this.spanChanged()

    this.held = { info, expiresAtMs: now.getTime() + this.limits.ttlMs }
    this.spanKey = key
    this.emitted += 1
    if (this.onObservation !== null) this.onObservation(info)
  }

  /** A span ended by a new observation, not by a clock: same bookkeeping. */
  private spanChanged(): void {
    this.held = null
    this.spanKey = null
  }
}
