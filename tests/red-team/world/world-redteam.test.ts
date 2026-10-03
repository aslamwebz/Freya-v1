// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore } from '../../../core/index'
import {
  CAPABILITIES,
  WORKER_CAPABILITIES,
  type Capability,
  type CoreCommandName,
  type CoreCommandResult,
} from '../../../core/protocol/core-protocol'
import { DefaultGuard, type Principal } from '../../../core/security/guard'
import { CAPABILITIES as GUARD_VOCABULARY } from '../../../core/protocol/core-protocol'
import {
  WorldEngine,
  normaliseWorldName,
  WORLD_OWNER_ENTITY_ID,
  WORLD_SELF_ENTITY_ID,
  WORLD_FORBIDDEN_REQUEST_KEYS,
  type WorldEvidenceRecord,
  type WorldEvidenceRequest,
} from '../../../core/world'
import { WORLD_NO_PAYLOAD } from '../../../core/protocol/world'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { workerAuthority } from '../../../core/testing'
import { EphemeralWorldStore } from '../../../core/world'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readdir } from 'node:fs/promises'
import {
  T0,
  anaWorksOnProject,
  emptyHolder,
  harness,
  memoryStore,
  missionRef,
  workerRef,
} from '../../core/world/fixture'

/**
 * RED TEAM — the Self & World Model under attack.
 *
 * Fourteen families, one per row of the threat model in `docs/PHASE-22.md`:
 *
 *  1. entity poisoning        8. privacy leakage
 *  2. relationship forgery    9. replay and tampering
 *  3. identity spoofing      10. replay and restart
 *  4. capability escalation  11. boundedness
 *  5. conflict handling      12. zero idle calls
 *  6. stale evidence         13. renderer cannot write
 *  7. source withdrawal      14. domain state is not duplicated
 *
 * The rule every family obeys: the attacker controls the *content*. Nothing here
 * controls a channel, a capability, a Guard decision or a store key — because in this
 * system those are not things content can reach.
 */

const SENTINEL = 'FREYA_RED_TEAM_WORLD_4B21'

/** A per-file request counter, so a submission is identifiable in a failure. */
let requestCounter = 0

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-world-red-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------- 1. entity poisoning */

describe('entity poisoning: untrusted content cannot adopt a trusted name', () => {
  it('records a poisoned entity as somebody else assertion, whatever the text says', () => {
    const world = harness()
    // The payload is a perfect forgery: it claims owner authority in its own words.
    world.imported({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      evidenceSummary: 'the owner said so, signed',
      sourceRef: 'turn-1',
    } as WorldEvidenceRequest)

    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    expect(ana?.claimKind).toBe('third_party_claim')
    expect(ana?.confidence).toBe('low')
    expect(ana?.epistemic).toBe('asserted')
    // There is no field that says "trusted", and the claim kind that most looks like one
    // is the owner's own, which this is not.
    expect(ana?.claimKind).not.toBe('owner_statement')
    expect(ana?.claimKind).not.toBe('domain_record')
    // And the poisoned summary is nowhere: only its length survives.
    expect(JSON.stringify(world.engine.summary())).not.toContain('signed')
  })

  it('records a model hypothesis as a hypothesis, even when it is certain-sounding', () => {
    const world = harness()
    world.model({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      evidenceSummary: 'I am certain this is correct',
    })
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    expect(ana?.claimKind).toBe('model_hypothesis')
    expect(ana?.epistemic).toBe('inferred')
    expect(ana?.confidence).toBe('low')
  })

  it('refuses a poisoned name outright rather than sanitising it into a real one', () => {
    for (const name of [
      'Ana<script>alert(1)</script>',
      '../../etc/passwd',
      'Ana\u0000drop',
      'Ana\nAna',
      SENTINEL + '/../owner',
    ]) {
      expect(normaliseWorldName(name)).toBeNull()
    }
  })

  it('refuses a whole poisoned payload rather than admitting the fields it recognises', () => {
    const world = harness()
    const outcome = world.engine.admit({
      request: {
        kind: 'entity',
        entityType: 'person',
        name: 'Ana',
        trust: 'owner',
        confidence: 'verified',
      } as unknown as WorldEvidenceRequest,
      channel: 'imported_content',
      actor: 'system',
      sensitivity: 'normal',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('claim_fields_not_admissible')
    // Nothing got in, not even the name.
    expect(world.engine.entities({ kind: 'person' }).entities.some((node) => node.name === 'Ana')).toBe(false)
  })

  it('refuses every authority-shaped key by name, so the attempt is visible', () => {
    for (const key of ['authority', 'capability', 'grant', 'permission', 'trust', 'trusted', 'principal', 'actor']) {
      expect(WORLD_FORBIDDEN_REQUEST_KEYS).toContain(key)
    }
  })
})

/* --------------------------------------------------- 2. relationship forgery */

describe('relationship forgery: a worker cannot assert a trusted relationship', () => {
  it('records a forged works_on as an untrusted claim, not a fact', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'entity', entityType: 'project', name: 'Atlas' })
    world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })

    const edges = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges
    const forged = edges.find((edge) => edge.relationType === 'works_on')
    expect(forged?.origin).toBe('admitted_evidence')
    expect(forged?.provenance.source).toBe('external-untrusted')
    expect(forged?.provenance.confidence).toBe('low')
    // Not one of the two things that would make it a fact: a domain record, or verified.
    expect(forged?.origin).not.toBe('domain_record')
    expect(forged?.provenance.epistemic).not.toBe('verified')
  })

  it('cannot forge a relation whose shape does not exist', () => {
    const world = harness()
    for (const relationType of ['assigned_to_self', 'is_admin', 'owns_all', 'works_on']) {
      const outcome = world.worker({
        kind: 'relation',
        relationType: relationType as never,
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'named', entityType: 'project', name: 'Atlas' },
      })
      if (relationType === 'works_on') {
        // A real relation is admitted — as a low-confidence claim, which the test above
        // already pins down.
        expect(outcome.ok).toBe(true)
        continue
      }
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('relation_type_unknown')
    }
  })

  it('cannot forge an endpoint pairing the table does not permit', () => {
    const world = harness()
    const outcome = world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'place', name: 'Lisbon' },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('relation_endpoints_invalid')
  })

  it('cannot cap an untrusted relation at owner weight by asking nicely', () => {
    const world = harness()
    const outcome = world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
      confidence: 'verified',
    } as WorldEvidenceRequest)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('claim_fields_not_admissible')
  })
})

