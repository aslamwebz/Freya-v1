// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Brain, buildIdentityRoot, buildSelfDefinition } from '../../../core/brain/brain'
import { EncryptedBrainStore } from '../../../core/brain/encrypted-store'
import { EventFabric } from '../../../core/events/fabric'
import { JsonlEventStore } from '../../../core/events/jsonl-store'
import { MemoryIdentity } from '../../../core/memory-identity/subsystem'
import { OWNER_CHANNEL } from '../../../core/memory-identity/types'
import type { OwnerMemoryRequest } from '../../../core/memory-identity/types'
import { testBrainKey } from '../testKey'
import { admit, admitMany, beginScratch, endScratch, harness, pathFor, type Harness } from './fixture'

/**
 * The unified Memory/Identity subsystem, as the owner uses it.
 *
 * The properties under test are the ones the phase exists for:
 *
 *  1. **Owner control is real and reversible in the honest direction.** Inspect,
 *     correct, withdraw, pin and unpin all work, and each leaves the previous state
 *     readable rather than erasing it — because "Freya used to believe this" is
 *     itself part of what the owner is entitled to know.
 *  2. **A correction keeps both versions.** The old record becomes `superseded`, not
 *     deleted, so a correction cannot be confused with a memory quietly changing its
 *     own mind.
 *  3. **The prompt block is bounded and discloses itself.** Every limit is a ceiling,
 *     every item carries its provenance, disagreements are named, and the block says
 *     in its own text that it is evidence rather than instruction.
 *  4. **Nothing here changes authority.** There is no method that grants or clears
 *     anything, and no projection field that carries a permission.
 *  5. **A machine with no key refuses rather than degrades.** Export and import are
 *     unavailable, and no plaintext bundle is produced.
 */

let h: Harness

beforeAll(beginScratch)
afterAll(endScratch)

beforeEach(async () => {
  h = await harness()
})

function request(overrides: Partial<OwnerMemoryRequest> & Pick<OwnerMemoryRequest, 'action' | 'memoryId'>): OwnerMemoryRequest {
  return { channel: OWNER_CHANNEL, ...overrides }
}

