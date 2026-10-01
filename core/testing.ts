import type { Core } from './index'
import type { OwnerAuthority, WorkerAuthority } from './authority'
import type { PrincipalId } from './protocol/core-protocol'
import type { SubordinateWorkerScope, WorkforceOwnerScope } from './workforce/authority'

/**
 * TEST SEAMS. NOT PART OF THE PRODUCTION CAPABILITY SURFACE.
 *
 * `core/index.ts` exports no way to obtain an authority object, on purpose. A
 * future agent or module is written inside Core and is issued an authority by
 * Core; it does not import a way to mint one. This file is the single exception,
 * and it exists so that tests can drive cognition and grant governance without
 * that capability leaking into anything a subsystem could reach.
 *
 * The cast below is the whole cost of that decision, and it is confined to one
 * file on purpose. If a second file needs one, the boundary is wrong.
 */

interface AuthorityIssuer {
  issueOwnerAuthority(): OwnerAuthority
  issueWorkerAuthority(principalId: PrincipalId): WorkerAuthority
  issueWorkforceOwnerScope(): WorkforceOwnerScope
  issueSubordinateScope(workerId: string): SubordinateWorkerScope
}

/** The owner's authority. Grant governance is only on this interface. */
export function ownerAuthority(core: Core): OwnerAuthority {
  return (core as unknown as AuthorityIssuer).issueOwnerAuthority()
}

/**
 * A worker's authority. No `createGrant`, no `revokeGrant`, and `user_turn` is
 * not in its request type.
 */
export function workerAuthority(core: Core, principalId: PrincipalId = 'agent:worker-1'): WorkerAuthority {
  return (core as unknown as AuthorityIssuer).issueWorkerAuthority(principalId)
}

/**
 * The owner's face of the workforce.
 *
 * Every roster, team, assignment and budget operation hangs off this one object, and a
 * subordinate scope has **none** of them. That asymmetry is the point: holding this is
 * the authority to distribute, and there is no capability string that can be passed to
 * acquire it.
 */
export function workforceOwnerScope(core: Core): WorkforceOwnerScope {
  return (core as unknown as AuthorityIssuer).issueWorkforceOwnerScope()
}

/**
 * One named worker's own subordinate scope.
 *
 * Fixed at issuance: the `workerId` is the scope's identity and is not a parameter of
 * any method, and the `principalId` is derived from it. There is no method that assigns
 * a capability, assigns context, creates an agent, or retires one — so "a worker
 * widening itself" is not a refused call, it is an absent one.
 */
export function subordinateScope(core: Core, workerId: string): SubordinateWorkerScope {
  return (core as unknown as AuthorityIssuer).issueSubordinateScope(workerId)
}