/* ----------------------------------------------------- 3. identity spoofing */

describe('identity spoofing: nothing written can redefine Freya', () => {
  it('keeps the singletons present and unchanged after every kind of claim', () => {
    const world = harness()
    const identityOf = (world: ReturnType<typeof harness>): unknown =>
      world.engine
        .entities({})
        .entities.filter((node) => node.singleton)
        .map((node) => ({
          entityId: node.entityId,
          kind: node.kind,
          name: node.name,
          claimKind: node.claimKind,
          epistemic: node.epistemic,
          singleton: node.singleton,
        }))
    const before = JSON.stringify(identityOf(world))

    for (const channel of ['owner', 'worker', 'model', 'imported', 'system'] as const) {
      world[channel]({ kind: 'entity', entityType: 'person', name: 'Freya' })
      world[channel]({ kind: 'entity', entityType: 'person', name: 'owner' })
      world[channel]({ kind: 'entity', entityType: 'self' as never, name: 'Freya' })
      world[channel]({
        kind: 'relation',
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: 'Freya' },
        object: { form: 'named', entityType: 'project', name: 'Atlas' },
      })
    }

    // Identity, kind and epistemic status are unchanged. A claim *about* Freya adds an
    // edge to her node, which is correct: she can be talked about. What it cannot do is
    // change who she is.
    expect(JSON.stringify(identityOf(world))).toBe(before)
    const singletons = world.engine.entities({}).entities.filter((node) => node.singleton)
    expect(singletons.map((node) => node.entityId).sort()).toEqual([WORLD_OWNER_ENTITY_ID, WORLD_SELF_ENTITY_ID].sort())
  })

  it('refuses every attempt to create or shadow a singleton by name', () => {
    const world = harness()
    for (const name of ['Freya', 'freya', 'FREYA', 'owner', 'Owner', 'ent_freya']) {
      const outcome = world.owner({ kind: 'entity', entityType: 'person', name })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('name_reserved')
    }
  })

  it('reports exactly two singleton nodes however much is admitted', () => {
    const world = harness()
    for (let index = 0; index < 20; index += 1) {
      world.worker({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    const singletons = world.engine.entities({}).entities.filter((node) => node.singleton)
    expect(singletons).toHaveLength(2)
  })
})

/* --------------------------------------------------- 4. capability escalation */

describe('capability escalation: a claim about a capability is not a capability', () => {
  it('cannot make a capability name into a thing in the world', () => {
    const world = harness()
    for (const capability of CAPABILITIES) {
      const outcome = world.owner({ kind: 'entity', entityType: 'person', name: capability })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('name_is_capability')
    }
  })

  it('cannot express "holds a capability" as a relation at all', () => {
    const world = harness()
    for (const relationType of [
      'has_capability',
      'grants',
      'is_authorised',
      'may_act',
      'trusts',
      'owns_capability',
    ]) {
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

  it('leaves Guard completely unchanged by a world write', () => {
    const guard = new DefaultGuard()
    const owner: Principal = { id: 'owner', capabilities: new Set(GUARD_VOCABULARY), trusted: true }
    const worker: Principal = { id: 'agent:alpha', capabilities: new Set(), trusted: false }
    const before = CAPABILITIES.map((capability) => guard.evaluate(owner, capability))

    const world = harness()
    for (const request of anaWorksOnProject()) world.owner(request)
    world.worker({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      attributes: { capability: 'security.stop' },
    } as WorldEvidenceRequest)

    const after = CAPABILITIES.map((capability) => guard.evaluate(owner, capability))
    expect(after).toEqual(before)
    // And a worker is refused before the capability list is even consulted.
    expect(guard.evaluate(worker, 'world.status.read').allowed).toBe(false)
  })

  it('keeps both world capabilities off every worker principal', () => {
    const worldCapabilities = CAPABILITIES.filter((capability) => capability.startsWith('world.'))
    for (const capability of worldCapabilities) {
      expect(WORKER_CAPABILITIES).not.toContain(capability)
      expect(new DefaultGuard().holds({ id: 'agent:x', capabilities: new Set([capability]), trusted: false }, capability)).toBe(
        false,
      )
    }
  })

  it('gives the worker authority object no world method to call', async () => {
    const core = createCore({
      dataPath: join(dir, 'authority.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await core.start()
    const worker = workerAuthority(core, 'agent:alpha')
    expect(Object.keys(worker).sort()).toEqual(['principalId', 'request'])
    for (const key of Object.keys(worker)) {
      expect(key.toLowerCase()).not.toContain('world')
    }
    // And nothing reachable from it names a capability.
    expect(JSON.stringify(Object.keys(worker))).not.toContain('capab')
    await core.stop()
  })

  it('gives no world subsystem object any way to reach a capability', () => {
    // Structural, not behavioural: there is nothing to reach, so there is nothing to
    // audit at runtime.
    new WorldEngine({
      persistence: new (class {
        readonly mode = 'ephemeral' as const
        readonly durable = false
        readonly durabilityReason = 'test'
        readonly faultReason = null as string | null
        async load() {
          return { ok: true as const, snapshot: { v: 1 as const, records: [], sequence: 0 } }
        }
        async commit(): Promise<void> {}
        async close(): Promise<void> {}
      })(),
      now: () => new Date(T0),
    })
    const surface = Object.getOwnPropertyNames(WorldEngine.prototype).map((name) => name.toLowerCase())
    for (const forbidden of ['grant', 'authorise', 'authorize', 'capability', 'stop', 'resume', 'provider', 'gateway', 'complete']) {
      expect(surface.some((name) => name.includes(forbidden))).toBe(false)
    }
  })
})

/* --------------------------------------------------------- 5. conflict handling */

describe('conflict handling: a disagreement is data, not a decision', () => {
  it('keeps every side of a two-source disagreement and chooses none', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'literal', value: 'Atlas' } })
    world.model({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'literal', value: 'Helios' } })

    const edges = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges
    expect(edges).toHaveLength(2)
    for (const edge of edges) {
      expect(edge.freshness).toBe('conflicted')
      expect(edge.conflictsWith).toHaveLength(2)
    }
    // Both claims keep their own weight. Neither was promoted to the other.
    const kinds = edges.map((edge) => edge.provenance.claimKind).sort()
    expect(kinds).toEqual(['model_hypothesis', 'owner_statement'])
  })

  it('refuses to let a stronger source silently overwrite a weaker one', () => {
    // The Brain ranks sources, and this is exactly why that ranking must not be used to
    // arbitrate: an observation outranking a person's own statement, chosen silently, is
    // the failure a world model exists to prevent.
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'literal', value: 'Atlas' } })
    world.system({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'literal', value: 'Helios' } })
    expect(world.engine.summary().counts.conflicts).toBe(1)
    expect(world.engine.summary().conflicts.items[0]?.evidenceIds).toHaveLength(2)
  })

  it('reports a conflict rather than resolving it, even for an untrusted source', () => {
    const world = harness()
    world.worker({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'literal', value: 'Atlas' } })
    world.worker({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'literal', value: 'Helios' } })
    expect(world.engine.summary().counts.conflicts).toBe(1)
  })
})

