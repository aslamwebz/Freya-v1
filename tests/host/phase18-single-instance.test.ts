import { describe, expect, it, vi } from 'vitest'
import {
  focusPrimaryWindow,
  installSingleInstanceGuard,
  type FocusableWindow,
} from '../../electron/startup/singleInstance'

function fakeWindow(options: { destroyed?: boolean; minimized?: boolean } = {}): FocusableWindow {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
}

describe('Phase 18 single-instance startup ownership', () => {
  it('quits before registering second-instance work when the profile lock is denied', () => {
    const quit = vi.fn()
    const onSecondInstance = vi.fn()
    const owned = installSingleInstanceGuard(
      { requestLock: () => false, quit, onSecondInstance },
      () => null,
      vi.fn(),
    )
    expect(owned).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('restores, shows and focuses the existing Freya window on a second launch', () => {
    let secondInstance: (() => void) | null = null
    const window = fakeWindow({ minimized: true })
    const missing = vi.fn()
    expect(installSingleInstanceGuard(
      { requestLock: () => true, quit: vi.fn(), onSecondInstance: (handler) => { secondInstance = handler } },
      () => window,
      missing,
    )).toBe(true)

    expect(secondInstance).not.toBeNull()
    ;(secondInstance as unknown as () => void)()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(missing).not.toHaveBeenCalled()
  })

  it('does not restore a window that is already unminimized', () => {
    const window = fakeWindow()
    expect(focusPrimaryWindow(window)).toBe(true)
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('delegates window recreation when no live primary window exists', () => {
    let secondInstance: (() => void) | null = null
    const missing = vi.fn()
    installSingleInstanceGuard(
      { requestLock: () => true, quit: vi.fn(), onSecondInstance: (handler) => { secondInstance = handler } },
      () => fakeWindow({ destroyed: true }),
      missing,
    )

    ;(secondInstance as unknown as () => void)()
    expect(missing).toHaveBeenCalledOnce()
  })
})
