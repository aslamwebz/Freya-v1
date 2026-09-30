import { CAPABILITIES, type Capability, type PrincipalId } from '../protocol/core-protocol'

/**
 * FREYA GUARD — the security root.
 *
 * The path is Identity → Capability → Scope → Policy → Risk → Approval →
 * Action → Audit. Phase 1 implements Identity, Capability and Policy, and
 * records every decision durably. Scope, Risk and Approval are named here as
 * the shape of what comes next rather than being faked into place.
 *
 * **Deny by default.** A principal holds nothing it was not explicitly given.
 * An unknown principal holds nothing. A capability outside the closed
 * vocabulary is not a capability.
 *
 * **A model can never grant.** There is no capability in the vocabulary that
 * confers the ability to create, extend or revoke grants, and the only
 * principal that may do so is `owner`. There is deliberately no path from a
 * provider response back into this module.
 */

export interface Principal {
  id: PrincipalId
  /** Capabilities held at this instant. Never inferred from context. */
  capabilities: ReadonlySet<Capability>
  /** False for a principal created from untrusted input. */
  trusted: boolean
}

/** The owner: the human running Freya. The only principal that may govern. */
export function ownerPrincipal(capabilities: readonly Capability[]): Principal {
  return { id: 'owner', capabilities: new Set(capabilities), trusted: true }
}

/** Freya itself, acting on its own behalf. Deliberately narrow. */
export function systemPrincipal(capabilities: readonly Capability[]): Principal {
  return { id: 'system', capabilities: new Set(capabilities), trusted: true }
}

/**
 * A future agent or module identity.
 *
 * Phase 1 creates none of these. The constructor exists so that the *shape* of
 * a worker identity is fixed before one is ever built: a worker gets
 * capabilities it was handed, is never `trusted`, and starts empty.
 */
export function workerPrincipal(id: string, capabilities: readonly Capability[] = []): Principal {
  return { id: `agent:${id}`, capabilities: new Set(capabilities), trusted: false }
}

export function isPrincipalId(value: unknown): value is PrincipalId {
  if (typeof value !== 'string') return false
  if (value === 'owner' || value === 'system') return true
  const scoped = /^(agent|module):[A-Za-z0-9._-]{1,64}$/.exec(value)
  return scoped !== null
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

export interface Guard {
  /** Evaluate one capability request for one principal. */
  evaluate(principal: Principal, capability: Capability): GuardVerdict
  /** Whether a principal holds a capability. A cheaper question, same answer. */
  holds(principal: Principal, capability: Capability): boolean
}

export type GuardVerdict = { allowed: true } | { allowed: false; outcome: 'deny' | 'approval_required'; reason: string }

export class DefaultGuard implements Guard {
  /**
   * @param approvalRequired capabilities that are real but have no workflow
   *   behind them yet. Phase 1 has none; the concept exists so that adding one
   *   later is a data change rather than an architectural one.
   */
  constructor(
    private readonly approvalRequired: ReadonlySet<Capability> = new Set(),
    private readonly denied: ReadonlySet<Capability> = new Set(),
  ) {}

  holds(principal: Principal, capability: Capability): boolean {
    return principal.trusted && principal.capabilities.has(capability)
  }

  evaluate(principal: Principal, capability: Capability): GuardVerdict {
    if (!isCapability(capability)) {
      return { allowed: false, outcome: 'deny', reason: 'capability is not in the vocabulary' }
    }
    // A principal assembled from untrusted input never carries authority,
    // whatever capability list it claims to have.
    if (!principal.trusted) {
      return { allowed: false, outcome: 'deny', reason: 'principal is not trusted' }
    }
    if (this.denied.has(capability)) {
      return { allowed: false, outcome: 'deny', reason: 'capability is explicitly denied' }
    }
    if (principal.capabilities.has(capability)) {
      return { allowed: true }
    }
    if (this.approvalRequired.has(capability)) {
      // Honest boundary: the capability is acknowledged, and no workflow
      // exists to approve it. Deny, and say why.
      return {
        allowed: false,
        outcome: 'approval_required',
        reason: 'capability requires approval and no approval workflow exists in Phase 1',
      }
    }
    return { allowed: false, outcome: 'deny', reason: 'principal does not hold the capability' }
  }
}
