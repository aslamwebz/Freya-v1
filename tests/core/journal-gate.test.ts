// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { repairInterruptedTurnConversationId } from '../../core/events/interrupted-turn-repair'
import type { AnyCoreEvent } from '../../core/events/envelope'

/**
 * Gate tests for `restoreKnownLegacyQuarantine`.
 *
 * A verified repair must reconcile both branches rather than overwrite the
 * active authority history. Real requests and every Guard denial stay present.
 *
 * These tests construct a realistic corrupted journal: a trusted prefix,
 * the integrity_fault event, post-fault events of varying shapes, and
 * a quarantine file whose only defect is the empty-conversationId row at
 * line trustedPrefixEvents+1. After the repair succeeds end-to-end and
 * the prefix matches, the gate is exercised.
 */

const TURN_ID = '9dced7e3-b003-4fcb-bbfa-5b8c83e48ba8'
const CONVERSATION_ID = '39bc8562-b545-4f2a-b30e-452d4b74ab9a'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-gate-'))
  file = join(dir, 'nested', 'events.jsonl')
  await mkdir(join(dir, 'nested'), { recursive: true })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

let counter = 0
function evt(seq: number, type: string, overrides: Partial<AnyCoreEvent> = {}): AnyCoreEvent {
  counter += 1
  return {
    eventId: `evt-${counter}-${type.replace(/\./g, '-')}`,
    sequence: seq,
    type,
    schemaVersion: 1,
    occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(),
    source: 'core',
    actor: type === 'guard.decision' || type === 'cognition.requested' ? 'owner' : 'system',
    correlationId: `corr-${counter}-${type}`,
    causationId: null,
    payload: {},
    ...overrides,
  } as AnyCoreEvent
}

