// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  computeUrgency,
  computeScore,
  scoreToTier,
  collectSignals,
  determineReason,
  assessItem,
  determineBlocker,
  prioritize,
  instantMs,
  type WorkItemMetadata,
  type PrioritizerContext,
} from '../../../core/executive'

const NOW = '2026-10-01T12:00:00.000Z'

function makeItem(over: Partial<WorkItemMetadata> = {}): WorkItemMetadata {
  return {
    itemId: 'item-1',
    kind: 'run',
    createdAt: NOW,
    deadlineAt: null,
    ownerImportance: 'normal',
    ownerIntent: 'none',
    dependencies: [],
    dependentCount: 0,
    evidenceState: 'fresh',
    confidence: 'high',
    verificationPending: false,
    approvalPending: false,
    budgetExhausted: false,
    stopAllActive: false,
    ...over,
  }
}

function makeContext(items: readonly WorkItemMetadata[]): PrioritizerContext {
  return {
    now: NOW,
    items,
    evidence: [],
    activeItemIds: new Set(),
  }
}

describe('computeUrgency', () => {
  it('returns whenever when no deadline is set', () => {
    expect(computeUrgency(null, NOW)).toBe('whenever')
  })

  it('returns immediate when deadline is within urgent window', () => {
    const deadline = new Date(instantMs(NOW)! + 30 * 60 * 1000).toISOString()
    expect(computeUrgency(deadline, NOW)).toBe('immediate')
  })

  it('returns soon when deadline is within elevated window', () => {
    const deadline = new Date(instantMs(NOW)! + 12 * 60 * 60 * 1000).toISOString()
    expect(computeUrgency(deadline, NOW)).toBe('soon')
  })

  it('returns normal when deadline is within normal window', () => {
    const deadline = new Date(instantMs(NOW)! + 48 * 60 * 60 * 1000).toISOString()
    expect(computeUrgency(deadline, NOW)).toBe('normal')
  })

  it('returns later when deadline is beyond normal window', () => {
    const deadline = new Date(instantMs(NOW)! + 7 * 24 * 60 * 60 * 1000).toISOString()
    expect(computeUrgency(deadline, NOW)).toBe('later')
  })
})

describe('computeScore', () => {
  it('returns a score bounded [0, 1]', () => {
    const item = makeItem()
    const score = computeScore(item, NOW, new Set())
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns a higher score for critical items', () => {
    const critical = makeItem({ ownerImportance: 'critical', ownerIntent: 'priority' })
    const normal = makeItem({ ownerImportance: 'normal', ownerIntent: 'none' })
    const criticalScore = computeScore(critical, NOW, new Set())
    const normalScore = computeScore(normal, NOW, new Set())
    expect(criticalScore).toBeGreaterThan(normalScore)
  })
})

describe('scoreToTier', () => {
  it('maps scores to tiers correctly', () => {
    expect(scoreToTier(0.95)).toBe('critical')
    expect(scoreToTier(0.75)).toBe('high')
    expect(scoreToTier(0.5)).toBe('normal')
    expect(scoreToTier(0.2)).toBe('low')
    expect(scoreToTier(0.05)).toBe('deferred')
  })
})

describe('collectSignals', () => {
  it('collects owner-explicit signal for priority intent', () => {
    const item = makeItem({ ownerIntent: 'priority' })
    const signals = collectSignals(item, NOW, new Set())
    expect(signals).toContain('owner-explicit')
  })

  it('collects deadline-imminent signal for urgent deadlines', () => {
    const deadline = new Date(instantMs(NOW)! + 30 * 60 * 1000).toISOString()
    const item = makeItem({ deadlineAt: deadline })
    const signals = collectSignals(item, NOW, new Set())
    expect(signals).toContain('deadline-imminent')
  })

  it('collects dependency-blocked signal only while the dependency is active', () => {
    const item = makeItem({ dependencies: ['dep-1'] })
    expect(collectSignals(item, NOW, new Set(['dep-1']))).toContain('dependency-blocked')
    // A dependency that has completed is met, and no longer blocks.
    expect(collectSignals(item, NOW, new Set())).not.toContain('dependency-blocked')
  })
})

describe('determineReason', () => {
  it('returns owner_override for priority intent', () => {
    const item = makeItem({ ownerIntent: 'priority' })
    expect(determineReason(item, NOW, new Set())).toBe('owner_override')
  })

  it('returns deadline_within_urgent_window for urgent deadlines', () => {
    const deadline = new Date(instantMs(NOW)! + 30 * 60 * 1000).toISOString()
    const item = makeItem({ deadlineAt: deadline })
    expect(determineReason(item, NOW, new Set())).toBe('deadline_within_urgent_window')
  })

  it('returns no_signals for normal items', () => {
    const item = makeItem()
    expect(determineReason(item, NOW, new Set())).toBe('no_signals')
  })
})

describe('assessItem', () => {
  it('produces a deterministic assessment', () => {
    const item = makeItem()
    const context = makeContext([item])
    const a1 = assessItem(item, context)
    const a2 = assessItem(item, context)
    expect(a1).toEqual(a2)
  })

  it('includes signals and reason', () => {
    const item = makeItem({ ownerIntent: 'priority' })
    const context = makeContext([item])
    const assessment = assessItem(item, context)
    expect(assessment.signals).toContain('owner-explicit')
    expect(assessment.reason).toBe('owner_override')
  })
})

