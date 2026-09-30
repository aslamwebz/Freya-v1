// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brain, buildIdentityRoot, buildSelfDefinition } from '../../core/brain/brain'
import { EncryptedBrainStore } from '../../core/brain/encrypted-store'
import { MemoryBrainStore } from '../../core/brain/memory-store'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { EventFabric } from '../../core/events/fabric'
import { isSecurityEvent } from '../../core/events/envelope'
import { parseDurableEvent } from '../../core/events/validate'
import { testBrainKey } from './testKey'

/**
 * The Brain as a whole.
 *
 * The unit tests below cover the store, admission and retrieval in isolation. This
 * file is about the properties that only appear when they are joined up:
 *
 *  1. **Three writes per admission.** Candidate, review, then record. There is no
 *     path that produces a recallable memory without the proposal and the decision
 *     both being on disk.
 *  2. **Nothing learned reaches the journal.** The event fabric is audit surface —
 *     read, copied, backed up, forwarded to whoever is debugging — and the Brain's
 *     contents must not travel with it.
 *  3. **A Brain fault is not a security event.** No Brain event may appear in
 *     `SECURITY_EVENT_TYPES`, because a disk error must not be able to look like a
 *     safety posture.
 *  4. **Identity has no write path.** Nothing in the public surface can change it.
 */

let dir = ''
let fabric: EventFabric | null = null
let brain: Brain | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-brain-facade-'))
})

afterEach(async () => {
  await brain?.close()
  await fabric?.close()
  brain = null
  fabric = null
  await rm(dir, { recursive: true, force: true })
})

let idCounter = 0

/** Deterministic ids, so a failure is reproducible. */
function newId(): string {
  idCounter += 1
  return `id-${String(idCounter).padStart(4, '0')}`
}

const CLOCK_START = Date.parse('2026-04-01T09:00:00.000Z')

async function open(options: { encrypted?: boolean } = {}): Promise<{ brain: Brain; fabric: EventFabric }> {
  const store = options.encrypted
    ? await EncryptedBrainStore.open({ path: join(dir, 'brain.enc'), key: testBrainKey() })
    : new MemoryBrainStore()
  const eventStore = await JsonlEventStore.open(join(dir, 'events.jsonl'))
  // `open`, not the constructor: the fabric recovers its sequence from the store, and
  // a hand-constructed one starts at undefined — which serialises as a null
  // sequence and is refused by the validator, exactly as it should be.
  const made = await EventFabric.open({
    store: eventStore,
    now: () => new Date(CLOCK_START),
    newId,
  })
  const built = new Brain({ store, fabric: made, now: () => new Date(CLOCK_START), newId })
  brain = built
  fabric = made
  return { brain: built, fabric: made }
}

