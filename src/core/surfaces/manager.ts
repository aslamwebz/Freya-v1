import { cascadePosition, clampLayout, clampPosition, clampSize, round, type Frame } from './geometry'
import { surfaceTypes, type Bounds, type Surface, type SurfaceLayout, type SurfaceType, type SurfaceTypeDescriptor } from './types'

export type SurfaceEventName =
  | 'surface.restored'
  | 'surface.opened'
  | 'surface.closed'
  | 'surface.focused'
  | 'surface.moved'
  | 'surface.resized'
  | 'surface.state.changed'

/**
 * What the manager's list currently looks like, reduced to the three facts the
 * rest of the shell needs.
 *
 * It travels on every event so the store's reducer can stay pure: the manager
 * owns the surfaces, and the shell should read a summary of them rather than a
 * second copy of the truth.
 */
export interface SurfaceSummary {
  open: number
  minimized: number
  focused: string | null
}

export interface SurfaceEvent {
  type: SurfaceEventName
  id: string
  surface: Surface | null
  summary: SurfaceSummary
}

export interface OpenSurfaceSpec {
  type: SurfaceType
  /** Reuse an existing id to re-open a persisted surface. */
  id?: string
  title?: string
  context?: Record<string, string>
}

export interface PersistedSurface {
  id: string
  type: SurfaceType
  title: string
  context: Record<string, string>
  layout: SurfaceLayout
}

export interface SurfaceManagerOptions {
  frame: Frame
  onEvent?: (event: SurfaceEvent) => void
  now?: () => number
  makeId?: (type: SurfaceType, sequence: number) => string
}

function defaultId(type: SurfaceType, sequence: number): string {
  return `${type}-${sequence}`
}

/** The descriptor's *minimum* size, which is not the same as its default size. */
function minSizeOf(descriptor: SurfaceTypeDescriptor): { width: number; height: number } {
  return { width: descriptor.minWidth, height: descriptor.minHeight }
}

/**
 * Owns every open surface and nothing else.
 *
 * Deliberately free of React and of the DOM: it is told the workspace frame
 * and told when it changes, and it decides geometry, focus order and lifecycle.
 * That is what makes the windowing behaviour testable and reusable — a future
 * surface type gets all of it by existing, not by being re-implemented.
 */
export class SurfaceManager {
  private items: Surface[] = []
  private listeners = new Set<() => void>()
  private frame: Frame
  private readonly onEvent: (event: SurfaceEvent) => void
  private readonly now: () => number
  private readonly makeId: (type: SurfaceType, sequence: number) => string
  private topZ = 0
  private sequence = 0

  constructor(options: SurfaceManagerOptions) {
    this.frame = options.frame
    this.onEvent = options.onEvent ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.makeId = options.makeId ?? defaultId
  }

  /* ------------------------------------------------------------- read */

  get surfaces(): readonly Surface[] {
    return this.items
  }

  get(id: string): Surface | undefined {
    return this.items.find((s) => s.id === id)
  }

  has(type: SurfaceType): boolean {
    return this.items.some((s) => s.type === type)
  }

  /** The topmost surface the user can actually see. */
  private topmostVisible(): Surface | undefined {
    let best: Surface | undefined
    for (const surface of this.items) {
      if (surface.layout.minimized || surface.state !== 'open') continue
      if (!best || surface.layout.z > best.layout.z) best = surface
    }
    return best
  }

  /**
   * The focused surface: the topmost visible one.
   *
   * Minima and closes are followed by an explicit handover, so this is a
   * definition rather than a search — and a shell with every surface minimised
   * correctly reports no focus, which is what makes the Escape shortcut inert
   * instead of reviving a window the user put away.
   */
  get focused(): Surface | undefined {
    return this.topmostVisible()
  }

