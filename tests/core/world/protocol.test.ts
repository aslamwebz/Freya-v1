// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  ABSENT_WORLD_ENTITY_DETAIL,
  ABSENT_WORLD_GRAPH,
  ABSENT_WORLD_SUMMARY,
  type WorldEntityDetailView,
  type WorldEntityNodeView,
  type WorldRelationGraphView,
} from '../../../core/protocol/world'
import { deriveEntityId, type NamedWorldEntityKind, type WorldEvidenceRequest } from '../../../core/world'
import { anaWorksOnProject, harness, missionRef, teamRef, tinyLimits, workerRef } from './fixture'

/**
 * THE PUBLIC READ CONTRACT — and, just as importantly, what it does not contain.
 *
 * The claims under test:
 *
 * 1. **A future UI can render a real graph** of only evidenced entities and
 *    relationships: nodes with kind, label and live state, and typed directed edges
 *    carrying provenance, epistemic status, confidence and freshness.
 * 2. **No projection carries private content**: no attribute values, no evidence
 *    summary text, no untrusted literal rendered verbatim.
 * 3. **Truncation is always visible**, as retained/total/hidden.
 * 4. **The absent projections say why**, rather than looking like an empty world.
 * 5. **The inspector answers for one selected entity** and is bounded too.
 */

/** A sentinel planted in every free-text field a caller could reach. */
const SECRET = 'FREYA_RED_TEAM_SECRET_7A91'

function seeded(limits = {}): ReturnType<typeof harness> {
  const world = harness({ limits })
  world.owner({
    kind: 'entity',
    entityType: 'person',
    name: 'Ana',
    attributes: { note: SECRET, employer: SECRET },
    evidenceSummary: `${SECRET} and then some more`,
  })
  world.owner({ kind: 'entity', entityType: 'project', name: 'Atlas' })
  world.owner({
    kind: 'relation',
    relationType: 'works_on',
    subject: { form: 'named', entityType: 'person', name: 'Ana' },
    object: { form: 'named', entityType: 'project', name: 'Atlas' },
    evidenceSummary: SECRET,
    sourceRef: 'event-0001',
  })
  return world
}

describe('a future UI has everything it needs to draw an evidenced graph', () => {
  it('gives every node a kind, a label source and a live state', () => {
    const world = seeded()
    const nodes = world.engine.entities({}).entities
    const ana = nodes.find((node) => node.name === 'Ana')
    expect(ana?.kind).toBe('person')
    expect(ana?.claimKind).toBe('owner_statement')
    expect(ana?.epistemic).toBe('asserted')
    expect(ana?.confidence).toBe('high')
    expect(ana?.freshness).toBe('current')
    expect(ana?.firstObservedAt).not.toBeNull()
    expect(ana?.lastObservedAt).not.toBeNull()
  })

  it('gives every edge a type, a direction and its provenance', () => {
    const world = seeded()
    const edges = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges
    expect(edges.length).toBe(1)
    const edge = edges[0]
    if (edge === undefined) return
    expect(edge.relationType).toBe('works_on')
    expect(edge.directed).toBe(true)
    expect(edge.origin).toBe('admitted_evidence')
    expect(edge.provenance.source).toBe('owner-assertion')
    expect(edge.provenance.actor).toBe('owner')
    expect(edge.provenance.observedAt).not.toBeNull()
    expect(edge.provenance.recordedAt).not.toBeNull()
    expect(edge.evidenceId).toMatch(/^wev-/)
    expect(edge.freshness).toBe('current')
    expect(edge.contested).toBe(false)
  })

  it('carries a live domain state on a reference node, in the domain own words', () => {
    const world = harness({ references: () => [missionRef('m-1', 'active'), missionRef('m-2', 'completed')] })
    const missions = world.engine.entities({ kind: 'mission' }).entities
    expect(missions.map((mission) => mission.reference?.status).sort()).toEqual(['active', 'completed'])
    expect(missions.find((mission) => mission.reference?.recordId === 'm-2')?.freshness).toBe('historical')
  })

  it('tells a surface which node the graph is a neighbourhood of', () => {
    const world = seeded()
    const whole = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(whole.scope).toBe('whole_world')
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    const focused = world.engine.relations({ focusEntityId: ana?.entityId ?? '', kinds: null, maxDepth: 1 })
    expect(focused.scope).toBe('neighbourhood')
    expect(focused.focusEntityId).toBe(ana?.entityId)
  })

  it('reports the limits it is working within on every view', () => {
    const summary = seeded().engine.summary()
    expect(summary.limits.maxProjectionEntities).toBeGreaterThan(0)
    expect(summary.limits.maxEdges).toBeGreaterThan(0)
    expect(summary.schemaVersion).toBe(1)
    expect(summary.sequence).toBeGreaterThan(0)
  })
})