describe('identity and self', () => {
  it('seeds the identity root and the self-definition once', async () => {
    const { brain: b } = await open()
    await b.seed({ identity: buildIdentityRoot(), self: buildSelfDefinition() })

    expect(b.identity()?.name).toBe('Freya')
    expect(b.identity()?.immutable).toBe(true)
    expect(b.self()?.complete).toBe(true)
    expect(b.self()?.limitations.length).toBeGreaterThan(0)

    // Seeding again is a no-op, so a later release cannot swap who Freya is at
    // runtime by changing a constant.
    await b.seed({ identity: { ...buildIdentityRoot(), name: 'Someone Else' }, self: buildSelfDefinition() })
    expect(b.identity()?.name).toBe('Freya')
  })

  it('has no way to install a different identity', () => {
    // Structural rather than a search for a particular verb: the only mutating
    // members are `writeMemory` and `archiveMemory`, which go through admission,
    // and the generic `write` is private. Nothing accepts an `IdentityRoot`, so
    // there is no path by which a caller could supply one.
    const surface = Brain.prototype as unknown as Record<string, unknown>
    const methods = Object.getOwnPropertyNames(surface).filter(
      (name) => name !== 'constructor' && typeof surface[name] === 'function',
    )
    // The whole surface, pinned. A new public mutator fails this test rather than
    // quietly appearing.
    expect(methods.sort()).toEqual(
      [
        'archiveMemory',
        'close',
        // Private in TypeScript, and named so: `write` is the only generic record
        // path, `emit` the only way to reach the journal, and `provenance` is what
        // stamps a source class on the way in.
        'emit',
        'health',
        'identity',
        'observe',
        'projection',
        'provenance',
        'recall',
        'recordExperience',
        'relate',
        'rememberEntity',
        'seed',
        'self',
        'state',
        'timestamp',
        'write',
        'writeMemory',
      ].sort(),
    )
    // Nothing accepts an IdentityRoot, so a caller cannot supply one — and `write`,
    // the generic record path, is private.
    expect(surface.writeIdentity).toBeUndefined()
    expect(surface.setIdentity).toBeUndefined()
    expect(surface.identityWrite).toBeUndefined()
  })

  it('states capabilities as what they cannot do, not only what they can', () => {
    const definition = buildSelfDefinition()
    for (const capability of definition.capabilities) {
      expect(capability.cannot.length).toBeGreaterThan(0)
    }
    expect(definition.limitations.length).toBeGreaterThan(0)
  })

  it('keeps live authority out of the persistent self-model', () => {
    // Budgets, stop state and journal integrity are Guard's and Governor's truth,
    // read fresh. A writable copy of them would go stale and then be believed.
    const serialised = JSON.stringify(buildSelfDefinition())
    expect(serialised).not.toMatch(/stopAll|budget|grantId|journal/i)
  })
})

describe('admission writes three records', () => {
  it('records the candidate, the review and the memory, in that order', async () => {
    const { brain: b } = await open()
    const outcome = await b.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner prefers short answers',
      source: 'owner-assertion',
      sourceRef: 'turn-1',
      confidence: 'high',
      sensitivity: 'normal',
    })

    expect(outcome.outcome).toBe('admitted')
    const state = b.state()
    expect(state.candidates.size).toBe(1)
    expect(state.reviews.size).toBe(1)
    expect(state.memories.size).toBe(1)

    const review = [...state.reviews.values()][0]
    expect(review?.decision).toBe('admitted')
    expect(review?.memoryId).toBe(outcome.memory?.memoryId)
  })

  it('keeps a refusal, with its reason and its proposal', async () => {
    const { brain: b } = await open()
    const outcome = await b.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the key is sk-abcdefghijklmnopqrstuvwx',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'normal',
    })

    expect(outcome.outcome).toBe('rejected')
    expect(outcome.memory).toBeNull()
    // A refusal nobody can examine is indistinguishable from an arbitrary one.
    expect(b.state().candidates.size).toBe(1)
    expect(b.state().reviews.size).toBe(1)
    expect([...b.state().reviews.values()][0]?.decision).toBe('rejected')
    expect(b.state().memories.size).toBe(0)
  })

  it('does not treat a Brain fault as a reason to fail the turn', async () => {
    const { brain: b } = await open()
    await b.close()
    const outcome = await b.writeMemory({
      kind: 'semantic',
      subject: 'x',
      content: 'anything',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'medium',
      sensitivity: 'normal',
    })
    expect(outcome.outcome).toBe('unavailable')
  })
})

describe('archiving', () => {
  it('stops recalling a withdrawn memory without deleting it', async () => {
    const { brain: b } = await open()
    const written = await b.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner drinks tea',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'normal',
    })
    const memoryId = written.memory?.memoryId as string

    expect(b.recall({ text: 'tea' }).memories).toHaveLength(1)

    const archived = await b.archiveMemory(memoryId, 'no longer true')
    expect(archived.outcome).toBe('admitted')

    // Still on disk, still readable, not recalled. Deletion and tampering must not
    // look alike — that is what the hash chain is for.
    expect(b.state().memories.get(memoryId)?.status).toBe('archived')
    expect(b.recall({ text: 'tea' }).memories).toHaveLength(0)
  })

  it('refuses to archive something that does not exist', async () => {
    const { brain: b } = await open()
    expect(await b.archiveMemory('nope', 'because')).toMatchObject({ outcome: 'rejected' })
  })
})

