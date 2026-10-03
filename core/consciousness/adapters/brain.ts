/**
 * THE BRAIN ADAPTER — today's authority behind the `self`, `world` and
 * `continuity` ports.
 *
 * ## What this is
 *
 * On this baseline the Brain is the authoritative projection holding Freya's
 * seeded self-account, the world's entity and relation counts, and the record of
 * recently admitted memories. So the Brain answers those three ports, and this file
 * is the only place that knows it.
 *
 * The projection does not. It reads ports, which is why swapping this adapter for
 * a Phase 22 one is a change to this directory and to one line of Core wiring, and
 * not a change to a single derivation rule.
 *
 * ## Precedence, and why it is not encoded here
 *
 * When Phase 22 lands, `self` and `world` will have their own producers. The rule
 * is that **the owning domain wins**, and it is deliberately *not* implemented as a
 * merge, a fallback chain or a "prefer whichever is non-null" inside this file —
 * because each of those would let two subsystems both believe they own the answer.
 * Instead `FreyaCore.consciousness()` picks exactly one producer per port and
 * passes its reading. One producer, one reading, no arbitration at read time.
 *
 * ## Privacy
 *
 * This adapter is where a widening would happen if one were careless, so it is
 * deliberately narrow:
 *
 * - `subjectLength` is computed here from the Brain's `subject` and the `subject`
 *   itself is never returned. This is the single most privacy-sensitive line in
 *   the lane, and it is one line rather than a convention applied elsewhere.
 * - `SelfCapabilityState` is narrowed through
 *   {@link narrowSelfCapabilityState} rather than passed through, because the
 *   Brain's own projection widens it to a bare `string`.
 * - `kind`, `source`, `confidence` and `status` are copied as the Brain's own
 *   closed unions, not widened to `string`. The crossing view declares the same
 *   unions, so a widened port could only ever fail to compile later — see
 *   {@link ConsciousContinuityItemReading} for why that is the honest choice.
 *
 * Every one of those choices is checked from the outside by
 * `tests/red-team/consciousness-leakage.test.ts`, which plants a sentinel in each
 * private channel and sweeps the *serialised* snapshot for it.
 */

import type { BrainProjection } from '../../brain/brain'
import type {
  ConsciousContinuityReading,
  ConsciousSelfReading,
  ConsciousWorldReading,
} from '../ports'
import { narrowSelfCapabilityState } from '../ports'

/**
 * Why the Brain cannot answer a port, as one sentence.
 *
 * Shared so the three adapters cannot drift into three slightly different ways of
 * saying the same thing, which is how a person ends up told "the Brain is
 * unhealthy" by one section and "the Brain could not be read" by another and has no
 * way to tell whether those are the same event.
 */
function brainReason(brain: BrainProjection): string {
  return brain.reason ?? 'the Brain could not be read'
}

/**
 * The Brain's self-account, as a `self` port reading.
 *
 * `null` when there is no Brain at all. An unhealthy Brain returns a reading whose
 * `health` is `'unavailable'` and whose fields are empty, because "there is no
 * Brain" and "the Brain is unreadable" are different facts and the projection has
 * to be able to tell them apart to report them as `'absent'` versus `'degraded'`.
 */
export function selfFromBrain(brain: BrainProjection | null): ConsciousSelfReading | null {
  if (brain === null) return null

  const trust = {
    sequence: brain.sequence,
    durable: brain.durable,
  } as const

  if (brain.health !== 'healthy') {
    return {
      ...trust,
      health: 'unavailable',
      reason: brainReason(brain),
      authority: 'brain',
      name: null,
      role: null,
      purpose: null,
      claimCount: 0,
      capabilities: [],
      limitations: [],
      complete: false,
    }
  }

  const identity = brain.identity
  const self = brain.self
  return {
    ...trust,
    health: 'ready',
    reason: null,
    authority: 'brain',
    name: identity?.name ?? null,
    role: identity?.role ?? null,
    purpose: identity?.purpose ?? null,
    claimCount: identity?.claims.length ?? 0,
    capabilities: (self?.capabilities ?? []).map((capability) => ({
      capability: capability.capability,
      // Narrowed, not passed through: the Brain's projection widens this to a bare
      // `string`, and a widened producer must not be able to widen the type a
      // renderer is typed against.
      state: narrowSelfCapabilityState(capability.state),
      cannot: [...capability.cannot],
    })),
    limitations: (self?.limitations ?? []).map((limitation) => ({
      limitationId: limitation.limitationId,
      statement: limitation.statement,
    })),
    // `complete: false` alongside `health: 'ready'` is a real reading, not a
    // contradiction: Core knows what it can do and does not yet know that it knows
    // all of it. Collapsing the two would make an unfinished self-account
    // indistinguishable from a complete one.
    complete: self?.complete ?? false,
  }
}

/**
 * The world's counts and recorded contradictions, as a `world` port reading.
 *
 * Counts only. The Brain projects entity and relation *counts* and no names, and
 * this adapter does not widen that — a surface needing a name recalls it
 * deliberately through the Brain, on the owner's authority.
 */
export function worldFromBrain(brain: BrainProjection | null): ConsciousWorldReading | null {
  if (brain === null) return null

  const trust = {
    sequence: brain.sequence,
    durable: brain.durable,
  } as const

  if (brain.health !== 'healthy') {
    return {
      ...trust,
      health: 'unavailable',
      reason: brainReason(brain),
      authority: 'brain',
      entities: null,
      relations: null,
      observations: null,
      memories: null,
      admitted: null,
      conflicted: null,
      rejected: null,
      withdrawn: null,
      experiences: null,
      conflicts: [],
    }
  }

  return {
    ...trust,
    health: 'ready',
    reason: null,
    authority: 'brain',
    entities: brain.counts.entities,
    relations: brain.counts.relations,
    observations: brain.counts.observations,
    memories: brain.counts.memories,
    admitted: brain.counts.admitted,
    conflicted: brain.counts.conflicted,
    rejected: brain.counts.rejected,
    withdrawn: brain.counts.withdrawn,
    experiences: brain.counts.experiences,
    conflicts: brain.conflicts.map((conflict) => ({
      memoryId: conflict.memoryId,
      conflictsWith: [...conflict.conflictsWith],
      detail: conflict.detail,
    })),
  }
}

/**
 * Recently admitted memories, as a `continuity` port reading.
 *
 * The `subjectLength` line below is the whole privacy argument for this section in
 * one expression: enough to see that something substantial was admitted about a
 * subject of a certain size, and not one character of either the content or the
 * subject.
 */
export function continuityFromBrain(brain: BrainProjection | null): ConsciousContinuityReading | null {
  if (brain === null) return null

  const trust = {
    sequence: brain.sequence,
    durable: brain.durable,
  } as const

  if (brain.health !== 'healthy') {
    return {
      ...trust,
      health: 'unavailable',
      reason: brainReason(brain),
      authority: 'brain',
      items: [],
      admittedTotal: null,
    }
  }

  return {
    ...trust,
    health: 'ready',
    reason: null,
    authority: 'brain',
    items: brain.recentAdmissions.map((entry) => ({
      memoryId: entry.memoryId,
      kind: entry.kind,
      source: entry.source,
      confidence: entry.confidence,
      status: entry.status,
      subjectLength: entry.subject.length,
      admittedAt: entry.admittedAt,
    })),
    admittedTotal: brain.counts.admitted,
  }
}
