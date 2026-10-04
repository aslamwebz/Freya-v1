// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PURE_RUNTIME_MODULES,
  RUNTIME_EVENT_TYPES,
  RUNTIME_REGISTRY,
  RuntimeActivationController,
  findForbiddenIdentifiersInSource,
  registryById,
} from '../../core/runtime'
import { CORE_EVENT_TYPES } from '../../core/events/envelope'
import { descriptor, facts, makeHandler, makeJournal } from '../core/runtime/harness'

/**
 * Red-team tests for runtime activation.
 *
 * These prove the activation system is what it claims: a registry, a dependency
 * checker and a lifecycle record. It is not a second authority path, it does not
 * infer, and no maturity result unlocks anything.
 */

const runtimeDir = join(process.cwd(), 'core', 'runtime')

async function sourceOf(name: string): Promise<string> {
  return await readFile(join(runtimeDir, name), 'utf8')
}

describe('the activation system holds no authority', () => {
  it('keeps the pure modules free of models, timers, grants and providers', async () => {
    for (const file of PURE_RUNTIME_MODULES) {
      const source = await sourceOf(file)
      expect(findForbiddenIdentifiersInSource(source), file).toEqual([])
    }
  })

  it('keeps the controller free of the model and authority vocabulary', async () => {
    const source = await sourceOf('controller.ts')
    const violations = findForbiddenIdentifiersInSource(source)
    expect(violations.map((violation) => violation.identifier)).toEqual([])
  })

  it('adds no command-like event to the durable vocabulary', () => {
    for (const type of RUNTIME_EVENT_TYPES) {
      expect(type).not.toMatch(/command|activate-domain|grant|approve/)
    }
    expect(CORE_EVENT_TYPES.some((type) => /^runtime\..*command/.test(type))).toBe(false)
  })

  it('has no method that activates, grants or approves', () => {
    const prototype = RuntimeActivationController.prototype as unknown as Record<string, unknown>
    for (const forbidden of ['activateDomain', 'setStatus', 'grant', 'approve', 'widen', 'selfActivate']) {
      expect(prototype[forbidden], forbidden).toBeUndefined()
    }
  })

  it('cannot be made to activate a blocked-mode domain by a handler that claims success', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.hands', activation: 'blocked', requirements: [] })
    const controller = new RuntimeActivationController({ journal: makeJournal() })
    controller.register([domain], [makeHandler(domain.id, log)])
    const projection = await controller.load(facts({ capabilityGrants: ['device.hands'] }))
    const view = projection.domains.find((entry) => entry.id === domain.id)
    expect(view?.status).toBe('blocked')
    expect(log).toEqual([])
  })
})

describe('the fail-closed and gated domains', () => {
  it('keeps Device Hands blocked without a host adapter and a grant', () => {
    const hands = registryById('core.device-hands')
    expect(hands?.activation).toBe('blocked')
    const kinds = hands?.requirements.map((requirement) => requirement.kind) ?? []
    expect(kinds).toContain('host-adapter')
    expect(kinds).toContain('capability-grant')
  })

  it('keeps Multi-Device blocked without a transport and a trusted device', () => {
    const multi = registryById('core.multidevice')
    expect(multi?.activation).toBe('blocked')
    const kinds = multi?.requirements.map((requirement) => requirement.kind) ?? []
    expect(kinds).toContain('transport')
    expect(kinds).toContain('trusted-device')
  })

  it('keeps the real-money domains fail-closed under abundant facts', async () => {
    for (const id of ['core.economic', 'core.enterprise']) {
      const domain = registryById(id)
      expect(domain?.activation, id).toBe('fail-closed')
      const controller = new RuntimeActivationController({ journal: makeJournal() })
      controller.register([domain!], [])
      const projection = await controller.load(
        facts({
          budgetRemainingUnits: 1_000_000,
          ownerApprovals: ['spend'],
          capabilityGrants: ['economic'],
        }),
      )
      const view = projection.domains.find((entry) => entry.id === id)
      expect(view?.status, id).toBe('blocked')
      expect(view?.reason, id).toMatch(/fail-closed/i)
    }
  })
})

describe('maturity is a measurement, never an authority source', () => {
  it('registers the threshold as available, not active, and requiring only the journal', () => {
    const threshold = registryById('core.threshold')
    expect(threshold?.activation).toBe('activatable')
    expect(threshold?.requirements.map((requirement) => requirement.kind)).toEqual(['journal'])
    expect(threshold?.kind).toBe('framework')
  })

  it('does not activate a mature result into a capability', async () => {
    const threshold = registryById('core.threshold')!
    const controller = new RuntimeActivationController({ journal: makeJournal() })
    controller.register([threshold], [])
    const projection = await controller.load(facts())
    const view = projection.domains.find((entry) => entry.id === threshold.id)
    // No handler is wired, so it is available and dependency-checked; it is not
    // running, and nothing about a mature result changes that.
    expect(view?.status).toBe('available')
    expect(projection.active).not.toContain(threshold.id)
  })

  it('covers every registered domain in the inventory', () => {
    expect(RUNTIME_REGISTRY.length).toBeGreaterThanOrEqual(20)
    const ids = RUNTIME_REGISTRY.map((entry) => entry.id)
    expect(ids).toContain('core.threshold')
    expect(ids).toContain('core.evolution')
    expect(ids).toContain('core.sovereignty')
  })
})
