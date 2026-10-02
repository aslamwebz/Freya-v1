// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PERSONALITY_LIMITS,
  REPETITION_BOUNDS,
  buildExpressionPlan,
  createRelationshipCandidate,
  admitRelationshipItem,
  cueHash,
  emptyCueLedger,
  interpretSocialContext,
  isCueEligible,
  normalizeRepetitionPolicy,
  recordCueUse,
  restoreCueLedger,
  selectCues,
  type CueCandidate,
  type RelationshipItem,
} from '../../../core/personality'

/**
 * Attack family: anti-repetition / oversize abuse.
 *
 * RED-TEAM families 17 (long-context instruction burial) and 24 (exfiltration
 * hidden in harmless-looking actions), against the Slice A boundedness
 * contract: every list has a maximum length and every string a maximum
 * character count, and the repetition policy may be narrowed within bounds
 * by trusted code, never widened past them.
 *
 * The attacks try to widen the repetition policy, flood the candidate list,
 * bury instructions in an oversized input, and replay a future-dated ledger
 * entry to make a rested cue look fresh. The invariant under attack: bounds
 * are clamped as data, excess is dropped and counted, and a use recorded
 * after `at` still counts as "recently used".
 */

const NOW = '2026-10-02T09:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function cueCandidate(cueId: string): CueCandidate {
  return Object.freeze({ cueId, key: cueId, kind: 'inside-joke', confidence: 'low' })
}

function admittedItem(itemId: string): RelationshipItem {
  const created = createRelationshipCandidate({
    itemId,
    kind: 'inside-joke',
    key: itemId,
    text: `poisoned shorthand ${itemId}`,
    tags: ['greeting'],
    cueKind: 'inside-joke',
    source: 'model-inference',
    sourceRef: 'turn-oversize',
    observedAt: NOW,
    recordedAt: NOW,
    proposedConfidence: 'verified',
    actor: 'model',
  })
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.reason)
  const admitted = admitRelationshipItem(created.item, { now: NOW, reason: 'owner reviewed' })
  expect(admitted.ok).toBe(true)
  if (!admitted.ok) throw new Error(admitted.reason)
  return admitted.item
}

describe('attack: the repetition policy is widened past its bounds', () => {
  it('cooldown cannot be narrowed below one hour', () => {
    const policy = normalizeRepetitionPolicy({ cooldownMs: 1 })
    expect(policy.cooldownMs).toBe(REPETITION_BOUNDS.minCooldownMs)
  })

  it('cooldown cannot be widened past ninety days', () => {
    const policy = normalizeRepetitionPolicy({ cooldownMs: 365 * 24 * 60 * 60 * 1_000 })
    expect(policy.cooldownMs).toBe(REPETITION_BOUNDS.maxCooldownMs)
  })

  it('offers per turn cannot exceed the frozen cap', () => {
    const policy = normalizeRepetitionPolicy({ maxOffersPerTurn: 999 })
    expect(policy.maxOffersPerTurn).toBe(PERSONALITY_LIMITS.maxCueOffersPerTurn)
  })

  it('offers per turn cannot go below one', () => {
    const policy = normalizeRepetitionPolicy({ maxOffersPerTurn: 0 })
    expect(policy.maxOffersPerTurn).toBe(REPETITION_BOUNDS.minOffersPerTurn)
  })

  it('non-finite values fall back to the defaults', () => {
    const policy = normalizeRepetitionPolicy({ cooldownMs: Number.NaN, maxOffersPerTurn: Number.POSITIVE_INFINITY })
    expect(policy.cooldownMs).toBe(3 * 24 * 60 * 60 * 1_000)
    expect(policy.maxOffersPerTurn).toBe(2)
  })
})

describe('attack: the candidate list is flooded', () => {
  it('selection caps offers per turn no matter how many are eligible', () => {
    const candidates = Array.from({ length: 50 }, (_, i) => cueCandidate(`flood-${i}`))
    const selection = selectCues(candidates, emptyCueLedger(), NOW)
    expect(selection.offered.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxCueOffersPerTurn)
    expect(selection.held.length).toBe(50 - selection.offered.length)
  })

  it('interpretation caps cue candidates', () => {
    const items: RelationshipItem[] = []
    for (let i = 0; i < PERSONALITY_LIMITS.maxCueCandidates + 20; i++) {
      items.push(admittedItem(`flood-item-${i}`))
    }
    const interpretation = interpretSocialContext({ now: NOW, facts: [], relationship: items })
    expect(interpretation.cueCandidates.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxCueCandidates)
  })

  it('interpretation caps relationship items and interaction facts considered', () => {
    const items: RelationshipItem[] = []
    for (let i = 0; i < PERSONALITY_LIMITS.maxRelationshipItems + 20; i++) {
      items.push(admittedItem(`cap-item-${i}`))
    }
    const interpretation = interpretSocialContext({ now: NOW, facts: [], relationship: items })
    expect(interpretation.counts.admittedItems).toBe(PERSONALITY_LIMITS.maxRelationshipItems)
  })

  it('interpretation caps preference hits and context tokens', () => {
    const items: RelationshipItem[] = []
    for (let i = 0; i < 40; i++) {
      items.push(admittedItem(`hit-item-${i}`))
    }
    const tokens = Array.from({ length: 40 }, (_, i) => `hit-item-${i}`)
    const interpretation = interpretSocialContext({
      now: NOW,
      facts: [],
      relationship: items,
      contextTokens: tokens,
    })
    expect(interpretation.preferenceHits.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxPreferenceHits)
  })
})

