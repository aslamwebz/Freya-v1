// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../core'
import {
  RELEASE_GATES,
  SHIPPING_SCOPE,
  buildInventoryFromProjection,
  capabilityReadiness,
  orderedRegistry,
  shippingClaimFor,
  startLiveQualification,
  type CapabilityInventory,
} from '../../../core/qualification'
import { QUALIFIED_MODULES, floorFacts } from '../fixture'

/**
 * Scenario gate: `runtime-activation-truth`.
 *
 * Bounded: one real Core, one real temporary directory, no network, no credential, no
 * host seam. Every other scenario crosses layers; this one crosses the seam between
 * what the release *says* and what the runtime *does*, which is the seam a release
 * report is most able to get wrong.
 *
 * It answers four questions, each of which has bitten a release before:
 *
 *   1. Does a live Core's projection produce the same readiness the release declares?
 *   2. Does any domain claim to be running while no activation handler exists for it?
 *   3. Does every capability the release ships actually appear in the measurement?
 *   4. Does every gate the release depends on name a capability it really measures?
 */

let dataPath = ''
let root = ''
let live: Awaited<ReturnType<typeof startLiveQualification>> | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freya-p49-runtime-'))
  dataPath = join(root, 'journal')
})

afterEach(async () => {
  if (live !== null) await live.stop()
  live = null
  await rm(root, { recursive: true, force: true })
})

function inventoryOf(projection: Parameters<typeof buildInventoryFromProjection>[0]): CapabilityInventory {
  return buildInventoryFromProjection(projection, { presentModules: QUALIFIED_MODULES })
}

describe('runtime activation truth', () => {
  it('a live Core on a bare machine agrees with the release inventory it is measured by', async () => {
    live = await startLiveQualification({
      dataPath,
      environment: {
        providerCredentialInEnv: false,
        liveModelRequested: false,
        keyringAvailable: false,
        platform: 'qualification',
      },
    })

    const inventory = inventoryOf(live.projection)

    // 1. The live projection must cover the whole canonical registry. A domain the
    //    controller does not know about cannot be claimed as shipped.
    expect(new Set(inventory.ids)).toEqual(new Set(orderedRegistry().map((d) => d.id)))

    // 2. Every shipping claim must be met by the live readiness, not by an assumption.
    for (const declaration of SHIPPING_SCOPE) {
      const capability = inventory.capabilities.find((c) => c.id === declaration.id)
      expect(capability, `${declaration.id} is declared but absent from the live projection`)
        .toBeDefined()
      if (declaration.claim === 'shipping') {
        expect(
          ['active', 'degraded'],
          `${declaration.id} is declared shipping but the live Core reports ${String(capability?.readiness)}`,
        ).toContain(capability?.readiness)
      }
    }

    // 3. The spine must be running. If it is not, nothing else in the report matters.
    expect(live.projection.domains.find((d) => d.id === 'core.security-spine')?.status).toBe('active')
  })

  it('never reports a domain as active when nothing can have started it', async () => {
    const core = createCore({ dataPath: join(root, 'second'), env: {} })
    await core.start()
    const projection = core.runtime()

    // Core registers the registry with no activation handlers. An activatable
    // domain may be available when its requirements are met, or blocked/degraded
    // when they are not. What it must never do without a handler is claim active.
    const activatable = orderedRegistry().filter((d) => d.activation === 'activatable')
    expect(activatable.length).toBeGreaterThan(0)
    for (const descriptor of activatable) {
      const view = projection.domains.find((d) => d.id === descriptor.id)!
      expect(view.status, `${descriptor.id} claimed ${view.status} with no handler wired`).not.toBe(
        'active',
      )
    }

    // And the fail-closed domains must be blocked no matter how complete the fact set.
    for (const descriptor of orderedRegistry().filter((d) => d.activation === 'fail-closed')) {
      const view = projection.domains.find((d) => d.id === descriptor.id)!
      expect(view.status).toBe('blocked')
    }

    await core.stop('scenario finished')
  })

  it('derives identical readiness from a fact set and from the live projection', async () => {
    live = await startLiveQualification({
      dataPath,
      environment: {
        providerCredentialInEnv: false,
        liveModelRequested: false,
        keyringAvailable: false,
        platform: 'qualification',
      },
    })
    const predicted = orderedRegistry().map((descriptor) => [
      descriptor.id,
      capabilityReadiness(descriptor, {
        facts: floorFacts(),
        presentModules: QUALIFIED_MODULES,
      }).readiness,
    ])
    const measured = live.projection.domains.map((view) => [view.id, view.status])

    expect(Object.fromEntries(measured)).toEqual(Object.fromEntries(predicted))
  })

  it('declares every registry capability, so nothing is implemented and unclaimed', () => {
    const declared = new Set(SHIPPING_SCOPE.map((declaration) => declaration.id))
    for (const descriptor of orderedRegistry()) {
      expect(declared, `${descriptor.id} has no shipping claim`).toContain(descriptor.id)
      expect(shippingClaimFor(descriptor.id)?.reason.length).toBeGreaterThan(20)
    }
    expect(declared.size).toBe(orderedRegistry().length)
  })

  it('names, for every gate that measures behaviour, a capability the registry knows', () => {
    const known = new Set(orderedRegistry().map((descriptor) => descriptor.id))
    for (const declaration of RELEASE_GATES) {
      for (const id of declaration.capabilities) {
        expect(known, `${declaration.id} names unknown capability ${id}`).toContain(id)
      }
    }
  })

  it('reaches ready, and reports ready, with no host seam at all', async () => {
    live = await startLiveQualification({
      dataPath,
      environment: {
        providerCredentialInEnv: false,
        liveModelRequested: false,
        keyringAvailable: false,
        platform: 'qualification',
      },
    })
    expect(live.lifecycle).toBe('ready')
    expect(live.projection.lifecycle).toBe('active')
    expect(live.projection.stopAllActive).toBe(false)
  })
})