import {
  CONTEXT_BOUNDARY_REFUSAL_TEXT,
  type ContextCommandOutcome,
  type ContextScopeRef,
} from '../../../protocol/context'
import type { ContextHostReport } from '../../coreIntegration'
import { activeWindowCandidate } from './candidate'
import { ACTIVE_WINDOW_SUPERSESSION_REASON } from './admit'
import type { ActiveWindowInfo } from './types'

/**
 * THE ADMISSION SEAM BRIDGE — from the observation lane to Core's host door.
 *
 * Issue #27 landed the Context facade, and its narrow admission seam for
 * anything the *host* reports is `ContextIntegration.admitHostReport`: a
 * typed report with no `source` field (the door fixes provenance to
 * `host_report`), a required `originId`, a scope from Core's own registry —
 * and no session scope, because a host placing ambient content where every
 * conversation can resolve it is the omniscient-screen feed the roadmap (and
 * this lane) refuses. Since #30 promoted `active_window`, that seam answers
 * it: the foundation table admits exactly one pairing — `host_report` — and
 * this file is the only mapping between the observation lane's shape and
 * that door's.
 *
 * The bridge adds no authority and subtracts none:
 *
 *  - it cannot express another kind or a claimed source — both are fixed
 *    here, in the type and in the construction, and the door fixes the rest;
 *  - it passes no clock: the facade keeps Core's clock, so the host lane
 *    cannot even suggest a *now*; the store-shaped admitter in `admit.ts`
 *    keeps the caller-supplied instant because that seam is caller-owned —
 *    the difference is deliberate, and each path matches its own door;
 *  - its supersession policy is the store path's, restated at the facade
 *    vocabulary: admit the new observation, take back the one *this bridge*
 *    admitted with the fixed, words-free reason, and let an already-expired
 *    predecessor report `revoke-already-settled` rather than be relabelled;
 *  - refusals return as Core named them. The bridge reports; it does not
 *    insist, retry, or rewrite scope.
 */

/**
 * The seam this bridge speaks, in the narrowest possible words.
 *
 * It is exactly `ContextIntegration`'s two host-facing methods, structural so
 * the real facade, a stub, or a wrapper all satisfy it without this file
 * knowing which. There is no third method to grow into: if a lane ever needs
 * more than admit-and-revoke, the wrong thing is being attempted.
 */
export interface ActiveWindowAdmissionLane {
  admitHostReport(report: ContextHostReport): ContextCommandOutcome
  revoke(contextId: string, reason: string): ContextCommandOutcome
}

export interface ActiveWindowHostReportOptions {
  /** Forwarded to the candidate; clamped at the domain ceiling, never beyond. */
  readonly ttlMs?: number | null
}

/**
 * The observation as a `ContextHostReport`, or null when it cannot honestly
 * be one.
 *
 * The only refusal this file makes on its own is the one the door would make
 * too: a report must name the observation behind it. The candidate carries an
 * origin by construction, so this guard exists for hand-constructed callers,
 * and a null here means *nothing was sent* rather than a partial report.
 */
export function activeWindowHostReport(
  observation: ActiveWindowInfo,
  scope: ContextScopeRef,
  options: ActiveWindowHostReportOptions = {},
): ContextHostReport | null {
  // An origin is the seam's requirement, and its two parts are the
  // observation's own: a blank provider or reading id can never compose into
  // an origin that *names a record*, so the report is refused here rather
  // than sent to be refused there.
  if (observation.providerId.trim().length === 0 || observation.observationId.trim().length === 0) {
    return null
  }
  const candidate = activeWindowCandidate(observation, scope, { ttlMs: options.ttlMs })
  const originId = candidate.originId
  if (typeof originId !== 'string' || originId.length === 0) return null
  return {
    kind: candidate.kind,
    scope: { scopeKind: scope.scopeKind, scopeId: scope.scopeId },
    content: candidate.content,
    originId,
    label: candidate.label ?? null,
    uri: candidate.uri ?? null,
    capturedAt: candidate.capturedAt ?? null,
    ttlMs: candidate.ttlMs ?? null,
  }
}

export interface ActiveWindowFacadeAdmitterOptions {
  readonly lane: ActiveWindowAdmissionLane
  /** A scope Core has declared. The facade answers any other — including the
   * session — with its own refusal, which this bridge relays unchanged. */
  readonly scope: ContextScopeRef
  readonly ttlMs?: number | null
}

/**
 * A listener-shaped admitter over the facade's host door: `WindowObservationService`'s
 * `onObservation` can call it directly. It takes no `now` — see the header.
 * Returns the facade's own outcome, admitted or named refusal.
 */
export function createActiveWindowFacadeAdmitter(
  options: ActiveWindowFacadeAdmitterOptions,
): (observation: ActiveWindowInfo) => ContextCommandOutcome {
  let lastAdmittedId: string | null = null

  return (observation) => {
    const report = activeWindowHostReport(observation, options.scope, { ttlMs: options.ttlMs })
    if (report === null) {
      return {
        operation: 'refused',
        ok: false,
        refusal: 'malformed_request',
        reason: CONTEXT_BOUNDARY_REFUSAL_TEXT.malformed_request,
      }
    }

    const outcome = options.lane.admitHostReport(report)
    if (outcome.ok && typeof outcome.contextId === 'string') {
      const previous = lastAdmittedId
      lastAdmittedId = outcome.contextId
      if (previous !== null && previous !== outcome.contextId) {
        // The facade names its own outcomes; an expired predecessor reports
        // `revoke-already-settled`, and that is left standing — the words are
        // already gone, and rewriting a clock's work as a human act would be
        // the one edit this bridge must not make.
        options.lane.revoke(previous, ACTIVE_WINDOW_SUPERSESSION_REASON)
      }
    }
    return outcome
  }
}