describe('world', () => {
  it('notes an entity once, however often it is observed', async () => {
    const { brain: b } = await open()
    const first = await b.rememberEntity({
      type: 'person',
      canonicalName: 'Ada Lovelace',
      source: 'owner-assertion',
      sourceRef: null,
      epistemic: 'asserted',
    })
    const second = await b.rememberEntity({
      type: 'person',
      // Different spacing and case; the same thing.
      canonicalName: '  ada   lovelace ',
      source: 'external-untrusted',
      sourceRef: null,
      epistemic: 'asserted',
    })
    expect(second.ok && second.entityId).toBe(first.ok ? first.entityId : null)
    // Re-observing something known is not a new entity, or "how many people does
    // Freya know" becomes a question with no stable answer.
    expect(b.state().entities.size).toBe(1)
  })

  it('refuses a relation with no object, or with both an object and a literal', async () => {
    const { brain: b } = await open()
    const subject = await b.rememberEntity({
      type: 'project',
      canonicalName: 'Project Alpha',
      source: 'owner-assertion',
      sourceRef: null,
      epistemic: 'asserted',
    })
    const id = subject.ok ? subject.entityId : ''

    const base = {
      subjectEntityId: id,
      predicate: 'status',
      source: 'owner-assertion' as const,
      sourceRef: null,
      confidence: 'high' as const,
      epistemic: 'asserted' as const,
    }
    expect(await b.relate(base)).toMatchObject({ ok: false })
    expect(await b.relate({ ...base, objectEntityId: id, literalValue: 'delayed' })).toMatchObject({ ok: false })
    expect(await b.relate({ ...base, literalValue: 'delayed' })).toMatchObject({ ok: true })
  })

  it('refuses a relation whose subject is unknown', async () => {
    const { brain: b } = await open()
    expect(
      await b.relate({
        subjectEntityId: 'nobody',
        predicate: 'status',
        literalValue: 'delayed',
        source: 'owner-assertion',
        sourceRef: null,
        confidence: 'high',
        epistemic: 'asserted',
      }),
    ).toMatchObject({ ok: false })
  })

  it('keeps a contradicting relation rather than replacing it', async () => {
    const { brain: b } = await open()
    const subject = await b.rememberEntity({
      type: 'project',
      canonicalName: 'Project Alpha',
      source: 'owner-assertion',
      sourceRef: null,
      epistemic: 'asserted',
    })
    const id = subject.ok ? subject.entityId : ''
    const base = {
      subjectEntityId: id,
      predicate: 'status',
      source: 'owner-assertion' as const,
      sourceRef: null,
      confidence: 'high' as const,
      epistemic: 'asserted' as const,
    }

    await b.relate({ ...base, literalValue: 'delayed' })
    const second = await b.relate({ ...base, literalValue: 'shipped' })

    // Both are current, and the pair is disclosed. Silently keeping only the newest
    // is how a Brain starts being confidently wrong about something told twice.
    expect(second.ok && second.conflictsWith.length).toBe(1)
    const current = [...b.state().relations.values()].filter((relation) => relation.validUntil === null)
    expect(current).toHaveLength(2)
    expect(b.recall({ text: 'alpha' }).conflicts.length).toBeGreaterThan(0)
  })

  it('keeps an observation as an observation, never promoted on its own', async () => {
    const { brain: b } = await open()
    const noted = await b.observe({
      stated: 'a message says Project Alpha is delayed',
      source: 'external-untrusted',
      sourceRef: 'msg-1',
    })
    expect(noted.ok).toBe(true)
    // It is stored, and it is not recallable as knowledge.
    expect(b.state().observations.size).toBe(1)
    expect(b.recall({ text: 'alpha delayed' }).memories).toEqual([])
  })

  it('refuses an empty observation', async () => {
    const { brain: b } = await open()
    expect(
      await b.observe({ stated: '   ', source: 'owner-assertion', sourceRef: null }),
    ).toMatchObject({ ok: false })
  })
})

