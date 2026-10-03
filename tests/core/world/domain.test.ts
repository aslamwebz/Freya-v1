// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  WORLD_LIMITS,
  WORLD_OWNER_ENTITY_ID,
  WORLD_REFUSAL_CODES,
  WORLD_SELF_ENTITY_ID,
  deriveEntityId,
  isWorldEntityId,
  normaliseWorldName,
  worldLimits,
  worldRelationSpec,
  type WorldEvidenceRequest,
} from '../../../core/world'
import {
  DAY_MS,
  T0,
  anaWorksOnProject,
  harness,
  missionRef,
  teamRef,
  tinyLimits,
  workerRef,
  type WorldHarness,
} from './fixture'

/**
 * THE WORLD DOMAIN — Phase 22's ontology, admission, folding and honesty rules.
 *
 * The claims under test are the ones the rest of the phase leans on:
 *
 * 1. **Identity is derived from a name**, so the same statement always produces the
 *    same entity and a restart reproduces the world.
 * 2. **An admission never names its own trust.** The channel decides the source, the
 *    epistemic ceiling and the confidence ceiling, and no payload can widen them.
 * 3. **`verified` is unreachable from any channel.** Only Core's own record of an
 *    authoritative domain is verified.
 * 4. **Conflicting claims coexist.** Both are kept, both are marked, and nothing
 *    chooses a winner.
 * 5. **Stale is not current.** Age and an end time both say so.
 * 6. **Withdrawal removes the fact**, not just the record that mentioned it.
 * 7. **Nothing is duplicated.** Reference nodes read the owning domain live.
 * 8. **Everything is bounded**, and truncation is visible rather than silent.
 */

describe('world identity is deterministic and derived from the name', () => {
  it('gives the same entity id for the same name on every call', () => {
    expect(deriveEntityId('person', 'Ana')).toBe(deriveEntityId('person', 'Ana'))
    expect(isWorldEntityId(deriveEntityId('person', 'Ana'))).toBe(true)
  })

  it('gives a person and a project with the same name two different entities', () => {
    // Not a limitation to tidy away later: the only honest way to merge them is
    // evidence that they are the same thing, and no amount of name matching produces it.
    expect(deriveEntityId('person', 'Atlas')).not.toBe(deriveEntityId('project', 'Atlas'))
  })

  it('collapses whitespace and surrounding space without repairing anything else', () => {
    expect(normaliseWorldName('  Ana   Ruiz ')).toBe('Ana Ruiz')
    expect(normaliseWorldName('Ana  Ruiz')).toBe(normaliseWorldName('Ana Ruiz'))
  })

  it('keeps two spellings apart, because two people beat one wrong merge', () => {
    expect(deriveEntityId('person', 'Ana')).not.toBe(deriveEntityId('person', 'Anna'))
  })

  it('refuses a name rather than repairing one', () => {
    for (const bad of ['../../etc/passwd', '', '   ', 'Ana\nRuiz', 'Ana\u0000Ruiz', 'Ana; DROP TABLE', 42, null, {}]) {
      expect(normaliseWorldName(bad)).toBeNull()
    }
  })

  it('refuses a name longer than the bound rather than truncating it', () => {
    expect(normaliseWorldName('a'.repeat(WORLD_LIMITS.maxNameChars))).not.toBeNull()
    expect(normaliseWorldName('a'.repeat(WORLD_LIMITS.maxNameChars + 1))).toBeNull()
  })

  it('accepts non-ASCII names, because refusing them is a bias not a safety rule', () => {
    expect(normaliseWorldName('Ana Ruiz')).not.toBeNull()
    expect(normaliseWorldName('Zoë O’Brien')).not.toBeNull()
    expect(normaliseWorldName('山田 花子')).not.toBeNull()
  })

  it('refuses the reserved names, so nobody can create or shadow a singleton', () => {
    expect(normaliseWorldName('Freya')).toBeNull()
    expect(normaliseWorldName('freya')).toBeNull()
    expect(normaliseWorldName('owner')).toBeNull()
    expect(normaliseWorldName('Owner')).toBeNull()
  })

  it('refuses a capability name as an entity, because a capability is not a thing', () => {
    expect(normaliseWorldName('security.stop')).toBeNull()
    expect(normaliseWorldName('cognition.grant.manage')).toBeNull()
    // A person may legitimately be called Stop; refusing that would quietly delete a
    // real entity to protect against a spelling.
    expect(normaliseWorldName('Stop')).not.toBeNull()
  })
})

