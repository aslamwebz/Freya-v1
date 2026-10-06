import { describe, expect, it } from 'vitest'
import { routePromptIntent } from '../../../src/app/chat/intent'
import { parseSearchRequest } from '../../../core/research/sessions'

describe('global composer intent routing', () => {
  it('treats "find 10 cat videos" as a complete discovery request, not a clarification', () => {
    expect(routePromptIntent('find 10 cat videos', { activeEyeSession: false })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })

    const parsed = parseSearchRequest('find 10 cat videos')
    expect(parsed.intent).toMatchObject({
      subject: 'cat',
      targetCount: 10,
      mediaType: 'video',
      site: null,
    })
  })

  it('does not invent a YouTube requirement when no site was requested', () => {
    const parsed = parseSearchRequest('show me 10 cat videos')
    expect(parsed.intent.site).toBeNull()
    expect(parsed.intent.mediaType).toBe('video')
    expect(parsed.intent.targetCount).toBe(10)
  })

  it('preserves an explicit source constraint when the owner actually supplied one', () => {
    const parsed = parseSearchRequest('find 10 cat videos on YouTube')
    expect(parsed.intent.site).toBe('youtube.com')
  })

  it('keeps obvious Eye refinements on the active session', () => {
    expect(routePromptIntent('only YouTube', { activeEyeSession: true })).toEqual({
      kind: 'eye-follow-up',
      reason: 'search-refinement',
    })
    expect(routePromptIntent('make it 50', { activeEyeSession: true })).toEqual({
      kind: 'eye-follow-up',
      reason: 'search-refinement',
    })
  })

  it('routes explicitly complex research without asking the owner to choose a tool', () => {
    expect(routePromptIntent('deep research the EU AI Act and compare multiple sources', { activeEyeSession: false })).toEqual({
      kind: 'deep-research',
      reason: 'explicit-deep-research',
    })
  })

  it('does not mistake a normal explanation or code request for web discovery', () => {
    expect(routePromptIntent('explain how video compression works', { activeEyeSession: false }).kind).toBe('chat')
    expect(routePromptIntent('find the bug in this PHP function', { activeEyeSession: false }).kind).toBe('chat')
  })

  it('answers a fresh-information question in the conversation, not in a research session', () => {
    // The routing is not cosmetic: `eye-new` opens a multi-iteration session whose
    // result is reported in a research card, so a question that needed looking up
    // produced no answer in the conversation and the owner had nothing to read.
    expect(routePromptIntent('find the latest Laravel news', { activeEyeSession: false })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })
    expect(routePromptIntent('what is the current official Laravel version?', { activeEyeSession: false }).kind).toBe('chat')
    expect(routePromptIntent('use your own browser to open the Laravel docs on queues', { activeEyeSession: false }).kind)
      .toBe('chat')
  })
})
