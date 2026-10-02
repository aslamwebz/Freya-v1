// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { EventFabric } from '../../core/events/fabric'
import type { EventStore } from '../../core/events/store'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { ModelGateway, type GatewayRecorder } from '../../core/model/gateway'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { ModelMessage } from '../../core/model/provider'
import { MindService } from '../../core/mind/mind'
import type { ExpressionMemory } from '../../core/mind/expression'
import type { CueUsageLedger, InteractionFact, RelationshipItem } from '../../core/personality/types'
import { admitRelationshipItem, createRelationshipCandidate } from '../../core/personality/relationship'
import type { CognitionIntent, OwnerAuthority } from '../../core/authority'
import type { CognitionOutcome } from '../../core/cognition/service'
import type { CognitionGrant, CognitionGrantSpec } from '../../core/cognition/grants'

const CONVERSATION_ID = 'c1'
const T0 = new Date('2026-06-01T09:00:00.000Z')

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event: AnyCoreEvent) => { events.push(event) },
    readAll: async () => [...events],
    readAfter: async (afterSequence: number) => events.filter((e) => e.sequence > afterSequence),
    lastSequence: async () => events[events.length - 1]?.sequence ?? 0,
    describe: () => 'memory',
    close: async () => undefined,
  }
}

const silentRecorder: GatewayRecorder = {
  started: async () => undefined,
  completed: async () => undefined,
  failed: async () => undefined,
  cancelled: async () => undefined,
}

interface Recorded {
  readonly prompt: string
  readonly messages: readonly ModelMessage[]
}

interface RecordingAuthority extends OwnerAuthority {
  readonly recorded: readonly Recorded[]
}

/** What the authority answers for a turn. Lets a test choose the outcome. */
type OutcomeFor = (intent: CognitionIntent) => CognitionOutcome

const ALLOWED: OutcomeFor = (intent) => ({
  status: 'allowed',
  requestId: intent.cognitionRequestId ?? 'r-stub',
  text: 'an answer',
  providerId: 'stub',
  model: 'stub',
})

function recordingAuthority(outcome: OutcomeFor = ALLOWED): RecordingAuthority {
  const recorded: Recorded[] = []
  return {
    principalId: 'owner',
    createGrant: async (_spec: CognitionGrantSpec) => undefined,
    revokeGrant: async () => false,
    grants: () => [] as readonly CognitionGrant[],
    request: async (intent: CognitionIntent): Promise<CognitionOutcome> => {
      recorded.push({ prompt: intent.prompt, messages: intent.messages ?? [] })
      return outcome(intent)
    },
    recorded,
  }
}

interface CountingMemory extends ExpressionMemory {
  readonly ledgerReads: number
  readonly cueWrites: readonly { cueId: string; kind: string; at: string }[]
}

/** A working seam that counts its reads and writes. */
function countingMemory(ledger: CueUsageLedger | null = null): CountingMemory {
  let ledgerReads = 0
  const cueWrites: { cueId: string; kind: string; at: string }[] = []
  return {
    readLedger: () => { ledgerReads += 1; return ledger },
    recordCueUse: (cueId: string, kind: string, at: string) => { cueWrites.push({ cueId, kind, at }) },
    get ledgerReads() { return ledgerReads },
    get cueWrites() { return [...cueWrites] },
  }
}

interface Fixture {
  readonly mind: MindService
  readonly authority: RecordingAuthority
  readonly provider: FakeModelProvider
}

async function buildMind(options: {
  /** `null` means no seam is wired at all; otherwise the exact seam to inject. */
  memory?: ExpressionMemory | null
  facts?: readonly InteractionFact[]
  relationship?: readonly RelationshipItem[]
  outcome?: OutcomeFor
} = {}): Promise<Fixture> {
  const now = T0.getTime()
  const fabric = await EventFabric.open({
    store: memoryEventStore(),
    now: () => new Date(now),
    newId: (() => { let n = 0; return () => `evt-${(n += 1).toString().padStart(4, '0')}` })(),
  })
  const conversations = new MemoryConversationStore({ mode: 'memory' })
  await conversations.putConversation({
    conversationId: CONVERSATION_ID,
    title: 'a conversation',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  })

  const authority = recordingAuthority(options.outcome)
  const provider = new FakeModelProvider()
  const mind = new MindService({
    fabric,
    store: conversations,
    authority,
    gateway: new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => new Date(now) }),
    now: () => new Date(now),
    newId: (() => { let n = 0; return () => `id-${(n += 1).toString().padStart(4, '0')}` })(),
    ...(options.memory === null ? {} : { expressionMemory: options.memory ?? countingMemory() }),
    interactionFacts: () => options.facts ?? [],
    relationshipItems: () => options.relationship ?? [],
  })

  return { mind, authority, provider }
}

