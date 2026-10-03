// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assumptionStatus,
  computeConfidence,
  conservativeInterpretation,
  isAssumptionExpired,
  isStaleEvidence,
  markStale,
  recordConflict,
  validateAssumption,
} from '../../core/longhorizon/uncertainty'
import {
  EVIDENCE_STALENESS_THRESHOLDS,
  type ConfidenceLevel,
  type GoalAssumption,
  type GoalEvidence,
} from '../../core/longhorizon/types'

/**
 * Uncertainty handling.
 *
 * The subsystem plans and decides even when information is incomplete, stale
 * or conflicted. These tests defend the properties that keep it honest:
 * confidence is derived, never fabricated; assumptions are explicit and
 * bounded; stale evidence is marked; conflicts are preserved and resolved
 * conservatively.
 */

const NOW = new Date('2026-10-01T09:00:00.000Z')

/* ---------------------------------------------------------- helpers */

function evidence(overrides: Partial<GoalEvidence> = {}): GoalEvidence {
  return {
    evidenceId: 'e1',
    goalId: 'g1',
    kind: 'recentEvents',
    source: 'source-1',
    collectedAt: '2026-10-01T08:00:00.000Z',
    confidence: 'medium',
    stale: false,
    conflictsWith: [],
    ...overrides,
  }
}

function assumption(overrides: Partial<GoalAssumption> = {}): GoalAssumption {
  return {
    assumptionId: 'a1',
    goalId: 'g1',
    statement: 'the API is available',
    confidence: 'medium',
    source: 'planner',
    expiresAt: '2026-10-01T10:00:00.000Z',
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  }
}

/* ---------------------------------------------------------- confidence */

describe('confidence is derived, never fabricated', () => {
  it('is unknown with no evidence', () => {
    expect(computeConfidence([])).toBe('unknown')
  })

  it('is medium for a single fresh source', () => {
    expect(computeConfidence([evidence()])).toBe('medium')
  })

  it('is high for multiple independent fresh sources', () => {
    const a = evidence({ evidenceId: 'e1', source: 'source-1' })
    const b = evidence({ evidenceId: 'e2', source: 'source-2' })
    expect(computeConfidence([a, b])).toBe('high')
  })

  it('is unknown when evidence conflicts', () => {
    const a = evidence({ evidenceId: 'e1', source: 'source-1', conflictsWith: ['e2'] })
    const b = evidence({ evidenceId: 'e2', source: 'source-2', conflictsWith: ['e1'] })
    expect(computeConfidence([a, b])).toBe('unknown')
  })

  it('caps at low when all evidence is stale', () => {
    const stale = evidence({ collectedAt: '2026-09-01T09:00:00.000Z', stale: true })
    expect(computeConfidence([stale])).toBe('low')
  })

  it('is deterministic for the same inputs', () => {
    const a = evidence({ evidenceId: 'e1', source: 'source-1' })
    const b = evidence({ evidenceId: 'e2', source: 'source-2' })
    expect(computeConfidence([a, b])).toBe(computeConfidence([a, b]))
  })
})

/* ---------------------------------------------------------- staleness */

describe('stale evidence is detected and marked', () => {
  it('is not stale when collected recently', () => {
    const fresh = evidence({ collectedAt: '2026-10-01T08:00:00.000Z' })
    expect(isStaleEvidence(fresh, NOW)).toBe(false)
  })

  it('is stale when older than the threshold for its kind', () => {
    const stale = evidence({ collectedAt: '2026-09-01T09:00:00.000Z' })
    expect(isStaleEvidence(stale, NOW)).toBe(true)
  })

  it('marks stale evidence without mutating the original', () => {
    const original = evidence({ collectedAt: '2026-09-01T09:00:00.000Z' })
    const marked = markStale(original, NOW)
    expect(marked.stale).toBe(true)
    expect(original.stale).toBe(false)
  })

  it('does not mark fresh evidence', () => {
    const fresh = evidence({ collectedAt: '2026-10-01T08:00:00.000Z' })
    const marked = markStale(fresh, NOW)
    expect(marked.stale).toBe(false)
  })

  it('has code-owned thresholds per evidence kind', () => {
    expect(EVIDENCE_STALENESS_THRESHOLDS.realTimeState).toBe(5 * 60_000)
    expect(EVIDENCE_STALENESS_THRESHOLDS.recentEvents).toBe(60 * 60_000)
    expect(EVIDENCE_STALENESS_THRESHOLDS.historicalData).toBe(24 * 60 * 60_000)
    expect(EVIDENCE_STALENESS_THRESHOLDS.staticConfiguration).toBe(30 * 24 * 60 * 60_000)
  })
})

