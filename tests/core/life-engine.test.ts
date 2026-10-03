// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { LifeEngine } from '../../core/life/engine'
import { MemoryLifeStore } from '../../core/vault/repositories/life-store'

/**
 * THE LIFE ENGINE, WITHOUT A CORE.
 *
 * Deterministic derivation from the journal, idempotency across replays, and
 * the store's refusal of invalid records.
 */

let dir: string
let fabric: EventFabric | null = null

async function openFabric(): Promise<EventFabric> {
  dir = await mkdtemp(join(tmpdir(), 'freya-life-engine-'))
  const store = await JsonlEventStore.open(join(dir, 'events.jsonl'))
  fabric = await EventFabric.open({ store, newId: (() => { let n = 0; return () => `e-${(n += 1)}` })() })
  return fabric
}

afterEach(async () => {
  await fabric?.close()
  fabric = null
  await rm(dir, { recursive: true, force: true })
})

describe('life engine derivation', () => {
  it('derives entries from the journal once and is idempotent on replay', async () => {
    const f = await openFabric()
    await f.append('mission.completed' as never, {
      missionId: 'mission-1',
      from: 'active',
      to: 'completed',
      reason: null,
      verifierId: 'v1',
    } as never, { actor: 'owner' })
    await f.append('mission.failed' as never, {
      missionId: 'mission-2',
      from: 'active',
      to: 'failed',
      reason: 'child_run_failed',
      verifierId: null,
    } as never, { actor: 'owner' })

    const store = new MemoryLifeStore()
    const engine = new LifeEngine({ fabric: f, store })
    await engine.open()
    expect(await engine.deriveFromJournal()).toBe(2)
    expect(store.state().entries.size).toBe(2)

    expect(await engine.deriveFromJournal()).toBe(0)
    expect(store.state().entries.size).toBe(2)

    const reopened = new LifeEngine({ fabric: f, store })
    await reopened.open()
    expect(await reopened.deriveFromJournal()).toBe(0)
    expect(store.state().entries.size).toBe(2)
  })

  it('does no enrichment while STOP ALL is latched', async () => {
    const f = await openFabric()
    await f.append('mission.completed' as never, {
      missionId: 'mission-3',
      from: 'active',
      to: 'completed',
      reason: null,
      verifierId: null,
    } as never, { actor: 'owner' })
    const store = new MemoryLifeStore()
    const engine = new LifeEngine({ fabric: f, store, stopped: () => true })
    await engine.open()
    expect(await engine.deriveFromJournal()).toBe(0)
    expect(store.state().entries.size).toBe(0)
  })
})

describe('memory life store', () => {
  it('round-trips a record and folds it', async () => {
    const store = new MemoryLifeStore()
    await store.write({
      kind: 'life-entry',
      entry: {
        entryId: 'life:test:1',
        kind: 'episode',
        title: 'Round trip',
        summary: 's',
        body: 'b',
        status: 'live',
        salience: 'low',
        derivation: 'owner-stated',
        confidence: 'high',
        provenance: {
          sourceDomain: 'owner',
          sourceId: null,
          observedAt: '2026-01-01T00:00:00.000Z',
          recordedAt: '2026-01-01T00:00:00.000Z',
          actor: 'owner',
          derivation: 'owner-stated',
          confidence: 'high',
        },
        references: [],
        occurredAt: null,
        recordedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        supersedes: null,
        lineage: [],
        tags: [],
        admissionReason: 'test',
      },
    })
    expect(store.state().entries.get('life:test:1')?.title).toBe('Round trip')
    expect(store.health().health).toBe('healthy')
    await store.close()
  })

  it('rejects an invalid record', async () => {
    const store = new MemoryLifeStore()
    await expect(
      store.write({
        kind: 'life-entry',
        entry: {
          entryId: '',
          kind: 'episode',
          title: '',
          summary: '',
          body: '',
          status: 'live',
          salience: 'low',
          derivation: 'observed',
          confidence: 'medium',
          provenance: {
            sourceDomain: 'system',
            sourceId: null,
            observedAt: '2026-01-01T00:00:00.000Z',
            recordedAt: '2026-01-01T00:00:00.000Z',
            actor: 'system',
            derivation: 'observed',
            confidence: 'medium',
          },
          references: [],
          occurredAt: null,
          recordedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
          supersedes: null,
          lineage: [],
          tags: [],
          admissionReason: 'test',
        },
      }),
    ).rejects.toThrow()
    await store.close()
  })
})
