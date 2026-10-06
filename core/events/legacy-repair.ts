import { parseDurableEvent } from './validate'
import type { AnyCoreEvent } from './envelope'

export const LEGACY_TOOL_LOOP_REQUEST_ID_REPAIR = 'legacy-tool-loop-request-id' as const

export interface KnownJournalRepair {
  readonly code: typeof LEGACY_TOOL_LOOP_REQUEST_ID_REPAIR
  readonly content: string
  readonly repairedEvents: number
  readonly repairedLineNumbers: readonly number[]
  readonly events: readonly AnyCoreEvent[]
}

/**
 * Repair exactly one historical Freya bug: continuation cognition request ids
 * were once written as `turnId#iteration`, while the durable id grammar never
 * allowed `#`. No other malformed event is changed.
 *
 * The whole journal must validate after those substitutions. One unknown defect,
 * torn tail or unrelated malformed line makes the repair refuse.
 */
export function repairKnownLegacyJournal(raw: string): KnownJournalRepair | null {
  if (raw.length === 0 || !raw.endsWith('\n')) return null

  const sourceLines = raw.slice(0, -1).split('\n')
  if (sourceLines.length === 0) return null

  const outputLines: string[] = []
  const events: AnyCoreEvent[] = []
  const repairedLineNumbers: number[] = []
  let previousSequence = 0

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? ''
    const parsed = parseDurableEvent(line, previousSequence)
    if (parsed.ok) {
      outputLines.push(line)
      events.push(parsed.event)
      previousSequence = parsed.event.sequence
      continue
    }

    const repaired = repairLegacyCognitionRequest(line, previousSequence)
    if (repaired === null) return null

    outputLines.push(repaired.line)
    events.push(repaired.event)
    previousSequence = repaired.event.sequence
    repairedLineNumbers.push(index + 1)
  }

  if (repairedLineNumbers.length === 0) return null

  return {
    code: LEGACY_TOOL_LOOP_REQUEST_ID_REPAIR,
    content: outputLines.join('\n') + '\n',
    repairedEvents: repairedLineNumbers.length,
    repairedLineNumbers,
    events,
  }
}

function repairLegacyCognitionRequest(
  line: string,
  previousSequence: number,
): { line: string; event: AnyCoreEvent } | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (event.type !== 'cognition.requested') return null

  const payload = event.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const request = payload as Record<string, unknown>
  if (typeof request.requestId !== 'string') return null

  // The historical bug used exactly one unsupported separator immediately before
  // the numeric continuation index. The base itself must already use the durable
  // id alphabet, so this cannot normalize arbitrary hostile text.
  const match = /^([A-Za-z0-9._:-]+)#([1-9][0-9]*)$/.exec(request.requestId)
  if (match === null) return null

  const repairedValue = {
    ...event,
    payload: {
      ...request,
      requestId: `${match[1]}:${match[2]}`,
    },
  }
  const repairedLine = JSON.stringify(repairedValue)
  const verdict = parseDurableEvent(repairedLine, previousSequence)
  if (!verdict.ok) return null

  return { line: repairedLine, event: verdict.event }
}
