/**
 * THE LEARNING FOLD, and the validation that guards it.
 *
 * One deterministic function from a sequence of records to a `LearningState`, used by the
 * memory store and the Vault store alike. Two implementations of "how do records become
 * state" is how a store ends up disagreeing with itself about what Freya has learned, so
 * there is one.
 *
 * Validation runs on **read** as well as on write. A row that parsed is only proven to be
 * the row that was written, not that it is well formed. A record that fails validation is
 * reported and the read stops — the store treats it as a broken chain — rather than being
 * silently skipped, because skipping would let a damaged claim be dropped and the rest
 * believed as though nothing were wrong.
 */

import { rebuildVerifiedOutcome, type OutcomeResult } from './outcome'
import { rebuildKnowledgeRecord, rebuildLearningExperience } from './rebuild'
import type {
  KnowledgeRecord,
  LearningExperience,
  LearningState,
  VerifiedOutcome,
} from './types'

export const LEARNING_RECORD_VERSION = 1

/**
 * The wrapper a store persists.
 *
 * A version and one record, rather than a bare record, so a future shape change is
 * detectable on read instead of being inferred from a field that happens to be absent.
 */
export type LearningRecord =
  | { readonly version: number; readonly kind: 'outcome'; readonly outcome: VerifiedOutcome }
  | { readonly version: number; readonly kind: 'experience'; readonly experience: LearningExperience }
  | { readonly version: number; readonly kind: 'knowledge'; readonly knowledge: KnowledgeRecord }

export function emptyLearningState(): LearningState {
  return { experiences: new Map(), knowledge: new Map(), outcomes: new Map(), sequence: 0 }
}

/**
 * Apply one record. Idempotent per id.
 *
 * A later write for the same id replaces the earlier one: a status change *is* the advance
 * of a record, and the record carries its own lifecycle, so keeping both would be a second
 * source of truth about one thing.
 */
export function applyRecord(state: LearningState, record: LearningRecord): void {
  state.sequence += 1
  if (record.kind === 'outcome') state.outcomes.set(record.outcome.outcomeId, record.outcome)
  else if (record.kind === 'experience') state.experiences.set(record.experience.experienceId, record.experience)
  else state.knowledge.set(record.knowledge.knowledgeId, record.knowledge)
}

/** Validate a stored value, re-running every construction rule the row would face. */
export function validateRecord(value: unknown): { ok: true; record: LearningRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a learning record is not an object' }
  }
  const wrapper = value as Record<string, unknown>
  if (wrapper.version !== LEARNING_RECORD_VERSION) {
    return { ok: false, reason: 'a learning record carried an unknown wrapper version' }
  }
  if (wrapper.kind === 'outcome') {
    const rebuilt: OutcomeResult<VerifiedOutcome> = rebuildVerifiedOutcome(wrapper.outcome)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return { ok: true, record: { version: LEARNING_RECORD_VERSION, kind: 'outcome', outcome: rebuilt.value } }
  }
  if (wrapper.kind === 'experience') {
    const rebuilt = rebuildLearningExperience(wrapper.experience)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return { ok: true, record: { version: LEARNING_RECORD_VERSION, kind: 'experience', experience: rebuilt.value } }
  }
  if (wrapper.kind === 'knowledge') {
    const rebuilt = rebuildKnowledgeRecord(wrapper.knowledge)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return { ok: true, record: { version: LEARNING_RECORD_VERSION, kind: 'knowledge', knowledge: rebuilt.value } }
  }
  return { ok: false, reason: 'a learning record named an unknown kind' }
}

/**
 * The row key a store persists one record under.
 *
 * One keyspace for the whole pipeline, namespaced by kind: `outcome:<id>`,
 * `experience:<id>`, `knowledge:<id>`. Namespacing rather than three tables means one
 * `vault_kv` domain, one fold and one degradation rule for all three, and it makes a
 * cross-kind id collision impossible to mistake for a conflict.
 */
export function recordKey(record: LearningRecord): string {
  if (record.kind === 'outcome') return `outcome:${record.outcome.outcomeId}`
  if (record.kind === 'experience') return `experience:${record.experience.experienceId}`
  return `knowledge:${record.knowledge.knowledgeId}`
}