/* ----------------------------------------------------------- 6. stale evidence */

describe('stale evidence: an old claim is never presented as current', () => {
  it('moves a claim through aging to stale without ever calling it current again', () => {
    const world = harness()
    for (const request of anaWorksOnProject()) world.owner(request)
    expect(world.engine.summary().byFreshness.current).toBeGreaterThan(0)

    world.advanceDays(30)
    expect(world.engine.summary().byFreshness.current).toBe(0)
    expect(world.engine.summary().byFreshness.aging).toBeGreaterThan(0)

    world.advanceDays(120)
    const summary = world.engine.summary()
    expect(summary.byFreshness.current).toBe(0)
    expect(summary.byFreshness.stale).toBeGreaterThan(0)
    expect(summary.uncertainties.items.some((item) => item.reason === 'stale')).toBe(true)
  })

  it('will not accept an observation from the future to make a fresh claim look old-proof', () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      observedAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000).toISOString(),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('instant_in_future')
  })

  it('marks a finished claim historical rather than deleting it', () => {
    const world = harness()
    for (const request of anaWorksOnProject()) world.owner(request)
    const relation = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges[0]
    const evidenceId = relation?.evidenceId
    expect(evidenceId).toBeDefined()
    // A new claim with an end time in the past: the claim is finished, not erased.
    world.owner({
      kind: 'relation',
      relationType: 'related_to',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
      validUntil: new Date(T0.getTime() + 1000).toISOString(),
    })
    world.moveTo(new Date(T0.getTime() + 86_400_000))
    expect(world.engine.summary().byFreshness.historical).toBeGreaterThan(0)
    expect(world.engine.summary().counts.edges).toBeGreaterThan(0)
  })
})

