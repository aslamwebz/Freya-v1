import { describe, expect, it } from 'vitest'
import { hostHarness, ALLOWED_HOST } from './harness'

describe('browser host adapter', () => {
  it('navigates and reads text, observing the page it actually reached', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.performBrowser({
      actionId: 'a',
      url: `https://${ALLOWED_HOST}/about`,
      selector: null,
      text: null,
      deadlineAt: '2026-07-01T09:00:30.000Z',
    })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('observed')
    expect(outcome.finalUrl).toBe(`https://${ALLOWED_HOST}/`)
    expect(outcome.textBytes).toBe(42)
    expect(h.counts.browserOpen).toBe(1)
    expect(h.counts.browserNavigate).toBe(1)
    expect(h.counts.browserRead).toBe(1)
  })

  it('refuses a click with a stated code and never opens a browser', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.performBrowser({
      actionId: 'a',
      url: `https://${ALLOWED_HOST}/about`,
      selector: '#submit',
      text: null,
      deadlineAt: '2026-07-01T09:00:30.000Z',
    })
    expect(outcome.holds).toBe(false)
    expect(outcome.evidence).toBe('reported')
    expect(outcome.code).toBe('browser-action-unsupported')
    expect(h.counts.browserOpen).toBe(0)
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('refuses typing with the same stated code and never opens a browser', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.performBrowser({
      actionId: 'a',
      url: `https://${ALLOWED_HOST}/about`,
      selector: '#name',
      text: 'Ada',
      deadlineAt: '2026-07-01T09:00:30.000Z',
    })
    expect(outcome.code).toBe('browser-action-unsupported')
    expect(h.counts.browserOpen).toBe(0)
  })

  it('reports a navigation that did not arrive as not held', async () => {
    const h = await hostHarness()
    h.browser.navigateResult = { ok: false, finalUrl: null, code: 'browser-navigate-failed' }
    const outcome = await h.effects.performBrowser({
      actionId: 'a',
      url: `https://${ALLOWED_HOST}/about`,
      selector: null,
      text: null,
      deadlineAt: '2026-07-01T09:00:30.000Z',
    })
    expect(outcome.holds).toBe(false)
    expect(outcome.evidence).toBe('reported')
    expect(outcome.finalUrl).toBeNull()
  })

  it('closes the session even when reading fails', async () => {
    const h = await hostHarness()
    h.browser.readResult = { ok: false, textBytes: 0, code: 'browser-read-failed' }
    const outcome = await h.effects.performBrowser({
      actionId: 'a',
      url: `https://${ALLOWED_HOST}/about`,
      selector: null,
      text: null,
      deadlineAt: '2026-07-01T09:00:30.000Z',
    })
    expect(outcome.holds).toBe(true)
    expect(outcome.textBytes).toBe(0)
    expect(h.browser.counts.close).toBe(1)
  })
})
