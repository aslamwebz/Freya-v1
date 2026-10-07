import { parseDurableEvent, isEventId } from './validate'
import type { AnyCoreEvent } from './envelope'

export const INTERRUPTED_TURN_CONVERSATION_ID_REPAIR =
  'interrupted-conversation-id-recovery' as const

export interface InterruptedTurnRepairLine {
  readonly line: number
  readonly sequence: number
  readonly turnId: string
  readonly recoveredConversationId: string
}

export interface InterruptedTurnRepair {
  readonly code: typeof INTERRUPTED_TURN_CONVERSATION_ID_REPAIR
  readonly content: string
  readonly repairedEvents: number
  readonly repairedLineNumbers: readonly number[]
  readonly repairs: readonly InterruptedTurnRepairLine[]
  readonly events: readonly AnyCoreEvent[]
}

/**
 * Repair exactly one historical Freya defect: an interrupted turn record that
 * was journaled with an empty `conversationId`. The writer that produced this
 * shape was the interrupt handler that fired before the conversation id was
 * resolved against the recovery store (commit 5b04457 closes that hole, but the
 * pre-fix row is still in production journals).
 *
 * The repair is intentionally narrow:
 *
 *   - Only `conversation.turn.interrupted` events with an empty-string
 *     `conversationId` are touched. Any other line that fails validation is
 *     left alone, and the whole repair refuses on it.
 *   - The recovered id must come from an earlier valid
 *     `conversation.turn.started` in the same journal with the exact same
 *     `turnId`. That is the only allowed source — the interrupted turn was
 *     written for the same conversation that the started turn opened, and a
 *     different conversation id would mean someone changed conversations mid-
 *     turn, which the schema does not allow.
 *   - The recovered id must pass the same durable-id validator the rest of
 *     the journal uses. A source start that itself fails validation is
 *     treated as if no source existed.
 *   - An ambiguous source — two or more trusted starts with the same turnId
 *     but disagreeing conversationIds — refuses. All agreeing sources are fine
 *     because the answer is the same.
 *   - The whole candidate journal must validate end-to-end after the
 *     substitutions, the same constraint every other repair bears. A repair
 *     that fixes one row but breaks another is not a repair.
 *
 * Returns `null` when nothing can be repaired, including the case where the
 * journal has no qualifying lines.
 */
export function repairInterruptedTurnConversationId(
  raw: string,
): InterruptedTurnRepair | null {
  if (raw.length === 0 || !raw.endsWith('\n')) return null

  const sourceLines = raw.slice(0, -1).split('\n')
  if (sourceLines.length === 0) return null

  const outputLines: string[] = []
  const events: AnyCoreEvent[] = []
  const repairs: InterruptedTurnRepairLine[] = []
  const repairedLineNumbers: number[] = []

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? ''
    const parsed = parseDurableEvent(line, 0)
    const previous = events.length === 0 ? 0 : events[events.length - 1]!.sequence

    if (parsed.ok) {
      // Trust the validated event — but make sure the sequence is monotonic
      // with what we have already accepted, in case prior repaired lines
      // changed the sequence ordering.
      if (parsed.event.sequence <= previous) return null
      outputLines.push(line)
      events.push(parsed.event)
      continue
    }

    // The line failed the general validator. It must be exactly the one
    // historical defect this repair fixes, and nothing else.
    const candidate = readInterruptedCandidate(line)
    if (candidate === null) return null

    const sourceConversationId = findSourceConversationId(
      events,
      candidate.turnId,
    )
    if (sourceConversationId === null) return null
    if (!isEventId(sourceConversationId)) return null

    const repairedValue = {
      ...candidate.raw,
      payload: { ...candidate.payload, conversationId: sourceConversationId },
    }
    const repairedLine = JSON.stringify(repairedValue)

    // The repaired line must validate against the full general ruleset, with
    // the strict sequence ordering the rest of the journal obeys.
    const reparsed = parseDurableEvent(repairedLine, previous)
    if (!reparsed.ok) return null
    if (reparsed.event.sequence !== candidate.sequence) return null

    outputLines.push(repairedLine)
    events.push(reparsed.event)
    repairs.push({
      line: index + 1,
      sequence: reparsed.event.sequence,
      turnId: candidate.turnId,
      recoveredConversationId: sourceConversationId,
    })
    repairedLineNumbers.push(index + 1)
  }

  if (repairedLineNumbers.length === 0) return null

  return {
    code: INTERRUPTED_TURN_CONVERSATION_ID_REPAIR,
    content: outputLines.join('\n') + '\n',
    repairedEvents: repairedLineNumbers.length,
    repairedLineNumbers,
    repairs,
    events,
  }
}

interface InterruptedCandidate {
  readonly sequence: number
  readonly turnId: string
  readonly payload: Record<string, unknown>
  readonly raw: Record<string, unknown>
}

function readInterruptedCandidate(line: string): InterruptedCandidate | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const event = value as Record<string, unknown>
  if (event.type !== 'conversation.turn.interrupted') return null

  const payload = event.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  if (record.conversationId !== '') return null
  if (typeof record.turnId !== 'string' || !isEventId(record.turnId)) return null

  const sequence = typeof event.sequence === 'number' ? event.sequence : NaN
  if (!Number.isInteger(sequence) || sequence <= 0) return null

  return { sequence, turnId: record.turnId, payload: record, raw: event }
}

/**
 * Walk the already-validated prefix for a trusted `conversation.turn.started`
 * with the exact same `turnId`, and return its `conversationId`.
 *
 *   - Zero matches → the interrupted turn is unprovable: refuse.
 *   - One match → the recovered id is that single conversation id.
 *   - Multiple matches that all agree → the recovered id is the agreed id.
 *   - Multiple matches that disagree → ambiguous: refuse.
 */
function findSourceConversationId(
  events: readonly AnyCoreEvent[],
  turnId: string,
): string | null {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'conversation.turn.started') continue
    if (event.payload.turnId !== turnId) continue
    const candidate = event.payload.conversationId
    if (!isEventId(candidate)) continue
    ids.add(candidate)
    if (ids.size > 1) return null
  }
  if (ids.size !== 1) return null
  return ids.values().next().value ?? null
}