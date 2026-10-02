/**
 * The Attention domain (Phase 12).
 *
 * Everything here is pure or narrowly ported: closed vocabularies, deterministic
 * importance/urgency/outcome scoring, an authorized ingest door that treats text as
 * data, a bounded schedule table, a journal-derived fold, and the projection that
 * turns those domain values into the read-only vocabulary a window may hold. No
 * I/O beyond the injected event fabric, no clock reads except through an injected
 * `now`, no randomness, no model, no authority.
 *
 * The engine is the only impure piece, and it is impure in exactly one way: it
 * appends to the journal. It cannot reach a provider, mint a capability, clear a
 * stop or widen a permission, because none of those exists on any type it holds.
 */

export * from './types'
export {
  KIND_IMPORTANCE,
  KIND_URGENCY,
  KIND_CUE,
  SOURCE_IMPORTANCE_CAP,
  scoreImportance,
  scoreUrgency,
  baseOutcome,
  decideAttention,
  type AttentionHistoryEntry,
  type AttentionIngestHistoryEntry,
  type AttentionPolicyInput,
  type AttentionPolicyResult,
} from './policy'
export {
  parseIngestPayload,
  parseSchedulePayload,
  buildAttentionEvent,
  type AttentionIngestInput,
  type AttentionScheduleInput,
  type NormalizedIngest,
} from './ingest'
export {
  initialAttentionState,
  reduceAttention,
  hasSeenKey,
  recentDecisions,
  pendingSchedules,
  type AttentionState,
  type AttentionCounts,
  type AttentionDecisionRecord,
  type AttentionIngestRecord,
} from './state'
export {
  projectAttention,
  recentDecisionViews,
  ABSENT_ATTENTION_PROJECTION,
  NO_ATTENTION_DOMAIN_REASON,
  type AttentionProjectionInput,
} from './projection'
export {
  AttentionEngine,
  type AttentionEngineOptions,
  type AttentionIngestOutcome,
  type AttentionInternalInput,
  type AttentionSourceScope,
  type AttentionBudgetLimit,
} from './engine'