describe('no projection carries private content', () => {
  it('leaks no attribute value, summary text or source reference into any view', () => {
    const world = seeded()
    const views: unknown[] = [
      world.engine.summary(),
      world.engine.entities({}),
      world.engine.entities({ includeWithdrawn: true }),
      world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }),
      world.engine.self(),
    ]
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    views.push(world.engine.entity(ana?.entityId ?? '', (fold) => fold.conflicts))

    for (const view of views) {
      expect(JSON.stringify(view)).not.toContain(SECRET)
    }
  })

  it('reports an attribute key and its measured length, and nothing else', () => {
    const world = seeded()
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    const keys = ana?.attributeKeys ?? []
    expect(keys.map((entry) => entry.key)).toEqual(['employer', 'note'])
    for (const entry of keys) expect(entry.valueLength).toBe(SECRET.length)
    expect(Object.keys(keys[0] ?? {})).toEqual(['key', 'valueLength'])
  })

  it('reports an evidence summary as a length and a flag, never as text', () => {
    const world = seeded()
    const edge = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges[0]
    if (edge === undefined) return
    expect(edge.provenance.evidenceSummaryPresent).toBe(true)
    expect(edge.provenance.evidenceSummaryLength).toBe(SECRET.length)
    expect(Object.keys(edge.provenance).sort()).toContain('evidenceSummaryLength')
    expect(Object.values(edge.provenance)).not.toContain(SECRET)
  })

  it('withholds an untrusted literal rather than rendering it in front of a person', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: SECRET },
    })
    const edge = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges[0]
    if (edge === undefined) return
    // C9: untrusted content stays data. Putting it on screen unchanged is how injected
    // text becomes an instruction a person acts on.
    expect(edge.literalValue).toBeNull()
    expect(edge.literalWithheld).toBe(true)
    expect(edge.literalValueLength).toBe(SECRET.length)
  })

  it('renders an owner literal verbatim, because a graph cannot be drawn without it', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: 'Atlas' },
    })
    const edge = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges[0]
    if (edge === undefined) return
    expect(edge.literalValue).toBe('Atlas')
    expect(edge.literalWithheld).toBe(false)
  })

  it('counts evidence that is too sensitive to project and shows it nowhere', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    const admitted = world.engine.admit({
      request: {
        kind: 'entity',
        entityType: 'person',
        name: 'Coded',
      },
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'secret-reference',
    })
    expect(admitted.ok).toBe(true)

    const summary = world.engine.summary()
    expect(summary.counts.withheld).toBe(1)
    expect(JSON.stringify(summary)).not.toContain('Coded')
    expect(world.engine.entities({ includeWithdrawn: true }).entities.some((node) => node.name === 'Coded')).toBe(false)
    expect(world.engine.entity(deriveId('person', 'Coded'), (fold) => fold.conflicts).entity).toBeNull()
  })

  it('carries no field a Mission, Skill or memory body could hide in', () => {
    const world = seeded()
    const view = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }) as WorldRelationGraphView
    const nodeKeys = new Set(Object.keys(view.nodes[0] ?? {}))
    for (const forbidden of ['title', 'intent', 'content', 'body', 'summary', 'steps', 'prompt', 'token', 'credential', 'key']) {
      expect(nodeKeys.has(forbidden)).toBe(false)
    }
    const edgeKeys = new Set(Object.keys(view.edges[0] ?? {}))
    for (const forbidden of ['content', 'body', 'prompt', 'payload', 'credential']) {
      expect(edgeKeys.has(forbidden)).toBe(false)
    }
  })
})

describe('truncation is visible rather than silent', () => {
  it('reports retained, total and hidden on the entity list', () => {
    const world = harness({ limits: tinyLimits() })
    for (let index = 0; index < 12; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    const list = world.engine.entities({})
    expect(list.entitiesTotal).toBeGreaterThan(list.entitiesRetained)
    expect(list.entitiesHidden).toBeGreaterThan(0)
    expect(list.entities.length).toBe(list.entitiesRetained)
  })

  it('reports retained, total and hidden on the graph', () => {
    const world = harness({ limits: tinyLimits() })
    for (let index = 0; index < 12; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
      world.owner({ kind: 'entity', entityType: 'project', name: `Project ${index}` })
    }
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.nodesHidden).toBeGreaterThan(0)
    expect(graph.nodesRetained + graph.nodesHidden).toBe(graph.nodesTotal)
  })

  it('bounds the conflicts it lists and says how many exist', () => {
    const world = harness({ limits: { maxConflictsListed: 2 } })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    for (const value of ['Atlas', 'Helios', 'Orion', 'Vega']) {
      world.owner({
        kind: 'relation',
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'literal', value },
      })
    }
    const summary = world.engine.summary()
    expect(summary.conflicts.total).toBe(1)
    expect(summary.conflicts.listed).toBe(1)
    expect(summary.conflicts.items[0]?.edgeIds.length).toBe(4)
  })

  it('reports retained, total and hidden on the inspector', () => {
    const world = harness({ limits: tinyLimits() })
    for (const request of anaWorksOnProject()) world.owner(request)
    const atlas = world.engine.entities({ kind: 'project' }).entities[0]
    const detail = world.engine.entity(atlas?.entityId ?? '', (fold) => fold.conflicts)
    expect(detail.edgesRetained + detail.edgesHidden).toBe(detail.edgesTotal)
    expect(detail.edges.length).toBe(detail.edgesRetained)
  })
})

