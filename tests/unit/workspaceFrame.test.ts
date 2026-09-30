import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFrame } from '../../src/ui/boot'

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('workspace frame', () => {
  it('keeps a newly opened surface above the chat bar and its launcher', () => {
    vi.stubGlobal('innerHeight', 1020)
    document.body.innerHTML = '<header class="header"></header><footer class="chatbar"></footer>'
    const header = document.querySelector('.header')!
    const bar = document.querySelector('.chatbar')!
    Object.defineProperty(header, 'offsetHeight', { value: 88 })
    bar.getBoundingClientRect = () => ({ top: 820 }) as DOMRect
    expect(workspaceFrame().height).toBe(732)
    expect(workspaceFrame().y).toBe(88)
  })

  it('uses the whole window below the header when no chat bar is present', () => {
    expect(workspaceFrame().height).toBe(Math.max(240, window.innerHeight - 88))
  })
})
