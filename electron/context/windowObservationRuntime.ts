import {
  WindowObservationService,
  createActiveWindowAdmitter,
  createActiveWindowFacadeAdmitter,
  type ActiveWindowAdmissionLane,
  type ActiveWindowInfo,
  type ActiveWindowProvider,
  type WindowAdmissionSink,
  type WindowObservationStats,
  type WindowSourceStatus,
  type WindowTimer,
} from '../../core/context/sources/window'
import type { ContextAdmissionResult, ContextScope } from '../../core/context/types'
import type { ContextCommandOutcome } from '../../core/protocol/context'

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
 * and fires once per span; an admitter turns each fired observation into a
 * request at one of the two narrow doors the domain owns — the caller-supplied
 * store-shaped sink (`ContextStore` satisfies it structurally), or the merged
 * Core facade's host lane (`ContextIntegration.admitHostReport`/`revoke`, via
 * `createActiveWindowFacadeAdmitter`). The runtime owns no store, exposes no
 * IPC, and adds no method that could act on a window — it observes, and
 * observation is not a verb you point at a screen or a permission. Enabling
 * this in production remains the host composition's explicit act — no file in
 * `main.ts`/`coreHost.ts`/`preload.ts` constructs it, and a test holds that
 * line — but since #27 the door it would hand its observations to exists.
 */

/**
 * The admission door, exactly one of two.
 *
 * The union is deliberate: a runtime that could admit to *both* would be one
 * refactor away from double-writing provenance, and a runtime with *neither*
 * would be observation for nobody — the very thing that keeps this lane out of
 * `main.ts`. The caller must say which door, in the type, at construction.
 */
export type WindowObservationAdmission =
  | { readonly sink: WindowAdmissionSink; readonly lane?: undefined }
  | { readonly lane: ActiveWindowAdmissionLane; readonly sink?: undefined }

export type WindowObservationRuntimeOptions = {
  /** The explicit opt-in. False means the runtime is inert by construction. */
  readonly enabled: boolean
  readonly provider: ActiveWindowProvider
  readonly scope: ContextScope
  readonly clock?: () => Date
  readonly timer?: WindowTimer | null
  readonly ttlMs?: number | null
  readonly cadenceMs?: number | null
  /** Read-only reporting hook; it cannot veto or rewrite an admission. */
  readonly onAdmission?: (result: ContextAdmissionResult | ContextCommandOutcome) => void
} & WindowObservationAdmission

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

  const admit =
    options.lane !== undefined
      ? createActiveWindowFacadeAdmitter({
          lane: options.lane,
          scope: options.scope,
          ttlMs: options.ttlMs,
        })
      : createActiveWindowAdmitter({
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
