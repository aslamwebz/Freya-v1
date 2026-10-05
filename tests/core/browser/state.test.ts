import { describe, expect, it } from 'vitest'
import {
  browserProjection,
  browserRecoveryReport,
  foldBrowserState,
  liveSessionCount,
  nextSessionId,
  openHandoffCount,
  pageIdFor,
  recoveryNeedsAttention,
} from '../../../core/browser'

const AT = '2026-01-01T00:00:00.000Z'

function opened(sessionId: string, target = 'public') {
  return { type: 'browser.dual.session.opened', payload: { sessionId, target, at: AT } }
}
function replaced(sessionId: string, revision: number, url: string) {
  return { type: 'browser.dual.page.replaced', payload: { sessionId, revision, url, at: AT } }
}
function failed(sessionId: string, revision: number, code: string) {
  return { type: 'browser.dual.page.failed', payload: { sessionId, revision, code, at: AT } }
}
function closed(sessionId: string) {
  return { type: 'browser.dual.session.closed', payload: { sessionId, target: 'public', at: AT } }
}

describe('truthful session state', () => {
  it('starts a session with nothing observed, and says so', () => {
    const state = foldBrowserState([opened('freya-0001')])
    const projection = browserProjection(state)
    expect(projection.sessions).toHaveLength(1)
    expect(projection.sessions[0]).toMatchObject({
      sessionId: 'freya-0001',
      session: 'open',
      page: 'absent',
      revision: 0,
      url: null,
      observed: false,
    })
  })

  it('records what a navigation actually landed on', () => {
    const state = foldBrowserState([opened('freya-0001'), replaced('freya-0001', 1, 'https://example.com/')])
    const projection = browserProjection(state)
    expect(projection.sessions[0]).toMatchObject({ page: 'ready', revision: 1, url: 'https://example.com/', observed: true })
  })

  it('reports a failed load as failed, not as absent, and not as ready', () => {
    const state = foldBrowserState([opened('freya-0001'), failed('freya-0001', 1, 'navigate-failed')])
    const projection = browserProjection(state)
    expect(projection.sessions[0]).toMatchObject({ page: 'failed', failureCode: 'navigate-failed', url: null })
  })

  it('reports a closed session as closed and drops its URL, so nothing can be re-navigated', () => {
    const state = foldBrowserState([opened('freya-0001'), replaced('freya-0001', 1, 'https://example.com/'), closed('freya-0001')])
    const projection = browserProjection(state)
    expect(projection.sessions).toHaveLength(0)
    const entry = state.sessions.get('freya-0001')
    expect(entry).toMatchObject({ session: 'closed', page: 'closed', url: null })
    expect(liveSessionCount(state)).toBe(0)
  })

  it('never lets the revision go backwards', () => {
    const state = foldBrowserState([
      opened('freya-0001'),
      replaced('freya-0001', 5, 'https://example.com/'),
      replaced('freya-0001', 2, 'https://example.com/old'),
    ])
    expect(state.sessions.get('freya-0001')?.revision).toBe(5)
    expect(state.sessions.get('freya-0001')?.url).toBe('https://example.com/')
  })

  it('ignores a second open for a session that is already open, and an event about a session that never existed', () => {
    const state = foldBrowserState([opened('freya-0001'), opened('freya-0001'), replaced('freya-9999', 1, 'https://example.com/')])
    expect(liveSessionCount(state)).toBe(1)
    expect(state.sessions.has('freya-9999')).toBe(false)
  })

  it('carries the Device Hands entries in the same journal without misunderstanding them', () => {
    const state = foldBrowserState([
      { type: 'hands.browser.performed', payload: { actionId: 'a1', actionKey: 'browser.navigate', textBytes: 12 } },
      opened('freya-0001'),
    ])
    expect(liveSessionCount(state)).toBe(1)
    expect(state.sessions.get('freya-0001')?.url).toBeNull()
  })

  it('names the page id deterministically from the session id', () => {
    expect(pageIdFor('freya-0001')).toBe('page-freya-0001')
    expect(nextSessionId(0)).toBe('freya-0000')
    expect(() => nextSessionId(-1)).toThrow()
    expect(() => nextSessionId(1.5)).toThrow()
  })

  it('counts open handoffs for the budget rather than tracking them separately', () => {
    const state = foldBrowserState([
      { type: 'browser.dual.handoff.offered', payload: { handoffId: 'h-1', from: 'public', to: 'authenticated', reason: 'r', at: AT } },
      { type: 'browser.dual.handoff.offered', payload: { handoffId: 'h-2', from: 'public', to: 'authenticated', reason: 'r', at: AT } },
      { type: 'browser.dual.handoff.consumed', payload: { handoffId: 'h-2', from: 'public', to: 'authenticated', at: AT } },
    ])
    expect(openHandoffCount(state)).toBe(1)
  })
})

