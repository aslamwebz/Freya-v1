import {
  WindowObservationService,
  createActiveWindowAdmitter,
  type ActiveWindowInfo,
  type ActiveWindowProvider,
  type WindowAdmissionSink,
  type WindowObservationStats,
  type WindowSourceStatus,
  type WindowTimer,
} from '../../core/context/sources/window'
import type { ContextAdmissionResult, ContextScope } from '../../core/context/types'

/**
 * THE OPT-IN WINDOW OBSERVATION RUNTIME.
 *
 * This is the smallest object a wired desktop host would ever build, and it
 * exists to make one guarantee structural rather than courteous: **a disabled
 * runtime touches nothing.** When `enabled` is false it does not subscribe,
 * does not schedule, does not read the provider, and does not admit — it has
 * no service to do those with. That is the "no ambient global capture when
 * disabled" acceptance expressed as construction, not as a flag checked at
 * every call site where it could be missed.
 *
 * When enabled, it is only a coupler: the source service holds observations
 * and fires once per span; the admitter turns each fired observation into a
 * `ContextAdmission` handed to the sink the caller already owns and revokes
 * the one it superseded. The runtime owns no store, exposes no IPC, and adds
 * no method that could act on a window — it observes, and observation is not
 * a verb you point at a screen or a permission. Production enablement (a live
 * Core admission boundary and a real provider) is issue #27's and the native
 * host's; nothing in `main.ts`/`coreHost.ts`/`preload.ts` is changed by this
 * lane, and a test holds that line.
 */

export interface WindowObservationRuntimeOptions {
  /** The explicit opt-in. False means the runtime is inert by construction. */
  readonly enabled: boolean
  readonly provider: ActiveWindowProvider
  readonly sink: WindowAdmissionSink
  readonly scope: ContextScope
  readonly clock?: () => Date
  readonly timer?: WindowTimer | null
  readonly ttlMs?: number | null
  readonly cadenceMs?: number | null
  /** Read-only reporting hook; it cannot veto or rewrite an observation. */
  readonly onAdmission?: (result: ContextAdmissionResult) => void
}

export interface WindowObservationRuntime {
  readonly enabled: boolean
  start(): WindowSourceStatus
  stop(): WindowSourceStatus
  poll(now?: Date): void
  status(now?: Date): WindowSourceStatus
  current(now?: Date): ActiveWindowInfo | null
  stats(): WindowObservationStats
}

/**
 * Build the runtime. Inert when disabled — the provider is never even asked
 * whether it is available, because asking is the first step of observing.
 */
export function createWindowObservationRuntime(
  options: WindowObservationRuntimeOptions,
): WindowObservationRuntime {
  if (!options.enabled) {
    const disabledStats: WindowObservationStats = {
      started: false,
      polls: 0,
      readings: 0,
      dropped: 0,
      failures: 0,
      emitted: 0,
      expired: 0,
    }
    return {
      enabled: false,
      start: () => 'disabled',
      stop: () => 'disabled',
      poll: () => undefined,
      status: () => 'disabled',
      current: () => null,
      stats: () => disabledStats,
    }
  }

  const admit = createActiveWindowAdmitter({
    sink: options.sink,
    scope: options.scope,
    clock: options.clock,
    ttlMs: options.ttlMs,
  })

  const service = new WindowObservationService({
    provider: options.provider,
    clock: options.clock,
    timer: options.timer,
    ttlMs: options.ttlMs,
    cadenceMs: options.cadenceMs,
    onObservation: (observation) => {
      const result = admit(observation)
      if (options.onAdmission) options.onAdmission(result)
    },
  })

  return {
    enabled: true,
    start: () => service.start(),
    stop: () => service.stop(),
    poll: (now) => service.poll(now),
    status: (now) => service.status(now),
    current: (now) => service.current(now),
    stats: () => service.stats(),
  }
}