describe('attack: a future-dated ledger entry makes a rested cue look fresh', () => {
  it('a use recorded after at still counts as recently used', () => {
    const ledger = recordCueUse(emptyCueLedger(), 'cue-replay', 'inside-joke', NOW)
    const future = new Date(NOW_MS + 60 * 60 * 1_000).toISOString()
    // The conservative reading is "recently used", never "fresh".
    expect(isCueEligible(ledger, 'cue-replay', future, normalizeRepetitionPolicy())).toBe(false)
  })

  it('a cue is offered again only after it has rested', () => {
    const ledger = recordCueUse(emptyCueLedger(), 'cue-rest', 'inside-joke', NOW)
    const within = new Date(NOW_MS + 60_000).toISOString()
    const rested = new Date(NOW_MS + normalizeRepetitionPolicy().cooldownMs + 1_000).toISOString()
    const candidates = [cueCandidate('cue-rest')]
    expect(selectCues(candidates, ledger, within).offered).toEqual([])
    expect(selectCues(candidates, ledger, within).held.length).toBe(1)
    expect(selectCues(candidates, ledger, rested).offered.length).toBe(1)
  })
})

describe('attack: the ledger grows without bound', () => {
  it('recording evicts least-recently-used entries at the cap', () => {
    let ledger = emptyCueLedger()
    for (let i = 0; i < PERSONALITY_LIMITS.maxLedgerEntries + 20; i++) {
      ledger = recordCueUse(ledger, `cue-${i}`, 'inside-joke', new Date(NOW_MS + i * 1_000).toISOString())
    }
    expect(ledger.entries.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxLedgerEntries)
    // The most recent entries survive; the oldest are evicted. The ledger
    // stores hashes, not cue ids, so the comparison is against the hashes.
    const hashes = new Set(ledger.entries.map((e) => e.cueHash))
    expect(hashes.has(cueHash('cue-0'))).toBe(false)
    expect(hashes.has(cueHash(`cue-${PERSONALITY_LIMITS.maxLedgerEntries + 19}`))).toBe(true)
  })

  it('restoring caps entries and validates every field', () => {
    const hostile = {
      schemaVersion: 1,
      maxEntries: 999,
      entries: [
        { cueHash: 'notahash', kind: 'inside-joke', lastUsedAt: NOW, uses: 1 },
        { cueHash: '00000001', kind: 'not-a-kind', lastUsedAt: NOW, uses: 1 },
        { cueHash: '00000002', kind: 'habit', lastUsedAt: 'not-a-date', uses: 1 },
        { cueHash: '00000003', kind: 'habit', lastUsedAt: NOW, uses: 0 },
        { cueHash: '00000004', kind: 'habit', lastUsedAt: NOW, uses: 2_000_000 },
        { cueHash: '00000005', kind: 'greeting', lastUsedAt: NOW, uses: 1 },
      ],
    }
    const restored = restoreCueLedger(hostile)
    expect(restored.maxEntries).toBe(PERSONALITY_LIMITS.maxLedgerEntries)
    expect(restored.entries.length).toBe(1)
    expect(restored.entries[0]?.cueHash).toBe('00000005')
  })
})

describe('attack: an oversized input buries instructions', () => {
  it('guidance lines over the limit are dropped and counted', () => {
    // Flood the interpretation with preference hits so the line list exceeds
    // the guidance cap; the excess must be dropped and counted, never silently
    // truncated into something half-meaningful. The items are preferences
    // (only preference/habit items produce preference hits) that also carry a
    // cue kind, so both the preference lines and the cue lines compete for the
    // same capped guidance budget.
    const items: RelationshipItem[] = []
    for (let i = 0; i < PERSONALITY_LIMITS.maxPreferenceHits + 10; i++) {
      const created = createRelationshipCandidate({
        itemId: `drop-item-${i}`,
        kind: 'preference',
        key: `drop-item-${i}`,
        text: `poisoned preference ${i}`,
        tags: ['greeting'],
        cueKind: 'inside-joke',
        source: 'model-inference',
        sourceRef: 'turn-oversize',
        observedAt: NOW,
        recordedAt: NOW,
        proposedConfidence: 'verified',
        actor: 'model',
      })
      expect(created.ok).toBe(true)
      if (!created.ok) throw new Error(created.reason)
      const admitted = admitRelationshipItem(created.item, { now: NOW, reason: 'owner reviewed' })
      expect(admitted.ok).toBe(true)
      if (!admitted.ok) throw new Error(admitted.reason)
      items.push(admitted.item)
    }
    const interpretation = interpretSocialContext({
      now: NOW,
      facts: [],
      relationship: items,
      contextTokens: ['greeting'],
    })
    const plan = buildExpressionPlan({ interpretation, at: NOW })
    expect(plan.guidance.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxGuidanceLines)
    expect(plan.droppedLineCount).toBeGreaterThan(0)
    for (const line of plan.guidance) {
      expect(line.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxGuidanceLineChars)
    }
  })

  it('cue references are capped even when many cues are offered', () => {
    const items: RelationshipItem[] = []
    for (let i = 0; i < PERSONALITY_LIMITS.maxCueCandidates + 10; i++) {
      items.push(admittedItem(`ref-item-${i}`))
    }
    const interpretation = interpretSocialContext({ now: NOW, facts: [], relationship: items })
    const plan = buildExpressionPlan({ interpretation, at: NOW })
    expect(plan.cueReferences.length).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxCueCandidates)
  })
})
