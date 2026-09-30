import type { CoreLifecycle, CoreStatus, JournalFault } from '../protocol/core-protocol'
import type { CoreState } from '../state'
import { activeGrants } from '../state'
import type { ModelGateway } from '../model/gateway'
import type { EventFabric } from '../events/fabric'

/**
 * The Core status projection.
 *
 * Derived entirely from durable state plus what the gateway knows about this
 * session. A fact that is genuinely unknown is `null`; nothing here is a
 * placeholder, a default, or an estimate.
 */
export interface ProjectionInput {
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
}

export function projectCoreStatus(input: ProjectionInput): CoreStatus {
  const { state, lifecycle, gateway, fabric, now, startedAt, integrity } = input

  return {
    lifecycle,
    eventSequence: fabric.lastSequence,
    coreStartedAt: startedAt,
    integrity,

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
      // A corrupt journal denies everything whatever the replayed latch says,
      // because the discarded segment may have held the STOP ALL that followed.
      // Reporting `ready` here would be the one lie this system cannot afford.
      status:
        state.stopAll.active || integrity.integrity === 'corrupt' ? 'deny_all' : 'ready',
      grantsActive: activeGrants(state, now).length,
    },

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
    faults: [...state.faults],
  }
}