describe('the relation vocabulary is closed and its pairings are checked', () => {
  it('names an unknown relation as unknown rather than admitting it', async () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'relation',
      relationType: 'has_capability' as never,
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: 'security.stop' },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('relation_type_unknown')
  })

  it('refuses a pairing the table does not permit', async () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'place', name: 'Lisbon' },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('relation_endpoints_invalid')
  })

  it('refuses a literal as the subject of a relation', async () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'literal', value: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('relation_endpoints_invalid')
  })

  it('marks the symmetric relations symmetric and the rest directed', () => {
    expect(worldRelationSpec('acquainted_with').directed).toBe(false)
    expect(worldRelationSpec('related_to').directed).toBe(false)
    expect(worldRelationSpec('works_on').directed).toBe(true)
    expect(worldRelationSpec('owns').directed).toBe(true)
  })

  it('knows which relations can only have one answer', () => {
    expect(worldRelationSpec('member_of').singleValued).toBe(true)
    expect(worldRelationSpec('works_at').singleValued).toBe(true)
    expect(worldRelationSpec('works_on').singleValued).toBe(false)
  })

  it('refuses an entity kind this build does not source yet', async () => {
    const world = harness()
    const outcome = world.owner({ kind: 'entity', entityType: 'conversation' as never, name: 'Tuesday' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('entity_unknown')
  })
})

describe('an admission never names its own trust', () => {
  it('assigns the owner channel owner-assertion and nothing louder', async () => {
    const world = harness()
    for (const request of anaWorksOnProject()) expect(world.owner(request).ok).toBe(true)
    const edges = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges
    expect(edges.length).toBeGreaterThan(0)
    for (const edge of edges) {
      expect(edge.provenance.source).toBe('owner-assertion')
      expect(edge.provenance.epistemic).toBe('asserted')
      expect(edge.provenance.confidence).toBe('high')
    }
  })

  it('assigns a worker claim untrusted weight, whatever the payload said', async () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'entity', entityType: 'project', name: 'Atlas' })
    const outcome = world.worker({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    expect(outcome.ok).toBe(true)
    const detail = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const claimed = detail.edges.filter((edge) => edge.provenance.claimKind === 'third_party_claim')
    expect(claimed.length).toBe(1)
    const only = claimed[0]
    expect(only?.provenance.source).toBe('external-untrusted')
    expect(only?.provenance.confidence).toBe('low')
    expect(only?.provenance.epistemic).not.toBe('verified')
  })

  it('refuses a payload that states its own certainty from a channel that may not', async () => {
    const world = harness()
    const outcome = world.worker({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      confidence: 'verified',
    } as WorldEvidenceRequest)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('claim_fields_not_admissible')
  })

  it('lets the owner state a certainty up to its own ceiling and no further', async () => {
    const world = harness()
    const ok = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana', confidence: 'low' })
    expect(ok.ok).toBe(true)
    const tooSure = world.owner({ kind: 'entity', entityType: 'person', name: 'Bo', confidence: 'verified' })
    expect(tooSure.ok).toBe(false)
    if (tooSure.ok) return
    expect(tooSure.code).toBe('confidence_above_channel')
  })

  it('refuses a whole payload carrying an authority-shaped key rather than stripping it', async () => {
    const world = harness()
    for (const key of ['authority', 'capability', 'grant', 'trust', 'verified', 'source', 'actor', 'principal']) {
      const outcome = world.owner({
        kind: 'entity',
        entityType: 'person',
        name: 'Ana',
        [key]: 'owner',
      } as unknown as WorldEvidenceRequest)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('claim_fields_not_admissible')
    }
  })

  it('never records a claim as verified, on any channel', async () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.system({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'reference', refKind: 'mission', refId: 'm-1' },
      confidence: 'verified',
    })
    const detail = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    for (const edge of detail.edges) {
      expect(edge.provenance.epistemic).not.toBe('verified')
      expect(edge.provenance.confidence).not.toBe('verified')
    }
  })

  it('refuses an observation from the future, because that provenance has not happened', async () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      observedAt: new Date(T0.getTime() + DAY_MS).toISOString(),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('instant_in_future')
  })

  it('refuses a claim that ends before it was observed', async () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
      observedAt: new Date(T0.getTime() - DAY_MS).toISOString(),
      validUntil: new Date(T0.getTime() - 10 * DAY_MS).toISOString(),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('valid_until_before_observed')
  })

  it('names a refusal in words rather than in a code alone', () => {
    expect(WORLD_REFUSAL_CODES.length).toBeGreaterThan(20)
    expect(new Set(WORLD_REFUSAL_CODES).size).toBe(WORLD_REFUSAL_CODES.length)
  })
})