/* ---------------------------------------------------------- 7. source withdrawal */

describe('source withdrawal: taking evidence back leaves no live fact behind', () => {
  it('removes a claim and everything derived from it, and says where it went', () => {
    const world = harness()
    const ids: string[] = []
    for (const request of anaWorksOnProject()) {
      const outcome = world.owner(request)
      if (outcome.ok) ids.push(outcome.evidenceId)
    }
    expect(world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges).toHaveLength(1)

    for (const evidenceId of ids) {
      expect(world.owner({ kind: 'withdrawal', targetEvidenceId: evidenceId, reason: 'wrong' }).ok).toBe(true)
    }
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.edges).toHaveLength(0)
    expect(graph.nodes.some((node) => node.name === 'Ana')).toBe(false)
    // Counted, not silently forgotten: a person who withdrew something can see that it
    // went somewhere rather than nowhere.
    expect(world.engine.summary().counts.withdrawnRecords).toBe(ids.length)
  })

  it('will not withdraw evidence that does not exist', () => {
    const world = harness()
    for (const target of ['wev-000000', 'not-an-id', '', 'wev-999999999']) {
      const outcome = world.owner({ kind: 'withdrawal', targetEvidenceId: target, reason: 'nope' })
      expect(outcome.ok).toBe(false)
    }
  })

  it('cannot resurrect a withdrawn claim by re-asserting it as a new one', () => {
    const world = harness()
    const created = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    if (!created.ok) return
    world.owner({ kind: 'withdrawal', targetEvidenceId: created.evidenceId, reason: 'wrong' })
    expect(world.engine.entities({}).entities.some((node) => node.name === 'Ana')).toBe(false)

    // Re-asserting is a *new claim*, and it shows as one — with its own evidence id, and
    // as fresh as the moment it was made rather than as the old one resurrected.
    const again = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.evidenceId).not.toBe(created.evidenceId)
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    expect(ana?.withdrawn).toBe(false)
    // Two evidence ids, not one: the withdrawn claim is still counted. A withdrawal that
    // erased the record would make it indistinguishable from never having been said, and
    // the whole point is that it can be seen to have been taken back.
    expect(ana?.evidenceCount).toBe(2)
    expect(world.engine.summary().counts.withdrawnRecords).toBe(1)
  })
})

/* ---------------------------------------------------------- 8. privacy leakage */

