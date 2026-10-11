import type { RuntimeStatus } from '../vocabulary/runtime.ts'

export const RUNTIME_EVENT_TYPES = [
// Runtime Activation (Phase 40) — metadata only.
  //
  // These record the registration and lifecycle decisions of the runtime
  // activation system: which domain was evaluated, whether its declared
  // dependencies were satisfied, what status it was moved to, and why. There is
  // no slot for a secret, a credential, a provider payload or a dependency's
  // contents; every field is a namespaced id, a closed status, a closed outcome,
  // a sentence a person can read, or a list of dependency labels.
  //
  // None of these is a security event. A decision here *reflects* a gate that
  // already existed; it cannot clear STOP ALL, widen a grant, approve anything or
  // contact a model. The absence of such a spelling is the point.
  'runtime.activation.decided',
'runtime.activation.changed',
'runtime.activation.stopped',
'runtime.activation.reconciled',
] as const

export interface RuntimeEventPayloads {
/* ------------------------------------------------------ runtime activation */

  /**
   * One domain's registration decision.
   *
   * `outcome` is the allowed/blocked verdict; `status` is where the domain now
   * stands; `missing` names the dependency labels that blocked it, if any.
   */
  'runtime.activation.decided': {
    domainId: string
    outcome: 'allowed' | 'blocked'
    status: RuntimeStatus
    reason: string
    missing: string[]
    requestedAt: string
  }

/** A domain's status changed after it had already been evaluated. */
  'runtime.activation.changed': {
    domainId: string
    from: RuntimeStatus
    to: RuntimeStatus
    reason: string
    missing: string[]
  }

/** A domain was stopped, with the reason recorded. */
  'runtime.activation.stopped': {
    domainId: string
    reason: string
    missing: string[]
  }

/**
   * A domain was reconciled after a Core restart.
   *
   * `previousStatus` is carried rather than read back from state, for Work's
   * reason: after a restart "what this domain was doing" is precisely the thing
   * that is no longer knowable from memory.
   */
  'runtime.activation.reconciled': {
    domainId: string
    previousStatus: RuntimeStatus
    status: RuntimeStatus
    reason: string
    missing: string[]
  }
}