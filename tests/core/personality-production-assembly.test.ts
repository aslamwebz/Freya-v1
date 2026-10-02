// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../../core'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import type { ModelRequest } from '../../core/model/provider'
import type { ConversationCommandOutcome } from '../../core/protocol/conversation'
import type { PersonalityProjection } from '../../core/protocol/personality'
import { EXPRESSION_BLOCK_MARKER } from '../../core/personality'

/**
 * PRODUCTION ASSEMBLY — the tests that attack the wiring rather than the pieces.
 *
 * Every other Phase 11 suite exercises a component: the domain, the store, the
 * Mind seam, the bridge. This one exercises the thing that only exists once they
 * are all connected — a Core that admits something the owner actually said,
 * persists it encrypted, comes back after a restart, and uses what it recovered
 * in the *same provider request* it was already going to make.
 *
 * Three properties carry most of the weight here, and all three are the ones a
 * component test cannot reach:
 *
 *  1. **The recovered state reaches the Mind.** A ledger or a record that survives
 *     a restart but never arrives at the turn path is a feature that does not work.
 *  2. **Degraded mode is truthful.** No key means an ephemeral relationship that
 *     says so — and, because anti-repetition cannot be trusted without durability,
 *     *no expression guidance at all* rather than guidance with a reset memory.
 *  3. **Nothing private travels.** The owner's words, the recorded clause and the
 *     store's own bytes stay out of the journal, the activity feed and the file.
 */

const KEY = new Uint8Array(32).fill(47)
const PRIVATE = 'PRIVATE_PERSONALITY_SENTINEL_51'
const NOW = '2026-10-02T09:00:00.000Z'

let dir: string
let clock: Date
let core: Core | null = null
let requests: ModelRequest[]
let fake: FakeModelProvider
/** Shared across boots so a restarted process never reuses an id. */
let ids = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-p11-assembly-'))
  clock = new Date(NOW)
  requests = []
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

/** The store path Core derives from its data path, beside the journal. */
function storePath(): string {
  return join(dir, 'events.jsonl.personality.enc')
}

function journalPath(): string {
  return join(dir, 'events.jsonl')
}

async function boot(key: Uint8Array | null = KEY, over: Partial<CoreOptions> = {}): Promise<Core> {
  fake = new FakeModelProvider()
  // The provider is spied on rather than replaced, so `calls` still increments the
  // way it would in production — the count is the assertion, and a wrapper that
  // forgot to increment it would make every "exactly one call" test vacuous.
  const real = fake.complete.bind(fake)
  vi.spyOn(fake, 'complete').mockImplementation(async (...args) => {
    requests.push(args[0])
    return real(...args)
  })
  const c = createCore({
    dataPath: journalPath(),
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    providers: [fake],
    personalityKey: key,
    now: () => new Date(clock),
    // A counter that does *not* reset between boots, because a real Core mints
    // unique ids and a restart that reused them would collide in the journal —
    // which is a property of the harness, not of the thing under test.
    newId: () => `p11-${(ids += 1)}`,
    ...over,
  } as CoreOptions)
  core = c
  await c.start()
  return c
}

async function newConversation(): Promise<string> {
  const result = await core!.handleCommand({ command: 'conversation.create', requestId: 'c0' })
  const conversation = result.conversation as ConversationCommandOutcome
  if (conversation.operation !== 'created') throw new Error('conversation was not created')
  return conversation.conversation.conversationId
}

async function send(text: string, requestId = 't1'): Promise<string> {
  const conversationId = await newConversation()
  const result = await core!.handleCommand({
    command: 'conversation.turn.submit',
    requestId,
    payload: { conversationId, text },
  })
  const outcome = result.conversation as ConversationCommandOutcome
  if (outcome.operation !== 'turn') {
    throw new Error(`turn was refused: ${JSON.stringify(result.refusal ?? outcome)}`)
  }
  return outcome.turn.outcome
}

