/**
 * Bounded anti-repetition: the cue ledger.
 *
 * Freya's expressiveness dies in two opposite ways — never greeting back, or
 * the same "shared joke" every single turn until it is a tic. This file exists
 * to keep *recurring gestures* (greetings, catchphrases, habits, inside-joke
 * shorthands) from being served too often, while holding the least possible
 * about them.
 *
 * ## Metadata, not surveillance
 *
 * A ledger entry is `(cueHash, kind, lastUsedAt, uses)` — an FNV-1a hash of the
 * code-assigned cue id, a closed label, an instant, a small counter. It is not
 * a transcript. The ledger cannot answer "what did the person say last
 * Tuesday", and was designed so it cannot even be asked: nothing in this file
 * accepts sentence input. Conversation content stays in the encrypted
 * conversation store where it belongs.
 *
 * ## Deterministic and bounded
 *
 * No clock, no randomness: every function takes `at` as a parameter and sorts
 * by explicit keys (instant, then hash), so two runs over the same records
 * agree on every byte. The entry list is capped — least-recently-used cues are
 * evicted first, ties by hash — which means the ledger cannot grow without
 * bound and an ancient cue resurfaces rather than a store filling up.
 */

import {
  PERSONALITY_LIMITS,
  instantMs,
  type CueCandidate,
  type CueKind,
  type CueUsageEntry,
  type CueUsageLedger,
} from './types'

/**
 * How often a cue may be offered. Defaults, and the bounds around them.
 *
 * `cooldownMs` is how long a cue rests after being offered; `maxOffersPerTurn`
 * caps gestures in any single plan no matter how many are eligible. A policy
 * may be *narrowed* within bounds by trusted code, never widened past them —
 * the same posture as workforce limits.
 */
export const REPETITION_BOUNDS = Object.freeze({
  minCooldownMs: 60 * 60 * 1_000,
  maxCooldownMs: 90 * 24 * 60 * 60 * 1_000,
  minOffersPerTurn: 1,
  maxOffersPerTurn: PERSONALITY_LIMITS.maxCueOffersPerTurn,
})

export const DEFAULT_REPETITION_POLICY = Object.freeze({
  cooldownMs: 3 * 24 * 60 * 60 * 1_000,
  maxOffersPerTurn: 2,
})

export interface RepetitionPolicy {
  readonly cooldownMs: number
  readonly maxOffersPerTurn: number
}

export function normalizeRepetitionPolicy(partial?: Partial<RepetitionPolicy>): RepetitionPolicy {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(Math.max(Math.floor(value), min), max)
  }
  return Object.freeze({
    cooldownMs: clamp(partial?.cooldownMs, DEFAULT_REPETITION_POLICY.cooldownMs, REPETITION_BOUNDS.minCooldownMs, REPETITION_BOUNDS.maxCooldownMs),
    maxOffersPerTurn: clamp(partial?.maxOffersPerTurn, DEFAULT_REPETITION_POLICY.maxOffersPerTurn, REPETITION_BOUNDS.minOffersPerTurn, REPETITION_BOUNDS.maxOffersPerTurn),
  })
}

/** FNV-1a over the UTF-16 units of a cue id. Deterministic, non-cryptographic. */
export function cueHash(cueId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < cueId.length; i++) {
    h ^= cueId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function emptyCueLedger(maxEntries: number = PERSONALITY_LIMITS.maxLedgerEntries): CueUsageLedger {
  return Object.freeze({
    schemaVersion: 1,
    maxEntries: Math.min(Math.max(1, Math.floor(maxEntries)), PERSONALITY_LIMITS.maxLedgerEntries),
    entries: Object.freeze([] as readonly CueUsageEntry[]),
  })
}

/** Rebuild a ledger from stored entries, re-validating the whole shape. */
export function restoreCueLedger(value: unknown): CueUsageLedger {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('entries' in value) ||
    !Array.isArray((value as { entries: unknown }).entries)
  ) {
    return emptyCueLedger()
  }
  const clean: CueUsageEntry[] = []
  for (const raw of (value as { entries: readonly unknown[] }).entries) {
    if (typeof raw !== 'object' || raw === null) continue
    const e = raw as Record<string, unknown>
    if (
      typeof e.cueHash === 'string' &&
      /^[0-9a-f]{8}$/.test(e.cueHash) &&
      typeof e.kind === 'string' &&
      instantMs(e.lastUsedAt) !== null &&
      typeof e.uses === 'number' &&
      Number.isInteger(e.uses) &&
      e.uses > 0 &&
      e.uses <= 1_000_000
    ) {
      const kind = e.kind
      if (!isKnownKind(kind)) continue
      clean.push(Object.freeze({ cueHash: e.cueHash, kind, lastUsedAt: e.lastUsedAt as string, uses: e.uses }))
    }
  }
  const rawMax = (value as Record<string, unknown>).maxEntries
  const maxEntries =
    typeof rawMax === 'number' && Number.isFinite(rawMax)
      ? Math.min(Math.max(1, Math.floor(rawMax)), PERSONALITY_LIMITS.maxLedgerEntries)
      : PERSONALITY_LIMITS.maxLedgerEntries
  return Object.freeze({ schemaVersion: 1, maxEntries, entries: Object.freeze(sortEntries(clean).slice(0, maxEntries)) })
}

