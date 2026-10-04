import { randomUUID } from 'node:crypto'
import {
  ASSUMPTION_STATUSES,
  CONFIDENCE_LEVELS,
  EVIDENCE_STALENESS_THRESHOLDS,
  type AssumptionStatus,
  type ConfidenceLevel,
  type EvidenceKind,
  type GoalAssumption,
  type GoalEvidence,
} from './types'

/**
 * UNCERTAINTY HANDLING.
 *
 * The long-horizon subsystem plans and decides even when information is
 * incomplete, stale or conflicted. This module is how it does so without
 * fabricating certainty.
 *
 * ## The rule
 *
 * Uncertainty is explicit, bounded, surfaced and honest. An assumption is
 * recorded with an expiration and a source. Confidence is derived from
 * evidence, never asserted. Stale evidence is marked stale. Conflicted
 * evidence preserves both versions and uses the conservative interpretation.
 *
 * ## What uncertainty is not
 *
 * Uncertainty does not grant authority. An uncertain goal cannot bypass Guard,
 * bypass Governor, exceed a budget, override STOP ALL or skip an approval.
 * Uncertainty determines how the subsystem *plans*; it never changes what the
 * subsystem *may* do.
 *
 * ## No model call
 *
 * Nothing here contacts a provider. Confidence is computed from the evidence
 * already held, and a confidence level that cannot be derived is `unknown`,
 * never a guessed number.
 */

/** The closed set of confidence levels, ordered from most to least certain. */
const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = ['high', 'medium', 'low', 'unknown']

/**
 * Derive a confidence level from evidence.
 *
 * The computation is deterministic and explainable:
 *
 * - No evidence → `unknown`.
 * - Evidence with a conflict → `unknown` (conflicting sources are not agreement).
 * - Stale evidence caps at `low`: a stale source is a single uncertain source,
 *   no matter how many copies of it exist.
 * - Multiple independent, fresh, agreeing sources → `high`.
 * - A single fresh source → `medium`.
 *
 * Confidence is never 100% and never fabricated: a level is always traceable
 * to the inputs that produced it.
 */
export function computeConfidence(evidence: readonly GoalEvidence[]): ConfidenceLevel {
  if (evidence.length === 0) return 'unknown'

  const fresh = evidence.filter((item) => !item.stale)
  if (fresh.length === 0) return 'low'

  const conflicting = fresh.some((item) => item.conflictsWith.length > 0)
  if (conflicting) return 'unknown'

  const sources = new Set(fresh.map((item) => item.source))
  if (sources.size >= 2) return 'high'
  return 'medium'
}

/**
 * Whether evidence is stale.
 *
 * Staleness is a function of the evidence's kind and its age against the
 * code-owned threshold for that kind. A piece of evidence does not become
 * untrue when it becomes stale; it becomes *unreliable*, and is marked as such
 * rather than silently trusted.
 */
export function isStaleEvidence(evidence: GoalEvidence, now: Date): boolean {
  const ageMs = now.getTime() - Date.parse(evidence.collectedAt)
  const threshold = EVIDENCE_STALENESS_THRESHOLDS[evidence.kind]
  return ageMs > threshold
}

/**
 * Mark stale evidence, returning a new record.
 *
 * Evidence is never mutated in place: a stale mark is a new fact about the
 * evidence, and the original collection time is preserved so the staleness is
 * explainable.
 */
export function markStale(evidence: GoalEvidence, now: Date): GoalEvidence {
  if (!isStaleEvidence(evidence, now)) return evidence
  return { ...evidence, stale: true }
}

/**
 * Record a conflict between two pieces of evidence.
 *
 * Both versions are preserved with their sources, and each records the other
 * as a conflict. The conflict is surfaced, not resolved: resolving it is a
 * decision for new evidence or an owner directive, not for this module.
 */
