// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normaliseSemanticBrowserRequest } from '../../../electron/browser/semanticRequest'

describe('owner blank browser tab normalisation', () => {
  it('accepts a new manual tab with a null URL without inventing a destination', () => {
    const result = normaliseSemanticBrowserRequest({
      op: 'open',
      url: null,
      origin: { kind: 'manual' },
      createdBy: 'user',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.request).toEqual({
      op: 'open', origin: { kind: 'manual' }, createdBy: 'user', activate: true,
    })
  })
  it('still refuses null navigation and malformed nonblank open addresses', () => {
    expect(normaliseSemanticBrowserRequest({
      op: 'navigate', tabId: 'tab-1', url: null,
    }).ok).toBe(false)
    expect(normaliseSemanticBrowserRequest({
      op: 'open', url: 'https://example.org/' + String.fromCharCode(0) + 'broken', createdBy: 'user',
    }).ok).toBe(false)
  })
  it('never permits a renderer to attribute a tab to Freya instead of the owner', () => {
    const result = normaliseSemanticBrowserRequest({ op: 'open', url: null, createdBy: 'freya' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request).toMatchObject({ createdBy: 'user' })
  })
})
