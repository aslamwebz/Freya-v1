/**
 * Runtime Activation (Phase 40) — the closed vocabularies.
 *
 * The whole lane hangs off one sentence:
 *
 * > Implemented is not available, and available is not active.
 *
 * A domain that exists in this repository has to be able to say, deterministically,
 * which of those it is, why, and what dependency would have to be satisfied before
 * it could move. Nothing here adds intelligence or permission; this is registration,
 * dependency checking, lifecycle ownership and honest status.
 *
 * Data only: no clock, no journal, no port, no `node:` import.
 */

/** The closed status vocabulary. Every domain is in exactly one of these. */
export const RUNTIME_STATUSES = [
  /** The module exists in the tree, but is not in the registry. */
  'implemented',
  /** In the registry, not yet evaluated against a fact set. */
  'registered',
  /** Every declared activation dependency is satisfied; it may be activated. */
  'available',
  /** Activated and running under this Core. */
  'active',
  /** Activated, but operating with a reduced capability whose reason is stated. */
  'degraded',
  /** A required dependency is missing, or a gate forbids activation. */
  'blocked',
  /** Deliberately turned off. Nothing in this phase sets this; it exists so a
   *  future host can be explicit rather than merely absent. */
  'disabled',
] as const
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number]