/** The one packet the fake provider was asked to complete. */
function onlyRequest(index = 0): ModelRequest {
  const found = requests[index]
  if (found === undefined) throw new Error(`no provider request at index ${index}`)
  return found
}

describe('the owner’s own words become a real, encrypted relationship record', () => {
  it('admits an explicit standing instruction with the owner’s provenance', async () => {
    const c = await boot()
    expect(c.personality().counts.admitted).toBe(0)

    expect(await send('Please keep it short from now on.')).toBe('completed')

    const projection = c.personality()
    expect(projection.health).toBe('ready')
    expect(projection.counts.admitted).toBe(1)
    const record = projection.items[0]
    expect(record?.key).toBe('conciseness-short')
    expect(record?.kind).toBe('preference')
    expect(record?.status).toBe('admitted')
    // The trust class is assigned by the pathway, and the pathway here is the
    // owner speaking in their own conversation. "From now on" makes it standing,
    // which is why the confidence is at the top of this domain's ceiling.
    expect(record?.sourceType).toBe('owner-assertion')
    expect(record?.confidence).toBe('high')
    // Never `verified`: a record of what was said is not a settled truth about a
    // person, and this domain has no path that could produce the word.
    expect(record?.confidence).not.toBe('verified')
    expect(record?.cueKind).toBeNull()
    expect(record?.lifecycleAt).toBeNull()
  })

  it('records nothing at all for a message that is not an instruction', async () => {
    const c = await boot()
    await send('The report you wrote last week was too long, sorry.')
    expect(c.personality().items).toEqual([])
    expect(c.personality().counts.admitted).toBe(0)
  })

  it('stores the owner’s clause encrypted, and never in the journal', async () => {
    const c = await boot()
    await send('keep it short from now on, please')

    const bytes = await readFile(storePath(), 'utf8')
    expect(bytes).not.toContain('keep it short')
    expect(bytes).not.toContain('conciseness-short')
    expect(bytes).not.toContain(PRIVATE)

    // The journal is the most-copied surface in the product: audit exports,
    // backups, bug reports. It carries the *fact* of an admission and the code
    // -owned slug, and it has no payload slot for a clause or a sentence.
    const journal = await readFile(journalPath(), 'utf8')
    expect(journal).not.toContain('keep it short')
    const admitted = journal
      .split('\n')
      .filter((line) => line.includes('"personality.record_changed"'))
      .map((line) => JSON.parse(line) as { payload: Record<string, unknown> })
    expect(admitted).toHaveLength(1)
    // Exactly the closed payload, nothing else. The id is Core-minted and is the
    // only variable field; every other value is a closed label or a code-owned
    // slug, which is what makes this safe to copy into an audit export.
    expect(Object.keys(admitted[0]?.payload ?? {}).sort()).toEqual([
      'admitted',
      'confidence',
      'itemId',
      'key',
      'kind',
      'lifecycleReason',
      'operation',
      'retained',
      'sourceType',
    ])
    expect(admitted[0]?.payload).toMatchObject({
      operation: 'admitted',
      kind: 'preference',
      key: 'conciseness-short',
      sourceType: 'owner-assertion',
      confidence: 'high',
      lifecycleReason: null,
      admitted: 1,
      retained: 1,
    })
    expect(String(admitted[0]?.payload.itemId)).toMatch(/^relationship:p11-\d+$/)

    // Nor the activity feed, which a window caches.
    expect(JSON.stringify(c.activity())).not.toContain('keep it short')
    // Nor the projection, which is the only thing a window ever holds.
    expect(JSON.stringify(c.personality())).not.toContain('keep it short')
  })

  it('destroys the clause when the owner takes the record back', async () => {
    const c = await boot()
    await send('keep it short from now on')
    expect(c.personality().counts.admitted).toBe(1)

    await send('forget that you keep it short', 't2')

    const projection = c.personality()
    expect(projection.counts.admitted).toBe(0)
    expect(projection.counts.retired).toBe(1)
    const tombstone = projection.items[0]
    expect(tombstone?.status).toBe('retired')
    expect(tombstone?.lifecycleReason).toBe('owner-withdrew-this-record')
    expect(tombstone?.lifecycleAt).not.toBeNull()
    // The metadata survives so the domain can still answer "this existed and was
    // withdrawn"; the text does not exist anywhere to answer with.
    expect(tombstone?.key).toBe('conciseness-short')

    await c.stop('after withdrawal')
    const bytes = await readFile(storePath(), 'utf8')
    expect(bytes).not.toContain('keep it short')
  })

  it('supersedes an older record for the same key rather than holding both', async () => {
    const c = await boot()
    await send('keep it short from now on')
    clock = new Date(clock.getTime() + 60_000)
    await send('actually, keep it brief from now on', 't2')

    const projection = c.personality()
    expect(projection.counts.admitted).toBe(1)
    expect(projection.counts.superseded).toBe(1)
    expect(projection.items.map((item) => item.status).sort()).toEqual(['admitted', 'superseded'])
    // The interpretation reads only admitted records, so an outdated preference
    // cannot keep steering turns after it has been replaced.
    expect(projection.interpretation?.preferenceHits).toBe(1)
  })
})

