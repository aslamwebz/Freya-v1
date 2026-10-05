import { describe, expect, it } from 'vitest'
import { DEVICE_HANDS_LIMITS } from '../../../core/devicehands'
import { normaliseRendererBrowserRequest } from '../../../electron/browser/rendererRequest'

describe('renderer browser request boundary', () => {
  it('accepts the closed browser vocabulary and strips fields the command does not own', () => {
    const reading = normaliseRendererBrowserRequest({
      command: 'page.navigate',
      target: 'public',
      sessionId: 'freya-0001',
      url: 'https://example.com/',
      context: { cookie: 'must-never-cross' },
      secret: 'also-no',
    })

    expect(reading).toEqual({
      ok: true,
      request: {
        command: 'page.navigate',
        target: 'public',
        sessionId: 'freya-0001',
        url: 'https://example.com/',
      },
    })
    if (reading.ok) {
      expect('context' in reading.request).toBe(false)
      expect('secret' in reading.request).toBe(false)
    }
  })

  it('will not let a renderer invent browser commands or targets', () => {
    expect(normaliseRendererBrowserRequest({ command: 'page.screenshot' }).ok).toBe(false)
    expect(normaliseRendererBrowserRequest({ command: 'page.read', sessionId: 's1', target: 'whatever' }).ok).toBe(false)
  })

  it('requires the reference Freya just described before an action can be named', () => {
    expect(normaliseRendererBrowserRequest({
      command: 'page.click',
      sessionId: 'freya-0001',
    }).ok).toBe(false)

    expect(normaliseRendererBrowserRequest({
      command: 'page.click',
      sessionId: 'freya-0001',
      ref: 'r1-1234567890abcdef',
    })).toMatchObject({
      ok: true,
      request: { command: 'page.click', sessionId: 'freya-0001', ref: 'r1-1234567890abcdef' },
    })
  })

  it('enforces Device Hands typed-text bounds before IPC', () => {
    const tooLarge = 'x'.repeat(DEVICE_HANDS_LIMITS.maxTypedTextBytes + 1)
    expect(normaliseRendererBrowserRequest({
      command: 'page.type',
      sessionId: 'freya-0001',
      ref: 'r1-1234567890abcdef',
      text: tooLarge,
    }).ok).toBe(false)
  })

  it('does not expose arbitrary cross-browser handoff context', () => {
    const reading = normaliseRendererBrowserRequest({
      command: 'handoff.offer',
      sessionId: 'freya-0001',
      reason: 'Continue this page in my signed-in browser',
      context: {
        authorization: 'Bearer secret',
        cookie: 'session=secret',
      },
    })
    expect(reading).toMatchObject({
      ok: true,
      request: {
        command: 'handoff.offer',
        sessionId: 'freya-0001',
      },
    })
    if (reading.ok) expect('context' in reading.request).toBe(false)
  })
})
