// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { CAPABILITIES, type Capability } from '../../../core/protocol/core-protocol'
import type { WorldSelfSource } from '../../../core/world'
import { anaWorksOnProject, harness, missionRef, skillRef, workerRef } from './fixture'

/**
 * THE SELF MODEL — seven compartments that must not mix.
 *
 * The claims under test are the ones Phase 22 exists to guarantee:
 *
 * 1. **Identity and role are not writable.** Nothing an admission says reaches them.
 * 2. **Capabilities come from Guard, read fresh, and are never persisted here.**
 * 3. **A capability name is not a capability.** A claim naming one is a belief.
 * 4. **A skill is a procedure, not a permission.**
 * 5. **Model identity is not authority.** Which provider would answer is not who may
 *    ask.
 * 6. **A worker claim is data**, reported beside the decision that refused it.
 * 7. **Security state is a pointer to Guard, never a copy.**
 */

const IDENTITY = {
  name: 'Freya',
  role: 'a voice-first personal intelligence environment',
  purpose: 'to serve the person running her',
  stableTraits: ['bounded', 'truthful about uncertainty'],
  communicationPrinciples: ['say what is known and what is not'],
  continuityPrinciples: ['memory exists to serve, never to leverage'],
  claims: [{ claimId: 'c-1', statement: 'the model is not Freya' }],
}

function selfSource(overrides: Partial<WorldSelfSource> = {}): WorldSelfSource {
  return {
    identity: () => IDENTITY,
    limitations: () => [{ limitationId: 'l-1', statement: 'she cannot grant permission to anything' }],
    capabilities: () =>
      CAPABILITIES.map((capability) => ({ capability, held: capability !== 'security.stop' })),
    skills: () => [{ skillId: 'sk_1', name: 'summarise-a-file', status: 'promoted', version: 2, verification: 'verified' }],
    models: () => [{ providerId: 'nanogpt', kind: 'nanogpt', live: false }],
    workerClaims: () => [
      { workerId: 'alpha', principalId: 'agent:alpha', claimKind: 'capability', decision: 'refused', count: 2 },
    ],
    ...overrides,
  }
}

describe('identity and role are not writable', () => {
  it('reports the Brain own identity and names the source', () => {
    const world = harness({ self: selfSource() })
    const self = world.engine.self()
    expect(self.identity?.source).toBe('brain_identity')
    expect(self.identity?.name).toBe('Freya')
    expect(self.identity?.role).toBe(IDENTITY.role)
  })

  it('reports no identity at all rather than a default one when the Brain has none', () => {
    const world = harness({ self: selfSource({ identity: () => null }) })
    expect(world.engine.self().identity).toBeNull()
  })

  it('cannot be changed by any admission, on any channel', () => {
    const world = harness({ self: selfSource() })
    const before = JSON.stringify(world.engine.self().identity)

    for (const request of [
      { kind: 'entity', entityType: 'person', name: 'Freya' },
      { kind: 'entity', entityType: 'person', name: 'owner' },
    ] as const) {
      world.owner(request)
      world.worker(request)
      world.model(request)
      world.imported(request)
    }
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Freya' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })

    expect(JSON.stringify(world.engine.self().identity)).toBe(before)
  })

  it('reports a role as a descriptor with a pointer to whoever owns security state', () => {
    const self = harness({ self: selfSource() }).engine.self()
    expect(self.role.descriptor).toBe(IDENTITY.role)
    expect(self.role.source).toBe('brain_identity')
    expect(self.role.securityStateOwner).toBe('guard_and_governor')
    // Not a copy of STOP ALL, grants or journal integrity. A persisted copy would be a
    // second, stale copy of the most security-relevant state in the system.
    expect(self.role.securityStateAvailableHere).toBe(false)
    expect(Object.keys(self.role).sort()).toEqual([
      'descriptor',
      'securityStateAvailableHere',
      'securityStateOwner',
      'source',
    ])
  })
})