function conversationTurnStarted(seq: number): AnyCoreEvent {
  return evt(seq, 'conversation.turn.started', {
    payload: {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
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

function conversationTurnInterruptedEmpty(seq: number): AnyCoreEvent {
  return evt(seq, 'conversation.turn.interrupted', {
    payload: {
      conversationId: '',
      turnId: TURN_ID,
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

function guardDenyJournalNotTrustworthy(seq: number): AnyCoreEvent {
  return evt(seq, 'guard.decision', {
    payload: { outcome: 'deny', reason: 'journal-not-trustworthy', capability: 'cognition.request', principal: 'owner' },
  })
}

function guardDenyOther(seq: number, reason: string): AnyCoreEvent {
  return evt(seq, 'guard.decision', {
    payload: { outcome: 'deny', reason, capability: 'cognition.request', principal: 'owner' },
  })
}

function integrityFault(seq: number, quarantinePath: string): AnyCoreEvent {
  return evt(seq, 'core.integrity_fault', {
    payload: {
      reason:
        'The event log is corrupt: line 4 is a complete event that does not validate (payload does not match the shape of conversation.turn.interrupted). 3 event(s) before it were read; everything from that line onward was discarded, so the security state derived from this log is incomplete. Cognition is refused until the log is repaired or removed.',
      line: 4,
      quarantinePath,
      trustedPrefixEvents: 3,
      trustedPrefixBytes: 100,
      damagedBytes: 50,
    },
  })
}

function coreStarted(seq: number): AnyCoreEvent {
  return evt(seq, 'core.started', { payload: { version: '0.1.0', storeKind: 'jsonl:test', recoveredSequence: 0 } })
}
function coreReady(seq: number): AnyCoreEvent {
  return evt(seq, 'core.ready', { payload: {} })
}
function coreDegraded(seq: number): AnyCoreEvent {
  return evt(seq, 'core.degraded', { payload: { reason: 'the event journal was found corrupt; see the preceding integrity fault' } })
}
function coreStopping(seq: number): AnyCoreEvent {
  return evt(seq, 'core.stopping', { payload: { reason: 'shutdown' } })
}
function coreStopped(seq: number): AnyCoreEvent {
  return evt(seq, 'core.stopped', { payload: { durationMs: 1 } })
}
function voiceStopped(seq: number): AnyCoreEvent {
  return evt(seq, 'voice.stopped', { payload: { scope: 'all', reason: 'shutdown' } })
}

function cognitionRequested(seq: number): AnyCoreEvent {
  // Constructed directly to avoid the discriminated-union inference picking
  // the wrong payload shape inside the generic helper.
  counter += 1
  return {
    eventId: `evt-${counter}-cognition-requested`,
    sequence: seq,
    type: 'cognition.requested',
    schemaVersion: 1,
    occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(),
    source: 'core',
    actor: 'owner',
    correlationId: `corr-${counter}-cognition-requested`,
    causationId: null,
    payload: {
      requestId: `req-${seq}-0000000000000000`,
      origin: 'user',
      cause: 'user_message',
      maxOutputTokens: 1024,
      requestedModel: null,
      parentRunId: null,
      goalId: null,
    },
  }
}

function joinLines(events: readonly AnyCoreEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

function buildRepairableQuarantine(): string {
  return joinLines([
    coreStarted(1),
    coreReady(2),
    conversationTurnStarted(3),
    conversationTurnInterruptedEmpty(4),
  ])
}

describe('restoreKnownLegacyQuarantine — post-fault authority gate', () => {
  it('restores when the only post-fault authority events are fail-closed guard.decision deny journal-not-trustworthy', async () => {
    const quarantine = buildRepairableQuarantine()
    const repair = repairInterruptedTurnConversationId(quarantine)
    expect(repair).not.toBeNull()

    const quarantinePath = join(dir, 'events.jsonl.quarantine')
    await writeFile(quarantinePath, quarantine, 'utf8')

    const trustedPrefix = repair!.events.slice(0, 3)
    const fault = integrityFault(4, quarantinePath)
    const post: AnyCoreEvent[] = [
      coreStarted(5),
      coreDegraded(6),
      guardDenyJournalNotTrustworthy(7),
      coreStopping(8),
      voiceStopped(9),
      coreStopped(10),
    ]
    await writeFile(file, joinLines([...trustedPrefix, fault, ...post]), 'utf8')

    const store = await JsonlEventStore.open(file)
    const report = store.knownRepairReport()
    expect(report).not.toBeNull()
    expect(report!.code).toBe('interrupted-conversation-id-recovery')
    expect(report!.repairedEvents).toBe(1)

    const after = await readFile(file, 'utf8')
    expect(after).toContain(JSON.stringify(CONVERSATION_ID))
    await store.close()
  })

  it('retains a real post-fault cognition request when reconciling the repair', async () => {
    const quarantine = buildRepairableQuarantine()
    const repair = repairInterruptedTurnConversationId(quarantine)
    expect(repair).not.toBeNull()

    const quarantinePath = join(dir, 'events.jsonl.quarantine')
    await writeFile(quarantinePath, quarantine, 'utf8')

    const trustedPrefix = repair!.events.slice(0, 3)
    const fault = integrityFault(4, quarantinePath)
    const post: AnyCoreEvent[] = [
      coreStarted(5),
      coreDegraded(6),
      cognitionRequested(7),
      guardDenyJournalNotTrustworthy(8),
      coreStopping(9),
      coreStopped(10),
    ]
    await writeFile(file, joinLines([...trustedPrefix, fault, ...post]), 'utf8')

    const store = await JsonlEventStore.open(file)
    expect(store.knownRepairReport()).not.toBeNull()
    const recovered = await store.readAll()
    expect(recovered.find(e => e.eventId === post[2]!.eventId)?.payload).toEqual(post[2]!.payload)
    await store.close()
  })

  it('retains independent Guard refusals when reconciling the repair', async () => {
    const quarantine = buildRepairableQuarantine()
    const repair = repairInterruptedTurnConversationId(quarantine)
    expect(repair).not.toBeNull()

    const quarantinePath = join(dir, 'events.jsonl.quarantine')
    await writeFile(quarantinePath, quarantine, 'utf8')

    const trustedPrefix = repair!.events.slice(0, 3)
    const fault = integrityFault(4, quarantinePath)
    const post: AnyCoreEvent[] = [
      coreStarted(5),
      guardDenyOther(6, 'policy: blocked by owner setting'),
      coreStopping(7),
      coreStopped(8),
    ]
    await writeFile(file, joinLines([...trustedPrefix, fault, ...post]), 'utf8')

    const store = await JsonlEventStore.open(file)
    expect(store.knownRepairReport()).not.toBeNull()
    const recovered = await store.readAll()
    expect(recovered.find(e => e.eventId === post[1]!.eventId)?.payload).toEqual(post[1]!.payload)
    await store.close()
  })
})
