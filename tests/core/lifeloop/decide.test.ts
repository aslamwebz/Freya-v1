import { describe, expect, it } from 'vitest'
import {
  DECIDE_ESCALATION,
  DECIDE_OUTCOMES,
  OWNER_ESCALATIONS,
  escalationRank,
  isEscalating,
  resolveEscalation,
  type DecideOutcome,
  type FocusState,
} from '../../../core/lifeloop'
import { FOCUSED, UNFOCUSED } from './fixture'

/**
 * The decide step, tested as the place where Freya takes something away from the
 * owner.
 *
 * The closed vocabulary, the ordered ladder, and the one rule that can push an
 * escalation down.
 */

describe('the decide vocabulary is closed and ordered', () => {
  it('is exactly the five outcomes the phase promised', () => {
    expect([...DECIDE_OUTCOMES]).toEqual(['do-nothing', 'remember', 'subtle-cue', 'speak', 'interrupt'])
  })

  it('maps every outcome onto a known escalation', () => {
    for (const outcome of DECIDE_OUTCOMES) {
      expect(OWNER_ESCALATIONS, outcome).toContain(DECIDE_ESCALATION[outcome])
    }
  })

  it('treats do-nothing and remember as the two silent outcomes', () => {
    expect(isEscalating('do-nothing')).toBe(false)
    expect(isEscalating('remember')).toBe(false)
    expect(isEscalating('subtle-cue')).toBe(true)
    expect(isEscalating('speak')).toBe(true)
    expect(isEscalating('interrupt')).toBe(true)
  })

  it('ranks the ladder strictly, so "louder" is a comparison and not a feeling', () => {
    const ranks = OWNER_ESCALATIONS.map(escalationRank)
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index], OWNER_ESCALATIONS[index]).toBeGreaterThan(ranks[index - 1] ?? 0)
    }
  })
})

describe('a quiet decision stays quiet', () => {
  it('reaches for nothing, whatever the owner is doing', () => {
    for (const focused of [true, false]) {
      for (const outcome of ['do-nothing', 'remember'] as const) {
        const resolved = resolveEscalation(outcome, focus(focused))
        expect(resolved, `${outcome}/${focused}`).toMatchObject({
          outcome,
          escalation: 'none',
          suppressed: false,
          code: 'not-escalating',
        })
      }
    }
  })
})

describe('focus suppresses interruption and nothing else', () => {
  it('holds back an interrupt while the owner is mid-task', () => {
    const resolved = resolveEscalation('interrupt', FOCUSED)
    expect(resolved).toMatchObject({
      outcome: 'do-nothing',
      escalation: 'none',
      suppressed: true,
      code: 'focus-suppressed-interrupt',
    })
  })

  it('lets a cue and a word through even while the owner is mid-task', () => {
    // Suppressing these would be silence the owner never agreed to. Only the
    // thing that takes them away from what they are doing is held back.
    for (const outcome of ['subtle-cue', 'speak'] as const) {
      expect(resolveEscalation(outcome, FOCUSED), outcome).toMatchObject({
        outcome,
        suppressed: false,
        code: 'escalation-permitted',
      })
    }
  })

  it('lets an interrupt through when the owner is free', () => {
    expect(resolveEscalation('interrupt', UNFOCUSED)).toMatchObject({
      outcome: 'interrupt',
      escalation: 'interrupt',
      suppressed: false,
      code: 'escalation-permitted',
    })
  })

  it('is idempotent: resolving a suppressed interrupt again stays quiet', () => {
    const once = resolveEscalation('interrupt', FOCUSED)
    const twice = resolveEscalation(once.outcome, FOCUSED)
    expect(twice).toMatchObject({ outcome: 'do-nothing', escalation: 'none' })
  })
})

describe('STOP ALL outranks every decision', () => {
  it('says nothing at all, however loud the decision was', () => {
    for (const outcome of DECIDE_OUTCOMES) {
      const resolved = resolveEscalation(outcome, UNFOCUSED, true)
      expect(resolved, outcome).toMatchObject({
        outcome: 'do-nothing',
        escalation: 'none',
        code: 'owner-stopped',
      })
    }
  })

  it('records that something was suppressed, so the journal does not read as silence', () => {
    expect(resolveEscalation('speak', UNFOCUSED, true).suppressed).toBe(true)
    expect(resolveEscalation('do-nothing', UNFOCUSED, true).suppressed).toBe(false)
  })
})

describe('the escalation ladder is monotonic', () => {
  it('never returns an outcome louder than the one it was given', () => {
    const focus: FocusState = FOCUSED
    for (const outcome of DECIDE_OUTCOMES) {
      const requested = escalationRank(DECIDE_ESCALATION[outcome])
      const granted = escalationRank(resolveEscalation(outcome, focus).escalation)
      expect(granted, outcome).toBeLessThanOrEqual(requested)
    }
  })

  it('only ever downgrades to the quietest outcome, never sideways', () => {
    // A suppressed interrupt becomes do-nothing, not speak. Speaking would be the
    // loop deciding something new — and deciding to speak is itself a cognition,
    // which needs a wake it has not had.
    for (const outcome of DECIDE_OUTCOMES) {
      const resolved = resolveEscalation(outcome as DecideOutcome, FOCUSED)
      if (resolved.suppressed) expect(resolved.outcome).toBe('do-nothing')
    }
  })
})

function focus(focused: boolean): FocusState {
  return focused ? FOCUSED : UNFOCUSED
}