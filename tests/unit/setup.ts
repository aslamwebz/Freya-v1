import '@testing-library/jest-dom/vitest'

/**
 * A `ResizeObserver` for jsdom.
 *
 * The Browser Workspace positions a **native** view, and the only way it learns where that
 * view should go is from the size of a measuring box in the document. jsdom does not implement
 * `ResizeObserver` and does not lay anything out, so this stub reports the box at its real
 * measured size — which, in jsdom, is zero, and a zero box is exactly the "hidden" case the
 * component has to handle. That is a useful accident: the hidden path is exercised by every
 * test in this file rather than by one written to exercise it.
 *
 * A test that needs a real size assigns one to `Element.prototype.getBoundingClientRect`.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class TestResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      this.callback()
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = TestResizeObserver
}
