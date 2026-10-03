import type { AnyCoreEvent } from '../events/envelope'
import { deterministicEntryId, type LifeEntryDraft } from './admission'
import type { LifeReference } from './types'

/**
 * THE DERIVATION TABLE — which authoritative events may become a Life entry.
 *
 * A closed table on purpose. Life History is *derived from* authoritative
 * evidence, and the set of evidence that may produce an entry is a decision Core
 * makes here rather than something a caller can widen. Every rule:
 *
 * - produces a deterministic entry id from the source id, so a restart cannot
 *   duplicate it and a replay cannot fork it;
 * - produces deterministic, content-free title and summary text — never the
 *   evidence's own body, and never a model's words;
 * - links to the evidence by `(domain, refKind, refId)` and nothing else.
 *
 * There is no model call here and no clock read: the event's own `occurredAt` is
 * the time, and an event that does not carry a date produces an entry whose
 * `occurredAt` is null rather than a fabricated one.
 */

function reference(
  domain: LifeReference['domain'],
  refKind: LifeReference['refKind'],
  refId: string,
  label: string | null = null,
): LifeReference {
  return { domain, refKind, refId, label }
}

/**
 * The Life entry an authoritative event implies, or null when it implies none.
 *
 * Pure: the same event always produces the same draft.
 */
export function deriveLifeDraft(event: AnyCoreEvent): LifeEntryDraft | null {
  switch (event.type) {
    case 'mission.completed':
      return missionDraft(event, 'milestone', 'high', 'A mission reached completion.')
    case 'mission.failed':
      return missionDraft(event, 'episode', 'medium', 'A mission did not reach completion.')
    case 'mission.cancelled':
      return missionDraft(event, 'episode', 'low', 'A mission was cancelled before completion.')
    case 'brain.memory.admitted':
      return memoryDraft(event)
    default:
      return null
  }
}

type MissionEvent = Extract<AnyCoreEvent, { type: 'mission.completed' | 'mission.failed' | 'mission.cancelled' }>

function missionDraft(
  event: MissionEvent,
  kind: LifeEntryDraft['kind'],
  salience: LifeEntryDraft['salience'],
  summary: string,
): LifeEntryDraft {
  const missionId = event.payload.missionId
  return {
    entryId: deterministicEntryId('mission', 'mission', missionId),
    kind,
    title: missionTitle(event.type),
    summary,
    body: '',
    salience,
    derivation: 'observed',
    confidence: 'high',
    provenance: {
      sourceDomain: 'mission',
      sourceId: missionId,
      observedAt: event.occurredAt,
      recordedAt: event.occurredAt,
      actor: event.actor,
    },
    references: [reference('mission', 'mission', missionId)],
    occurredAt: event.occurredAt,
    tags: ['mission'],
    admissionReason: `derived from ${event.type} for mission ${missionId}`,
  }
}

function missionTitle(type: MissionEvent['type']): string {
  if (type === 'mission.completed') return 'Mission completed'
  if (type === 'mission.failed') return 'Mission failed'
  return 'Mission cancelled'
}

function memoryDraft(event: Extract<AnyCoreEvent, { type: 'brain.memory.admitted' }>): LifeEntryDraft | null {
  if (event.payload.kind !== 'autobiographical') return null
  const memoryId = event.payload.memoryId
  return {
    entryId: deterministicEntryId('brain', 'memory', memoryId),
    kind: 'milestone',
    title: 'An autobiographical memory was recorded',
    summary: `Freya recorded a fact about herself (${event.payload.contentLength} characters).`,
    body: '',
    salience: 'medium',
    derivation: 'observed',
    confidence: 'medium',
    provenance: {
      sourceDomain: 'brain',
      sourceId: memoryId,
      observedAt: event.occurredAt,
      recordedAt: event.occurredAt,
      actor: event.actor,
    },
    references: [reference('brain', 'memory', memoryId)],
    occurredAt: event.occurredAt,
    tags: ['memory'],
    admissionReason: `derived from brain.memory.admitted for memory ${memoryId}`,
  }
}
