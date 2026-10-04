import type {
  RuntimeDependencyEvidence,
  RuntimeDependencyKind,
  RuntimeDependencyRequirement,
  RuntimeFacts,
} from './types'

/**
 * The dependency evaluator.
 *
 * Pure: one requirement plus one fact set in, one measured answer out. There is
 * no cache, no clock and no port here, so "why is this blocked?" is answered by
 * the same function every time it is asked.
 *
 * A requirement with a `key` names *which* sub-resource it needs; one without
 * asks only whether the kind exists at all.
 */

function has(list: readonly string[], key: string | null): boolean {
  if (key === null) return list.length > 0
  return list.includes(key)
}

export function evaluateDependency(
  requirement: RuntimeDependencyRequirement,
  facts: RuntimeFacts,
): RuntimeDependencyEvidence {
  const { kind, key, label, required } = requirement
  const base = { kind, key, label, required }

  switch (kind) {
    case 'journal':
      return {
        ...base,
        satisfied: facts.journalTrustworthy,
        detail: facts.journalTrustworthy
          ? 'the durable event journal is open and trustworthy'
          : 'the durable event journal is not trustworthy',
      }
    case 'host-adapter':
      return {
        ...base,
        satisfied: has(facts.hostAdapters, key),
        detail: has(facts.hostAdapters, key)
          ? `the ${key ?? 'required'} host adapter is present`
          : `the ${key ?? 'required'} host adapter is absent`,
      }
    case 'vault':
      return {
        ...base,
        satisfied: facts.vaultOpen,
        detail: facts.vaultOpen
          ? 'the encrypted Vault is open'
          : 'the encrypted Vault is not open',
      }
    case 'keyring':
      return {
        ...base,
        satisfied: has(facts.keyringKeys, key),
        detail: has(facts.keyringKeys, key)
          ? `the ${key ?? 'required'} key is present in the keyring`
          : `the ${key ?? 'required'} key is absent from the keyring`,
      }
    case 'provider':
      return {
        ...base,
        satisfied: facts.providerConfigured && facts.providerCount > 0,
        detail: facts.providerConfigured
          ? `${facts.providerCount} model provider(s) configured`
          : 'no model provider is configured',
      }
    case 'owner-approval':
      return {
        ...base,
        satisfied: has(facts.ownerApprovals, key),
        detail: has(facts.ownerApprovals, key)
          ? `owner approval for ${key ?? 'the required subject'} is present`
          : `owner approval for ${key ?? 'the required subject'} is absent`,
      }
    case 'capability-grant':
      return {
        ...base,
        satisfied: has(facts.capabilityGrants, key),
        detail: has(facts.capabilityGrants, key)
          ? `an active capability grant for ${key ?? 'the required capability'} exists`
          : `no active capability grant for ${key ?? 'the required capability'} exists`,
      }
    case 'trusted-device':
      return {
        ...base,
        satisfied: facts.trustedDevices > 0,
        detail:
          facts.trustedDevices > 0
            ? `${facts.trustedDevices} trusted device(s) enrolled`
            : 'no trusted device is enrolled',
      }
    case 'transport':
      return {
        ...base,
        satisfied: facts.transportAvailable,
        detail: facts.transportAvailable
          ? 'a device transport is available'
          : 'no device transport is available',
      }
    case 'external-connector':
      return {
        ...base,
        satisfied: has(facts.connectors, key),
        detail: has(facts.connectors, key)
          ? `the ${key ?? 'required'} connector is configured`
          : `the ${key ?? 'required'} connector is not configured`,
      }
    case 'budget':
      return {
        ...base,
        satisfied: facts.budgetRemainingUnits > 0,
        detail:
          facts.budgetRemainingUnits > 0
            ? `${facts.budgetRemainingUnits} budgeted unit(s) remain`
            : 'no budgeted units remain',
      }
    case 'policy':
      return {
        ...base,
        satisfied: facts.policyPresent,
        detail: facts.policyPresent
          ? 'a policy object is present'
          : 'no policy object is present',
      }
    case 'recovery-journal':
      return {
        ...base,
        satisfied: facts.recoveryJournalReady,
        detail: facts.recoveryJournalReady
          ? 'the recovery journal seam is satisfied'
          : 'the recovery journal seam is not satisfied',
      }
    case 'continuation':
      return {
        ...base,
        satisfied: facts.continuationReady,
        detail: facts.continuationReady
          ? 'the long-horizon continuation subsystem is wired'
          : 'the long-horizon continuation subsystem is not wired',
      }
    case 'store':
      return {
        ...base,
        satisfied: true,
        detail: 'a store is available for this domain',
      }
    default: {
      // Exhaustiveness: a new kind must be handled rather than silently allowed.
      const never: never = kind
      return {
        ...base,
        satisfied: false,
        detail: `unknown dependency kind: ${String(never)}`,
      }
    }
  }
}

export function evaluateRequirements(
  requirements: readonly RuntimeDependencyRequirement[],
  facts: RuntimeFacts,
): readonly RuntimeDependencyEvidence[] {
  return requirements.map((requirement) => evaluateDependency(requirement, facts))
}

/** The labels of required dependencies that are not satisfied. */
export function missingRequirements(
  evidence: readonly RuntimeDependencyEvidence[],
): readonly string[] {
  return evidence.filter((item) => item.required && !item.satisfied).map((item) => item.label)
}

/** The labels of optional dependencies that are not satisfied (degradations). */
export function degradedRequirements(
  evidence: readonly RuntimeDependencyEvidence[],
): readonly string[] {
  return evidence.filter((item) => !item.required && !item.satisfied).map((item) => item.label)
}

/** A small helper so the registry reads as declarations, not constructor calls. */
export function require(
  kind: RuntimeDependencyKind,
  label: string,
  key: string | null = null,
): RuntimeDependencyRequirement {
  return { kind, key, label, required: true }
}

/** An optional requirement: absence lowers the domain to `degraded`. */
export function optional(
  kind: RuntimeDependencyKind,
  label: string,
  key: string | null = null,
): RuntimeDependencyRequirement {
  return { kind, key, label, required: false }
}
