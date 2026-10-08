import type { AnyCoreEvent } from './envelope'
import { parseDurableEvent } from './validate'

type IntegrityFault = Extract<AnyCoreEvent, { type: 'core.integrity_fault' }>

export interface ReconciledJournal {
  readonly events: readonly AnyCoreEvent[]
  readonly content: string
  readonly reconciledEvents: number
  readonly sequenceOffset: number
}

/** Join a repaired older branch with its later active continuation, never replace it. */
export function reconcileKnownJournal(
  older: readonly AnyCoreEvent[],
  current: readonly AnyCoreEvent[],
  fault: IntegrityFault,
): ReconciledJournal | null {
  const prefixCount = fault.payload.trustedPrefixEvents
  if (fault.payload.line !== prefixCount + 1 || older.length <= prefixCount || current.length <= prefixCount) return null
  for (let index = 0; index < prefixCount; index++) {
    if (JSON.stringify(older[index]) !== JSON.stringify(current[index])) return null
  }
  let earlierUnresolved = false
  for (const event of current.slice(0, prefixCount)) {
    if (event.type === 'core.integrity_fault') earlierUnresolved = true
    else if (event.type === 'core.integrity_repaired') earlierUnresolved = false
  }
  if (earlierUnresolved) return null

  const recoveredSuffix = older.slice(prefixCount)
  const activeSuffix = current.slice(prefixCount)
  // This repair must not acknowledge a second, unexplained gap in either branch.
  if (recoveredSuffix.some(e => e.type === 'core.integrity_fault')) return null
  if (!activeSuffix.some(e => e.eventId === fault.eventId)) return null
  if (activeSuffix.some(e => e.type === 'core.integrity_fault' && e.eventId !== fault.eventId)) return null

  // The branches must be sequential. Interleaved histories need operator review;
  // sequence numbers alone cannot order independent writers after the fork.
  const oldestActive = activeSuffix.reduce((oldest, e) => Math.min(oldest, Date.parse(e.occurredAt)), Infinity)
  if (recoveredSuffix.some(e => Date.parse(e.occurredAt) > oldestActive)) return null

  const identities = new Set<string>()
  for (const event of [...older, ...activeSuffix]) {
    if (identities.has(event.eventId)) return null
    identities.add(event.eventId)
  }

  // Only the envelope sequence changes. Original sequences remain in the archive;
  // event IDs, timestamps, payloads and ID-based causal links remain intact.
  const prefixSequence = prefixCount === 0 ? 0 : current[prefixCount - 1]!.sequence
  const sequenceOffset = older.at(-1)!.sequence - prefixSequence
  const events = [...older, ...activeSuffix.map(e => ({ ...e, sequence: e.sequence + sequenceOffset }))]
  let previous = 0
  const output: string[] = []
  for (const event of events) {
    const line = JSON.stringify(event)
    const parsed = parseDurableEvent(line, previous)
    if (!parsed.ok) return null
    previous = event.sequence
    output.push(line)
  }
  return { events, content: output.join('\n') + '\n', reconciledEvents: activeSuffix.length, sequenceOffset }
}
