// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  EXPRESSION_CUE_LABELS,
  MAX_EXPRESSION_CUE_CHARS,
  expressionCueLine,
  projectionCueLine,
} from '../../src/presence/expressionCue'
import { CUE_KINDS } from '../../core/personality/types'
import {
  ABSENT_PERSONALITY_PROJECTION,
  type PersonalityCueView,
} from '../../core/protocol/personality'

/**
 * The one expression cue Presence is allowed to draw.
 *
 * Small module, sharp edges: the line it produces is bounded and closed, it
 * is derived from a Core projection rather than supplied by a caller, and a
 * cue anti-repetition is holding draws nothing at all.
 */

function cue(over: Partial<PersonalityCueView> = {}): PersonalityCueView {
  return { cueId: 'cue-hash-7f3a', kind: 'greeting', mode: 'offer', ...over }
}

describe('the label table is closed', () => {
  it('covers exactly the domain’s cue kinds, and nothing else', () => {
    expect([...Object.keys(EXPRESSION_CUE_LABELS)].sort()).toEqual([...CUE_KINDS].sort())
    expect(Object.isFrozen(EXPRESSION_CUE_LABELS)).toBe(true)
    for (const kind of CUE_KINDS) {
      expect(EXPRESSION_CUE_LABELS[kind].length).toBeGreaterThan(0)
    }
  })

  it('answers a kind the domain does not have with the literal string it was handed', () => {
    // Display only, never parsed: an unknown kind does not silently become a
    // known one, and nothing here invents a fifth label to cope with it.
    expect(EXPRESSION_CUE_LABELS['fan-mail' as never]).toBeUndefined()
  })
})

describe('what the cue line says', () => {
  it('names the kind Core chose, in one bounded line', () => {
    for (const kind of CUE_KINDS) {
      const line = expressionCueLine(cue({ kind }))
      expect(line).toBe(`Expression cue: ${EXPRESSION_CUE_LABELS[kind]}`)
      expect(line!.length).toBeLessThanOrEqual(MAX_EXPRESSION_CUE_CHARS)
      // The words come from the table, not from the record the cue belongs to.
      expect(line).toMatch(/^Expression cue: /)
    }
  })

  it('draws nothing for a held cue — the ledger suppressed it', () => {
    // Anti-repetition holds a cue because Freya used it too recently.
    // Showing it anyway would express the gesture the ledger just suppressed.
    expect(expressionCueLine(cue({ mode: 'hold' }))).toBeNull()
    expect(projectionCueLine({ ...ABSENT_PERSONALITY_PROJECTION, presenceCue: cue({ mode: 'hold' }) })).toBeNull()
  })

  it('draws nothing when Core offered no cue', () => {
    expect(expressionCueLine(null)).toBeNull()
    expect(projectionCueLine(null)).toBeNull()
    expect(projectionCueLine(ABSENT_PERSONALITY_PROJECTION)).toBeNull()
  })

  it('reads the same straight off a projection Core built', () => {
    const projection = { ...ABSENT_PERSONALITY_PROJECTION, presenceCue: cue({ kind: 'inside-joke' }) }
    expect(projectionCueLine(projection)).toBe('Expression cue: inside joke')
    // The cue's identity crosses as a hash; nothing here echoes it back.
    expect(projectionCueLine(projection)).not.toContain('7f3a')
  })
})