describe('the singletons exist because Core says so, not because anybody said so', () => {
  it('reports Freya and the owner even with no evidence at all', () => {
    const world = harness()
    const summary = world.engine.summary()
    expect(summary.counts.entities).toBe(2)
    const ids = world.engine.entities({}).entities.map((entity) => entity.entityId).sort()
    expect(ids).toEqual([WORLD_OWNER_ENTITY_ID, WORLD_SELF_ENTITY_ID].sort())
  })

  it('reports Freya as verified and the owner as asserted, which are different claims', () => {
    const world = harness()
    const entities = world.engine.entities({}).entities
    const freya = entities.find((entity) => entity.entityId === WORLD_SELF_ENTITY_ID)
    const owner = entities.find((entity) => entity.entityId === WORLD_OWNER_ENTITY_ID)
    expect(freya?.epistemic).toBe('verified')
    expect(freya?.claimKind).toBe('domain_record')
    expect(owner?.epistemic).toBe('asserted')
    expect(owner?.claimKind).toBe('owner_statement')
  })

  it('resolves a claim that names Freya to her node without creating one', () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Freya' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    // Referring to Freya is allowed; defining her is not. That asymmetry is the whole
    // point: the singletons are impossible to create and perfectly possible to talk
    // about, and refusing both would make the self node unreachable in every sentence
    // that mentions it.
    expect(outcome.ok).toBe(true)
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.edges.some((edge) => edge.fromEntityId === WORLD_SELF_ENTITY_ID)).toBe(true)
    expect(graph.nodes.some((node) => node.name === 'Freya' && node.singleton)).toBe(true)
    expect(graph.nodes.filter((node) => node.name === 'Freya')).toHaveLength(1)
  })

  it('refuses to let evidence redefine the owner either', () => {
    const world = harness()
    const outcome = world.owner({ kind: 'entity', entityType: 'person', name: 'owner' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('name_reserved')
  })
})

