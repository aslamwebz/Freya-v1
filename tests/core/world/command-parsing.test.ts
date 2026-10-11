import { describe, expect, it } from 'vitest'
import { worldGraphOptionsFrom, worldKindFrom } from '../../../core/world/command-parsing'

describe('World command payload parsing', () => {
  it('accepts only known kinds and distinguishes an omitted kind from an invalid one', () => {
    expect(worldKindFrom(undefined)).toBeNull()
    expect(worldKindFrom('person')).toBe('person')
    expect(worldKindFrom('unicorn')).toBeUndefined()
    expect(worldKindFrom(42)).toBeUndefined()
  })

  it('keeps graph reads bounded and refuses unknown or unbounded options', () => {
    expect(worldGraphOptionsFrom(undefined)).toEqual({ focusEntityId: null, kinds: null, maxDepth: 1 })
    expect(worldGraphOptionsFrom({ focusEntityId: 'person-1', kinds: ['person'], maxDepth: 2 })).toEqual({
      focusEntityId: 'person-1',
      kinds: ['person'],
      maxDepth: 2,
    })
    expect(worldGraphOptionsFrom({ maxDepth: 3 })).toEqual({ refusal: 'maxDepth is 0, 1 or 2' })
    expect(worldGraphOptionsFrom({ query: '*'})).toEqual({ refusal: 'a graph read accepts only focusEntityId, kinds and maxDepth' })
  })
})