describe('experience', () => {
  it('records a turn as metadata and never as text', async () => {
    const { brain: b } = await open()
    const result = await b.recordExperience({
      goalSummary: 'answered a conversation turn',
      startedAt: '2026-04-01T09:00:00.000Z',
      endedAt: '2026-04-01T09:00:01.000Z',
      modelsUsed: ['fake-model'],
      toolsUsed: [],
      actions: [{ at: '2026-04-01T09:00:00.000Z', summary: 'requested one cognition', outcome: 'succeeded' }],
      observations: ['used 2 recalled items as reference'],
      evidenceRefs: ['turn-1'],
      result: 'completed',
      humanCorrection: null,
      relatedEntities: [],
      relatedMemories: [],
      resourceUsage: {
        providerId: 'fake',
        model: 'fake-model',
        providerContacted: true,
        inputTokens: null,
        outputTokens: null,
        usageUnknown: true,
      },
      answerPersisted: true,
      conversationId: 'conv-1',
      turnId: 'turn-1',
    })

    expect(result.ok).toBe(true)
    const stored = [...b.state().experiences.values()][0]
    // Phase 4 has no verifier, so this is not negotiable.
    expect(stored?.verification).toBe('unverified')
    // The turn's words stay in the encrypted conversation store, referenced by id.
    expect(stored?.evidenceRefs).toEqual(['turn-1'])
    expect(JSON.stringify(stored)).not.toMatch(/the question was|here is my answer/i)
  })

  it('refuses an over-long goal summary', async () => {
    const { brain: b } = await open()
    const result = await b.recordExperience({
      goalSummary: 'x'.repeat(2_000),
      startedAt: '2026-04-01T09:00:00.000Z',
      endedAt: '2026-04-01T09:00:01.000Z',
      modelsUsed: [],
      toolsUsed: [],
      actions: [],
      observations: [],
      evidenceRefs: [],
      result: 'completed',
      humanCorrection: null,
      relatedEntities: [],
      relatedMemories: [],
      resourceUsage: {
        providerId: null,
        model: null,
        providerContacted: false,
        inputTokens: null,
        outputTokens: null,
        usageUnknown: true,
      },
      answerPersisted: false,
      conversationId: null,
      turnId: null,
    })
    expect(result.ok).toBe(false)
  })
})

describe('the projection', () => {
  it('states durability and health separately, and says which is which', async () => {
    const { brain: b } = await open()
    const ephemeral = b.projection()
    expect(ephemeral.durable).toBe(false)
    expect(ephemeral.persistence).toBe('memory')

    await b.close()
    const { brain: durable } = await open({ encrypted: true })
    expect(durable.projection().durable).toBe(true)
    expect(durable.projection().persistence).toBe('encrypted')
  })

  it('carries no memory content in a listing', async () => {
    const { brain: b } = await open()
    await b.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner is allergic to shellfish and prefers window seats',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'personal',
    })
    // A listing is something a person scans, so it must not become a second copy of
    // every memory. Content comes only through an explicit recall.
    const serialised = JSON.stringify(b.projection())
    expect(serialised).not.toMatch(/shellfish|window seats/)
    expect(serialised).toContain('the owner')
  })

  it('counts refusals from the reviews, since a refusal never becomes a memory', async () => {
    const { brain: b } = await open()
    await b.writeMemory({
      kind: 'semantic',
      subject: 'x',
      content: 'password = correcthorsebattery',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'normal',
    })
    // Counting memories would report zero refusals on a Brain that had just refused
    // one.
    expect(b.projection().counts.rejected).toBe(1)
  })
})