describe('restart recovery', () => {
  it('says "never opened" about an empty record rather than claiming anything', () => {
    const report = browserRecoveryReport({ entries: [], trustworthy: true })
    expect(report.neverOpened).toBe(true)
    expect(report.uncertain).toEqual([])
    expect(recoveryNeedsAttention(report)).toBe(false)
  })

  it('reports a session that was open when the run ended, and does not reopen it', () => {
    const report = browserRecoveryReport({
      entries: [opened('freya-0001'), replaced('freya-0001', 3, 'https://example.com/')],
      trustworthy: true,
    })
    expect(report.sessionsLost).toEqual([{ sessionId: 'freya-0001', url: 'https://example.com/' }])
    expect(report.uncertain.map((entry) => entry.id)).toEqual(['freya-0001'])
    expect(recoveryNeedsAttention(report)).toBe(true)
    expect(report.summary).toContain('None of them were replayed')
  })

  it('reports an unsettled handoff as uncertain, and never as consumed', () => {
    const report = browserRecoveryReport({
      entries: [
        { type: 'browser.dual.handoff.offered', payload: { handoffId: 'h-1', from: 'public', to: 'authenticated', reason: 'r', at: AT } },
        { type: 'browser.dual.handoff.consumed', payload: { handoffId: 'h-1', from: 'public', to: 'authenticated', at: AT } },
      ],
      trustworthy: true,
    })
    expect(report.handoffsUncertain).toEqual([])
  })

  it('reports a handoff the record left open as uncertain', () => {
    const report = browserRecoveryReport({
      entries: [{ type: 'browser.dual.handoff.offered', payload: { handoffId: 'h-1', from: 'public', to: 'authenticated', reason: 'r', at: AT } }],
      trustworthy: true,
    })
    expect(report.handoffsUncertain).toEqual(['h-1'])
    expect(report.uncertain.some((entry) => entry.kind === 'handoff' && entry.id === 'h-1')).toBe(true)
  })

  it('refuses to claim anything at all when the record does not chain', () => {
    const report = browserRecoveryReport({ entries: [opened('freya-0001')], trustworthy: false })
    expect(report.trustworthy).toBe(false)
    expect(report.summary).toContain('could not be believed')
    expect(report.summary).toContain('nothing is claimed')
  })

  it('counts descriptions and refusals without treating them as effects to replay', () => {
    const report = browserRecoveryReport({
      entries: [
        opened('freya-0001'),
        { type: 'browser.dual.page.described', payload: { sessionId: 'freya-0001', revision: 1, elements: 4, readBytes: 120, at: AT } },
        { type: 'browser.dual.page.described', payload: { sessionId: 'freya-0001', revision: 1, elements: 4, readBytes: 120, at: AT } },
        { type: 'browser.dual.refused', payload: { command: 'page.click', target: 'public', code: 'page-stale', at: AT } },
        closed('freya-0001'),
      ],
      trustworthy: true,
    })
    expect(report.pagesDescribed).toBe(2)
    expect(report.refusals).toBe(1)
    expect(report.uncertain).toEqual([])
    expect(report.summary).toContain('left nothing uncertain')
  })
})