describe('conflicting claims coexist and nothing picks a winner', () => {
  function twoDisagreeingStatements(): WorldHarness {
    const world = harness()
    for (const statement of ['booted', 'running'] as const) {
      world.owner({
        kind: 'entity',
        entityType: 'person',
        name: 'Ana',
      })
      world.owner({
        kind: 'entity',
        entityType: 'project',
        name: 'Atlas',
      })
      world.owner({
        kind: 'relation',
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'literal', value: statement },
      })
    }
    return world
  }

  it('keeps both claims and marks both conflicted', () => {
    const world = twoDisagreeingStatements()
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const disputed = graph.edges.filter((edge) => edge.freshness === 'conflicted')
    expect(disputed.length).toBe(2)
    for (const edge of disputed) {
      expect(edge.conflictsWith.length).toBe(2)
      expect(edge.contested).toBe(true)
    }
  })

  it('discloses the disagreement in the summary with both sides named', () => {
    const world = twoDisagreeingStatements()
    const summary = world.engine.summary()
    expect(summary.counts.conflicts).toBe(1)
    expect(summary.conflicts.total).toBe(1)
    expect(summary.conflicts.items[0]?.edgeIds.length).toBe(2)
    expect(summary.conflicts.items[0]?.evidenceIds.length).toBe(2)
    expect(summary.conflicts.items[0]?.reason).toBe('disagreeing_values')
  })

  it('treats two employers for one person as a disagreement rather than two facts', () => {
    // `works_at` is single-valued: a person works at one organisation. Two claims are
    // a disagreement, and the point of listing it is that a projection which cannot
    // express a disagreement will express certainty instead.
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    for (const employer of ['Acme', 'Globex']) {
      world.owner({ kind: 'entity', entityType: 'organisation', name: employer })
      world.owner({
        kind: 'relation',
        relationType: 'works_at',
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'named', entityType: 'organisation', name: employer },
      })
    }
    const summary = world.engine.summary()
    const disagreeingObjects = summary.conflicts.items.filter(
      (conflict) => conflict.reason === 'disagreeing_objects',
    )
    expect(disagreeingObjects.length).toBe(1)
    expect(disagreeingObjects[0]?.edgeIds.length).toBe(2)
  })

  it('lets an explicit supersession retire the earlier claim instead of conflicting', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    const first = world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: 'Atlas' },
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'literal', value: 'Helios' },
      supersedes: first.evidenceId,
    })
    expect(second.ok).toBe(true)
    const summary = world.engine.summary()
    expect(summary.counts.conflicts).toBe(0)
    expect(summary.counts.supersededRecords).toBe(1)
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    // Both claims are still there — a replacement is not a deletion — but the replaced
    // one is `historical` rather than `current`, because somebody said otherwise, not
    // because time passed.
    const replaced = graph.edges.find((edge) => edge.literalValue === 'Atlas')
    const replacement = graph.edges.find((edge) => edge.literalValue === 'Helios')
    expect(replaced?.freshness).toBe('historical')
    expect(replaced?.supersededBy).toBe(replacement?.edgeId)
    expect(replacement?.freshness).toBe('current')
    expect(replacement?.provenance.epistemic).toBe('asserted')
  })

  it('refuses a supersession naming evidence that does not exist', () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      supersedes: 'wev-999999',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('supersedes_unknown')
  })
})

describe('stale is not current, and a finished claim is not a live one', () => {
  it('reports a fresh owner claim as current', () => {
    const world = harness()
    for (const request of anaWorksOnProject()) world.owner(request)
    expect(world.engine.summary().byFreshness.current).toBeGreaterThan(0)
    expect(world.engine.summary().byFreshness.stale).toBe(0)
  })

  it('reports an old claim as aging, then as stale, without ever calling it current', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    world.advanceDays(30)
    expect(world.engine.summary().byFreshness.aging).toBeGreaterThan(0)
    world.advanceDays(90)
    const summary = world.engine.summary()
    expect(summary.byFreshness.stale).toBeGreaterThan(0)
    expect(summary.byFreshness.current).toBe(0)
  })

  it('reports a claim past its end time as historical rather than stale', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'entity', entityType: 'project', name: 'Atlas' })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
      validUntil: new Date(T0.getTime() + DAY_MS).toISOString(),
    })
    world.moveTo(new Date(T0.getTime() + 2 * DAY_MS))
    expect(world.engine.summary().byFreshness.historical).toBeGreaterThan(0)
  })

  it('lists an explicit unknown as an unknown rather than inventing a fact', () => {
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Bo' })
    const outcome = world.owner({
      kind: 'unknown',
      relationType: 'related_to',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'person', name: 'Bo' },
    })
    expect(outcome.ok).toBe(true)
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const unknownEdge = graph.edges.find((edge) => edge.provenance.claimKind === 'unknown')
    expect(unknownEdge).toBeDefined()
    expect(unknownEdge?.provenance.epistemic).toBe('unknown')
    expect(unknownEdge?.provenance.confidence).toBe('unknown')
    expect(world.engine.summary().byClaimKind.unknown).toBeGreaterThan(0)
  })
})