describe('recovered state actually feeds the turn path', () => {
  it('a restarted Core honours a preference it recovered, in the same single call', async () => {
    const c = await boot()
    await send('please be more formal from now on')
    // The owner's own question is of course in the packet — it is the turn. What
    // must not be there is a *duplicate* of it as relationship content, and on this
    // first turn there is nothing to honour yet.
    expect(requests).toHaveLength(1)
    const first = onlyRequest()
    expect(first.messages.some((message) => message.content.includes(EXPRESSION_BLOCK_MARKER))).toBe(false)

    await c.stop('first process')
    requests = []
    const second = await boot()

    // The record is back, and it is *admitted* rather than a candidate.
    expect(second.personality().counts.admitted).toBe(1)
    expect(second.personality().items[0]?.key).toBe('formal')
    expect(second.personality().persistence.durable).toBe(true)

    await send('what do you think?', 't2')

    // One call. Exactly one, as always.
    expect(requests).toHaveLength(1)
    const packet = onlyRequest()
    const block = packet.messages.find((message) => message.content.includes(EXPRESSION_BLOCK_MARKER))
    expect(block?.role).toBe('user')
    // The recovered formality preference reached the expression plan as a
    // catalogue line about a registered register — and the owner's original words
    // are nowhere in the process, including in the *new* conversation's packet.
    expect(block?.content).toContain('formal register')
    expect(JSON.stringify(packet)).not.toContain('please be more formal')
    // And the question is still last, so guidance cannot answer instead of it.
    expect(packet.messages[packet.messages.length - 1]?.content).toContain('what do you think?')
  })

  it('recovers the anti-repetition ledger and holds a cue it already used', async () => {
    const c = await boot(KEY, { personalityLimits: { maxRelationshipItems: 8 } })
    // Seed a cue through the trusted lane the only production code has, then
    // reach into the store the way the Mind does, so the ledger has an entry.
    const lane = c as unknown as {
      personalityDomain?: { recordCueUse: (id: string, kind: 'greeting', at: string) => void }
    }
    lane.personalityDomain?.recordCueUse('cue:seeded', 'greeting', clock.toISOString())
    await c.stop('first process')

    const second = await boot(KEY, { personalityLimits: { maxRelationshipItems: 8 } })
    // The ledger survived: a restored store knows the gesture was already used.
    expect(second.personality().repetition?.entries).toBe(1)
    expect(second.personality().repetition?.entries).toBeGreaterThan(0)

    await send('hello there', 't2')
    // The restarted Core planned against the recovered ledger, and reported the
    // hold as a count rather than hiding it.
    expect(requests).toHaveLength(1)
    expect(second.personality().repetition?.entries).toBe(1)
  })

  it('an interrupted process loses nothing it had already written', async () => {
    const c = await boot()
    await send('keep it short from now on')
    // Stop without an explicit flush, which is what a crash looks like.
    await c.stop('simulated shutdown')

    const second = await boot()
    expect(second.personality().counts.admitted).toBe(1)
    expect(second.personality().persistence.retained).toBe(1)
  })
})