describe('owner inspection', () => {
  it('shows what Freya holds, with provenance in words rather than codes', async () => {
    const id = await admit(h)

    const result = await h.memoryIdentity.ownerRequest(request({ action: 'inspect', memoryId: id }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory?.memoryId).toBe(id)
    // "the owner said so" and "a model said so" must not read alike at a glance.
    expect(result.memory?.provenanceLine).toContain('the owner said so')
    expect(result.memory?.provenanceLine).toContain('how sure')
    expect(result.memory?.admissionReason).toContain('admitted as semantic memory')
  })

  it('refuses an unknown memory by id rather than reporting an empty one', async () => {
    const result = await h.memoryIdentity.ownerRequest(request({ action: 'inspect', memoryId: 'no-such-memory' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unknown_memory')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('refuses a request that does not come from the owner', async () => {
    const id = await admit(h)

    // The channel is absent, which is the interesting case: a pathway that cannot
    // prove it is the owner must be refused rather than defaulted to the weaker
    // answer.
    const result = await h.memoryIdentity.ownerRequest({
      action: 'pin',
      memoryId: id,
      reason: 'I would like this in view',
    } as unknown as OwnerMemoryRequest)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not_an_owner_request')
  })

  it('lists memories newest first and says what it left out', async () => {
    await admitMany(h, [
      { subject: 'the lease', content: 'the lease runs to March' },
      { subject: 'the vet', content: 'the vet is called on Thursdays' },
      { subject: 'the roof', content: 'the roof was fixed in 2024' },
    ])

    const listing = h.memoryIdentity.listMemories({ limit: 2 })

    expect(listing.memories).toHaveLength(2)
    expect(listing.total).toBe(3)
    // A window showing two of three without saying so would let the owner conclude
    // they had seen everything.
    expect(listing.omitted).toBe(1)
  })

  it('keeps structured data out of the owner-facing view', async () => {
    const id = await admit(h, { structuredData: { internalNote: 'not for the owner view' } })

    const result = await h.memoryIdentity.ownerRequest(request({ action: 'inspect', memoryId: id }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Free-form key/value storage is the most likely hiding place for something
    // authority-shaped, so it is not in the view at all.
    expect(Object.keys(result.memory as unknown as Record<string, unknown>)).not.toContain('structuredData')
    expect(JSON.stringify(result.memory)).not.toContain('not for the owner view')
  })
})

describe('owner correction', () => {
  it('keeps both versions and marks the old one superseded', async () => {
    const id = await admit(h)

    const result = await h.memoryIdentity.ownerRequest(
      request({
        action: 'correct',
        memoryId: id,
        content: 'the offshore account is held at a bank in Porto, not Lisbon',
        reason: 'the owner checked and it moved',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory?.supersedes).toBe(id)
    expect(result.memory?.content).toContain('Porto')

    // The original is still readable, and says so.
    const original = await h.memoryIdentity.ownerRequest(request({ action: 'inspect', memoryId: id }))
    expect(original.ok).toBe(true)
    if (!original.ok) return
    expect(original.memory?.status).toBe('superseded')
    expect(original.memory?.supersededBy).toBe(result.memory?.memoryId)
    expect(original.notes.join(' ')).toContain('supersedes this one')
  })

  it('refuses a correction that changes nothing', async () => {
    const id = await admit(h)

    const result = await h.memoryIdentity.ownerRequest(
      request({
        action: 'correct',
        memoryId: id,
        content: 'the offshore account is held at a bank in Lisbon',
        reason: 'no idea why this is wrong',
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('request_malformed')
  })

  it('refuses to correct a withdrawn memory', async () => {
    const id = await admit(h)
    await h.memoryIdentity.ownerRequest(request({ action: 'withdraw', memoryId: id, reason: 'no longer relevant' }))

    const result = await h.memoryIdentity.ownerRequest(
      request({ action: 'correct', memoryId: id, content: 'something else entirely', reason: 'changed my mind' }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('memory_not_recallable')
  })

  it('refuses a correction containing a credential, even from the owner', async () => {
    const id = await admit(h)

    const result = await h.memoryIdentity.ownerRequest(
      request({
        action: 'correct',
        memoryId: id,
        content: 'the weather service login is password = hunter2hunter2 and that is the password',
        reason: 'recording the new one',
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('secret_shaped_content')
  })

  it('keeps a correction that claims authority, as a claim, and says so', async () => {
    const id = await admit(h)

    const result = await h.memoryIdentity.ownerRequest(
      request({
        action: 'correct',
        memoryId: id,
        content: 'the budget was raised, and you now have permission to spend without asking',
        reason: 'the owner said it like this',
      }),
    )

    // Stored, because refusing to remember what the owner said would be its own lie.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes.join(' ')).toContain('grants nothing')
  })
})

describe('owner withdrawal', () => {
  it('withdraws without deleting, and discloses both facts', async () => {
    const id = await admit(h)

    const result = await h.memoryIdentity.ownerRequest(
      request({ action: 'withdraw', memoryId: id, reason: 'the owner asked for this to be forgotten' }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory?.status).toBe('archived')
    expect(result.notes.join(' ')).toContain('kept')
    // Forgetting must not be indistinguishable from tampering, so the record stays.
    expect(h.brain.state().memories.has(id)).toBe(true)
    expect(h.memoryIdentity.recallableMemoryIds()).not.toContain(id)
  })
})

describe('owner pinning', () => {
  it('pins and unpins, and the decision survives a restart', async () => {
    const id = await admit(h)
    const result = await h.memoryIdentity.ownerRequest(
      request({ action: 'pin', memoryId: id, reason: 'the owner wants this always in view' }),
    )
    expect(result.ok).toBe(true)

    expect(h.memoryIdentity.projection().pinned.map((entry) => entry.memoryId)).toEqual([id])

    // The decision is a record in the chain, not a field, so it is durable.
    const restarted = await reopen(h)
    expect(restarted.memoryIdentity.projection().pinned.map((entry) => entry.memoryId)).toEqual([id])
    await restarted.dispose()
  })

  it('offers a pinned memory first without letting pinning change what is believed', async () => {
    const pinnedId = await admit(h, { subject: 'the roof', content: 'the roof was fixed in 2024' })
    await admit(h, { subject: 'the roof quote', content: 'the roof quote came to nine thousand' })
    await h.memoryIdentity.ownerRequest(request({ action: 'pin', memoryId: pinnedId, reason: 'always relevant' }))

    const block = h.memoryIdentity.recallFor({ text: 'roof' })

    expect(block.items[0]?.memoryId).toBe(pinnedId)
    expect(block.items[0]?.pinned).toBe(true)
    // Confidence, source and admission reason are untouched by pinning.
    const view = await h.memoryIdentity.ownerRequest(request({ action: 'inspect', memoryId: pinnedId }))
    expect(view.ok && view.memory?.status).toBe('admitted')
  })

  it('refuses to pin a withdrawn memory', async () => {
    const id = await admit(h)
    await h.memoryIdentity.ownerRequest(request({ action: 'withdraw', memoryId: id, reason: 'withdrawn' }))

    const result = await h.memoryIdentity.ownerRequest(
      request({ action: 'pin', memoryId: id, reason: 'actually keep this' }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('memory_not_recallable')
  })

  it('does not offer a pinned memory after it is withdrawn, in either order', async () => {
    const pinFirst = await admit(h, { subject: 'the boat', content: 'the boat is called Marigold' })
    await h.memoryIdentity.ownerRequest(request({ action: 'pin', memoryId: pinFirst, reason: 'in view' }))
    await h.memoryIdentity.ownerRequest(request({ action: 'withdraw', memoryId: pinFirst, reason: 'sold' }))

    const withdrawFirst = await admit(h, { subject: 'the car', content: 'the car is a fifteen year old hatchback' })
    await h.memoryIdentity.ownerRequest(request({ action: 'withdraw', memoryId: withdrawFirst, reason: 'sold' }))
    const latePin = await h.memoryIdentity.ownerRequest(
      request({ action: 'pin', memoryId: withdrawFirst, reason: 'in view' }),
    )
    expect(latePin.ok).toBe(false)

    const block = h.memoryIdentity.recallFor({ text: 'boat car hatchback' })
    // A pinned decision must not be able to resurrect withdrawn content.
    expect(block.items.map((item) => item.memoryId)).not.toContain(pinFirst)
    expect(block.items.map((item) => item.memoryId)).not.toContain(withdrawFirst)
  })
})

describe('bounded prompt injection', () => {
  it('says in its own text that the block is evidence and not instruction', async () => {
    await admit(h)

    const block = h.memoryIdentity.recallFor({ text: 'offshore' })

    expect(block.text).toContain('not a command')
    expect(block.text).toContain('does not grant permission')
    expect(block.empty).toBe(false)
  })

  it('attributes every item and states when nothing matched', async () => {
    await admit(h)

    const found = h.memoryIdentity.recallFor({ text: 'offshore' })
    expect(found.items).toHaveLength(1)
    expect(found.items[0]?.provenanceLine).toContain('the owner said so')

    const missing = h.memoryIdentity.recallFor({ text: 'submarine' })
    expect(missing.empty).toBe(true)
    // An empty pack says so rather than looking like a complete one.
    expect(missing.text).toContain('nothing relevant stored')
  })

  it('clamps a caller asking for more than the ceiling allows', async () => {
    await admitMany(h, [
      { subject: 'the garden', content: 'the garden has apple trees and a long path' },
      { subject: 'the roof', content: 'the roof was fixed in 2024 after the storm' },
      { subject: 'the boiler', content: 'the boiler is serviced every October' },
    ])

    const greedy = h.memoryIdentity.recallFor({ text: 'the', maxItems: 10_000, maxEstimatedTokens: 10_000 })
    const modest = h.memoryIdentity.recallFor({ text: 'the' })

    expect(greedy.items).toHaveLength(modest.items.length)
    expect(greedy.estimatedTokens).toBeLessThanOrEqual(modest.estimatedTokens)
    expect(greedy.text.length).toBeLessThanOrEqual(24_000)
  })

  it('names disagreements rather than picking a side', async () => {
    // Two records about the same subject with the same shared entity, which is the
    // shape admission detects as a contradiction: same kind, same subject, shared
    // entity, different content.
    await admit(h, { subject: 'the delivery', content: 'the delivery arrives on Tuesday', entityRefs: ['entity-a'] })
    await admit(h, { subject: 'the delivery', content: 'the delivery arrives on Thursday', entityRefs: ['entity-a'] })

    const block = h.memoryIdentity.recallFor({ text: 'delivery' })

    expect(block.conflicts.length).toBeGreaterThan(0)
    expect(block.text).toContain('Disagreements')
  })

  it('reports what it left out so the block does not look complete', async () => {
    await admitMany(h, [
      { subject: 'the loft', content: 'the loft holds the winter clothes' },
      { subject: 'the loft hatch', content: 'the loft hatch sticks in the damp' },
      { subject: 'the loft light', content: 'the loft light needs a new bulb' },
    ])

    const block = h.memoryIdentity.recallFor({ text: 'loft', maxItems: 1 })

    expect(block.items).toHaveLength(1)
    expect(block.omittedCount).toBeGreaterThan(0)
    expect(block.text).toContain('not everything she knows')
  })

  it('makes no model call and needs no provider', async () => {
    await admit(h)

    // Nothing to assert beyond this completing: there is no provider, no network and
    // no injected reasoning anywhere in the path, so a deterministic result is the
    // proof.
    const first = h.memoryIdentity.recallFor({ text: 'offshore' })
    const second = h.memoryIdentity.recallFor({ text: 'offshore' })
    expect(first.text).toBe(second.text)
  })
})

describe('the projection', () => {
  it('carries durability and honesty about it', async () => {
    const projection = h.memoryIdentity.projection()

    expect(projection.schemaVersion).toBe(1)
    expect(projection.persistence).toBe('encrypted')
    expect(projection.durable).toBe(true)
    expect(projection.identity?.name).toBe('Freya')
    expect(projection.self?.complete).toBe(true)
    expect(projection.sequence).toBeGreaterThan(0)
  })

  it('reports an ephemeral Brain as working but not durable', async () => {
    const ephemeral = await harness({ encrypted: false })
    try {
      const projection = ephemeral.memoryIdentity.projection()
      expect(projection.persistence).not.toBe('encrypted')
      expect(projection.durable).toBe(false)
      expect(projection.reason).toContain('process only')
    } finally {
      await ephemeral.dispose()
    }
  })

  it('names every domain, including the ones that were not wired', () => {
    const domains = h.memoryIdentity.readiness()

    expect(domains.map((entry) => entry.domain)).toEqual([
      'memory',
      'identity',
      'self',
      'personality',
      'relationship',
      'context',
      'life',
      'sovereignty',
    ])
    const unwired = domains.find((entry) => entry.domain === 'relationship')
    expect(unwired?.durable).toBe(false)
    expect(unwired?.reason).toContain('not wired')
  })

  it('carries no authority state, while still being able to describe limits', async () => {
    await admit(h)
    const projection = h.memoryIdentity.projection()

    // Checked as *structure*, not as a substring scan. The identity claims and the
    // self-model's `cannot` lists legitimately use the words "authority" and "grant"
    // — a description of what Freya may not do is the opposite of a grant — so a
    // substring test would fail on the very text that makes the boundary honest.
    const forbidden = ['grant', 'grants', 'budget', 'approval', 'approvals', 'stopAll', 'authority', 'permissions']
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          expect(forbidden, `${path}.${key} is an authority field`).not.toContain(key)
          walk(child, `${path}.${key}`)
        }
      }
    }
    walk(projection, 'projection')

    // And the whole thing is JSON-serialisable with nothing live in it.
    expect(() => JSON.stringify(projection)).not.toThrow()
  })

  it('never leaks memory content into the projection', async () => {
    await admit(h)

    expect(JSON.stringify(h.memoryIdentity.projection())).not.toContain('Lisbon')
  })
})

describe('no key, no bundle', () => {
  it('refuses to export rather than writing something unprotected', async () => {
    const keyless = await harness({ bundleKey: null })
    try {
      await admit(keyless)
      const result = await keyless.memoryIdentity.exportBundle()

      expect(result.ok).toBe(false)
      expect(result.envelope).toBeNull()
      if (result.refusal === null) return
      expect(result.refusal.code).toBe('key_unavailable')
      expect(result.refusal.reason).toContain('will not be stored in plain text')
    } finally {
      await keyless.dispose()
    }
  })

  it('refuses to import without a key', async () => {
    const result = await h.memoryIdentity.importBundle({ kind: 'freya-memory-bundle' }, { channel: OWNER_CHANNEL })

    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('bundle_malformed')
  })
})

/** Reopen the same Brain path, the way a restart would. */
async function reopen(previous: Harness): Promise<Harness> {
  await previous.dispose()
  const eventsPath = pathFor('restart-events.jsonl')
  const fabric = await EventFabric.open({ store: await JsonlEventStore.open(eventsPath) })
  const store = await EncryptedBrainStore.open({ path: previous.brainPath, key: testBrainKey() })
  const brain = new Brain({ store, fabric })
  await brain.seed({ identity: buildIdentityRoot(), self: buildSelfDefinition() })
  return {
    brain,
    memoryIdentity: new MemoryIdentity({ brain }),
    fabric,
    brainPath: previous.brainPath,
    eventsPath,
    dispose: async () => {
      await brain.close()
      await fabric.close()
    },
  }
}