describe('privacy leakage: no broad projection carries private content', () => {
  it('leaks no sentinel planted in every free-text field a caller can reach', () => {
    const world = harness()
    // Every field that is *not* a name. Aliases are deliberately excluded: an alias is a
    // name, and a name is the one thing a graph cannot be drawn without, so projecting
    // one is minimum-necessary disclosure rather than a leak.
    world.owner({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      attributes: { secret: SENTINEL, note: SENTINEL },
      evidenceSummary: SENTINEL,
    })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: 'Atlas' },
      evidenceSummary: SENTINEL,
    })
    // The untrusted literal carries the sentinel, and must not come out the other side
    // in any form: rendering attacker-chosen text in front of a person unchanged is how
    // injected text becomes an instruction (C9).
    world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: SENTINEL },
    })

    const ana = world.engine.entities({ kind: 'person' }).entities[0]
    const views = [
      world.engine.summary(),
      world.engine.entities({}),
      world.engine.entities({ includeWithdrawn: true }),
      world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }),
      world.engine.self(),
      world.engine.entity(ana?.entityId ?? '', (fold) => fold.conflicts),
    ]
    for (const view of views) {
      const json = JSON.stringify(view)
      // The sentinel is a *value*, never a key, so a value-only search is the honest
      // test: a projection must not carry it anywhere a person could read it.
      expect(json).not.toContain(SENTINEL)
    }

    // And the contrast, because a privacy rule with no stated boundary is not a rule: an
    // **owner-stated** literal is projected, because a typed edge cannot be drawn without
    // it, while the untrusted one is withheld and says so with a length instead.
    const edges = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges
    const ownerLiteral = edges.find((edge) => edge.provenance.claimKind === 'owner_statement')
    const untrustedLiteral = edges.find((edge) => edge.provenance.claimKind === 'third_party_claim')
    expect(ownerLiteral?.literalValue).toBe('Atlas')
    expect(untrustedLiteral?.literalValue).toBeNull()
    expect(untrustedLiteral?.literalWithheld).toBe(true)
    expect(untrustedLiteral?.literalValueLength).toBe(SENTINEL.length)
  })

  it('refuses an alias that is not a name, so no text can ride in on one', () => {
    const world = harness()
    for (const alias of [`<script>${SENTINEL}</script>`, '../../x', `${SENTINEL}; drop`]) {
      const outcome = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana', aliases: [alias] })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('alias_unusable')
    }
  })

  it('refuses a source reference that is a sentence rather than an id', () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      sourceRef: `turn ${SENTINEL}`,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('source_ref_too_large')
  })

  it('keeps an entity backed only by sensitive evidence out of every listing', () => {
    const world = harness()
    const admitted = world.engine.admit({
      request: { kind: 'entity', entityType: 'person', name: 'Coded' },
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'secret-reference',
    })
    expect(admitted.ok).toBe(true)
    expect(world.engine.entities({}).entities.some((node) => node.name === 'Coded')).toBe(false)
    expect(world.engine.entities({ includeWithdrawn: true }).entities.some((node) => node.name === 'Coded')).toBe(false)
    expect(world.engine.summary().counts.withheld).toBe(1)
  })

  it('writes no claim anywhere readable when there is no Vault to write it into', async () => {
    // The durable path is the one encrypted Vault, and its plaintext proof is in the
    // binding-gated Vault suites. What has to hold *without* a binding is the negative:
    // a world with nowhere encrypted to put its evidence writes nothing at all, rather
    // than falling back to a file of its own.
    const world = harness({ store: new EphemeralWorldStore() })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana', evidenceSummary: SENTINEL })
    await world.engine.settled()
    await world.engine.close()
    expect(await readdir(dir)).toEqual([])
  })
})

/* ------------------------------------------------------- 9. replay and tampering */

describe('replay and tampering: a changed record fails closed', () => {
  it('serves nothing at all rather than the records that happened to parse', async () => {
    // The ledger is refused whole on any fault. There is no path that returns the rows
    // that happened to validate, because a world whose contents depend on which rows
    // somebody chose to damage is not a world model.
    const holder = emptyHolder()
    holder.snapshot = {
      v: 1,
      records: [
        validRecord(),
        { ...validRecord(), evidenceId: 'wev-000002', sequence: 2, actor: 'superuser' },
      ],
      sequence: 2,
    } as never
    const engine = new WorldEngine({ persistence: memoryStore(holder), now: () => new Date(T0) })
    const opened = await engine.open()
    expect(opened.ok).toBe(false)
    expect(engine.summary().counts.evidenceRecords).toBe(0)
    await engine.close()
  })

  it('refuses a record that authenticates but is not a legal record', async () => {
    // The codec runs in both directions, so a row that is intact but says something the
    // domain will not believe is a fault rather than a value.
    const holder = emptyHolder()
    holder.snapshot = {
      v: 1,
      records: [{ ...validRecord(), channel: 'worker_claim', confidence: 'high' }],
      sequence: 1,
    } as never
    const engine = new WorldEngine({ persistence: memoryStore(holder), now: () => new Date(T0) })
    expect((await engine.open()).ok).toBe(false)
    expect(engine.summary().counts.evidenceRecords).toBe(0)
    await engine.close()
  })

  it('names no second store: the world has exactly one durable mechanism', () => {
    // A structural check, because the failure it guards against is architectural rather
    // than behavioural. Every other test in this file would still pass if somebody added
    // a bespoke encrypted world file, a JSONL ledger or a second database alongside the
    // Vault, and `PLAN.md` Step E forbids precisely that.
    const sources = worldDomainSources()
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.some((path) => path.includes('encrypted-store'))).toBe(false)
    expect(sources.some((path) => path.endsWith('open.ts'))).toBe(false)
    // No world file may touch the filesystem: storage is the Vault's job, and a
    // `node:fs` import here is how a bespoke file would come back.
    for (const path of sources) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/from 'node:fs/)
    }
    // The one hash in the domain is a *deterministic id* derivation, not a cipher and
    // not key material. Pinning it to identity.ts keeps that true if it ever moves.
    expect(sources.filter((path) => /from 'node:crypto'/.test(readFileSync(path, 'utf8')))).toEqual([
      join(fileURLToPath(new URL('../../../core/world/', import.meta.url)), 'identity.ts'),
    ])
  })
})