describe('the inspector answers for one selected entity', () => {
  it('returns the node, its edges, its conflicts and its evidence ids', () => {
    const world = seeded()
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    const detail: WorldEntityDetailView = world.engine.entity(ana?.entityId ?? '', (fold) => fold.conflicts)
    expect(detail.entity?.name).toBe('Ana')
    expect(detail.entityId).toBe(ana?.entityId)
    expect(detail.edges.length).toBeGreaterThan(0)
    expect(detail.evidenceIds.every((id) => id.startsWith('wev-'))).toBe(true)
    expect(detail.conflicts).toEqual([])
  })

  it('lists neighbours with the direction of each relation', () => {
    const world = seeded()
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Ana')
    const detail = world.engine.entity(ana?.entityId ?? '', (fold) => fold.conflicts)
    expect(detail.neighbours.length).toBe(1)
    expect(detail.neighbours[0]?.relationType).toBe('works_on')
    expect(detail.neighbours[0]?.direction).toBe('outgoing')
  })

  it('reports an entity that does not exist as not found rather than as an empty one', () => {
    const world = seeded()
    const detail = world.engine.entity('ent_deadbeefdeadbeef', (fold) => fold.conflicts)
    expect(detail.entity).toBeNull()
    expect(detail.entityId).toBe('ent_deadbeefdeadbeef')
    expect(detail.edges).toEqual([])
  })

  it('refuses an entity id that is not a usable id at all', () => {
    const world = seeded()
    expect(world.engine.entity('', (fold) => fold.conflicts).entityId).toBe('')
    expect(world.engine.entity(null, (fold) => fold.conflicts).entityId).toBe('')
    expect(world.engine.entity('a'.repeat(200), (fold) => fold.conflicts).entityId).toBe('')
  })
})

describe('an absent world says why rather than looking like an empty one', () => {
  it('carries a reason, a health and an honest durability answer', () => {
    expect(ABSENT_WORLD_SUMMARY.health).toBe('unavailable')
    expect(ABSENT_WORLD_SUMMARY.reason).toContain('not reported a world model')
    expect(ABSENT_WORLD_SUMMARY.persistence.durable).toBe(false)
    expect(ABSENT_WORLD_ENTITY_DETAIL.entity).toBeNull()
    expect(ABSENT_WORLD_GRAPH.scope).toBe('empty')
  })

  it('is what a closed engine reports, rather than throwing', () => {
    const world = harness()
    world.engine.close()
    expect(world.engine.summary().health).toBe('unavailable')
    expect(world.engine.entities({}).entities).toEqual([])
    expect(world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).nodes).toEqual([])
  })

  it('refuses an admission once closed rather than accepting a claim it will never hold', () => {
    const world = harness()
    world.engine.close()
    const outcome = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('store_closed')
  })
})

describe('a domain-derived edge is distinguishable from a claim at a glance', () => {
  it('marks origin on every edge', () => {
    const world = harness({
      references: () => [workerRef('alpha', 'working', { teamId: 't-1' }), teamRef('t-1', 'active', ['alpha'])],
    })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const origins = new Set(graph.edges.map((edge) => edge.origin))
    // Every edge here came from a Core record, and says so.
    expect(origins).toEqual(new Set(['domain_record']))
  })

  it('reports a derived edge with no evidence id, because nobody claimed it', () => {
    const world = harness({
      references: () => [workerRef('alpha', 'working', { teamId: 't-1' }), teamRef('t-1', 'active', ['alpha'])],
    })
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    for (const edge of graph.edges) {
      if (edge.origin !== 'domain_record') continue
      expect(edge.evidenceId).toBeNull()
      expect(edge.provenance.claimKind).toBe('domain_record')
    }
  })
})

/** The world's own deterministic id, so a test can name an entity it knows exists. */
function deriveId(entityType: NamedWorldEntityKind, name: string): string {
  return deriveEntityId(entityType, name)
}

/** Unused today, kept honest: the type must stay reachable for future contract tests. */
export type _RequestShape = WorldEvidenceRequest
export type _NodeShape = WorldEntityNodeView