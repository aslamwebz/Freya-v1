import { describe, expect, it } from 'vitest'
import {
  READINESS_STATES,
  buildCapabilityInventory,
  buildInventoryFromProjection,
  capabilityReadiness,
  inventorySummary,
  readinessFromRuntimeStatus,
  registryById,
  type ReadinessState,
} from '../../core/qualification'
import { QUALIFIED_MODULES, floorFacts, projectedInput } from './fixture'

/**
 * The five-state readiness vocabulary.
 *
 * Every test here is about one thing: making a state impossible to reach without the
 * evidence that justifies it. If a domain can be `active` without its implementation
 * being present, or `available` while something is missing that it needs, or silently
 * collapse two states into one, then the vocabulary is decoration.
 */

describe('Phase 49 capability readiness', () => {
  it('names exactly five states and recognises no others', () => {
    expect(READINESS_STATES).toEqual(['active', 'available', 'degraded', 'blocked', 'unavailable'])
  })

  it('treats an implementation that is not in this build as unavailable, not as idle', () => {
    const brain = registryById('core.brain')
    expect(brain).toBeDefined()
    const derived = capabilityReadiness(brain!, {
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES.filter((id) => id !== 'core.brain'),
    })
    expect(derived.readiness).toBe('unavailable')
    expect(derived.reason).toContain('not in this build')
  })

  it('reports a bare but present Core-owned domain as active, and names no reduction', () => {
    const attention = registryById('core.attention')
    const derived = capabilityReadiness(attention!, {
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES,
    })
    expect(derived.readiness).toBe('active')
    expect(derived.missing).toEqual([])
    expect(derived.reduced).toEqual([])
  })

  it('reports a missing keyring entry as degraded rather than blocked', () => {
    const brain = registryById('core.brain')
    const withoutKey = capabilityReadiness(brain!, {
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES,
    })
    expect(withoutKey.readiness).toBe('degraded')
    expect(withoutKey.missing).toEqual([])
    expect(withoutKey.reduced.join(' ')).toContain('Brain keyring entry')

    const withKey = capabilityReadiness(brain!, {
      facts: floorFacts({ keyringKeys: ['brain'] }),
      presentModules: QUALIFIED_MODULES,
    })
    expect(withKey.readiness).toBe('active')
    expect(withKey.reduced).toEqual([])
  })

  it('reports a required dependency that is absent as blocked, and names it', () => {
    const hands = registryById('core.device-hands')
    const derived = capabilityReadiness(hands!, {
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES,
    })
    expect(derived.readiness).toBe('blocked')
    expect(derived.missing).toContain('a Device Hands capability grant')
  })

  it('keeps a fail-closed domain blocked even when every dependency is satisfied', () => {
    const enterprise = registryById('core.enterprise')
    const satisfied = capabilityReadiness(enterprise!, {
      facts: floorFacts({
        journalTrustworthy: true,
        hostAdapters: ['device-hands'],
        capabilityGrants: ['device.hands'],
        transportAvailable: true,
        trustedDevices: 1,
      }),
      presentModules: QUALIFIED_MODULES,
    })
    expect(satisfied.readiness).toBe('blocked')
  })

  it('reports an activatable domain with a wired handler as active and without one as available', () => {
    const sovereignty = registryById('core.sovereignty')
    const facts = floorFacts()
    const withoutHandler = capabilityReadiness(sovereignty!, {
      facts,
      presentModules: QUALIFIED_MODULES,
    })
    expect(withoutHandler.readiness).toBe('available')

    const withHandler = capabilityReadiness(sovereignty!, {
      facts,
      presentModules: QUALIFIED_MODULES,
      wiredHandlers: ['core.sovereignty'],
    })
    expect(withHandler.readiness).toBe('active')
  })

  it('blocks every domain but the security spine once STOP ALL is latched', () => {
    const facts = floorFacts({ stopAllActive: true })
    const states = QUALIFIED_MODULES.map((id) => [
      id,
      capabilityReadiness(registryById(id)!, { facts, presentModules: QUALIFIED_MODULES })
        .readiness,
    ])
    const notBlocked = states.filter(([, state]) => state !== 'blocked').map(([id]) => id)
    expect(notBlocked).toEqual(['core.security-spine'])
  })

  it('maps every runtime status onto a readiness state, and pre-activation statuses onto blocked', () => {
    const mapped: Readonly<Record<string, ReadinessState>> = {
      active: 'active',
      degraded: 'degraded',
      available: 'available',
      blocked: 'blocked',
      disabled: 'blocked',
      implemented: 'blocked',
      registered: 'blocked',
    }
    for (const [status, readiness] of Object.entries(mapped)) {
      expect(readinessFromRuntimeStatus(status as never)).toBe(readiness)
    }
  })
})