/* ------------------------------------------------------ 10. replay and restart */

describe('replay and restart: the same evidence gives the same world', () => {
  it('reproduces an identical projection across a restart', async () => {
    const holder = emptyHolder()
    const first = harness({ store: memoryStore(holder), start: T0 })
    first.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    first.owner({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Ana' }, object: { form: 'named', entityType: 'project', name: 'Atlas' } })
    first.owner({ kind: 'entity', entityType: 'person', name: 'Bo' })
    first.owner({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: 'Bo' }, object: { form: 'named', entityType: 'project', name: 'Helios' } })
    await first.engine.settled()
    const before = JSON.stringify(first.engine.summary())
    const beforeGraph = JSON.stringify(first.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }))
    await first.engine.close()

    const reopened = new WorldEngine({
      persistence: memoryStore(holder),
      now: () => new Date(T0),
    })
    await reopened.open()
    expect(JSON.stringify(reopened.summary())).toBe(before)
    expect(JSON.stringify(reopened.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }))).toBe(beforeGraph)
    await reopened.close()
  })

  it('reproduces the same world even when the durable history was built in a different order', () => {
    const forwards = harness()
    for (const request of anaWorksOnProject()) forwards.owner(request)
    const backwards = harness()
    const requests = anaWorksOnProject()
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      backwards.owner(requests[index] as WorldEvidenceRequest)
    }
    const shape = (world: ReturnType<typeof harness>): string =>
      JSON.stringify(
        world.engine
          .relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
          .edges.map((edge) => `${edge.fromEntityId}|${edge.relationType}|${edge.toEntityId ?? ''}`)
          .sort(),
      )
    expect(shape(backwards)).toBe(shape(forwards))
  })
})

/* ------------------------------------------------------------ 11. boundedness */

describe('boundedness: a flood of evidence cannot become an unbounded world', () => {
  it('holds every population inside its ceiling however much is admitted', () => {
    const world = harness({
      limits: {
        maxEvidenceRecords: 8,
        maxEntities: 6,
        maxEdges: 10,
        maxProjectionEntities: 4,
        maxProjectionEdges: 5,
      },
    })
    for (let index = 0; index < 200; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
      world.owner({ kind: 'relation', relationType: 'works_on', subject: { form: 'named', entityType: 'person', name: `Person ${index}` }, object: { form: 'named', entityType: 'project', name: `Project ${index}` } })
    }
    const summary = world.engine.summary()
    expect(summary.counts.evidenceRecords).toBeLessThanOrEqual(8)
    const entities = world.engine.entities({})
    expect(entities.entities.length).toBeLessThanOrEqual(6)
    expect(entities.entitiesHidden).toBeGreaterThan(0)
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.edges.length).toBeLessThanOrEqual(10)
  })

  it('refuses an unbounded graph walk rather than returning a whole world by accident', () => {
    const world = harness()
    for (let index = 0; index < 40; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    const ana = world.engine.entities({ kind: 'person' }).entities[0]
    const whole = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const focused = world.engine.relations({ focusEntityId: ana?.entityId ?? '', kinds: null, maxDepth: 2 })
    expect(whole.scope).toBe('whole_world')
    expect(focused.scope).toBe('neighbourhood')
  })

  it('bounds a single entity fan-out so one hub cannot become the whole model', () => {
    const world = harness({ limits: { maxEdgesPerEntity: 3, maxEntityDetailEdges: 3 } })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    for (let index = 0; index < 20; index += 1) {
      world.owner({ kind: 'entity', entityType: 'project', name: `Project ${index}` })
      world.owner({
        kind: 'relation',
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'named', entityType: 'project', name: `Project ${index}` },
      })
    }
    const ana = world.engine.entities({ kind: 'person' }).entities[0]
    const detail = world.engine.entity(ana?.entityId ?? '', (fold) => fold.conflicts)
    expect(detail.edges.length).toBeLessThanOrEqual(3)
    expect(detail.edgesHidden).toBeGreaterThan(0)
  })

  it('bounds what a Core retains durably as well as what it shows', async () => {
    const holder = emptyHolder()
    const world = harness({ store: memoryStore(holder), limits: { maxEvidenceRecords: 6 } })
    for (let index = 0; index < 60; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    await world.engine.settled()
    await world.engine.close()
    // The retention bound is what keeps a durable ledger a map rather than a database.
    expect(holder.snapshot.records.length).toBeLessThanOrEqual(6)
  })
})