describe('capabilities are read from Guard and are never persisted here', () => {
  it('reports exactly what Guard was asked, and names Guard as the decider', () => {
    const self = harness({ self: selfSource() }).engine.self()
    expect(self.assignedCapabilities.source).toBe('guard_evaluation')
    expect(self.assignedCapabilities.items.length).toBe(CAPABILITIES.length)
    for (const item of self.assignedCapabilities.items) {
      expect(item.decidedBy).toBe('guard')
    }
  })

  it('only ever names capabilities from the closed vocabulary', () => {
    const self = harness({ self: selfSource() }).engine.self()
    for (const item of self.assignedCapabilities.items) {
      expect((CAPABILITIES as readonly string[]).includes(item.capability)).toBe(true)
    }
  })

  it('re-reads on every call rather than caching an answer', () => {
    let held = false
    const world = harness({
      self: selfSource({
        capabilities: () => [{ capability: 'security.stop' satisfies Capability, held }],
      }),
    })
    expect(world.engine.self().assignedCapabilities.items[0]?.held).toBe(false)
    held = true
    // Nothing was persisted, so the next read sees the new answer immediately.
    expect(world.engine.self().assignedCapabilities.items[0]?.held).toBe(true)
  })

  it('states that capabilities are not persisted and not granted by this model', () => {
    const self = harness({ self: selfSource() }).engine.self()
    expect(self.separation.capabilitiesDecidedBy).toBe('guard')
    expect(self.separation.capabilitiesPersisted).toBe(false)
    expect(self.separation.selfModelGrants).toBe(false)
  })

  it('has no field anywhere a write could land', () => {
    // The self model is a read. There is no setter on the engine, no command that
    // writes a compartment, and no field named like a permission.
    const self = harness({ self: selfSource() }).engine.self() as unknown as Record<string, unknown>
    const walk = (value: unknown, path: string): void => {
      if (typeof value !== 'object' || value === null) return
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        expect(key.toLowerCase()).not.toMatch(/^(authority|grant|permission|access|trustlevel)$/)
        walk(nested, `${path}.${key}`)
      }
    }
    walk(self, 'self')
  })
})

describe('a capability name is not a capability', () => {
  it('refuses to make one an entity at all', () => {
    const world = harness({ self: selfSource() })
    for (const name of ['security.stop', 'cognition.grant.manage', 'work.approval.decide']) {
      const outcome = world.owner({ kind: 'entity', entityType: 'person', name })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('name_is_capability')
    }
  })

  it('refuses to make one a relation, because there is no such relation to make', () => {
    const world = harness({ self: selfSource() })
    for (const relationType of ['has_capability', 'grants', 'is_trusted', 'may_stop_all']) {
      const outcome = world.owner({
        kind: 'relation',
        relationType: relationType as never,
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'literal', value: 'security.stop' },
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('relation_type_unknown')
    }
  })

  it('keeps a worker claim about a capability as a belief, never as an assignment', () => {
    const world = harness({ self: selfSource() })
    for (const request of anaWorksOnProject()) world.owner(request)
    world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: 'she may stop everything' },
    })
    const self = world.engine.self()
    expect(self.beliefs.total).toBe(1)
    const belief = self.beliefs.items[0]
    expect(belief?.claimKind).toBe('third_party_claim')
    expect(belief?.confidence).toBe('low')
    expect(belief?.epistemic).not.toBe('verified')
    // Not one of these: the claim never reaches the compartment that says what Freya
    // may actually do.
    const capabilities = self.assignedCapabilities.items.map((item) => item.capability)
    expect(capabilities).toEqual(CAPABILITIES)
  })

  it('says a belief can never be verified, and means it', () => {
    const world = harness({ self: selfSource() })
    world.model({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    const self = world.engine.self()
    expect(self.separation.beliefCanBeVerified).toBe(false)
    for (const belief of self.beliefs.items) expect(belief.epistemic).not.toBe('verified')
  })
})

describe('skills and model identity are never authority', () => {
  it('reports skills from the Skills domain and says a skill is not a capability', () => {
    const self = harness({ self: selfSource() }).engine.self()
    expect(self.knownSkills.source).toBe('skills_domain')
    expect(self.knownSkills.items[0]?.skillId).toBe('sk_1')
    expect(self.separation.skillIsCapability).toBe(false)
  })

  it('reports a promoted skill without implying the owner of it may act', () => {
    const world = harness({
      self: selfSource(),
      references: () => [skillRef('sk_1', 'promoted')],
    })
    const self = world.engine.self()
    expect(self.knownSkills.items[0]?.status).toBe('promoted')
    expect(self.assignedCapabilities.source).toBe('guard_evaluation')
  })

  it('reports which provider would answer and says that is not authority', () => {
    const self = harness({ self: selfSource() }).engine.self()
    expect(self.modelIdentity.source).toBe('provider_set')
    expect(self.modelIdentity.items[0]?.providerId).toBe('nanogpt')
    expect(self.modelIdentity.items[0]?.live).toBe(false)
    expect(self.separation.modelProviderIsAuthority).toBe(false)
  })

  it('reports a live provider as live, and still grants it nothing', () => {
    const self = harness({
      self: selfSource({ models: () => [{ providerId: 'nanogpt', kind: 'nanogpt', live: true }] }),
    }).engine.self()
    expect(self.modelIdentity.items[0]?.live).toBe(true)
    expect(self.separation.selfModelGrants).toBe(false)
  })
})