describe('what reaches the journal', () => {
  it('records metadata only, never what was learned', async () => {
    const { brain: b } = await open()
    await b.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner is allergic to shellfish',
      source: 'owner-assertion',
      sourceRef: 'turn-1',
      confidence: 'high',
      sensitivity: 'personal',
    })

    const raw = await readAllEvents()
    const admitted = raw.filter((event) => event.type === 'brain.memory.admitted')
    expect(admitted).toHaveLength(1)
    const payload = admitted[0]?.payload as Record<string, unknown>
    // The journal is read, copied and backed up far more freely than the Brain.
    expect(JSON.stringify(payload)).not.toMatch(/shellfish/)
    expect(payload).toMatchObject({ source: 'owner-assertion', kind: 'semantic' })
    expect(payload.contentLength).toBe('the owner is allergic to shellfish'.length)
  })

  it('measures an entity name rather than recording it', async () => {
    const { brain: b } = await open()
    await b.rememberEntity({
      type: 'person',
      canonicalName: 'Ada Lovelace',
      source: 'owner-assertion',
      sourceRef: null,
      epistemic: 'asserted',
    })
    const raw = await readAllEvents()
    const noted = raw.find((event) => event.type === 'brain.world.entity_noted')
    expect(JSON.stringify(noted?.payload)).not.toMatch(/Ada/)
    expect((noted?.payload as Record<string, unknown>).nameLength).toBe('Ada Lovelace'.length)
  })

  it('has no recalled event, so the journal cannot become a record of associations', async () => {
    const { brain: b } = await open()
    await b.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner drinks tea',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'normal',
    })
    b.recall({ text: 'tea' })
    b.recall({ text: 'tea' })

    const raw = await readAllEvents()
    // Recall happens constantly. Journalling it would record what Freya connected to
    // what, every time, forever.
    expect(raw.some((event) => event.type.includes('recall'))).toBe(false)
    expect(raw.some((event) => event.type.startsWith('brain.'))).toBe(true)
  })

  it('treats no Brain event as a security event', () => {
    // A corrupt Brain cannot grant cognition or clear a stop, and it does not lose
    // authority either. If any of these were in the security stream, a disk error
    // could masquerade as a safety posture.
    for (const type of [
      'brain.degraded',
      'brain.memory.admitted',
      'brain.memory.reviewed',
      'brain.memory.archived',
      'brain.world.related',
      'brain.experience.recorded',
    ] as const) {
      expect(isSecurityEvent(type)).toBe(false)
    }
  })
})

describe('durability across a restart', () => {
  it('remembers what it was told, encrypted, and reports the same counts', async () => {
    const first = await open({ encrypted: true })
    await first.brain.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner prefers short answers',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'normal',
    })
    await first.brain.close()
    await first.fabric.close()
    brain = null
    fabric = null

    const second = await open({ encrypted: true })
    expect(second.brain.state().memories.size).toBe(1)
    expect(second.brain.recall({ text: 'short answers' }).memories).toHaveLength(1)
    // The chain is what makes this a claim about a log rather than a file with
    // plausible contents in it.
    expect(second.brain.projection().sequence).toBeGreaterThan(0)
    expect(second.brain.projection().durable).toBe(true)
  })

  it('reads nothing at all when the key is wrong', async () => {
    const first = await open({ encrypted: true })
    await first.brain.writeMemory({
      kind: 'semantic',
      subject: 'the owner',
      content: 'the owner prefers short answers',
      source: 'owner-assertion',
      sourceRef: null,
      confidence: 'high',
      sensitivity: 'normal',
    })
    await first.brain.close()
    await first.fabric.close()
    brain = null
    fabric = null

    // Reopen with the conversation domain's key. Reported as degraded rather than
    // refused, because a Brain that cannot read itself must still let Freya answer.
    const store = await EncryptedBrainStore.open({
      path: join(dir, 'brain.enc'),
      key: new Uint8Array(32).fill(9),
    })
    expect(store.health().health).toBe('degraded')
    expect(store.state().memories.size).toBe(0)
  })
})

/**
 * Read the journal back through the same validator replay uses.
 *
 * Deliberately not reading the file with a JSON parser of its own: a test that
 * parsed the journal more permissively than production would happily pass on a log
 * that Core itself would have refused.
 */
async function readAllEvents(): Promise<{ type: string; payload: unknown }[]> {
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
  const out: { type: string; payload: unknown }[] = []
  let previous = 0
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const parsed = parseDurableEvent(line, previous)
    // A line the validator refuses is a line production would refuse too, so
    // skipping it here keeps this helper as strict as replay.
    if (!parsed.ok) continue
    previous = parsed.event.sequence
    out.push({ type: parsed.event.type, payload: parsed.event.payload })
  }
  return out
}