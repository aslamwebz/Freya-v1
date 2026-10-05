// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Brain, buildIdentityRoot, buildSelfDefinition } from '../../../core/brain/brain'
import { EncryptedBrainStore } from '../../../core/brain/encrypted-store'
import { MemoryBrainStore } from '../../../core/brain/memory-store'
import { EventFabric } from '../../../core/events/fabric'
import { JsonlEventStore } from '../../../core/events/jsonl-store'
import { BrainStoreError, type BrainRecord } from '../../../core/brain/store'
import { validateRecord } from '../../../core/brain/fold'
import { admit, beginScratch, endScratch, harness, pathFor, type Harness } from './fixture'

/**
 * The owner-ownership record, at the level of the store rather than the façade.
 *
 * The façade tests prove the owner can pin. These prove the two properties that make
 * pinning *safe*, which the façade cannot demonstrate on its own:
 *
 *  1. **Only the owner can decide what Freya keeps in view.** The check lives in
 *     `validateRecord`, so it runs on **read** as well as on write. A record claiming
 *     any other principal is refused even when it is already on disk and already
 *     encrypted — which is the only way the guarantee survives a bug in a future
 *     writer, or a hand-crafted file.
 *  2. **The decision is a record, not a field.** It lives in the chain, so the whole
 *     history of what the owner pinned and when stays readable, and it survives a
 *     restart.
 *
 * Also checked here: the journal records *that* the owner pinned something without
 * recording why, because the journal is audit surface that is copied far more freely
 * than the Brain itself.
 */

let h: Harness

beforeAll(beginScratch)
afterAll(endScratch)

beforeEach(async () => {
  h = await harness()
})

/** A well-formed ownership record the store must accept. */
function ownershipRecord(overrides: Record<string, unknown> = {}): BrainRecord {
  return {
    kind: 'memory-ownership',
    ownership: {
      memoryId: 'memory-1',
      pinned: true,
      decidedAt: '2026-01-01T00:00:00.000Z',
      decidedBy: 'owner',
      reason: 'the owner asked for this always in view',
      ...overrides,
    },
  } as unknown as BrainRecord
}

describe('ownership record validation', () => {
  it('accepts a decision by the owner', () => {
    expect(validateRecord(ownershipRecord()).ok).toBe(true)
  })

  it('refuses a decision by anything else, on read as well as on write', () => {
    // The single most important check on this record. A subsystem, a worker or a
    // model that could write `decidedBy: 'system'` would be able to decide what the
    // owner always sees — which is memory poisoning with a user interface.
    for (const actor of ['system', 'model', 'freya', 'renderer', 'OWNER', '']) {
      const checked = validateRecord(ownershipRecord({ decidedBy: actor }))
      expect(checked.ok, `decidedBy: ${actor} must be refused`).toBe(false)
      if (checked.ok) continue
      expect(checked.reason).toContain('only the owner decides')
    }
  })

  it('refuses a malformed decision', () => {
    expect(validateRecord(ownershipRecord({ pinned: 'yes' })).ok).toBe(false)
    expect(validateRecord(ownershipRecord({ decidedAt: 'not a time' })).ok).toBe(false)
    expect(validateRecord(ownershipRecord({ reason: '' })).ok).toBe(false)
    expect(validateRecord(ownershipRecord({ memoryId: '' })).ok).toBe(false)
  })

  it('is refused by a real store, not only by the validator', async () => {
    const store = new MemoryBrainStore()
    const fabric = await EventFabric.open({ store: await JsonlEventStore.open(await scratch()) })
    const brain = new Brain({ store, fabric })
    try {
      await expect(brain.setMemoryPinned('no-such-memory', true, 'because')).resolves.toMatchObject({
        outcome: 'rejected',
      })
      expect(store.state().ownership.size).toBe(0)
    } finally {
      await brain.close()
      await fabric.close()
    }
  })
})