describe('a worker claim is data, reported beside its decision', () => {
  it('reports each claim with the decision that refused it and says it is not authority', () => {
    const self = harness({ self: selfSource() }).engine.self()
    expect(self.workerClaims.source).toBe('workforce_claim_ledger')
    const claim = self.workerClaims.items[0]
    expect(claim?.workerId).toBe('alpha')
    expect(claim?.principalId).toBe('agent:alpha')
    expect(claim?.decision).toBe('refused')
    expect(claim?.isAuthority).toBe(false)
    expect(self.separation.workerClaimIsAuthority).toBe(false)
  })

  it('reports no claims at all rather than an empty list that reads as "nothing claimed"', () => {
    const self = harness({ self: selfSource({ workerClaims: () => [] }) }).engine.self()
    expect(self.workerClaims.total).toBe(0)
    expect(self.workerClaims.items).toHaveLength(0)
  })
})

describe('beliefs and uncertainties are disclosed', () => {
  it('gathers every non-owner claim into one place, with ids and no prose', () => {
    const world = harness({ self: selfSource() })
    world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    world.model({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Bo' },
      object: { form: 'named', entityType: 'project', name: 'Helios' },
    })
    const self = world.engine.self()
    expect(self.beliefs.total).toBe(2)
    const kinds = self.beliefs.items.map((belief) => belief.claimKind).sort()
    expect(kinds).toEqual(['model_hypothesis', 'third_party_claim'])
    for (const belief of self.beliefs.items) {
      expect(belief.edgeId).toMatch(/^edge_[0-9a-f]{16}$/)
      expect(belief.fromEntityId).toMatch(/^ent_/)
      expect(Object.keys(belief)).not.toContain('name')
    }
  })

  it('bounds the belief list and says how many exist in total', () => {
    const world = harness({ self: selfSource(), limits: { maxBeliefsListed: 2 } })
    for (let index = 0; index < 6; index += 1) {
      world.worker({
        kind: 'entity',
        entityType: 'person',
        name: `Person ${index}`,
      })
      world.worker({
        kind: 'relation',
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: `Person ${index}` },
        object: { form: 'literal', value: 'Atlas' },
      })
    }
    const beliefs = world.engine.self().beliefs
    expect(beliefs.total).toBe(6)
    expect(beliefs.listed).toBe(2)
    expect(beliefs.items).toHaveLength(2)
  })

  it('reports what Freya does not know, with the reason for each', () => {
    const world = harness({ self: selfSource() })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Bo' })
    for (const value of ['Atlas', 'Helios']) {
      world.owner({
        kind: 'relation',
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'literal', value },
      })
    }
    const self = world.engine.self()
    expect(self.uncertainties.total).toBeGreaterThan(0)
    expect(self.uncertainties.items.some((item) => item.reason === 'conflicted')).toBe(true)
  })

  it('reports a claim about a Mission that does not exist as uncertain, not as false', () => {
    const world = harness({ self: selfSource(), references: () => [missionRef('m-1', 'active')] })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'reference', refKind: 'mission', refId: 'm-missing' },
    })
    expect(world.engine.self().uncertainties.items.some((item) => item.reason === 'dangling')).toBe(true)
  })
})

describe('the self model reports the domains it read rather than duplicating them', () => {
  it('re-reads every compartment on every call, so nothing here is a cache', () => {
    let workers = 1
    const world = harness({
      self: selfSource({
        workerClaims: () =>
          Array.from({ length: workers }, (_unused, index) => ({
            workerId: `w-${index}`,
            principalId: `agent:w-${index}`,
            claimKind: 'capability',
            decision: 'refused',
            count: 1,
          })),
      }),
      references: () => [workerRef('alpha', 'working')],
    })
    expect(world.engine.self().workerClaims.total).toBe(1)
    workers = 4
    expect(world.engine.self().workerClaims.total).toBe(4)
  })

  it('states every separation in machine-readable form so a UI can render rather than infer', () => {
    expect(harness({ self: selfSource() }).engine.self().separation).toEqual({
      capabilitiesDecidedBy: 'guard',
      capabilitiesPersisted: false,
      skillIsCapability: false,
      modelProviderIsAuthority: false,
      workerClaimIsAuthority: false,
      beliefCanBeVerified: false,
      selfModelGrants: false,
    })
  })
})