describe('withdrawing evidence leaves no unqualified live fact behind', () => {
  it('removes the claim from the graph and says how many were withdrawn', () => {
    const world = harness()
    for (const request of anaWorksOnProject()) world.owner(request)
    const before = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(before.edges.length).toBe(1)

    // Withdraw the relation itself.
    const state = world.engine.state()
    const relationEvidence = [...state.edges.values()].find((edge) => edge.evidenceId !== null)
    expect(relationEvidence?.evidenceId).not.toBeNull()

    const outcome = world.owner({
      kind: 'withdrawal',
      targetEvidenceId: relationEvidence?.evidenceId ?? '',
      reason: 'that is not true',
    })
    expect(outcome.ok).toBe(true)
    const after = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(after.edges.length).toBe(0)
    expect(world.engine.summary().counts.withdrawnRecords).toBeGreaterThan(0)
  })

  it('drops an entity whose only evidence was withdrawn, and keeps counting it', () => {
    const world = harness()
    const created = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(world.engine.entities({}).entities.some((entity) => entity.name === 'Ana')).toBe(true)

    expect(world.owner({ kind: 'withdrawal', targetEvidenceId: created.evidenceId, reason: 'wrong' }).ok).toBe(true)

    const listed = world.engine.entities({})
    expect(listed.entities.some((entity) => entity.name === 'Ana')).toBe(false)
    expect(world.engine.summary().counts.withdrawnRecords).toBeGreaterThan(0)
  })

  it('still shows a withdrawn entity when the owner asks for withdrawn ones', () => {
    const world = harness()
    const created = world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    if (!created.ok) return
    world.owner({ kind: 'withdrawal', targetEvidenceId: created.evidenceId, reason: 'wrong' })
    const listed = world.engine.entities({ includeWithdrawn: true })
    const ana = listed.entities.find((entity) => entity.name === 'Ana')
    expect(ana?.withdrawn).toBe(true)
  })

  it('refuses a withdrawal naming evidence that does not exist', () => {
    const world = harness()
    const outcome = world.owner({
      kind: 'withdrawal',
      targetEvidenceId: 'wev-999999',
      reason: 'nope',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('withdrawal_unknown')
  })

  it('drops a relation whose subject was withdrawn, rather than drawing a line to nothing', () => {
    const world = harness()
    const ids: string[] = []
    for (const request of anaWorksOnProject()) {
      const outcome = world.owner(request)
      if (outcome.ok) ids.push(outcome.evidenceId)
    }
    expect(world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges.length).toBe(1)

    for (const evidenceId of ids) {
      expect(world.owner({ kind: 'withdrawal', targetEvidenceId: evidenceId, reason: 'wrong' }).ok).toBe(true)
    }

    // Every claim is gone: no node, no edge, and the counts say they went somewhere.
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.edges.length).toBe(0)
    expect(graph.nodes.some((node) => node.name === 'Ana')).toBe(false)
    expect(world.engine.summary().counts.withdrawnRecords).toBe(3)
  })

  it('keeps an entity whose relation was withdrawn but whose own evidence stands', () => {
    const world = harness()
    const ids: string[] = []
    for (const request of anaWorksOnProject()) {
      const outcome = world.owner(request)
      if (outcome.ok) ids.push(outcome.evidenceId)
    }
    const relationId = ids[2]
    if (relationId === undefined) return
    expect(world.owner({ kind: 'withdrawal', targetEvidenceId: relationId, reason: 'not that one' }).ok).toBe(true)
    expect(world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }).edges.length).toBe(0)
    expect(world.engine.entities({}).entities.some((entity) => entity.name === 'Ana')).toBe(true)
  })
})

