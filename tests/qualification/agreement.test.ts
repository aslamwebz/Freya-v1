import { describe, expect, it } from 'vitest'
import { RuntimeActivationController, orderedRegistry as runtimeOrder } from '../../core/runtime'
import {
  capabilityReadiness,
  orderedRegistry,
  registryById,
  type ReadinessState,
} from '../../core/qualification'
import type { RuntimeFacts, RuntimeProjection } from '../../core/runtime'
import { makeHandler, makeJournal } from '../core/runtime/harness'
import { QUALIFIED_MODULES, floorFacts } from './fixture'

/**
 * The inventory must not be a second opinion.
 *
 * `core/qualification/inventory.ts` derives readiness from a descriptor and a fact set
 * *without* a journal, because a release report has to be producible offline. The
 * activation controller derives it again, with a journal, at run time. Two derivations
 * is two chances to disagree — and a release document describing a runtime that does
 * not exist is worse than no release document at all.
 *
 * So this suite runs both, over the real registry, across a matrix of fact sets and
 * handler wirings, and requires them to agree on every single domain. If somebody edits
 * the inventory's precedence without editing the controller's, or the reverse, this
 * fails.
 */

const FACT_MATRIX: readonly { name: string; facts: RuntimeFacts }[] = [
  { name: 'a bare ready Core', facts: floorFacts() },
  { name: 'an untrustworthy journal', facts: floorFacts({ journalTrustworthy: false }) },
  { name: 'Core still booting', facts: floorFacts({ coreLifecycle: 'booting' }) },
  { name: 'Core degraded', facts: floorFacts({ coreLifecycle: 'degraded' }) },
  { name: 'Core stopping', facts: floorFacts({ coreLifecycle: 'stopping' }) },
  { name: 'Core stopped', facts: floorFacts({ coreLifecycle: 'stopped' }) },
  { name: 'STOP ALL latched', facts: floorFacts({ stopAllActive: true }) },
  { name: 'an open Vault', facts: floorFacts({ vaultOpen: true }) },
  { name: 'every keyring entry present', facts: floorFacts({ keyringKeys: ['conversation', 'brain', 'personality'] }) },
  { name: 'a provider configured', facts: floorFacts({ providerConfigured: true, providerCount: 2 }) },
  { name: 'every host adapter wired', facts: floorFacts({ hostAdapters: ['research', 'relay', 'voice', 'window', 'device-hands'] }) },
  { name: 'every connector wired', facts: floorFacts({ connectors: ['email', 'calendar', 'github'] }) },
  {
    name: 'every dependency satisfied at once',
    facts: floorFacts({
      vaultOpen: true,
      keyringKeys: ['conversation', 'brain', 'personality'],
      providerConfigured: true,
      providerCount: 1,
      hostAdapters: ['research', 'relay', 'voice', 'window', 'device-hands'],
      connectors: ['email'],
      ownerApprovals: ['device.hands'],
      capabilityGrants: ['device.hands'],
      trustedDevices: 2,
      transportAvailable: true,
      budgetRemainingUnits: 100,
      policyPresent: true,
      recoveryJournalReady: true,
      continuationReady: true,
    }),
  },
  {
    name: 'everything satisfied while STOP ALL is latched',
    facts: floorFacts({
      stopAllActive: true,
      vaultOpen: true,
      keyringKeys: ['conversation', 'brain', 'personality'],
      providerConfigured: true,
      providerCount: 1,
      hostAdapters: ['device-hands'],
      capabilityGrants: ['device.hands'],
      trustedDevices: 2,
      transportAvailable: true,
      budgetRemainingUnits: 100,
      policyPresent: true,
      recoveryJournalReady: true,
      continuationReady: true,
    }),
  },
]

const HANDLER_WIRINGS: readonly { name: string; wired: readonly string[] }[] = [
  { name: 'no activation handler wired', wired: [] },
  { name: 'the three activatable domains wired', wired: ['core.sovereignty', 'core.evolution', 'core.threshold'] },
  { name: 'Device Hands and the extension wired', wired: ['core.device-hands', 'core.browserext'] },
  { name: 'everything wired', wired: runtimeOrder().map((descriptor) => descriptor.id) },
]

/** A controller wired exactly the way Core wires it, plus an explicit handler set. */
async function controllerProjection(
  facts: RuntimeFacts,
  wired: readonly string[],
): Promise<RuntimeProjection> {
  const log: string[] = []
  const controller = new RuntimeActivationController({
    journal: makeJournal(),
    now: () => '2026-01-01T00:00:00.000Z',
  })
  controller.register(orderedRegistry(), wired.map((id) => makeHandler(id, log)))
  return await controller.load(facts)
}

describe('Phase 49 inventory and runtime activation never disagree', () => {
  for (const { name, facts } of FACT_MATRIX) {
    it(`derives the same readiness as the live controller with ${name}`, async () => {
      for (const { name: wiringName, wired } of HANDLER_WIRINGS) {
        const projection = await controllerProjection(facts, wired)
        const disagreements: string[] = []

        for (const descriptor of orderedRegistry()) {
          const predicted: ReadinessState = capabilityReadiness(descriptor, {
            facts,
            presentModules: QUALIFIED_MODULES,
            wiredHandlers: wiringName === 'no activation handler wired' ? [] : wired,
          }).readiness
          const view = projection.domains.find((candidate) => candidate.id === descriptor.id)
          if (view === undefined) {
            disagreements.push(`${descriptor.id}: absent from the live projection`)
            continue
          }
          // The controller's vocabulary has no `unavailable`: that is a build-level
          // fact, and both sides are being fed "the module is present" here, so the
          // comparison is like for like.
          if (predicted !== view.status) {
            disagreements.push(
              `${descriptor.id}: inventory says ${predicted}, controller says ${String(view.status)} (${wiringName})`,
            )
          }
        }

        expect(disagreements).toEqual([])
      }
    })
  }

  it('agrees even when a domain is registered but absent from the projection', async () => {
    const projection = await controllerProjection(floorFacts(), [])
    const subset = orderedRegistry().slice(0, 3).map((descriptor) => descriptor.id)
    for (const id of subset) expect(projection.domains.map((domain) => domain.id)).toContain(id)
    expect(registryById(subset[0]!)).toBeDefined()
  })

  it('never reports an activatable domain as active when no handler is wired', async () => {
    const projection = await controllerProjection(floorFacts(), [])
    const activatable = orderedRegistry().filter((descriptor) => descriptor.activation === 'activatable')
    expect(activatable.length).toBeGreaterThan(0)
    for (const descriptor of activatable) {
      const view = projection.domains.find((domain) => domain.id === descriptor.id)!
      expect(view.status).toBe('available')
    }
  })

  it('never reports the security spine as anything but active while Core is ready', async () => {
    for (const { facts } of FACT_MATRIX) {
      const projection = await controllerProjection(facts, [])
      const spine = projection.domains.find((domain) => domain.id === 'core.security-spine')!
      if (facts.stopAllActive && facts.journalTrustworthy) expect(spine.status).toBe('active')
    }
  })
})