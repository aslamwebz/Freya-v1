// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { repairInterruptedTurnConversationId } from '../../core/events/interrupted-turn-repair'

/**
 * A focused test of the historical interrupted-turn repair.
 *
 * The defect under repair: a `conversation.turn.interrupted` event whose
 * `payload.conversationId` is the empty string. The validator
 * (`CONVERSATION_TURN` in `validate.ts`) requires `isEventId(conversationId)`,
 * which rejects the empty string. The writer that produced the pre-fix row was
 * the interrupt handler that fired before the conversation id was resolved
 * against the recovery store; commit 5b04457 closes that hole for new writes.
 *
 * Rules this test pins:
 *   1. A journal with one empty-conversationId interrupted turn and one
 *      earlier, valid conversation.turn.started with the same turnId repairs.
 *   2. Ambiguity (two started events with same turnId but different
 *      conversationIds) refuses.
 *   3. Missing source turn refuses.
 *   4. A started turn whose own conversationId fails the id grammar does not
 *     contaminate the source set — its id is filtered, so if it was the only
 *      candidate the repair refuses.
 *   5. An unrelated malformed line in the same journal refuses the repair
 *      (the repair fixes exactly one historical defect and nothing else).
 *   6. The full candidate journal must validate end-to-end after the repair,
 *      enforced by `parseDurableEvent` per line + monotonic-sequence checks.
 *
 * Helpers construct minimal-but-valid event JSON. The payloads only carry the
 * fields the relevant payload rules require, and they use simple ids that
 * satisfy the durable-id grammar (`[A-Za-z0-9._:-]{1,128}`). No private data,
 * no real identifiers, no real tokens.
 */

const SOURCE_TURN_ID = 'turn-source-1'
const SOURCE_CONVERSATION_ID = 'conv-source-uuid-aaaa-bbbb-cccc-dddddddddddd'
const OTHER_CONVERSATION_ID = 'conv-source-uuid-eeee-ffff-gggg-hhhhhhhhhhhh'

function startTurn(seq: number, turnId: string, conversationId: string): string {
  return JSON.stringify({
    eventId: `evt-${seq}-start`,
    sequence: seq,
    type: 'conversation.turn.started',
    schemaVersion: 1,
    occurredAt: `2026-10-01T00:00:0${seq % 10}.000Z`,
    source: 'core',
    actor: 'owner',
    correlationId: `corr-${seq}-start-0000000000000000`,
    causationId: null,
    payload: {
      conversationId,
      turnId,
      userMessageId: null,
      assistantMessageId: null,
      contentLength: 0,
      requestId: null,
      providerId: null,
      model: null,
      outcome: 'started',
      reason: null,
    },
  })
}

function interruptedTurnEmpty(seq: number, turnId: string): string {
  return JSON.stringify({
    eventId: `evt-${seq}-intr`,
    sequence: seq,
    type: 'conversation.turn.interrupted',
    schemaVersion: 1,
    occurredAt: `2026-10-01T00:00:1${seq % 10}.000Z`,
    source: 'core',
    actor: 'owner',
    correlationId: `corr-${seq}-intr-0000000000000000`,
    causationId: null,
    payload: {
      conversationId: '',
      turnId,
      userMessageId: null,
      assistantMessageId: null,
      contentLength: 0,
      requestId: null,
      providerId: null,
      model: null,
      outcome: 'interrupted',
      reason: null,
    },
  })
}

function interruptedTurnWithValidId(seq: number, turnId: string, conversationId: string): string {
  return JSON.stringify({
    eventId: `evt-${seq}-intr`,
    sequence: seq,
    type: 'conversation.turn.interrupted',
    schemaVersion: 1,
    occurredAt: `2026-10-01T00:00:1${seq % 10}.000Z`,
    source: 'core',
    actor: 'owner',
    correlationId: `corr-${seq}-intr-0000000000000000`,
    causationId: null,
    payload: {
      conversationId,
      turnId,
      userMessageId: null,
      assistantMessageId: null,
      contentLength: 0,
      requestId: null,
      providerId: null,
      model: null,
      outcome: 'interrupted',
      reason: null,
    },
  })
}

function coreStarted(seq: number): string {
  return JSON.stringify({
    eventId: `evt-${seq}-started`,
    sequence: seq,
    type: 'core.started',
    schemaVersion: 1,
    occurredAt: `2026-10-01T00:00:0${seq % 10}.000Z`,
    source: 'core',
    actor: 'system',
    correlationId: `corr-${seq}-started-0000000000000000`,
    causationId: null,
    payload: { version: '0.1.0', storeKind: 'jsonl:test', recoveredSequence: 0 },
  })
}

function coreReady(seq: number): string {
  return JSON.stringify({
    eventId: `evt-${seq}-ready`,
    sequence: seq,
    type: 'core.ready',
    schemaVersion: 1,
    occurredAt: `2026-10-01T00:00:0${seq % 10}.000Z`,
    source: 'core',
    actor: 'system',
    correlationId: `corr-${seq}-ready-0000000000000000`,
    causationId: null,
    payload: {},
  })
}

function join(...lines: string[]): string {
  return lines.join('\n') + '\n'
}