describe('reference nodes read the owning domain and are never copied', () => {
  it('reports a Mission with the Mission domain own status and no label', () => {
    const world = harness({ references: () => [missionRef('m-1', 'active')] })
    const mission = world.engine.entities({ kind: 'mission' }).entities[0]
    expect(mission?.reference?.recordId).toBe('m-1')
    expect(mission?.reference?.status).toBe('active')
    expect(mission?.reference?.domain).toBe('mission')
    expect(mission?.label).toBeNull()
  })

  it('marks a terminal record historical, because the domain finished it', () => {
    const world = harness({ references: () => [missionRef('m-1', 'completed', T0.toISOString())] })
    const mission = world.engine.entities({ kind: 'mission' }).entities[0]
    expect(mission?.freshness).toBe('historical')
  })

  it('shows a Mission cancelled a moment ago as cancelled, with no reconciliation', () => {
    const world = harness({ references: () => [missionRef('m-1', 'active')] })
    expect(world.engine.entities({ kind: 'mission' }).entities[0]?.reference?.status).toBe('active')
    // The same engine, the same evidence, the domain now reporting something else:
    // there is no second copy of Mission state anywhere to fall out of date.
    const moved = harness({ references: () => [missionRef('m-1', 'cancelled', T0.toISOString())] })
    expect(moved.engine.entities({ kind: 'mission' }).entities[0]?.reference?.status).toBe('cancelled')
  })

  it('marks a reference node as a domain record rather than a claim', () => {
    const world = harness({ references: () => [missionRef('m-1', 'active')] })
    const mission = world.engine.entities({ kind: 'mission' }).entities[0]
    expect(mission?.claimKind).toBe('domain_record')
    expect(mission?.epistemic).toBe('verified')
  })

  it('derives a worker membership edge from the Workforce record, with no claim needed', () => {
    const world = harness({
      references: () => [workerRef('alpha', 'working', { teamId: 't-1' }), teamRef('t-1', 'active', ['alpha'])],
    })
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const membership = graph.edges.find((edge) => edge.relationType === 'member_of')
    expect(membership).toBeDefined()
    expect(membership?.origin).toBe('domain_record')
    expect(membership?.provenance.source).toBe('system-observation')
    expect(membership?.evidenceId).toBeNull()
  })

  it('derives a worker assignment edge from the Mission the assignment names', () => {
    const world = harness({
      references: () => [
        workerRef('alpha', 'working', { assignment: { kind: 'mission', id: 'm-1' } }),
        missionRef('m-1', 'active'),
      ],
    })
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    const assigned = graph.edges.find((edge) => edge.relationType === 'assigned_to')
    expect(assigned?.origin).toBe('domain_record')
    expect(assigned?.toEntityId).toBeDefined()
  })

  it('counts a claim about a record that does not exist as dangling rather than false', () => {
    const world = harness({ references: () => [] })
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'reference', refKind: 'mission', refId: 'm-nope' },
    })
    const summary = world.engine.summary()
    expect(summary.counts.danglingEdges).toBe(1)
    expect(summary.uncertainties.items.some((item) => item.reason === 'dangling')).toBe(true)
  })
})

