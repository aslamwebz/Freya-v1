// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  cueHash,
  emptyCueLedger,
  recordCueUse,
  restoreCueLedger,
  isCueEligible,
  selectCues,
  normalizeRepetitionPolicy,
  REPETITION_BOUNDS,
  DEFAULT_REPETITION_POLICY,
  PERSONALITY_LIMITS,
  type CueCandidate,
} from '../../core/personality'

/**
 * The anti-repetition ledger: bounded, deterministic, metadata-only.
 */

const T0 = Date.parse('2026-10-02T12:00:00.000Z')
const at = (msAgo: number): string => new Date(T0 - msAgo).toISOString()
const NOW = new Date(T0).toISOString()
const DAY = 24 * 60 * 60 * 1_000

const day = (label: string): CueCandidate =>
  Object.freeze({ cueId: `cue:${label}`, key: label, kind: 'greeting', confidence: 'high' })

describe('cue hashing and ledger bounds', () => {
  it('hashes are deterministic 8-hex metadata', () => {
    expect(cueHash('cue:hello')).toBe(cueHash('cue:hello'))
    expect(cueHash('cue:hello')).not.toBe(cueHash('cue:world'))
    expect(cueHash('cue:hello')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('recordCueUse is pure: the old ledger is untouched', () => {
    const base = emptyCueLedger()
    const next = recordCueUse(base, 'cue:a', 'greeting', NOW)
    expect(base.entries.length).toBe(0)
    expect(next.entries.length).toBe(1)
    const again = recordCueUse(next, 'cue:a', 'greeting', at(1_000))
    expect(next.entries[0]?.uses).toBe(1)
    expect(again.entries[0]?.uses).toBe(2)
    const latest = recordCueUse(next, 'cue:a', 'greeting', new Date(T0 + 1_000).toISOString())
    expect(latest.entries[0]?.uses).toBe(2)
  })

  it('evicts least-recently-used, tie-broken by hash, and never exceeds the cap', () => {
    let ledger = emptyCueLedger(4)
    for (let i = 0; i < 10; i++) {
      ledger = recordCueUse(ledger, `cue:${i}`, 'habit', new Date(T0 + i * 1_000).toISOString())
    }
    expect(ledger.entries.length).toBe(4)
    const hashes = ledger.entries.map((e) => e.cueHash)
    expect(hashes).toEqual([6, 7, 8, 9].map((i) => cueHash(`cue:${i}`)))
  })

  it('restoreCueLedger rejects malformed and authority-shaped records', () => {
    const restored = restoreCueLedger({
      entries: [
        { cueHash: 'deadbeef', kind: 'greeting', lastUsedAt: NOW, uses: 1 },
        { cueHash: 'NOT-A-HASH', kind: 'greeting', lastUsedAt: NOW, uses: 1 },
        { cueHash: 'cafe0001', kind: 'bypass-guard', lastUsedAt: NOW, uses: 1 },
        { cueHash: 'cafe0002', kind: 'habit', lastUsedAt: 'yesterday', uses: 2 },
        { cueHash: 'cafe0003', kind: 'catchphrase', lastUsedAt: NOW, uses: 1, grant: 'admin' },
        null,
        'x',
      ],
    })
    expect(restored.entries.map((e) => e.cueHash)).toEqual(['cafe0003', 'deadbeef'])
    expect(Object.keys(restored.entries[0] ?? {})).toEqual(['cueHash', 'kind', 'lastUsedAt', 'uses'])
    expect(restoreCueLedger('garbage').entries.length).toBe(0)
  })
})

describe('eligibility and selection', () => {
  const policy = normalizeRepetitionPolicy({ cooldownMs: DAY })

  it('unknown cues are fresh; recent use suppresses until the cooldown passes', () => {
    const used = recordCueUse(emptyCueLedger(), 'cue:hi', 'greeting', NOW)
    expect(isCueEligible(used, 'cue:hi', at(1_000), policy)).toBe(false)
    expect(isCueEligible(used, 'cue:other', at(1_000), policy)).toBe(true)
    expect(isCueEligible(used, 'cue:hi', new Date(T0 + DAY).toISOString(), policy)).toBe(true)
  })

  it('a malformed now is never eligible, and never throws', () => {
    expect(isCueEligible(emptyCueLedger(), 'cue:hi', 'nonsense', policy)).toBe(false)
  })

  it('selectCues caps offers per turn and reports the rest as held, in order', () => {
    const candidates = [day('a'), day('b'), day('c'), day('d')]
    const tight = normalizeRepetitionPolicy({ maxOffersPerTurn: 2 })
    const selection = selectCues(candidates, emptyCueLedger(), NOW, tight)
    expect(selection.offered.map((c) => c.key)).toEqual(['a', 'b'])
    expect(selection.held.map((c) => c.key)).toEqual(['c', 'd'])
    // Nothing was actually recorded by selecting: the ledger is unchanged,
    // recording is a separate, explicit step the host takes.
    expect(emptyCueLedger().entries.length).toBe(0)
  })

  it('a cue in cooldown moves to held without disturbing offer order', () => {
    const used = recordCueUse(emptyCueLedger(), 'cue:b', 'greeting', NOW)
    const selection = selectCues([day('a'), day('b'), day('c')], used, NOW, normalizeRepetitionPolicy({ maxOffersPerTurn: 3 }))
    expect(selection.offered.map((c) => c.key)).toEqual(['a', 'c'])
    expect(selection.held.map((c) => c.key)).toEqual(['b'])
  })
})

describe('policy normalisation', () => {
  it('can be narrowed and is clamped to the bounds — never widened past them', () => {
    const defaults = normalizeRepetitionPolicy()
    expect(defaults.cooldownMs).toBe(DEFAULT_REPETITION_POLICY.cooldownMs)

    const widened = normalizeRepetitionPolicy({ cooldownMs: Number.MAX_SAFE_INTEGER, maxOffersPerTurn: 999 })
    expect(widened.cooldownMs).toBe(REPETITION_BOUNDS.maxCooldownMs)
    expect(widened.maxOffersPerTurn).toBe(REPETITION_BOUNDS.maxOffersPerTurn)

    const shrunk = normalizeRepetitionPolicy({ cooldownMs: 500, maxOffersPerTurn: 0 })
    expect(shrunk.cooldownMs).toBe(REPETITION_BOUNDS.minCooldownMs)
    expect(shrunk.maxOffersPerTurn).toBe(REPETITION_BOUNDS.minOffersPerTurn)

    expect(normalizeRepetitionPolicy({ cooldownMs: NaN }).cooldownMs).toBe(DEFAULT_REPETITION_POLICY.cooldownMs)
  })

  it('the ledger cap is bounded by the domain limits even when asked larger', () => {
    expect(emptyCueLedger(999_999).maxEntries).toBe(PERSONALITY_LIMITS.maxLedgerEntries)
    expect(emptyCueLedger(0).maxEntries).toBe(1)
  })
})
