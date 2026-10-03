/**
 * THE SELF ADAPTER — Phase 22's producer for the `self` port.
 *
 * Phase 22 (Self & World Model) landed, so `self` is no longer answered by the
 * Brain: the world domain's self model is the authority, and this adapter is the
 * one place that knows how a `WorldSelfModel` becomes a `ConsciousSelfReading`.
 * The projection does not change — it reads the port.
 *
 * ## One producer per port, chosen in Core
 *
 * The Brain used to answer this port. It no longer does: `FreyaCore` picks the
 * world domain's self model, and the Brain is read directly for the one thing
 * only it can answer — whether the Brain itself is readable, which is a
 * `provenance` fact rather than a section. There is no merge and no fallback
 * chain, because either would let two subsystems both believe they own the
 * answer.
 *
 * ## What is deliberately not widened
 *
 * - **Capability state.** The world domain records `held: boolean` per
 *   capability — a live Guard evaluation, not a vocabulary. This adapter maps
 *   it onto the port's closed union (`'available'` / `'unavailable'`) and
 *   leaves `'disabled'` and `'unknown'` unproduced rather than inventing a
 *   distinction the domain does not make.
 * - **`cannot` is empty, honestly.** The Brain's capability carried fixed
 *   prohibition strings; the world domain's descriptor does not record them.
 *   An empty array is the truthful reading — "no fixed prohibitions recorded" —
 *   where a copied list would be a claim the domain never made.
 * - **`complete` is true whenever a model exists.** The world's self model is a
 *   pure fold of live sources, recomputed on every projection: there is no
 *   partial-building state for it to be in, so "not finished building" is not
 *   a condition this producer can report.
 */

import type { WorldSelfModel } from '../../world/self'
import type { WorldViewHeader } from '../../protocol/world'
import type { ConsciousSelfReading } from '../ports'

/**
 * The world domain's self model, as a `self` port reading.
 *
 * `null` when there is no model at all. `header` supplies the trust fields —
 * the self model is folded from the same world state as the summary, so the
 * world domain's own health, durability and reason are the reading's.
 */
export function selfFromWorld(
  model: WorldSelfModel | null,
  header: WorldViewHeader,
): ConsciousSelfReading | null {
  if (model === null) return null

  const trust = {
    health: header.health,
    sequence: model.sequence,
    durable: header.persistence.durable,
    reason: header.reason,
  } as const

  if (header.health !== 'ready') {
    return {
      ...trust,
      health: 'unavailable',
      reason: header.reason ?? 'the world model could not be read',
      authority: 'self',
      name: null,
      role: null,
      purpose: null,
      claimCount: 0,
      capabilities: [],
      limitations: [],
      complete: false,
    }
  }

  const identity = model.identity
  return {
    ...trust,
    health: 'ready',
    reason: null,
    authority: 'self',
    name: identity?.name ?? null,
    role: identity?.role ?? null,
    purpose: identity?.purpose ?? null,
    claimCount: identity?.claims.length ?? 0,
    capabilities: model.assignedCapabilities.items.map((fact) => ({
      capability: fact.capability,
      state: fact.held ? 'available' : 'unavailable',
      cannot: [],
    })),
    limitations: model.limitations.items.map((limitation) => ({
      limitationId: limitation.limitationId,
      statement: limitation.statement,
    })),
    complete: true,
  }
}
