// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  projectExecutiveState,
  createExecutiveItem,
  isConfidenceHonest,
  boundList,
  boundString,
  type ProjectionContext,
} from '../../../core/executive'

const NOW = '2026-10-01T12:00:00.000Z'

function makeContext(over: Partial<ProjectionContext> = {}): ProjectionContext {
  return {
    now: NOW,
    prioritization: {
      ranked: [],
      blocked: [],
      deferred: [],
      assumptions: [],
      generatedAt: NOW,
    },
    plans: [],
    confidence: 'high',
    ...over,
  }
}

describe('projectExecutiveState', () => {
  it('produces an empty state when no items exist', () => {
    const context = makeContext()
    const state = projectExecutiveState(context)
    expect(state.whatMatters.length).toBe(0)
    expect(state.nextBoundedAction).toBeNull()
  })

  it('includes ranked items in whatMatters', () => {
    const context = makeContext({
      prioritization: {
        ranked: [
          {
            itemId: 'item-1',
            kind: 'run',
            priority: 'critical',
            urgency: 'immediate',
            importance: 'critical',
            score: 0.95,
            reasoning: ['owner_override'],
            nextBoundedAction: {
              actionId: 'action-1',
              kind: 'execute',
              target: 'item-1',
              deadlineAt: NOW,
              maxDurationMs: 60_000,
              maxAttempts: 3,
            },
          },
        ],
        blocked: [],
        deferred: [],
        assumptions: [],
        generatedAt: NOW,
      },
    })
    const state = projectExecutiveState(context)
    expect(state.whatMatters.length).toBe(1)
    expect(state.whatMatters[0]?.itemId).toBe('item-1')
  })

  it('includes blocked items in whatIsBlocked', () => {
    const context = makeContext({
      prioritization: {
        ranked: [],
        blocked: [
          {
            itemId: 'blocked-1',
            kind: 'run',
            blocker: { type: 'stop-all' },
            reasoning: ['stop-all-active'],
          },
        ],
        deferred: [],
        assumptions: [],
        generatedAt: NOW,
      },
    })
    const state = projectExecutiveState(context)
    expect(state.whatIsBlocked.length).toBe(1)
    expect(state.whatIsBlocked[0]).toContain('blocked-1')
  })

  it('is deterministic', () => {
    const context = makeContext()
    const s1 = projectExecutiveState(context)
    const s2 = projectExecutiveState(context)
    expect(s1).toEqual(s2)
  })
})

describe('createExecutiveItem', () => {
  it('creates an executive item with bounded fields', () => {
    const item = createExecutiveItem(
      'item-1',
      'run',
      'a'.repeat(300),
      ['reason-1'],
      ['evidence-1'],
      'high',
    )
    expect(item.itemId).toBe('item-1')
    expect(item.summary.length).toBeLessThanOrEqual(256)
  })
})

describe('isConfidenceHonest', () => {
  it('returns false for high confidence with insufficient evidence', () => {
    const item = createExecutiveItem('item-1', 'run', 'test', [], [], 'high')
    expect(isConfidenceHonest(item, 1)).toBe(false)
  })

  it('returns true for high confidence with sufficient evidence', () => {
    const item = createExecutiveItem('item-1', 'run', 'test', [], [], 'high')
    expect(isConfidenceHonest(item, 2)).toBe(true)
  })
})

describe('boundList', () => {
  it('bounds a list to the maximum length', () => {
    const items = [1, 2, 3, 4, 5]
    expect(boundList(items, 3).length).toBe(3)
  })
})

describe('boundString', () => {
  it('bounds a string to the maximum length', () => {
    expect(boundString('a'.repeat(300), 256).length).toBe(256)
  })
})