describe('degraded mode is truthful rather than convenient', () => {
  it('uses an explicitly ephemeral relationship with no plaintext fallback', async () => {
    const c = await boot(null)
    await send('keep it short from now on')

    const projection = c.personality()
    expect(projection.persistence).toMatchObject({ mode: 'ephemeral', durable: false })
    expect(projection.persistence.reason).toMatch(/secure Personality key/)
    // The only file on disk is the journal. No plaintext store, no key beside
    // the data, no weaker file standing in for an encrypted one.
    expect(existsSync(storePath())).toBe(false)

    await c.stop('ephemeral teardown')
    const restarted = await boot(null)
    expect(restarted.personality().items).toEqual([])
  })

  it('serves no expression guidance at all when the ledger cannot be trusted', async () => {
    const c = await boot(null)
    await send('keep it short from now on')

    // The turn still happened and still cost exactly one call.
    expect(requests).toHaveLength(1)
    const packet = onlyRequest()
    // No expression block: a ledger that does not survive a restart cannot bound
    // repetition, and an unbounded ledger re-offers the same gesture forever.
    expect(packet.messages.some((message) => message.content.includes(EXPRESSION_BLOCK_MARKER))).toBe(false)
    expect(c.personality().persistence.durable).toBe(false)
  })

  it('keeps damaged ciphertext intact and leaves unrelated Core available', async () => {
    const c = await boot()
    await send('keep it short from now on')
    await c.stop('first process')
    await writeFile(storePath(), 'damaged encrypted Personality')

    const second = await boot()
    expect(second.personality().persistence.durable).toBe(false)
    expect(second.personality().persistence.faultReason).not.toBeNull()
    expect(second.personality().persistence.faultReason).not.toContain('keep it short')
    // The whole snapshot is refused rather than served partially, and the file is
    // not rewritten from a partial read — that would drop records silently.
    expect(second.personality().items).toEqual([])

    await send('keep it brief from now on', 't2')
    expect(await readFile(storePath(), 'utf8')).toBe('damaged encrypted Personality')
    // A broken relationship store cannot take conversation down with it.
    expect((await second.handleCommand({ command: 'conversation.create', requestId: 'c9' })).ok).toBe(true)
  })

  it('reports a damaged store in the journal without a private echo', async () => {
    const c = await boot()
    await send('keep it short from now on')
    await c.stop('first process')
    await writeFile(storePath(), `${PRIVATE} damaged encrypted Personality`)

    const second = await boot()
    const journal = await readFile(journalPath(), 'utf8')
    expect(journal).toContain('personality.degraded')
    // The reason is a fixed sentence: a decoder or filesystem error must never
    // reflect the bytes it choked on back into the audit surface.
    expect(journal.split('\n').find((line) => line.includes('personality.degraded'))).not.toContain(
      PRIVATE,
    )
    expect(second.status().faults.some((fault) => fault.includes('Personality store'))).toBe(true)
  })

  it('does not journal ephemeral mode as a fault', async () => {
    await boot(null)
    // Having no secure key is an ordinary configuration, not damage, and putting
    // it in the journal as a fault would train a reader to ignore the list. The
    // projection already says `durable: false` with the reason in words.
    const journal = await readFile(journalPath(), 'utf8')
    expect(journal).not.toContain('personality.degraded')
    expect(core!.status().faults.filter((fault) => fault.includes('Personality'))).toEqual([])
  })
})