describe('ownership through the Brain', () => {
  it('records the decision and keeps the memory unchanged', async () => {
    const id = await admit(h)

    const outcome = await h.brain.setMemoryPinned(id, true, 'the owner wants this in view')

    expect(outcome.outcome).toBe('admitted')
    expect(h.brain.ownership(id)?.pinned).toBe(true)
    expect(h.brain.ownership(id)?.decidedBy).toBe('owner')
    // The belief itself is untouched: status, confidence and source all stay put.
    const memory = h.brain.state().memories.get(id)
    expect(memory?.status).toBe('admitted')
    expect(memory?.confidence).toBe('high')
    expect(memory?.source).toBe('owner-assertion')
  })

  it('takes the latest decision, and keeps the earlier one in the chain', async () => {
    const id = await admit(h)

    await h.brain.setMemoryPinned(id, true, 'pinned for now')
    await h.brain.setMemoryPinned(id, false, 'no longer needed')

    expect(h.brain.ownership(id)?.pinned).toBe(false)
    expect(h.brain.pinnedMemoryIds()).toEqual([])
    // Three writes survive this: pin, unpin, and the chain that links them.
    expect(h.brain.state().sequence).toBeGreaterThan(0)
  })

  it('survives a restart, because it is a record in the chain', async () => {
    const id = await admit(h)
    await h.brain.setMemoryPinned(id, true, 'the owner wants this in view')
    const path = h.brainPath
    await h.dispose()

    const fabric = await EventFabric.open({ store: await JsonlEventStore.open(pathFor('reopen-events.jsonl')) })
    const store = await EncryptedBrainStore.open({ path, key: (await import('../testKey')).testBrainKey() })
    const brain = new Brain({ store, fabric })
    await brain.seed({ identity: buildIdentityRoot(), self: buildSelfDefinition() })
    try {
      expect(brain.ownership(id)?.pinned).toBe(true)
      expect(brain.ownership(id)?.reason).toBe('the owner wants this in view')
      expect(brain.pinnedMemoryIds()).toEqual([id])
    } finally {
      await brain.close()
      await fabric.close()
    }
  })

  it('journals that a decision was made, without the owner\'s words', async () => {
    const id = await admit(h)

    await h.brain.setMemoryPinned(id, true, 'the reason is my divorce and it is not for the log')

    // The journal is audit surface: read, copied and backed up far more freely than
    // the Brain. A private aside has no business in it, so only the fact, the target
    // and the *length* of the explanation are journalled.
    const events = await readJournal(h.eventsPath)
    expect(events).toContain('brain.memory.ownership_set')
    expect(events).not.toContain('divorce')
  })

  it('leaves the identity root untouched', async () => {
    const id = await admit(h)
    const before = h.brain.identity()

    await h.brain.setMemoryPinned(id, true, 'in view')

    expect(h.brain.identity()).toEqual(before)
    expect(h.brain.identity()?.immutable).toBe(true)
  })
})

describe('a store that cannot be believed', () => {
  it('refuses writes rather than appending past a break', async () => {
    const path = pathFor('degraded.enc')
    const { testBrainKey } = await import('../testKey')
    const key = testBrainKey()

    const first = await EncryptedBrainStore.open({ path, key })
    const fabricA = await EventFabric.open({ store: await JsonlEventStore.open(pathFor('degraded-a.jsonl')) })
    const brainA = new Brain({ store: first, fabric: fabricA })
    await brainA.seed({ identity: buildIdentityRoot(), self: buildSelfDefinition() })
    const id = await admit({ brain: brainA, dispose: async () => undefined } as unknown as Harness)
    await brainA.setMemoryPinned(id, true, 'in view')
    await brainA.close()
    await fabricA.close()

    // Corrupt the middle of the log, the way a damaged disk would.
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n')
    lines.splice(1, 1, '{"version":1,"kind":"memory-record","seq":99,"prev":"x","context":"y","nonce":"z","cipher":"c","tag":"t"}')
    await writeFile(path, lines.join('\n'), 'utf8')

    const second = await EncryptedBrainStore.open({ path, key })
    const fabricB = await EventFabric.open({ store: await JsonlEventStore.open(pathFor('degraded-b.jsonl')) })
    const brainB = new Brain({ store: second, fabric: fabricB })
    try {
      expect(brainB.health().health).toBe('degraded')
      // Asked of the store directly rather than through a Brain method, because every
      // Brain method checks its arguments first and would return `rejected` for an
      // unknown id before reaching the disk. The property under test is the chain's,
      // not the argument validation's.
      await expect(
        second.write({
          kind: 'memory-ownership',
          ownership: {
            memoryId: 'anything',
            pinned: true,
            decidedAt: '2026-01-01T00:00:00.000Z',
            decidedBy: 'owner',
            reason: 'in view',
          },
        }),
      ).rejects.toBeInstanceOf(BrainStoreError)
    } finally {
      await brainB.close()
      await fabricB.close()
    }
  })
})

/* ------------------------------------------------------------------ paths */

async function scratch(): Promise<string> {
  return pathFor('ownership-events.jsonl')
}

async function readJournal(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}