  /** The three facts the shell reads, recomputed on demand. */
  summary(): SurfaceSummary {
    const focused = this.topmostVisible()
    return {
      open: this.items.length,
      minimized: this.items.filter((s) => s.layout.minimized).length,
      focused: focused?.id ?? null,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private commit(event: SurfaceEventName, id: string, surface: Surface | null): void {
    for (const listener of this.listeners) listener()
    this.onEvent({ type: event, id, surface, summary: this.summary() })
  }

  /**
   * Hand focus to whatever is now on top. Called after the focused surface goes
   * away, so a minimised or closed window never leaves the workspace with a
   * stale z-order and no active surface.
   */
  private handOverFocus(released: Surface | undefined): void {
    const next = this.topmostVisible()
    if (!next || next.id === released?.id) return
    this.topZ = Math.max(this.topZ, next.layout.z)
    this.replace(next, { state: 'open', layout: { ...next.layout, z: this.topZ } })
    this.onEvent({ type: 'surface.focused', id: next.id, surface: next, summary: this.summary() })
  }

  /* ------------------------------------------------------------ frame */

  /**
   * The workspace was resized. Every surface is re-clamped so that a layout
   * saved on a wide display cannot leave windows off-screen on a small one.
   */
  setFrame(frame: Frame): void {
    this.frame = frame
    let changed = false
    for (const surface of this.items) {
      const next = this.clamp(surface)
      if (!sameLayout(next.layout, surface.layout)) {
        this.replace(surface, { layout: next.layout })
        changed = true
      }
    }
    if (changed) this.notifyGeometry()
  }

  private clamp(surface: Surface): Surface {
    const descriptor = surfaceTypes[surface.type]
    return {
      ...surface,
      layout: clampLayout(surface.layout, minSizeOf(descriptor), this.frame),
    }
  }

  private notifyGeometry(): void {
    for (const listener of this.listeners) listener()
  }

  /**
   * Copy-on-write. The surfaces array gets a new identity on every mutation so
   * that `useSyncExternalStore` sees a changed snapshot — mutating in place
   * would leave React with an identical reference and silently never re-render.
   */
  private replace(surface: Surface, patch: Partial<Surface>): Surface {
    const next = { ...surface, ...patch }
    this.items = this.items.map((item) => (item === surface ? next : item))
    return next
  }

  private descriptorOf(surface: Surface) {
    return surfaceTypes[surface.type]
  }

  /* ------------------------------------------------------------- open */

  open(spec: OpenSurfaceSpec): Surface {
    const existing = spec.id ? this.get(spec.id) : undefined
    if (existing) {
      this.focus(existing.id)
      return existing
    }

    const descriptor = surfaceTypes[spec.type]
    const size = clampSize(
      { width: descriptor.width, height: descriptor.height },
      minSizeOf(descriptor),
      this.frame,
    )
    const position = cascadePosition(this.items.length, size, this.frame)
    this.sequence += 1
    const id = spec.id ?? this.makeId(spec.type, this.sequence)

    this.topZ += 1
    const surface: Surface = {
      id,
      type: spec.type,
      title: spec.title ?? descriptor.title,
      context: spec.context ?? {},
      state: 'open',
      createdAt: this.now(),
      layout: {
        ...position,
        ...size,
        minimized: false,
        maximized: false,
        pinned: false,
        z: this.topZ,
        restoreBounds: null,
      },
    }

    this.items = [...this.items, surface]
    this.commit('surface.opened', id, surface)
    this.onEvent({ type: 'surface.focused', id, surface, summary: this.summary() })
    return surface
  }

  /* ------------------------------------------------------------ close */

  close(id: string): boolean {
    const surface = this.get(id)
    if (!surface) return false
    this.items = this.items.filter((s) => s.id !== id)
    this.commit('surface.closed', id, null)
    this.handOverFocus(surface)
    return true
  }

  /* ------------------------------------------------------------ focus */

  focus(id: string): boolean {
    const surface = this.get(id)
    if (!surface) return false
    const alreadyTop = surface.layout.z === this.topZ && !surface.layout.minimized
    if (alreadyTop) return true

    this.topZ += 1
    const next = this.replace(surface, {
      state: 'open',
      layout: { ...surface.layout, z: this.topZ, minimized: false },
    })
    this.commit('surface.focused', id, next)
    return true
  }

  /**
   * Move focus one step up or down the stack, wrapping. Always moves: a cycle
   * that lands back on the current surface is not a cycle.
   *
   * The traversal order is insertion order, not z-order — z changes every time
   * a surface is focused, so sorting by it would make the cycle rotate under
   * itself and never reach every surface.
   */
  cycle(direction: 1 | -1 = 1): string | null {
    const candidates = this.items.filter((s) => !s.layout.minimized)
    if (candidates.length < 2) return null
    const current = this.focused
    const index = current ? candidates.findIndex((s) => s.id === current.id) : candidates.length - 1
    const next = candidates[(index + direction + candidates.length) % candidates.length]
    if (!next) return null
    this.focus(next.id)
    return next.id
  }

  /* -------------------------------------------------------- move/resize */

  move(id: string, x: number, y: number): boolean {
    const surface = this.get(id)
    if (!surface || surface.layout.maximized) return false
    const size = { width: surface.layout.width, height: surface.layout.height }
    const position = clampPosition({ x, y }, size, this.frame)
    if (position.x === surface.layout.x && position.y === surface.layout.y) return true
    const next = this.replace(surface, {
      layout: { ...surface.layout, ...position },
    })
    this.commit('surface.moved', id, next)
    return true
  }

  resize(id: string, width: number, height: number): boolean {
    const surface = this.get(id)
    if (!surface) return false
    if (surface.layout.maximized) {
      this.restoreBoundsOf(surface.id)
    }
    const current = this.get(id)
    if (!current) return false
    const descriptor = this.descriptorOf(current)
    const size = clampSize({ width, height }, minSizeOf(descriptor), this.frame)
    const position = clampPosition(
      { x: current.layout.x, y: current.layout.y },
      size,
      this.frame,
    )
    const next = this.replace(current, {
      layout: { ...current.layout, ...size, ...position, maximized: false, minimized: false },
    })
    this.commit('surface.resized', id, next)
    return true
  }

  /* -------------------------------------------------------- window state */

  minimize(id: string): boolean {
    const surface = this.get(id)
    if (!surface || surface.layout.minimized) return false
    const wasFocused = this.focused?.id === surface.id
    const next = this.replace(surface, {
      state: 'minimized',
      layout: { ...surface.layout, minimized: true },
    })
    this.commit('surface.state.changed', id, next)
    if (wasFocused) this.handOverFocus(next)
    return true
  }

  maximize(id: string): boolean {
    const surface = this.get(id)
    if (!surface || surface.layout.maximized) return false
    const restoreBounds: Bounds = {
      x: surface.layout.x,
      y: surface.layout.y,
      width: surface.layout.width,
      height: surface.layout.height,
    }
    this.topZ += 1
    const next = this.replace(surface, {
      state: 'open',
      layout: {
        ...surface.layout,
        x: this.frame.x,
        y: this.frame.y,
        width: this.frame.width,
        height: this.frame.height,
        minimized: false,
        maximized: true,
        z: this.topZ,
        restoreBounds,
      },
    })
    this.commit('surface.state.changed', id, next)
    this.onEvent({ type: 'surface.focused', id, surface: next, summary: this.summary() })
    return true
  }

  /** Leave the maximised state, returning to the geometry held before it. */
  unmaximize(id: string): boolean {
    const surface = this.get(id)
    if (!surface || !surface.layout.maximized) return false
    return this.restoreBoundsOf(id)
  }

  private restoreBoundsOf(id: string): boolean {
    const surface = this.get(id)
    if (!surface) return false
    const bounds = surface.layout.restoreBounds ?? {
      x: surface.layout.x,
      y: surface.layout.y,
      width: this.descriptorOf(surface).width,
      height: this.descriptorOf(surface).height,
    }
    const descriptor = this.descriptorOf(surface)
    const size = clampSize(bounds, minSizeOf(descriptor), this.frame)
    const position = clampPosition({ x: bounds.x, y: bounds.y }, size, this.frame)
    const next = this.replace(surface, {
      state: 'open',
      layout: {
        ...surface.layout,
        ...position,
        ...size,
        maximized: false,
        minimized: false,
        restoreBounds: null,
      },
    })
    this.commit('surface.state.changed', id, next)
    return true
  }

  togglePin(id: string): boolean {
    const surface = this.get(id)
    if (!surface) return false
    const next = this.replace(surface, {
      layout: { ...surface.layout, pinned: !surface.layout.pinned },
    })
    this.commit('surface.state.changed', id, next)
    return true
  }

  /* ------------------------------------------------------ persistence */

  serialize(): PersistedSurface[] {
    return this.items.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      context: s.context,
      layout: { ...s.layout, restoreBounds: s.layout.restoreBounds ? { ...s.layout.restoreBounds } : null },
    }))
  }

  /**
   * Replace the workspace with a persisted layout. Ids are preserved, so a
   * surface that was mid-run when the app quit comes back with its identity —
   * which is what will let long-running work reattach to it.
   */
  restore(persisted: readonly PersistedSurface[]): void {
    this.items = []
    this.topZ = 0
    for (const entry of persisted) {
      this.topZ += 1
      const descriptor = surfaceTypes[entry.type]
      const size = clampSize(entry.layout, minSizeOf(descriptor), this.frame)
      const position = clampPosition({ x: entry.layout.x, y: entry.layout.y }, size, this.frame)
      this.items.push({
        id: entry.id,
        type: entry.type,
        title: entry.title || descriptor.title,
        context: entry.context ?? {},
        state: entry.layout.minimized ? 'minimized' : 'open',
        createdAt: this.now(),
        layout: {
          ...position,
          ...size,
          minimized: Boolean(entry.layout.minimized),
          maximized: false,
          pinned: Boolean(entry.layout.pinned),
          z: this.topZ,
          restoreBounds: entry.layout.restoreBounds ?? null,
        },
      })
    }
    this.notifyGeometry()
    // The list changed wholesale, so the shell is told once rather than per
    // surface. Skipping this leaves the store's summary describing a
    // workspace that no longer exists.
    this.onEvent({ type: 'surface.restored', id: '', surface: null, summary: this.summary() })
  }
}

function sameLayout(a: SurfaceLayout, b: SurfaceLayout): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.minimized === b.minimized &&
    a.maximized === b.maximized &&
    a.pinned === b.pinned &&
    a.z === b.z
  )
}

export { round }
