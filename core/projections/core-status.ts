import type { CoreLifecycle, CoreStatus, JournalFault } from '../protocol/core-protocol'
import type { CoreState } from '../state'
import { activeGrants } from '../state'
import type { ModelGateway } from '../model/gateway'
import type { EventFabric } from '../events/fabric'

/**
 * How the Core's journal is being persisted right now.
 *
 * `durable` is the normal case: the JSONL store on disk. `ephemeral-fallback`
 * is the emergency case the runtime reports when the durable store could not
 * be opened: an in-memory store is in use, nothing written this session
 * survives a restart, and the workspace must label itself temporary.
 */
export type PersistenceMode = 'durable' | 'ephemeral-fallback'

export interface PersistenceView {
  mode: PersistenceMode
  durable: boolean
  reason: string | null
  eventStorePath: string | null
}

/**
 * The Core status projection.
 *
 * Derived entirely from durable state plus what the gateway knows about this
 * session. A fact that is genuinely unknown is `null`; nothing here is a
 * placeholder, a default, or an estimate.
 */
export interface ProjectionInput {
  modelSelection?: CoreStatus['modelSelection']
  state: CoreState
  lifecycle: CoreLifecycle
  gateway: ModelGateway
  fabric: EventFabric
  now: Date
  /** What recovery found. Session state, not derived from the log. */
  integrity: JournalFault
  /** When this Core process booted. Session state, deliberately not derived
   *  from the log: replaying a partial log must never invent a start time. */
  startedAt: string | null
  /** How the active event store is being persisted. */
  persistence: PersistenceView
  /** Whether the Core process is operationally able to serve commands. */
  operational: boolean
  /** Where runtime diagnostics are being written. Null until the first write. */
  diagnosticsPath: string | null
  /** How many diagnostics writes have failed since the Core started. */
  diagnosticsWriteFailures: number
  /** The most recent lifecycle transition, if any. */
  lastLifecycleTransition?: { from: CoreLifecycle; to: CoreLifecycle; at: string; reason: string | null }
}

/**
 * Decide the governor posture from real, current security facts.
 *
 * The Governor answers to STOP ALL, to the integrity of the durable log,
 * and to the cognition gate. Aggregate `degraded` is a *health* label, not a
 * security policy: a Core that is operationally healthy but has a single
 * unrelated subsystem in trouble is still `ready` for the Governor's
 * purposes, because the Governor is asked the question "may I trust what
 * the journal told me?" and a clean journal answers yes.
 *
 * The case the Governor must still catch is the one the integrity test
 * suite guards: a journal that suffered damage which quarantined a segment
 * that *may* have contained a STOP ALL. The replayed state says "not
 * stopped" because the latch was in the discarded segment. Even when the
 * quarantine preserves the bytes, the runtime cannot replay them into
 * `state.stopAll`, so the Governor is the last line of defence: it must say
 * `deny_all` whenever the state carries a recorded `integrityFault`,
 * regardless of the current read's `integrity` (which only describes this
 * process's read, not the security state).
 */
export function governorStatus(
  state: CoreState,
  integrity: JournalFault,
  gateOpen: boolean,
): 'ready' | 'deny_all' {
  if (state.stopAll.active) return 'deny_all'
  if (state.integrityFault !== null) return 'deny_all'
  if (integrity.integrity === 'corrupt') return 'deny_all'
  if (!gateOpen) return 'deny_all'
  return 'ready'
}

export function projectCoreStatus(input: ProjectionInput): CoreStatus {
  const { state, gateway, fabric, now, startedAt, integrity } = input
  const gate = gateway.gateStatus()

  return {
    lifecycle: input.lifecycle,
    operational: input.operational,
    eventSequence: fabric.lastSequence,
    coreStartedAt: startedAt,
    integrity,
    persistence: input.persistence,
    diagnostics: {
      path: input.diagnosticsPath,
      writeFailures: input.diagnosticsWriteFailures,
    },
    ...(input.lastLifecycleTransition ? { lastLifecycleTransition: input.lastLifecycleTransition } : {}),

    stopAll: {
      active: state.stopAll.active,
      activatedAt: state.stopAll.activatedAt,
      activatedBy: state.stopAll.activatedBy,
    },

    guard: {
      // Deny by default is a posture worth showing rather than implying.
      defaultOutcome: 'deny',
      approvalWorkflow: 'unavailable',
    },

    governor: {
      // Health is reported separately. The governor is a security posture,
      // and the only things that should set it to deny_all are STOP ALL,
      // an untrustworthy durable journal, or a fail-closed cognition gate.
      status: governorStatus(state, integrity, gate.open),
      grantsActive: activeGrants(state, now).length,
    },

    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    providers: gateway.statuses(),
    // The one place live provider work is read. The gateway owns the registry
    // that holds the controllers, so this is a fact about the process rather
    // than a reading of the journal.
    activeProviderCalls: gateway.activeCallCount(),
    sessionUsage: gateway.usage(),
    // A durable start with no terminal event is an unfinished attempt. After a
    // crash we cannot know how many tokens the provider consumed, so the
    // recovered total is a lower bound until/unless a terminal event exists.
    // pendingRequests preserves multiplicity, including repeated request ids.
    durableUsage: {
      ...state.durableUsage,
      unknownUsageCalls:
        state.durableUsage.unknownUsageCalls + state.pendingRequests.length,
    },
    faults: [
      ...state.faults,
      ...(!gate.open && !state.stopAll.active
        ? [`cognition gate is fail-closed: ${gate.reason ?? 'reason unavailable'}`]
        : []),
    ],
  }
}
