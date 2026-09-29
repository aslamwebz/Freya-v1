import { surfaceTypes, type Surface, type SurfaceType } from '../core/surfaces/types'
import type { SurfaceManager } from '../core/surfaces/manager'

/**
 * The seam between the shell chrome and the Surface Manager.
 *
 * Components import `openSurface` and nothing else from the surface layer.
 * There is no event bus for UI-to-UI chatter and no component-to-component
 * calls: the manager is the single owner, and this module is the only way in.
 */

let manager: SurfaceManager | null = null

export function bindSurfaceManager(next: SurfaceManager): void {
  manager = next
}

export function surfaceManager(): SurfaceManager | null {
  return manager
}

export function openSurface(type: SurfaceType, title?: string): Surface | null {
  if (!manager) return null
  return manager.open({ type, ...(title ? { title } : {}) })
}

/**
 * Dock behaviour: raise an open surface, or open it if it is not open yet.
 * A surface that is already focused is minimised instead, which is the
 * expected toggle and keeps the dock honest about what is on screen.
 */
export function toggleSurface(type: SurfaceType): void {
  if (!manager) return
  const existing = manager.surfaces.find((s) => s.type === type && s.state !== 'closed')
  if (!existing) {
    openSurface(type)
    return
  }
  if (existing.layout.minimized) {
    manager.focus(existing.id)
    return
  }
  const focused = manager.focused
  if (focused?.id === existing.id) manager.minimize(existing.id)
  else manager.focus(existing.id)
}

export function closeSurface(id: string): void {
  manager?.close(id)
}

export function isSurfaceOpen(type: SurfaceType): boolean {
  return manager?.surfaces.some((s) => s.type === type) ?? false
}

export function surfaceTitle(type: SurfaceType): string {
  return surfaceTypes[type].title
}