interface Harness extends Fixture {
  readonly expressionMemory: CountingMemory
}

async function harness(options?: {
  facts?: readonly InteractionFact[]
  relationship?: readonly RelationshipItem[]
  ledger?: CueUsageLedger | null
  outcome?: OutcomeFor
}): Promise<Harness> {
  const { ledger, ...rest } = options ?? {}
  const expressionMemory = countingMemory(ledger ?? null)
  const fixture = await buildMind({ ...rest, memory: expressionMemory })
  return { ...fixture, expressionMemory }
}

function systemText(messages: readonly ModelMessage[]): string {
  return messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
}

function expressionBlockOf(messages: readonly ModelMessage[]): ModelMessage | undefined {
  return messages.find((m) => m.content.includes('personality & expression guidance'))
}

function admittedItem(overrides: Partial<Parameters<typeof createRelationshipCandidate>[0]> = {}): RelationshipItem {
  const result = createRelationshipCandidate({
    itemId: 'item-1',
    kind: 'preference',
    key: 'formality-relaxed',
    text: 'the owner prefers a relaxed register',
    tags: ['formality'],
    cueKind: null,
    source: 'owner-assertion',
    sourceRef: null,
    observedAt: T0.toISOString(),
    recordedAt: T0.toISOString(),
    proposedConfidence: 'high',
    actor: 'owner',
    ...overrides,
  })
  if (!result.ok) throw new Error(result.reason)
  const admitted = admitRelationshipItem(result.item, { now: T0.toISOString(), reason: 'owner reviewed and admitted the record' })
  if (!admitted.ok) throw new Error(admitted.reason)
  return admitted.item
}

const GREETING_FACT: InteractionFact = {
  factId: 'f1',
  kind: 'greeting-received',
  observedAt: T0.toISOString(),
  sourceRef: 'turn-1',
  tags: ['greeting'],
}

describe('expression planning reaches the packet on a real turn', () => {
  it('splices a bounded expression block in immediately before the question', async () => {
    const item = admittedItem()
    const { mind, authority } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    const turn = await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello there' })
    expect(turn.outcome).toBe('completed')

    const messages = authority.recorded[0]?.messages ?? []
    expect(messages.length).toBeGreaterThanOrEqual(3)
    expect(messages[0]?.role).toBe('system')
    const block = expressionBlockOf(messages)
    expect(block).toBeDefined()
    expect(block?.role).toBe('user')
    const blockIndex = messages.indexOf(block!)
    const questionIndex = messages.findIndex((m) => m.content === 'hello there')
    expect(blockIndex).toBeGreaterThan(-1)
    expect(questionIndex).toBeGreaterThan(blockIndex)
    expect(messages.at(-1)?.content).toBe('hello there')
  })

  it('produces no expression block when there is no signal', async () => {
    const { mind, authority } = await harness()

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    const messages = authority.recorded[0]?.messages ?? []

    expect(expressionBlockOf(messages)).toBeUndefined()
    expect(messages.length).toBe(2)
    expect(systemText(messages)).toContain('You are Freya')
  })

  it('keeps the expression block out of the system message', async () => {
    const item = admittedItem()
    const { mind, authority } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    const messages = authority.recorded[0]?.messages ?? []

    const system = systemText(messages)
    expect(system).toContain('You are Freya')
    expect(system).not.toContain('personality & expression guidance')
    expect(system).not.toContain('Style guidance only')
  })

  it('flattens the expression block into the prompt as well', async () => {
    const item = admittedItem()
    const { mind, authority } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    const recorded = authority.recorded[0]
    expect(recorded?.prompt).toContain('personality & expression guidance')
    expect(recorded?.prompt).toContain('hello')
  })
})

describe('expression planning costs exactly one provider call', () => {
  it('makes exactly one provider call per turn with expression planning', async () => {
    const item = admittedItem()
    const { mind, authority } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(authority.recorded.length).toBe(1)

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't2', text: 'again' })
    expect(authority.recorded.length).toBe(2)
  })

  it('reads the ledger once per turn and never while idle', async () => {
    const item = admittedItem()
    const { mind, expressionMemory } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    expect(expressionMemory.ledgerReads).toBe(0)

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(expressionMemory.ledgerReads).toBe(1)

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't2', text: 'again' })
    expect(expressionMemory.ledgerReads).toBe(2)
  })
})

describe('anti-repetition records cue use', () => {
  it('records cue use for offered cues after the turn', async () => {
    const item = admittedItem({ kind: 'inside-joke', key: 'shared-joke', cueKind: 'inside-joke' })
    const { mind, expressionMemory } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(expressionMemory.cueWrites.length).toBeGreaterThan(0)
    expect(expressionMemory.cueWrites[0]?.cueId).toBe('cue:item-1')
    expect(expressionMemory.cueWrites[0]?.kind).toBe('inside-joke')
  })

  it('records no cue use when no cues are offered', async () => {
    const item = admittedItem()
    const { mind, expressionMemory } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(expressionMemory.cueWrites).toHaveLength(0)
  })
})

