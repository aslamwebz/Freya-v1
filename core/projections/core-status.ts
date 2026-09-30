import type { CoreLifecycle, CoreStatus } from '../protocol/core-protocol'
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
  /** When this Core process booted. Session state, deliberately not derived
   *  from the log: replaying a partial log must never invent a start time. */
  startedAt: string | null
}

export function projectCoreStatus(input: ProjectionInput): CoreStatus {
  const { state, lifecycle, gateway, fabric, now, startedAt } = input

  return {
    lifecycle,
    eventSequence: fabric.lastSequence,
    coreStartedAt: startedAt,

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
      // While STOP ALL is latched the Governor refuses everything, so that is
      // the honest status rather than a cheerful one.
      status: state.stopAll.active ? 'deny_all' : 'ready',
      grantsActive: activeGrants(state, now).length,
    },

    providers: gateway.statuses(),
    sessionUsage: gateway.usage(),
    durableUsage: state.durableUsage,
    faults: [...state.faults],
  }
}
