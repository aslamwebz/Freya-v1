import { describe, expect, it } from 'vitest'
import { routeEyePrompt } from '../../../src/app/chat/modes'

describe('routeEyePrompt', () => {
  it('creates the first Eye session without trimming the owner prompt', () => {
    expect(routeEyePrompt(null, '  find 100 cat videos  ')).toEqual({
      kind: 'create',
      text: '  find 100 cat videos  ',
    })
  })

  it('keeps ordinary corrections and follow-ups on the active Eye session', () => {
    const sessionId = 'eye-123'

    expect(routeEyePrompt(sessionId, 'make it 50')).toEqual({
      kind: 'follow-up',
      sessionId,
      text: 'make it 50',
    })
    expect(routeEyePrompt(sessionId, 'only YouTube')).toEqual({
      kind: 'follow-up',
      sessionId,
      text: 'only YouTube',
    })
    expect(routeEyePrompt(sessionId, 'find only images')).toEqual({
      kind: 'follow-up',
      sessionId,
      text: 'find only images',
    })
    expect(routeEyePrompt(sessionId, 'show me ones in the barn')).toEqual({
      kind: 'follow-up',
      sessionId,
      text: 'show me ones in the barn',
    })
  })

  it('creates a new session only for an explicit new-search command', () => {
    const sessionId = 'eye-123'

    expect(routeEyePrompt(sessionId, 'start new search for barn cats')).toEqual({
      kind: 'create',
      text: 'start new search for barn cats',
    })
    expect(routeEyePrompt(sessionId, 'please begin a new eye: alpine cabins')).toEqual({
      kind: 'create',
      text: 'please begin a new eye: alpine cabins',
    })
    expect(routeEyePrompt(sessionId, 'new search - electric vans')).toEqual({
      kind: 'create',
      text: 'new search - electric vans',
    })
  })
})
