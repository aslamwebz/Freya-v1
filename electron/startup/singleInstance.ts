export interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface SingleInstancePort {
  requestLock(): boolean
  quit(): void
  onSecondInstance(handler: () => void): void
}

export function focusPrimaryWindow(window: FocusableWindow | null): boolean {
  if (window === null || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}
export function installSingleInstanceGuard(
  port: SingleInstancePort,
  getWindow: () => FocusableWindow | null,
  onMissingWindow: () => void,
): boolean {
  if (!port.requestLock()) {
    port.quit()
    return false
  }

  port.onSecondInstance(() => {
    if (!focusPrimaryWindow(getWindow())) onMissingWindow()
  })
  return true
}