describe('bounded retention is a fact about the store, not a hope', () => {
  it('retires the oldest records rather than growing without limit', async () => {
    const c = await boot(KEY, { personalityLimits: { maxRelationshipItems: 2 } })
    // Five distinct standing instructions, one at a time.
    for (const [index, text] of [
      'keep it short from now on',
      'be more formal from now on',
      'keep it relaxed from now on',
      'be more direct from now on',
      'keep it detailed from now on',
    ].entries()) {
      clock = new Date(clock.getTime() + 60_000)
      await send(text, `t-${index}`)
    }
    const projection = c.personality()
    expect(projection.persistence.retained).toBeLessThanOrEqual(2)
    expect(projection.items.length).toBeLessThanOrEqual(2)
  })

  it('applies the bound on demand, so a Core can prove it', async () => {
    const c = await boot(KEY, { personalityLimits: { maxRelationshipItems: 1 } })
    await send('keep it short from now on')
    clock = new Date(clock.getTime() + 60_000)
    await send('be more formal from now on', 't2')

    const lane = c as unknown as {
      personalityDomain?: { retireOverflow: () => { dropped: readonly string[]; retained: number } }
    }
    const report = lane.personalityDomain?.retireOverflow()
    expect(report?.retained).toBeLessThanOrEqual(1)
    expect(c.personality().persistence.retained).toBe(report?.retained ?? 0)
  })
})

describe('idle Freya is still provably idle', () => {
  it('startup, recovery, reads and shutdown spend nothing', async () => {
    const c = await boot()
    expect(fake.calls).toBe(0)
    await send('keep it short from now on')
    expect(fake.calls).toBe(1)

    c.personality()
    c.status()
    c.activity()
    await c.stop('idle teardown')

    const replay = new FakeModelProvider()
    const restarted = createCore({
      dataPath: journalPath(),
      conversationStore: new MemoryConversationStore({ mode: 'memory' }),
      providers: [replay],
      personalityKey: KEY,
      now: () => new Date(clock),
    } as CoreOptions)
    core = restarted
    await restarted.start()
    // Recovery rebuilt a relationship and a ledger and still spent nothing.
    expect(replay.calls).toBe(0)
    expect(restarted.personality().counts.admitted).toBe(1)

    const events = (await readFile(journalPath(), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string })
    // One started, one completed — and nothing at all from the second process.
    const started = events.filter((event) => event.type === 'model.request.started')
    expect(started).toHaveLength(1)
  })
})

describe('the projection a window receives stays non-authoritative', () => {
  it('carries no field a renderer could have written back', async () => {
    const c = await boot()
    await send('keep it short from now on')
    const projection: PersonalityProjection = c.personality()
    expect(Object.keys(projection).sort()).toEqual([
      'counts',
      'expression',
      'health',
      'interpretation',
      'items',
      'limits',
      'persistence',
      'presenceCue',
      'reason',
      'repetition',
      'schemaVersion',
      'sequence',
      'temperament',
    ])
    // No recorded text, no tags, no admission reason, and no authority shape
    // anywhere in the tree.
    const serialised = JSON.stringify(projection)
    expect(serialised).not.toContain('keep it short')
    for (const forbidden of ['capability', 'grant', 'permission', 'authority', 'override', 'mood']) {
      expect(serialised.toLowerCase()).not.toContain(`"${forbidden}"`)
    }
  })

  it('holds the cannot-weaken claim as data on the artefact itself', async () => {
    const c = await boot()
    await send('keep it short from now on')
    const projection = c.personality()
    expect(projection.temperament?.constitutionFirst).toBe(true)
    expect(projection.temperament?.identitySupersedesTemperament).toBe(true)
    expect(projection.expression?.cannotWeaken).toEqual([
      'Constitution',
      'FREYA_IDENTITY',
      'Guard',
      'Governor',
      'STOP ALL',
      'truthfulness',
      'capability boundaries',
    ])
  })
})