describe('Phase 49 inventory roll-up', () => {
  const inventory = buildCapabilityInventory({
    facts: floorFacts(),
    presentModules: QUALIFIED_MODULES,
  })

  it('covers every registry id, so nothing can be quietly dropped', () => {
    expect(inventory.ids).toHaveLength(29)
    expect(new Set(inventory.ids).size).toBe(inventory.ids.length)
  })

  it('counts each readiness exactly once and the counts sum to the whole', () => {
    const total = Object.values(inventory.counts).reduce((sum, value) => sum + value, 0)
    expect(total).toBe(inventory.capabilities.length)
    for (const state of READINESS_STATES) {
      const counted = inventory.capabilities.filter((c) => c.readiness === state).length
      expect(inventory.counts[state]).toBe(counted)
    }
  })

  it('lists running, available and blocked as disjoint groups that partition the inventory', () => {
    const running = new Set(inventory.running)
    const available = new Set(inventory.available)
    const blocked = new Set(inventory.blocked.map((c) => c.id))
    for (const id of [...running].filter((value) => available.has(value))) {
      throw new Error(`${id} is both running and available`)
    }
    expect([...running, ...available, ...blocked].sort()).toEqual(
      [...inventory.ids].sort(),
    )
  })

  it('reports every blocked capability with a reason, and never leaves one silent', () => {
    for (const capability of inventory.blocked) {
      // A reason is required. A missing dependency is *not*: a fail-closed domain is
      // blocked with nothing missing, and demanding otherwise would force the report
      // to invent a deficiency that does not exist.
      expect(capability.reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('summarises by count only, so a headline can never name a capability', () => {
    const summary = inventorySummary(inventory)
    for (const id of inventory.ids) expect(summary).not.toContain(id)
    expect(summary).toContain(`${String(inventory.counts.active)} active`)
  })

  it('derives the same counts from a live-shaped projection as from the pure derivation', () => {
    // A projection built from the very same decisions must not change the arithmetic;
    // that is the property `agreement.test.ts` proves against a real controller.
    const view = (id: string) => ({
      id,
      family: registryById(id)!.family,
      title: registryById(id)!.title,
      module: registryById(id)!.module,
      kind: registryById(id)!.kind,
      activation: registryById(id)!.activation,
      status: capabilityReadiness(registryById(id)!, {
        facts: floorFacts(),
        presentModules: QUALIFIED_MODULES,
      }).readiness,
      reason: 'test',
      missing: [],
      evidence: [],
      activatedAt: null,
      changedAt: null,
      lastOutcome: null,
      note: registryById(id)!.note,
    })
    const projection = {
      lifecycle: 'active',
      generatedAt: '2026-01-01T00:00:00.000Z',
      stopAllActive: false,
      counts: {} as never,
      domains: inventory.ids.map(view),
      active: [],
      blocked: [],
      degraded: [],
      lastStopReason: null,
      lastReconciledAt: null,
      recoveredDomains: [],
    } as never

    const fromProjection = buildInventoryFromProjection(projection, projectedInput())
    expect(fromProjection.counts).toEqual(inventory.counts)
  })
})