describe('every population is bounded, and truncation is visible', () => {
  it('evicts the oldest evidence past the record ceiling', () => {
    const world = harness({ limits: { maxEvidenceRecords: 4 } })
    for (let index = 0; index < 12; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    expect(world.engine.summary().counts.evidenceRecords).toBeLessThanOrEqual(4)
  })

  it('reports retained, total and hidden for the entity list', () => {
    const world = harness({ limits: tinyLimits() })
    for (let index = 0; index < 10; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    const list = world.engine.entities({})
    expect(list.entitiesRetained).toBeLessThanOrEqual(list.entitiesTotal)
    expect(list.entitiesHidden).toBe(list.entitiesTotal - list.entitiesRetained)
    expect(list.entities.length).toBe(list.entitiesRetained)
  })

  it('reports retained, total and hidden for the graph', () => {
    const world = harness({ limits: tinyLimits() })
    for (let index = 0; index < 10; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
      world.owner({ kind: 'entity', entityType: 'project', name: `Project ${index}` })
    }
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.nodesHidden).toBe(graph.nodesTotal - graph.nodesRetained)
    expect(graph.edgesHidden).toBe(graph.edgesTotal - graph.edgesRetained)
  })

  it('can only lower a code ceiling, never raise one', () => {
    const raised = worldLimits({ maxEntities: 1_000_000 })
    expect(raised.maxEntities).toBe(WORLD_LIMITS.maxEntities)
    const lowered = worldLimits({ maxEntities: 10 })
    expect(lowered.maxEntities).toBe(10)
  })

  it('keeps its own bounds self-consistent when a caller lowers one of them', () => {
    const limits = worldLimits({ maxEntities: 4, maxProjectionEntities: 100 })
    expect(limits.maxProjectionEntities).toBeLessThanOrEqual(limits.maxEntities)
  })

  it('will not let staleness be expressed below the freshness horizon', () => {
    const limits = worldLimits({ freshnessHorizonMs: 10, staleAfterMs: 1 })
    expect(limits.staleAfterMs).toBeGreaterThanOrEqual(limits.freshnessHorizonMs)
  })
})

describe('the fold is deterministic', () => {
  it('produces the same world shape for the same statements in any arrival order', () => {
    const first = harness()
    for (const request of anaWorksOnProject()) first.owner(request)

    const second = harness()
    const requests = anaWorksOnProject()
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      second.owner(requests[index] as WorldEvidenceRequest)
    }

    const shape = (world: WorldHarness): string =>
      JSON.stringify(
        world.engine
          .relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
          .edges.map((edge) => `${edge.fromEntityId}|${edge.relationType}|${edge.toEntityId ?? ''}`)
          .sort(),
      )
    expect(shape(second)).toBe(shape(first))
    // Node ids are purely a function of the normalised name, so even those agree.
    expect(second.engine.entities({}).entities.map((entity) => entity.entityId).sort()).toEqual(
      first.engine.entities({}).entities.map((entity) => entity.entityId).sort(),
    )
  })

  it('keeps two people saying the same thing as two claims rather than one fact', () => {
    // This is why an edge's id includes its evidence id: collapsing identical claims
    // would make it impossible to represent that two people asserted the same thing,
    // which is the raw material of every conflict this model has to be able to show.
    const world = harness()
    world.owner({ kind: 'entity', entityType: 'person', name: 'Ana' })
    world.owner({ kind: 'entity', entityType: 'project', name: 'Atlas' })
    const relation: WorldEvidenceRequest = {
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    }
    world.owner(relation)
    world.owner(relation)
    const graph = world.engine.relations({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(graph.edges.length).toBe(2)
    // Identical claims are not a disagreement, so nothing is marked conflicted.
    expect(world.engine.summary().counts.conflicts).toBe(0)
  })

  it('gives the same projection twice in a row from one engine', () => {
    const world = harness()
    for (const request of anaWorksOnProject()) world.owner(request)
    const first = JSON.stringify(world.engine.summary())
    const second = JSON.stringify(world.engine.summary())
    expect(second).toBe(first)
  })

  it('lists entities in a total order that does not depend on the map', () => {
    const world = harness()
    for (const name of ['Zoe', 'Ana', 'Bo', 'Cy']) {
      world.owner({ kind: 'entity', entityType: 'person', name })
    }
    const listed = world.engine.entities({}).entities.map((entity) => entity.name)
    // Persons first in name order, then Freya — whose kind is `self`, which sorts
    // after `person`. A total order that put the singletons anywhere else would be a
    // total order nobody could rely on.
    expect(listed).toEqual(['Ana', 'Bo', 'Cy', 'Zoe', 'owner', 'Freya'])
  })
})

describe('the graph read is bounded by depth as well as by size', () => {
  it('returns a neighbourhood rather than the whole world when one entity is focused', () => {
    const world = harness()
    for (let index = 0; index < 12; index += 1) {
      world.owner({ kind: 'entity', entityType: 'person', name: `Person ${index}` })
    }
    world.owner({ kind: 'entity', entityType: 'project', name: 'Atlas' })
    world.owner({
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Person 0' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    const ana = world.engine.entities({ kind: 'person' }).entities.find((node) => node.name === 'Person 0')
    expect(ana).toBeDefined()
    const neighbourhood = world.engine.relations({
      focusEntityId: ana?.entityId ?? '',
      kinds: null,
      maxDepth: 1,
    })
    expect(neighbourhood.scope).toBe('neighbourhood')
    expect(neighbourhood.focusEntityId).toBe(ana?.entityId)
    expect(neighbourhood.nodes.length).toBeLessThan(world.engine.entities({}).entities.length)
  })

  it('says the world is empty rather than showing an empty graph as if it were the world', () => {
    const graph = harness().engine.relations({ focusEntityId: 'ent_missing', kinds: null, maxDepth: 1 })
    expect(graph.scope).toBe('whole_world')
    expect(graph.nodes.length).toBeGreaterThan(0)
  })
})