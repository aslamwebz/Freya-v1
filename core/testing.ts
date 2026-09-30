import type { Core } from './index'
import type { OwnerAuthority, WorkerAuthority } from './authority'
import type { PrincipalId } from './protocol/core-protocol'

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