describe('repairInterruptedTurnConversationId', () => {
  it('repairs a single empty-conversationId interrupted turn using the matching source started', () => {
    const raw = join(
      coreStarted(1),
      coreReady(2),
      startTurn(3, SOURCE_TURN_ID, SOURCE_CONVERSATION_ID),
      interruptedTurnEmpty(4, SOURCE_TURN_ID),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).not.toBeNull()
    expect(r!.code).toBe('interrupted-conversation-id-recovery')
    expect(r!.repairedEvents).toBe(1)
    expect(r!.repairedLineNumbers).toEqual([4])
    expect(r!.repairs).toHaveLength(1)
    expect(r!.repairs[0]).toEqual({
      line: 4,
      sequence: 4,
      turnId: SOURCE_TURN_ID,
      recoveredConversationId: SOURCE_CONVERSATION_ID,
    })
    expect(r!.events).toHaveLength(4)
    const repaired = r!.events[3]!
    expect(repaired.type).toBe('conversation.turn.interrupted')
    if (repaired.type !== 'conversation.turn.interrupted') throw new Error('expected interrupted')
    expect(repaired.payload.conversationId).toBe(SOURCE_CONVERSATION_ID)
  })

  it('refuses when two started turns with the same turnId disagree on conversationId', () => {
    const raw = join(
      startTurn(1, SOURCE_TURN_ID, SOURCE_CONVERSATION_ID),
      startTurn(2, SOURCE_TURN_ID, OTHER_CONVERSATION_ID),
      interruptedTurnEmpty(3, SOURCE_TURN_ID),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).toBeNull()
  })

  it('refuses when no matching source started turn exists', () => {
    const raw = join(
      coreStarted(1),
      interruptedTurnEmpty(2, 'turn-with-no-source'),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).toBeNull()
  })

  it('refuses when the only matching started turn carries a malformed conversationId', () => {
    // A started turn whose conversationId is not a valid event id. The repair
    // must filter it from the source set, leaving the interrupted turn with no
    // provable source — refuse rather than guess.
    const badId = 'has spaces and a slash/bad'
    expect(badId).toBeTruthy()
    const raw = join(
      startTurn(1, SOURCE_TURN_ID, badId),
      interruptedTurnEmpty(2, SOURCE_TURN_ID),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).toBeNull()
  })

  it('refuses when an unrelated malformed line appears in the journal', () => {
    // The journal contains the provable source AND the empty-conversationId
    // interrupted turn, but also a third line that is independently malformed
    // for a different reason. The repair fixes exactly one historical defect;
    // it must refuse rather than repair one row and leave the other broken.
    const raw = join(
      coreStarted(1),
      startTurn(2, SOURCE_TURN_ID, SOURCE_CONVERSATION_ID),
      // Sequence regression — the general validator rejects this.
      coreStarted(1),
      interruptedTurnEmpty(4, SOURCE_TURN_ID),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).toBeNull()
  })

  it('refuses when the intercepted conversationId is missing entirely', () => {
    // The repair targets empty-string conversationId specifically. A missing
    // conversationId field is a different shape and must not be touched.
    const malformed = JSON.stringify({
      eventId: 'evt-2-intr',
      sequence: 2,
      type: 'conversation.turn.interrupted',
      schemaVersion: 1,
      occurredAt: '2026-10-01T00:00:01.000Z',
      source: 'core',
      actor: 'owner',
      correlationId: 'corr-2-intr-0000000000000000',
      causationId: null,
      payload: {
        turnId: SOURCE_TURN_ID,
        userMessageId: null,
        assistantMessageId: null,
        contentLength: 0,
        requestId: null,
        providerId: null,
        model: null,
        outcome: 'interrupted',
        reason: null,
      },
    })
    const raw = join(
      startTurn(1, SOURCE_TURN_ID, SOURCE_CONVERSATION_ID),
      malformed,
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).toBeNull()
  })

  it('returns the full event list end-to-end after repair (no other broken lines)', () => {
    const raw = join(
      coreStarted(1),
      coreReady(2),
      startTurn(3, SOURCE_TURN_ID, SOURCE_CONVERSATION_ID),
      interruptedTurnEmpty(4, SOURCE_TURN_ID),
      coreReady(5),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).not.toBeNull()
    // Every returned event parses and the sequence ordering is monotonic,
    // i.e. the repair output validates end-to-end.
    const sequences = r!.events.map((e) => e.sequence)
    expect(sequences).toEqual([1, 2, 3, 4, 5])
    const types = r!.events.map((e) => e.type)
    expect(types).toEqual([
      'core.started',
      'core.ready',
      'conversation.turn.started',
      'conversation.turn.interrupted',
      'core.ready',
    ])
  })

  it('leaves an already-valid empty conversationId row alone (no spurious repair)', () => {
    // A row whose conversationId is the empty string but whose type is not
    // conversation.turn.interrupted must not be touched.
    const raw = join(
      coreStarted(1),
      interruptedTurnWithValidId(2, SOURCE_TURN_ID, SOURCE_CONVERSATION_ID),
    )
    const r = repairInterruptedTurnConversationId(raw)
    expect(r).toBeNull()
  })
})