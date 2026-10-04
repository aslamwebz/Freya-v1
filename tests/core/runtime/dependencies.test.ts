import { describe, expect, it } from 'vitest'
import {
  degradedRequirements,
  evaluateDependency,
  evaluateRequirements,
  missingRequirements,
  optional,
  require,
} from '../../../core/runtime'
import type { RuntimeDependencyKind } from '../../../core/runtime'
import { facts } from './harness'

describe('the dependency evaluator', () => {
  it('measures the journal fact', () => {
    expect(evaluateDependency(require('journal', 'journal'), facts()).satisfied).toBe(true)
    expect(
      evaluateDependency(require('journal', 'journal'), facts({ journalTrustworthy: false })).satisfied,
    ).toBe(false)
  })

  it('measures a named host adapter', () => {
    const requirement = require('host-adapter', 'the device-hands adapter', 'device-hands')
    expect(evaluateDependency(requirement, facts()).satisfied).toBe(false)
    expect(
      evaluateDependency(requirement, facts({ hostAdapters: ['device-hands'] })).satisfied,
    ).toBe(true)
    // A different adapter does not satisfy a named requirement.
    expect(
      evaluateDependency(requirement, facts({ hostAdapters: ['research'] })).satisfied,
    ).toBe(false)
  })

  it('measures a keyring secret by name', () => {
    const requirement = require('keyring', 'the Brain key', 'brain')
    expect(evaluateDependency(requirement, facts()).satisfied).toBe(false)
    expect(evaluateDependency(requirement, facts({ keyringKeys: ['brain'] })).satisfied).toBe(true)
  })

  it('measures vault, provider, approval, grant, device and transport', () => {
    expect(evaluateDependency(require('vault', 'vault'), facts()).satisfied).toBe(false)
    expect(evaluateDependency(require('vault', 'vault'), facts({ vaultOpen: true })).satisfied).toBe(true)
    expect(
      evaluateDependency(require('provider', 'provider'), facts({ providerConfigured: true, providerCount: 1 }))
        .satisfied,
    ).toBe(true)
    expect(
      evaluateDependency(require('owner-approval', 'approval', 'device.hands'), facts({ ownerApprovals: ['device.hands'] }))
        .satisfied,
    ).toBe(true)
    expect(
      evaluateDependency(require('capability-grant', 'grant', 'device.hands'), facts({ capabilityGrants: ['device.hands'] }))
        .satisfied,
    ).toBe(true)
    expect(
      evaluateDependency(require('trusted-device', 'device'), facts({ trustedDevices: 2 })).satisfied,
    ).toBe(true)
    expect(
      evaluateDependency(require('transport', 'transport'), facts({ transportAvailable: true })).satisfied,
    ).toBe(true)
  })

  it('measures recovery journal, continuation, connector, budget and policy', () => {
    expect(
      evaluateDependency(require('recovery-journal', 'recovery'), facts()).satisfied,
    ).toBe(false)
    expect(
      evaluateDependency(require('recovery-journal', 'recovery'), facts({ recoveryJournalReady: true }))
        .satisfied,
    ).toBe(true)
    expect(evaluateDependency(require('continuation', 'continuation'), facts()).satisfied).toBe(false)
    expect(
      evaluateDependency(require('external-connector', 'email', 'email'), facts({ connectors: ['email'] }))
        .satisfied,
    ).toBe(true)
    expect(evaluateDependency(require('budget', 'budget'), facts({ budgetRemainingUnits: 1 })).satisfied).toBe(true)
    expect(evaluateDependency(require('policy', 'policy'), facts()).satisfied).toBe(false)
    expect(evaluateDependency(require('store', 'store'), facts()).satisfied).toBe(true)
  })

  it('separates required misses from optional ones', () => {
    const requirements = [
      require('vault', 'the Vault'),
      optional('external-connector', 'a connector'),
    ]
    const evidence = evaluateRequirements(requirements, facts())
    expect(missingRequirements(evidence)).toEqual(['the Vault'])
    expect(degradedRequirements(evidence)).toEqual(['a connector'])
  })

  it('covers every declared dependency kind without falling through', () => {
    const kinds: RuntimeDependencyKind[] = [
      'journal',
      'host-adapter',
      'vault',
      'keyring',
      'provider',
      'owner-approval',
      'capability-grant',
      'trusted-device',
      'transport',
      'external-connector',
      'budget',
      'policy',
      'recovery-journal',
      'continuation',
      'store',
    ]
    for (const kind of kinds) {
      const reading = evaluateDependency(require(kind, kind), facts())
      expect(reading.detail.length, kind).toBeGreaterThan(0)
    }
  })
})