describe('determineBlocker', () => {
  it('returns stop-all when STOP ALL is active', () => {
    const item = makeItem({ stopAllActive: true })
    expect(determineBlocker(item)).toEqual({ type: 'stop-all' })
  })

  it('returns budget-exhausted when budget is exhausted', () => {
    const item = makeItem({ budgetExhausted: true })
    expect(determineBlocker(item)).toEqual({ type: 'budget-exhausted', grantId: 'unknown' })
  })

  it('returns null when no blocker exists', () => {
    const item = makeItem()
    expect(determineBlocker(item)).toBeNull()
  })

  it('blocks only while a dependency is still active', () => {
    const item = makeItem({ dependencies: ['dep-1', 'dep-2'] })
    expect(determineBlocker(item, new Set(['dep-1']))).toEqual({
      type: 'dependency-unmet',
      dependsOn: ['dep-1'],
    })
    expect(determineBlocker(item, new Set())).toBeNull()
  })

  it('holds conflicted evidence in a blocked state', () => {
    const item = makeItem({ evidenceState: 'conflicted' })
    expect(determineBlocker(item)).toEqual({ type: 'conflicted-evidence' })
  })

  it('does not block stale evidence, only conflicted', () => {
    const item = makeItem({ evidenceState: 'stale' })
    expect(determineBlocker(item)).toBeNull()
  })

  it('expires a deadline against the injected clock, not creation', () => {
    const item = makeItem({
      createdAt: '2026-10-01T00:00:00.000Z',
      deadlineAt: '2026-10-01T06:00:00.000Z',
    })
    expect(determineBlocker(item, new Set(), '2026-10-01T05:00:00.000Z')).toBeNull()
    expect(determineBlocker(item, new Set(), '2026-10-01T07:00:00.000Z')).toEqual({
      type: 'deadline-expired',
      deadlineAt: '2026-10-01T06:00:00.000Z',
    })
  })
})

describe('prioritize', () => {
  it('ranks items by score descending', () => {
    const critical = makeItem({ itemId: 'critical', ownerImportance: 'critical', ownerIntent: 'priority' })
    const normal = makeItem({ itemId: 'normal', ownerImportance: 'normal', ownerIntent: 'none' })
    const context = makeContext([normal, critical])
    const result = prioritize(context)
    expect(result.ranked[0]?.itemId).toBe('critical')
    expect(result.ranked[1]?.itemId).toBe('normal')
  })

  it('is deterministic', () => {
    const item1 = makeItem({ itemId: 'item-1' })
    const item2 = makeItem({ itemId: 'item-2' })
    const context = makeContext([item1, item2])
    const r1 = prioritize(context)
    const r2 = prioritize(context)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  it('separates blocked items', () => {
    const blocked = makeItem({ itemId: 'blocked', stopAllActive: true })
    const normal = makeItem({ itemId: 'normal' })
    const context = makeContext([blocked, normal])
    const result = prioritize(context)
    expect(result.blocked.length).toBe(1)
    expect(result.ranked.length).toBe(1)
  })

  it('separates deferred items', () => {
    const deferred = makeItem({ itemId: 'deferred', ownerIntent: 'defer' })
    const normal = makeItem({ itemId: 'normal' })
    const context = makeContext([deferred, normal])
    const result = prioritize(context)
    expect(result.deferred.length).toBe(1)
    expect(result.ranked.length).toBe(1)
  })

  it('breaks ties by createdAt then itemId', () => {
    const item1 = makeItem({ itemId: 'a', createdAt: '2026-10-01T10:00:00.000Z' })
    const item2 = makeItem({ itemId: 'b', createdAt: '2026-10-01T11:00:00.000Z' })
    const context = makeContext([item2, item1])
    const result = prioritize(context)
    expect(result.ranked[0]?.itemId).toBe('a')
    expect(result.ranked[1]?.itemId).toBe('b')
  })

  it('does not block an item whose dependencies have completed', () => {
    const item = makeItem({ itemId: 'dependent', dependencies: ['done-1'] })
    const context: PrioritizerContext = {
      now: NOW,
      items: [item],
      evidence: [],
      activeItemIds: new Set(),
    }
    const result = prioritize(context)
    expect(result.blocked.length).toBe(0)
    expect(result.ranked[0]?.itemId).toBe('dependent')
  })

  it('blocks an item while its dependency is still active', () => {
    const item = makeItem({ itemId: 'dependent', dependencies: ['live-1'] })
    const context: PrioritizerContext = {
      now: NOW,
      items: [item],
      evidence: [],
      activeItemIds: new Set(['live-1']),
    }
    const result = prioritize(context)
    expect(result.blocked[0]?.blocker).toEqual({ type: 'dependency-unmet', dependsOn: ['live-1'] })
  })

  it('holds conflicted evidence in the blocked list', () => {
    const item = makeItem({ itemId: 'conflicted', evidenceState: 'conflicted' })
    const result = prioritize(makeContext([item]))
    expect(result.blocked[0]?.blocker).toEqual({ type: 'conflicted-evidence' })
    expect(result.ranked.length).toBe(0)
  })
})