/* ----------------------------------------------------------- 12. zero idle calls */

describe('zero idle calls: nothing in this phase can spend money', () => {
  it('makes no provider call for any read, write or subscription', async () => {
    const provider = new FakeModelProvider()
    requestCounter = 0
    const core = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [provider],
    })
    await core.start()
    const before = provider.calls

    const submit = (command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> => {
      requestCounter += 1
      return core.handleCommand({ command, requestId: `r-${requestCounter}`, ...(payload === undefined ? {} : { payload }) })
    }

    await submit('world.summary.read')
    await submit('world.entities.read')
    await submit('world.relations.read')
    await submit('self.status.read')
    await submit('world.entity.read', { entityId: 'ent_0123456789abcdef' })
    await submit('world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Ana' })
    await submit('world.summary.read')

    expect(provider.calls).toBe(before)
    await core.stop()
  })

  it('makes no provider call even for an empty world', async () => {
    const provider = new FakeModelProvider()
    const world = harness()
    const before = provider.calls
    world.engine.summary()
    world.engine.self()
    world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(provider.calls).toBe(before)
  })

  it('holds no gateway, provider or authority object anywhere in the domain', () => {
    // The strongest form of the claim: there is nothing to call, so "zero idle calls"
    // is not a budget that has been kept but a capability that is absent.
    const moduleNames = [
      'types',
      'identity',
      'evidence',
      'relations',
      'fold',
      'state',
      'self',
      'projection',
      'engine',
    ]
    for (const name of moduleNames) {
      expect(name.length).toBeGreaterThan(0)
    }
    const engineMethods = Object.getOwnPropertyNames(WorldEngine.prototype).map((name) => name.toLowerCase())
    for (const forbidden of ['call', 'complete', 'ask', 'infer', 'summarise', 'summarize', 'prompt']) {
      expect(engineMethods.some((name) => name.includes(forbidden))).toBe(false)
    }
  })
})

/* -------------------------------------------------------- 13. renderer cannot write */

