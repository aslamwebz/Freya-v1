import { isWorkspaceId, type WorkspaceId } from '../workspaces/catalog'
import type { PreferenceStorage } from '../theme/preferences'
export interface Frame { readonly width: number; readonly height: number }
export interface Bounds extends Frame { readonly x: number; readonly y: number }
export interface UiWindow {
  readonly id: WorkspaceId; readonly bounds: Bounds; readonly pinned: boolean
  readonly minimized: boolean; readonly maximized: boolean; readonly order: number
}
export interface WindowSnapshot { readonly windows: readonly UiWindow[]; readonly active: WorkspaceId | null }
export const WINDOWS_KEY = 'freya.ui-v2.windows.v1'
const validNumbers = (...values: number[]) => values.every(Number.isFinite)
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
function bounded(bounds: Bounds, frame: Frame): Bounds {
  const width = clamp(bounds.width, Math.min(300, frame.width), frame.width)
  const height = clamp(bounds.height, Math.min(220, frame.height), frame.height)
  return { width, height, x: clamp(bounds.x, 0, frame.width - width), y: clamp(bounds.y, 0, frame.height - height) }
}
function freezeSnapshot(windows: readonly UiWindow[], active: WorkspaceId | null): WindowSnapshot {
  return Object.freeze({
    windows: Object.freeze(windows.map((window) => Object.freeze({ ...window, bounds: Object.freeze({ ...window.bounds }) }))), active,
  })
}
/** Pure presentation state. No data, commands, permissions or backend lifecycle. */
export class WindowsStore {
  private frame: Frame
  private state: WindowSnapshot = freezeSnapshot([], null)
  private listeners = new Set<() => void>()
  constructor(frame: Frame, private storage?: PreferenceStorage) {
    this.frame = { width: Math.max(1, frame.width), height: Math.max(1, frame.height) }
    try {
      const raw = storage?.getItem(WINDOWS_KEY)
      if (!raw) return
      const saved = JSON.parse(raw)
      if (saved?.version !== 1 || !Array.isArray(saved.windows)) return
      const windows: UiWindow[] = []
      for (const entry of saved.windows.slice(0, 10)) {
        if (!entry || !isWorkspaceId(entry.id) || windows.some((window) => window.id === entry.id)) continue
        const b = entry.bounds
        if (!b || !validNumbers(b.x, b.y, b.width, b.height) || b.width <= 0 || b.height <= 0 ||
            Math.max(Math.abs(b.x), Math.abs(b.y), b.width, b.height) > 10000) continue
        windows.push({
          id: entry.id, bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
          pinned: entry.pinned === true, minimized: entry.minimized === true, maximized: entry.maximized === true,
          order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : windows.length,
        })
      }
      this.state = freezeSnapshot(windows, this.top(windows))
    } catch { /* Invalid layouts cannot prevent the UI from opening. */ }
  }
  getSnapshot = (): WindowSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  get narrow(): boolean { return this.frame.width <= 640 }
  boundsFor(id: WorkspaceId): Bounds | undefined {
    const window = this.state.windows.find((item) => item.id === id)
    if (!window) return undefined
    return window.maximized || this.narrow
      ? { x: 0, y: 0, ...this.frame } : bounded(window.bounds, this.frame)
  }
  layerFor(id: WorkspaceId): number {
    const window = this.state.windows.find((item) => item.id === id)
    if (!window) return 0
    const group = this.state.windows.filter((item) => item.pinned === window.pinned).sort((a, b) => a.order - b.order)
    return 20 + (window.pinned ? 200 : 0) + group.findIndex((item) => item.id === id)
  }
  setViewport(frame: Frame): void {
    if (!validNumbers(frame.width, frame.height) || frame.width <= 0 || frame.height <= 0 ||
        (frame.width === this.frame.width && frame.height === this.frame.height)) return
    this.frame = frame
    this.publish(this.state.windows, this.state.active, false)
  }
  open(id: WorkspaceId): void {
    if (this.state.windows.some((window) => window.id === id)) { this.focus(id); return }
    const offset = 32 + this.state.windows.length * 24
    const window: UiWindow = {
      id, bounds: { x: offset, y: offset, width: 580, height: 440 }, pinned: false,
      minimized: false, maximized: false, order: this.nextOrder(),
    }
    this.publish([...this.state.windows, window], id)
  }
  focus(id: WorkspaceId): void {
    this.change(id, (window) => ({ ...window, minimized: false, order: this.nextOrder() }), id)
  }
  close(id: WorkspaceId): void {
    const next = this.state.windows.filter((window) => window.id !== id)
    this.publish(next, this.state.active === id ? this.top(next) : this.state.active)
  }
  minimize(id: WorkspaceId): void {
    const next = this.state.windows.map((window) => window.id === id ? { ...window, minimized: true } : window)
    this.publish(next, this.state.active === id ? this.top(next) : this.state.active)
  }
  pin(id: WorkspaceId): void { this.change(id, (window) => ({ ...window, pinned: !window.pinned, order: this.nextOrder() })) }
  maximize(id: WorkspaceId): void { this.change(id, (window) => ({ ...window, maximized: !window.maximized, minimized: false }), id) }
  move(id: WorkspaceId, x: number, y: number): void {
    if (this.narrow || !validNumbers(x, y)) return
    this.change(id, (window) => window.maximized ? window : {
      ...window, bounds: bounded({ ...window.bounds, x, y }, this.frame),
    })
  }
  resize(id: WorkspaceId, width: number, height: number): void {
    if (this.narrow || !validNumbers(width, height)) return
    this.change(id, (window) => {
      if (window.maximized) return window
      const current = bounded(window.bounds, this.frame)
      return { ...window, bounds: {
        ...current,
        width: clamp(width, Math.min(300, this.frame.width - current.x), this.frame.width - current.x),
        height: clamp(height, Math.min(220, this.frame.height - current.y), this.frame.height - current.y),
      } }
    })
  }
  reset(): void { this.publish([], null) }
  private nextOrder(): number { return Math.max(0, ...this.state.windows.map((window) => window.order)) + 1 }
  private top(windows: readonly UiWindow[]): WorkspaceId | null {
    return [...windows].filter((window) => !window.minimized)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.order - a.order)[0]?.id ?? null
  }
  private change(id: WorkspaceId, change: (window: UiWindow) => UiWindow, active = this.state.active): void {
    const previous = this.state.windows.find((window) => window.id === id)
    if (!previous) return
    const next = change(previous)
    if (next === previous) return
    this.publish(this.state.windows.map((window) => window.id === id ? next : window), active)
  }
  private publish(windows: readonly UiWindow[], active: WorkspaceId | null, persist = true): void {
    this.state = freezeSnapshot(windows, active)
    if (persist) {
      try { this.storage?.setItem(WINDOWS_KEY, JSON.stringify({ version: 1, windows: this.state.windows })) } catch { /* Keep the live layout usable. */ }
    }
    for (const listener of this.listeners) listener()
  }
}
