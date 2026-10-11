// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { turnExperienceRecord } from '../../core/brain/turn-experience'
import type { TurnExperience } from '../../core/mind/turn-types'

const base: TurnExperience = {
  conversationId: 'conversation-1', turnId: 'turn-1',
  startedAt: '2026-10-11T10:00:00Z', endedAt: '2026-10-11T10:00:10Z',
  outcome: 'completed', reason: null, providerId: 'fixture', model: 'fixture-model',
  providerContacted: true, requestLength: 40, answerLength: 120,
  referenceUsed: false, referenceItemCount: 0, answerPersisted: true,
}
describe('truthful Brain experience metadata', () => {
  it('records real tool names, success, failures and denials without copying prompts or arguments', () => {
    const result = turnExperienceRecord({ ...base, toolSteps: [
      { name: 'web_search', capability: 'search.web', outcome: 'ok', executed: true },
      { name: 'browser_read', capability: 'browser.read', outcome: 'failed', executed: true },
      { name: 'mail_send', capability: 'mail.send', outcome: 'denied', executed: false },
    ] })
    expect(result.toolsUsed).toEqual(['web_search', 'browser_read'])
    expect(result.actions.map(action => action.outcome)).toEqual(['succeeded', 'succeeded', 'failed', 'skipped'])
    expect(JSON.stringify(result)).not.toContain('private user text')
    expect('verification' in result).toBe(false)
    expect(result.evidenceRefs).toEqual(['turn-1'])
  })

  it('never describes a completed conversation as a verified task outcome', () => {
    const result = turnExperienceRecord(base)
    expect(result.toolsUsed).toEqual([])
    expect(result.humanCorrection).toBeNull()
    expect(result.evidenceRefs).toEqual(['turn-1'])
  })
})
