import type { PrincipalId } from '../identity'
import type { GuardOutcome } from '../security'
import type { ProviderStatus, ModelUsage } from '../model'

/* ---------------------------------------------------------- projection */

export type CoreLifecycle = 'booting' | 'ready' | 'degraded' | 'stopping' | 'stopped'

/**
 * Everything the renderer may know about Core.
 *
 * This is a projection of durable state, not a live handle. A field that is
 * genuinely unknown is `null`, never a placeholder number.
 */
/**
 * Whether the journal can be believed.
 *
 * `torn` is ordinary: a crash interrupted the last write and the surviving
 * prefix is the whole truth. `corrupt` is not: a complete line failed
 * validation, so the journal cannot be replayed into security state — the
 * discarded segment could have contained a STOP ALL. A Core in this state denies
 * cognition regardless of what the replayed prefix says.
 */
export type JournalIntegrity = 'ok' | 'torn' | 'corrupt'

export interface JournalFault {
  integrity: JournalIntegrity
  /** Why, in words a person can act on. Never null. */
  reason: string
  /** Which line the problem was found on, 1-indexed. */
  line: number | null
  /** Complete events that were read and believed. */
  eventsRead: number
  /** Bytes discarded during recovery, including a torn tail. */
  bytesDiscarded: number
}

export interface CoreStatus {
  lifecycle: CoreLifecycle
  /**
   * Whether the Core process is currently able to serve commands.
   *
   * Operational is a *process-level* property: a Core in the ephemeral-fallback
   * path is still operational even though `persistence.durable` is false, and
   * a Core in the durable path with a single corrupt subsystem is still
   * operational. Use this in the UI to decide whether the workspace is
   * usable, never `lifecycle === 'ready'` alone.
   */
  operational: boolean
  /** Last active event sequence. Persistence describes whether it is durable. */
  eventSequence: number
  coreStartedAt: string | null
  /**
   * Always present. A healthy journal says so explicitly, because the absence of
   * a warning is not the same thing as a warning that is absent.
   */
  integrity: JournalFault
  /**
   * How durable the current process's history actually is. A Core that opened
   * its durable store normally reports `durable: true`; a Core that fell back
   * to the in-memory store because the durable store could not be opened
   * reports `durable: false` with a `mode: 'ephemeral-fallback'` and a
   * `reason` naming the failure. The UI uses this to label the workspace
   * honestly — "event history is temporary" — without
   * locking the owner out.
   */
  persistence: {
    mode: 'durable' | 'ephemeral-fallback'
    durable: boolean
    /** Always present; explains what the mode is and why. */
    reason: string | null
    /** The on-disk path of the active event store, when one exists. */
    eventStorePath: string | null
  }
  /**
   * Where runtime diagnostics are being written. Always present after start;
   * lets the UI surface "show last error" without hardcoding a path.
   */
  diagnostics: {
    path: string | null
    /** How many record writes have failed since this Core started. */
    writeFailures: number
  }
  /**
   * The most recent lifecycle transition, for "what changed" UX. Optional so
   * the first render before the first transition is still valid.
   */
  lastLifecycleTransition?: {
    from: CoreLifecycle
    to: CoreLifecycle
    at: string
    reason: string | null
  }
  /** The event-derived latch survives restart only with durable persistence. */
  stopAll: {
    active: boolean
    activatedAt: string | null
    activatedBy: PrincipalId | null
  }
  guard: {
    /** Deny by default; shown so the posture is visible rather than implied. */
    defaultOutcome: GuardOutcome
    /** Capable of approval, but no approval workflow exists in Phase 1. */
    approvalWorkflow: 'unavailable'
  }
  governor: {
    /**
     * `unknown` is not the same as `deny_all`. A Core that has not finished
     * booting has no answer, and reporting "denying everything" there would
     * claim a stop latch that may well not be set.
     */
    status: 'ready' | 'deny_all' | 'unknown'
    grantsActive: number
  }
  modelSelection?: { model: string | null; providerId: string | null; defaultModel: string | null }
  providers: ProviderStatus[]
  /**
   * Provider requests executing **right now**, in this Core process.
   *
   * Read straight from the Model Gateway's active registry, which is the only
   * in-process record of live work. Deliberately not derived from the durable
   * journal: a journal can say a request was started and cannot say whether it
   * is still running, and a Core that died mid-call leaves a start with no
   * finish forever. Inferring "working" from that history is how an idle Freya
   * ends up claiming it is thinking.
   *
   * Zero means nothing is being spent, which is the normal state.
   */
  activeProviderCalls: number
  /** Usage for this Core session. Durable totals are separate. */
  sessionUsage: ModelUsage
  durableUsage: ModelUsage
  /** Non-empty when something is wrong; Core says what, rather than hiding it. */
  faults: string[]
}
