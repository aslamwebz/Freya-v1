import type { RuntimeFacts } from '../../core/runtime'
import type { ProjectedInventoryInput } from '../../core/qualification'

/**
 * Shared fixtures for the Phase 49 qualification suite.
 *
 * Nothing here mocks a Core, a journal or a store. Every helper either supplies plain
 * data to a pure function, or points a real one at a real temporary directory. A
 * qualification suite that faked the thing it is qualifying would be the exact failure
 * this phase exists to prevent.
 */

export const QUALIFIED_MODULES: readonly string[] = [
  'core.security-spine',
  'core.vault',
  'core.missions',
  'core.work',
  'core.conversation',
  'core.context',
  'core.workforce',
  'core.brain',
  'core.personality',
  'core.attention',
  'core.office',
  'core.relay',
  'core.skills',
  'core.voice',
  'core.world',
  'core.life',
  'core.consciousness',
  'core.lifeloop',
  'core.foundry',
  'core.long-horizon',
  'core.economic',
  'core.enterprise',
  'core.multidevice',
  'core.device-hands',
  'core.resilience',
  'core.sovereignty',
  'core.evolution',
  'core.threshold',
  'core.browserext',
]

/** The plainest fact set: a Core that is up, with nothing wired beyond its journal. */
export function floorFacts(overrides: Partial<RuntimeFacts> = {}): RuntimeFacts {
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

export function projectedInput(overrides: Partial<ProjectedInventoryInput> = {}): ProjectedInventoryInput {
  return { presentModules: QUALIFIED_MODULES, ...overrides }
}