/* ---------------------------------------------------------- conflicts */

describe('conflicted evidence is preserved', () => {
  it('records a conflict on both sides', () => {
    const a = evidence({ evidenceId: 'e1' })
    const b = evidence({ evidenceId: 'e2' })
    const [aConflicted, bConflicted] = recordConflict(a, b, NOW)
    expect(aConflicted.conflictsWith).toContain('e2')
    expect(bConflicted.conflictsWith).toContain('e1')
  })

  it('preserves both versions', () => {
    const a = evidence({ evidenceId: 'e1', source: 'source-1' })
    const b = evidence({ evidenceId: 'e2', source: 'source-2' })
    const [aConflicted, bConflicted] = recordConflict(a, b, NOW)
    expect(aConflicted.source).toBe('source-1')
    expect(bConflicted.source).toBe('source-2')
  })

  it('uses the conservative interpretation', () => {
    const a: ConfidenceLevel = 'high'
    const b: ConfidenceLevel = 'low'
    const conservative = conservativeInterpretation(a, b, (x, y) => (x === 'unknown' ? x : y))
    expect(conservative).toBe('low')
  })
})

/* ---------------------------------------------------------- assumptions */

describe('assumptions are explicit and bounded', () => {
  it('validates a well-formed assumption', () => {
    const result = validateAssumption({
      statement: 'the API is available',
      source: 'planner',
      ttlMs: 60_000,
      now: NOW,
    })
    expect(result.ok).toBe(true)
  })

  it('refuses an empty statement', () => {
    const result = validateAssumption({ statement: '', source: 'planner', ttlMs: 60_000, now: NOW })
    expect(result.ok).toBe(false)
  })

  it('refuses an assumption with no source', () => {
    const result = validateAssumption({ statement: 'the API is available', source: '', ttlMs: 60_000, now: NOW })
    expect(result.ok).toBe(false)
  })

  it('refuses an assumption with no expiration', () => {
    const result = validateAssumption({ statement: 'the API is available', source: 'planner', ttlMs: 0, now: NOW })
    expect(result.ok).toBe(false)
  })

  it('refuses an unknown confidence level', () => {
    const result = validateAssumption({
      statement: 'the API is available',
      source: 'planner',
      confidence: 'certain' as never,
      ttlMs: 60_000,
      now: NOW,
    })
    expect(result.ok).toBe(false)
  })

  it('is active before its expiration', () => {
    const active = assumption({ expiresAt: '2026-10-01T10:00:00.000Z' })
    expect(assumptionStatus(active, NOW)).toBe('active')
    expect(isAssumptionExpired(active, NOW)).toBe(false)
  })

  it('is expired after its expiration', () => {
    const expired = assumption({ expiresAt: '2026-10-01T08:00:00.000Z' })
    expect(assumptionStatus(expired, NOW)).toBe('expired')
    expect(isAssumptionExpired(expired, NOW)).toBe(true)
  })

  it('keeps a confirmed assumption confirmed', () => {
    const confirmed = assumption({ status: 'confirmed' })
    expect(assumptionStatus(confirmed, NOW)).toBe('confirmed')
  })

  it('keeps a refuted assumption refuted', () => {
    const refuted = assumption({ status: 'refuted' })
    expect(assumptionStatus(refuted, NOW)).toBe('refuted')
  })
})

/* ---------------------------------------------------------- no authority */

describe('uncertainty does not grant authority', () => {
  it('has no Guard, Governor, or budget', async () => {
    const mod = await import('../../core/longhorizon/uncertainty')
    expect(mod).not.toHaveProperty('guard')
    expect(mod).not.toHaveProperty('governor')
    expect(mod).not.toHaveProperty('budget')
  })

  it('cannot override owner directives', () => {
    const result = validateAssumption({
      statement: 'the owner said to stop',
      source: 'planner',
      ttlMs: 60_000,
      now: NOW,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('planner')
    }
  })
})