function brokenMemory(): ExpressionMemory & { readonly reads: number; readonly writes: number } {
  let reads = 0
  let writes = 0
  return {
    readLedger: () => { reads += 1; throw new Error('expression memory is on fire') },
    recordCueUse: () => { writes += 1; throw new Error('expression memory is on fire') },
    get reads() { return reads },
    get writes() { return writes },
  }
}

describe('no usable expression memory means no personality expression', () => {
  it('emits no block and records no cue use when the memory throws', async () => {
    const item = admittedItem({ kind: 'inside-joke', key: 'shared-joke', cueKind: 'inside-joke' })
    const memory = brokenMemory()
    const { mind, authority } = await buildMind({ memory, facts: [GREETING_FACT], relationship: [item] })

    const turn = await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(turn.outcome).toBe('completed')

    const messages = authority.recorded[0]?.messages ?? []
    // A seam that cannot be read is not treated as an empty ledger: there is no
    // expression block at all, and the packet is exactly system + question.
    expect(messages).toHaveLength(2)
    expect(expressionBlockOf(messages)).toBeUndefined()
    // It was probed once to discover the fault, and never written.
    expect(memory.reads).toBe(1)
    expect(memory.writes).toBe(0)
  })

  it('emits no block and performs no cue I/O when no seam is wired at all', async () => {
    const item = admittedItem({ kind: 'inside-joke', key: 'shared-joke', cueKind: 'inside-joke' })
    const { mind, authority } = await buildMind({ memory: null, facts: [GREETING_FACT], relationship: [item] })

    const turn = await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(turn.outcome).toBe('completed')

    const messages = authority.recorded[0]?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(expressionBlockOf(messages)).toBeUndefined()
  })
})

describe('cue use is gated on a provider actually being reached', () => {
  it('does not record cue use when the Governor denies the request', async () => {
    const item = admittedItem({ kind: 'inside-joke', key: 'shared-joke', cueKind: 'inside-joke' })
    const { mind, expressionMemory, authority } = await harness({
      relationship: [item],
      facts: [GREETING_FACT],
      outcome: (intent) => ({
        status: 'denied',
        requestId: intent.cognitionRequestId ?? 'r',
        reason: 'the Governor refused',
      }),
    })

    const turn = await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(turn.outcome).toBe('denied')
    // The request reached the authority but never a provider, so no cue was spent.
    expect(authority.recorded.length).toBe(1)
    expect(expressionMemory.cueWrites).toHaveLength(0)
  })

  it('does not record cue use when the turn is cancelled before contact', async () => {
    const item = admittedItem({ kind: 'inside-joke', key: 'shared-joke', cueKind: 'inside-joke' })
    const { mind, expressionMemory } = await harness({
      relationship: [item],
      facts: [GREETING_FACT],
      outcome: (intent) => ({
        status: 'cancelled',
        requestId: intent.cognitionRequestId ?? 'r',
        reason: 'stopped before contact',
        providerContacted: false,
      }),
    })

    const turn = await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(turn.outcome).toBe('cancelled')
    expect(expressionMemory.cueWrites).toHaveLength(0)
  })

  it('records cue use when a provider was contacted and then failed', async () => {
    const item = admittedItem({ kind: 'inside-joke', key: 'shared-joke', cueKind: 'inside-joke' })
    const { mind, expressionMemory } = await harness({
      relationship: [item],
      facts: [GREETING_FACT],
      outcome: (intent) => ({
        status: 'failed',
        requestId: intent.cognitionRequestId ?? 'r',
        reason: 'provider blew up',
        providerContacted: true,
      }),
    })

    const turn = await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(turn.outcome).toBe('failed')
    // A provider had the request, so the gesture was spent even though it failed.
    expect(expressionMemory.cueWrites.length).toBeGreaterThan(0)
  })
})

describe('expression planning preserves authority boundaries', () => {
  it('produces a plan that cannot weaken safety', async () => {
    const item = admittedItem()
    const { mind, authority } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    const messages = authority.recorded[0]?.messages ?? []
    const block = expressionBlockOf(messages)
    expect(block).toBeDefined()
    expect(block?.content).toContain('cannot weaken')
    expect(block?.content).toContain('Constitution')
    expect(block?.content).toContain('STOP ALL')
  })

  it('does not add a second provider call for expression planning', async () => {
    const item = admittedItem()
    const { mind, authority } = await harness({ relationship: [item], facts: [GREETING_FACT] })

    await mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })
    expect(authority.recorded.length).toBe(1)
  })
})