export function recordConflict(
  a: GoalEvidence,
  b: GoalEvidence,
  now: Date,
): readonly [GoalEvidence, GoalEvidence] {
  const aConflicted: GoalEvidence = {
    ...a,
    stale: a.stale || isStaleEvidence(a, now),
    conflictsWith: [...a.conflictsWith, b.evidenceId],
  }
  const bConflicted: GoalEvidence = {
    ...b,
    stale: b.stale || isStaleEvidence(b, now),
    conflictsWith: [...b.conflictsWith, a.evidenceId],
  }
  return [aConflicted, bConflicted]
}

/**
 * The conservative interpretation of a conflict.
 *
 * Given two conflicted readings, the conservative one is the one that claims
 * *less*: the lower confidence, the shorter deadline, the smaller count. When
 * the two readings do not differ, there is nothing to be conservative about
 * and the first is returned.
 *
 * This is the planning default, not the truth: a conflict is surfaced to the
 * owner either way, and the conservative reading is what the plan uses until
 * the conflict is resolved.
 */
export function conservativeInterpretation<T>(
  a: T,
  b: T,
  conservatism: (left: T, right: T) => T,
): T {
  return conservatism(a, b)
}

/**
 * Whether an assumption has expired.
 *
 * An assumption is bounded by its expiration. An expired assumption is not
 * deleted — it is marked `expired`, so the record shows what was assumed and
 * when it stopped being usable.
 */
export function isAssumptionExpired(assumption: GoalAssumption, now: Date): boolean {
  return now.getTime() >= Date.parse(assumption.expiresAt)
}

/**
 * The status of an assumption at a given clock.
 *
 * Derived, never stored: an assumption's status is a function of its
 * expiration and its confirmation state, so the same assumption cannot be
 * `active` in one read and `expired` in the next without the clock moving.
 */
export function assumptionStatus(assumption: GoalAssumption, now: Date): AssumptionStatus {
  if (assumption.status === 'confirmed' || assumption.status === 'refuted') return assumption.status
  if (isAssumptionExpired(assumption, now)) return 'expired'
  return 'active'
}

/**
 * Validate an assumption's content.
 *
 * An assumption must be explicit (a non-empty statement), bounded (a future
 * expiration) and sourced (a non-empty source). An assumption without a source
 * is an implicit assumption with a name on it, which is the one kind this
 * module exists to prevent.
 */
export function validateAssumption(input: {
  readonly statement: string
  readonly source: string
  readonly confidence?: ConfidenceLevel
  readonly ttlMs: number
  readonly now: Date
}): { ok: true; readonly statement: string; readonly source: string; readonly confidence: ConfidenceLevel; readonly expiresAt: string } | { ok: false; readonly reason: string } {
  if (typeof input.statement !== 'string' || input.statement.trim().length === 0) {
    return { ok: false, reason: 'an assumption must state what it assumes' }
  }
  if (typeof input.source !== 'string' || input.source.trim().length === 0) {
    return { ok: false, reason: 'an assumption must name its source' }
  }
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    return { ok: false, reason: 'an assumption must have a positive expiration' }
  }
  const confidence = input.confidence ?? 'unknown'
  if (!CONFIDENCE_ORDER.includes(confidence)) {
    return { ok: false, reason: 'a confidence level is one of high, medium, low or unknown' }
  }
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString()
  return { ok: true, statement: input.statement.trim(), source: input.source.trim(), confidence, expiresAt }
}

/**
 * The closed set of confidence levels, for callers that need to validate one.
 */
export function confidenceLevels(): readonly ConfidenceLevel[] {
  return CONFIDENCE_LEVELS
}

/**
 * The closed set of assumption statuses, for callers that need to validate one.
 */
export function assumptionStatuses(): readonly AssumptionStatus[] {
  return ASSUMPTION_STATUSES
}

/**
 * The closed set of evidence kinds, for callers that need to validate one.
 */
export function evidenceKinds(): readonly EvidenceKind[] {
  return Object.keys(EVIDENCE_STALENESS_THRESHOLDS) as readonly EvidenceKind[]
}

/**
 * A new assumption id. Injectable for deterministic tests.
 */
export function newAssumptionId(newId: () => string = () => randomUUID()): string {
  return newId()
}
