// @vitest-environment node
import { RelationshipEngine } from '../../../core/relationship'
import { MemoryRelationshipStore } from '../../../core/vault/repositories/relationship-store'

/**
 * RED TEAM HARNESS — Phase 27 fixtures.
 *
 * One attacker model: an untrusted page, a document, a connector payload, a renderer, or
 * a model that has been given an opportunity to be persuasive. The attacker's goal is to
 * make Phase 27 into a machine that manufactures intimacy, manufactures obligation, or
 * launders untrusted text into owner-trusted relationship memory.
 *
 * The fixture is deterministic by construction: `now` and `newId` are injected, the
 * store is the in-memory one so no key or binding is involved, and every attack is a
 * value rather than a race. No clock, no randomness, no network, no model provider.
 */

export const NOW = new Date('2026-06-01T12:00:00.000Z')
export const NOW_ISO = NOW.toISOString()
export const OBSERVED = '2026-05-01T08:00:00.000Z'
export const LATER_OBSERVED = '2026-05-20T08:00:00.000Z'

/** A synthetic private string. Never real data; nothing here is a real secret. */
export const SENTINEL = 'FREYA_RED_TEAM_PRIVATE_4E19'

export interface RelationshipFixture {
  readonly engine: RelationshipEngine
  readonly store: MemoryRelationshipStore
  readonly stopped: { value: boolean }
}

export function relationshipFixture(options: { stopped?: boolean } = {}): RelationshipFixture {
  let counter = 0
  const stopped = { value: options.stopped ?? false }
  const store = new MemoryRelationshipStore()
  const engine = new RelationshipEngine({
    store,
    now: () => NOW,
    newId: () => `rel-${(counter += 1)}`,
    stopped: () => stopped.value,
  })
  return { engine, store, stopped }
}

/** The id of the first record in the ledger, or a thrown error if there is none. */
export function firstEntryId(fixture: RelationshipFixture): string {
  const entries = fixture.engine.listEntries()
  if (!entries.ok) throw new Error('the broad read refused')
  const id = entries.entries.items[0]?.entryId
  if (id === undefined) throw new Error('no record was written')
  return id
}

/**
 * A payload shaped exactly like a record, with whatever extra the attacker likes.
 *
 * Built through the domain's own constructor so these tests measure the *engine's*
 * pathways rather than a hand-rolled object that could differ from the real shape.
 */
export function statement(
  overrides: Record<string, unknown> = {},
): Parameters<RelationshipEngine['recordOwnerStatement']>[0] {
  return {
    kind: 'interaction-pattern',
    key: 'starts-with-a-question',
    text: 'the owner opens most sessions with a question',
    tags: [],
    evidenceRefs: ['event-1'],
    observedAt: OBSERVED,
    ...overrides,
  } as Parameters<RelationshipEngine['recordOwnerStatement']>[0]
}