function isKnownKind(kind: string): kind is CueKind {
  return kind === 'greeting' || kind === 'catchphrase' || kind === 'habit' || kind === 'inside-joke'
}

function sortEntries(entries: readonly CueUsageEntry[]): CueUsageEntry[] {
  return [...entries].sort(
    (a, b) =>
      (instantMs(a.lastUsedAt) ?? 0) - (instantMs(b.lastUsedAt) ?? 0) ||
      (a.cueHash < b.cueHash ? -1 : a.cueHash > b.cueHash ? 1 : 0),
  )
}

/**
 * Record that a cue was actually offered, returning a *new* ledger.
 *
 * The old ledger is untouched — persistence and ordering are the host's
 * problem in Slice B; here the transition is a pure value in, value out.
 * Eviction is least-recently-used, tie-broken by hash so it never depends on
 * which order records happened to arrive.
 */
export function recordCueUse(
  ledger: CueUsageLedger,
  cueId: string,
  kind: CueKind,
  at: string,
): CueUsageLedger {
  const hash = cueHash(cueId)
  if (instantMs(at) === null) return ledger
  const rest = ledger.entries.filter((entry) => entry.cueHash !== hash)
  const previous = ledger.entries.find((entry) => entry.cueHash === hash)
  const entry: CueUsageEntry = Object.freeze({
    cueHash: hash,
    kind,
    lastUsedAt: at,
    uses: (previous?.uses ?? 0) + 1,
  })
  const merged = sortEntries([...rest, entry])
  const trimmed = merged.length > ledger.maxEntries ? merged.slice(merged.length - ledger.maxEntries) : merged
  return Object.freeze({ schemaVersion: ledger.schemaVersion, maxEntries: ledger.maxEntries, entries: Object.freeze(trimmed) })
}

/** Whether a cue has rested past its cooldown as of `at`. Unknown cues are fresh. */
export function isCueEligible(
  ledger: CueUsageLedger,
  cueId: string,
  at: string,
  policy: RepetitionPolicy,
): boolean {
  const nowMs = instantMs(at)
  if (nowMs === null) return false
  const entry = ledger.entries.find((e) => e.cueHash === cueHash(cueId))
  if (entry === undefined) return true
  const then = instantMs(entry.lastUsedAt)
  if (then === null) return true
  // A use recorded *after* `at` (out-of-order clock, replayed record) still
  // counts: the conservative reading is "recently used", never "fresh".
  if (then > nowMs) return false
  return nowMs - then >= policy.cooldownMs
}

export interface CueSelection {
  readonly offered: readonly CueCandidate[]
  readonly held: readonly CueCandidate[]
}

/**
 * Filter eligible candidates against the ledger.
 *
 * Input order is preserved (the interpretation already sorted
 * deterministically), a per-turn cap is applied, and anything still resting is
 * reported as `held` rather than silently vanishing — a plan that hides its
 * own suppression cannot be evaluated for it.
 */
export function selectCues(
  candidates: readonly CueCandidate[],
  ledger: CueUsageLedger,
  at: string,
  policy: RepetitionPolicy = normalizeRepetitionPolicy(),
): CueSelection {
  const offered: CueCandidate[] = []
  const held: CueCandidate[] = []
  for (const candidate of candidates) {
    if (offered.length >= policy.maxOffersPerTurn || !isCueEligible(ledger, candidate.cueId, at, policy)) {
      held.push(candidate)
    } else {
      offered.push(candidate)
    }
  }
  return Object.freeze({ offered: Object.freeze(offered), held: Object.freeze(held) })
}