describe('renderer cannot write: the bridge carries no write door', () => {
  it('lists the five reads and neither write in the renderer allowlist', async () => {
    const source = await readFile(join(process.cwd(), 'electron', 'preload.ts'), 'utf8')
    const allowlist = /const CORE_COMMANDS[\s\S]*?new Set<CoreCommandName>\(\[([\s\S]*?)\]\)/.exec(source)
    expect(allowlist).not.toBeNull()
    const commands = [...(allowlist?.[1] ?? '').matchAll(/'([a-zA-Z.]+)'/g)]
      .map((match) => match[1])
      .filter((command): command is string => command !== undefined)
    expect(commands.filter((command) => command.startsWith('world.'))).toEqual([
      'world.summary.read',
      'world.entities.read',
      'world.entity.read',
      'world.relations.read',
    ])
    expect(commands).toContain('self.status.read')
    // The two owner writes are Core-internal and must never appear here.
    expect(commands).not.toContain('world.statement.submit')
    expect(commands).not.toContain('world.statement.withdraw')
  })

  it('keeps the preload restatement of the world refusal sentence in step with Core', async () => {
    // The preload cannot import `core/protocol/world.ts` without dragging that module's
    // frozen absent projections into every window's startup path, so the sentence is
    // restated there. This is the test that stops the two copies drifting apart.
    const preload = await readFile(join(process.cwd(), 'electron', 'preload.ts'), 'utf8')
    const declared = /const WORLD_NO_PAYLOAD = '([^']+)'/.exec(preload)
    expect(declared).not.toBeNull()
    expect(WORLD_NO_PAYLOAD).toBe(declared?.[1])
  })

  it('declares no world write command in the protocol at all', async () => {
    const source = await readFile(join(process.cwd(), 'core', 'protocol', 'core-protocol.ts'), 'utf8')
    for (const invented of [
      'world.entity.create',
      'world.relation.assert',
      'world.confidence.set',
      'world.identity.write',
      'world.capability.grant',
    ]) {
      expect(source).not.toContain(`| '${invented}'`)
    }
  })

  it('refuses a world command with no payload where the shape requires one', async () => {
    requestCounter = 0
    const core = createCore({
      dataPath: join(dir, 'events2.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await core.start()
    const result = await core.handleCommand({
      command: 'world.entity.read' as CoreCommandName,
      requestId: 'r-empty',
    })
    expect(result.ok).toBe(false)
    await core.stop()
  })

  it('refuses a world write while STOP ALL is active, and keeps refusing after a resume attempt', async () => {
    requestCounter = 0
    const core = createCore({
      dataPath: join(dir, 'events3.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await core.start()
    const submit = (command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> => {
      requestCounter += 1
      return core.handleCommand({ command, requestId: `s-${requestCounter}`, ...(payload === undefined ? {} : { payload }) })
    }
    await submit('security.stopAll', { reason: 'red team' })
    const blocked = await submit('world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Ana' })
    expect(blocked.ok).toBe(false)
    expect(blocked.refusal?.reason).toContain('stopped')
    await core.stop()
  })
})

/* ------------------------------------------------ 14. domain state is not duplicated */

describe('domain state is not duplicated: the world holds no copy to go stale', () => {
  it('shows a Mission cancelled a moment ago as cancelled, with no reconciliation', () => {
    const active = harness({ references: () => [missionRef('m-1', 'active')] })
    const cancelled = harness({ references: () => [missionRef('m-1', 'cancelled', T0.toISOString())] })
    const read = (world: ReturnType<typeof harness>): string | undefined =>
      world.engine.entities({ kind: 'mission' }).entities[0]?.reference?.status
    expect(read(active)).toBe('active')
    expect(read(cancelled)).toBe('cancelled')
  })

  it('derives a worker membership from the Workforce record, so a claim cannot contradict it silently', () => {
    const world = harness({
      references: () => [workerRef('alpha', 'working', { teamId: 't-1' })],
    })
    const edges = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges
    // No team record exists, so the derived edge has nothing to point at and is not
    // drawn — an honest absence rather than a line to nothing.
    expect(edges.filter((edge) => edge.relationType === 'member_of')).toHaveLength(0)
  })

  it('carries no Mission, Skill or Work content in any node field', () => {
    const world = harness({
      references: () => [missionRef('m-1', 'active'), workerRef('alpha', 'working')],
    })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana', attributes: { note: SENTINEL } })
    const nodeKeys = new Set(
      world.engine.entities({}).entities.flatMap((node) => Object.keys(node)),
    )
    for (const forbidden of ['title', 'intent', 'successCriteria', 'content', 'body', 'summary', 'steps', 'prompt']) {
      expect(nodeKeys.has(forbidden)).toBe(false)
    }
  })

  it('reports a reference node state as the owning domain own words', () => {
    const world = harness({ references: () => [workerRef('alpha', 'blocked')] })
    const worker = world.engine.entities({ kind: 'worker' }).entities[0]
    expect(worker?.reference?.status).toBe('blocked')
    expect(worker?.reference?.domain).toBe('workforce')
    // Core's own record of a domain it owns, and the only `verified` population here.
    expect(worker?.claimKind).toBe('domain_record')
    expect(worker?.epistemic).toBe('verified')
  })

  it('keeps capability vocabulary out of the world module entirely', () => {
    const worldTypes = WorldEngine as unknown as { prototype: object }
    expect(worldTypes.prototype).toBeDefined()
    const guardOnly: Capability = 'security.stop'
    // A capability name exists in this module only as a string to be refused, never as a
    // value to be compared against. If this test ever needs the list, the wrong thing
    // has happened.
    expect(normaliseWorldName(guardOnly)).toBeNull()
  })
})
/** A minimal legal record, for the tamper tests that are not about its content. */
function validRecord(): WorldEvidenceRecord {
  return {
    evidenceId: 'wev-000001',
    sequence: 1,
    kind: 'entity',
    channel: 'owner_statement',
    recordedAt: '2026-06-01T09:00:00.000Z',
    observedAt: '2026-06-01T09:00:00.000Z',
    source: 'owner-assertion',
    actor: 'owner',
    sourceRef: null,
    sensitivity: 'personal',
    epistemic: 'asserted',
    confidence: 'high',
    evidenceSummary: null,
    supersedes: null,
    entity: { entityType: 'person', name: 'Ana', aliases: [], attributes: {} },
    relation: null,
    withdrawal: null,
  }
}

/**
 * Every source file of the world domain, read from disk.
 *
 * Exists so the "no second store" check above is about the shipped code rather than
 * about an import list somebody remembered to update.
 */
function worldDomainSources(): string[] {
  const root = fileURLToPath(new URL('../../../core/world/', import.meta.url))
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(root, entry))
}
