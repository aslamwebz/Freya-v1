import type {
  RuntimeActivationHandler,
  RuntimeDependencyRequirement,
  RuntimeDomainDescriptor,
  RuntimeEventType,
  RuntimeFacts,
  RuntimeJournalEntry,
  RuntimeJournalPort,
  RuntimePayload,
} from '../../../core/runtime'

/**
 * A deterministic in-memory activation journal, matching the port Core fills.
 */
export function makeJournal(): RuntimeJournalPort & { entries: RuntimeJournalEntry[] } {
  const entries: RuntimeJournalEntry[] = []
  let clock = 0
  return {
    entries,
    append: async (type: RuntimeEventType, payload: RuntimePayload) => {
      clock += 1
      entries.push({
        sequence: entries.length + 1,
        type,
        payload,
        recordedAt: new Date(2026, 0, 1, 0, 0, clock).toISOString(),
      })
    },
    replay: async () => [...entries],
  }
}

/** A handler that records every start and stop, so duplicates are visible. */
export function makeHandler(
  id: string,
  log: string[],
  behaviour: { failStart?: boolean } = {},
): RuntimeActivationHandler {
  return {
    id,
    start: async () => {
      log.push(`start:${id}`)
      if (behaviour.failStart === true) throw new Error(`${id} refused to start`)
    },
    stop: async (reason: string) => {
      log.push(`stop:${id}:${reason}`)
    },
  }
}

export function facts(overrides: Partial<RuntimeFacts> = {}): RuntimeFacts {
  return {
    coreLifecycle: 'ready',
    journalTrustworthy: true,
    stopAllActive: false,
    vaultOpen: false,
    keyringKeys: [],
    providerConfigured: false,
    providerCount: 0,
    hostAdapters: [],
    connectors: [],
    ownerApprovals: [],
    capabilityGrants: [],
    trustedDevices: 0,
    transportAvailable: false,
    budgetRemainingUnits: 0,
    policyPresent: false,
    recoveryJournalReady: false,
    continuationReady: false,
    ...overrides,
  }
}

export function descriptor(
  overrides: Partial<RuntimeDomainDescriptor> & { id: string },
): RuntimeDomainDescriptor {
  return {
    family: 'mission-work',
    title: overrides.id,
    module: `core/${overrides.id}`,
    kind: 'phase-runtime',
    activation: 'activatable',
    requirements: [],
    order: 100,
    note: 'test domain',
    ...overrides,
  }
}

export function requires(
  kind: RuntimeDependencyRequirement['kind'],
  label: string,
  key: string | null = null,
): RuntimeDependencyRequirement {
  return { kind, key, label, required: true }
}

export function optionalDep(
  kind: RuntimeDependencyRequirement['kind'],
  label: string,
  key: string | null = null,
): RuntimeDependencyRequirement {
  return { kind, key, label, required: false }
}
