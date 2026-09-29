import type { Surface, SurfaceType } from '../core/surfaces/types'
import type { SurfaceManager } from '../core/surfaces/manager'
import { manager } from './boot'

/**
 * The seam between the shell chrome and the Surface Manager.
 *
 * Components import `openSurface` and nothing else from the surface layer.
 * There is no event bus for UI-to-UI chatter and no component-to-component
 * calls: the manager is the single owner, and this module is the only way in.
 */

export function surfaceManager(): SurfaceManager {
  return manager
}

export function openSurface(type: SurfaceType, title?: string): Surface {
  return manager.open({ type, ...(title ? { title } : {}) })
}

/**
 * Dock behaviour: raise an open surface, or open it if it is not open yet.
 * A surface that is already focused is minimised instead, which is the
 * expected toggle and keeps the dock honest about what is on screen.
 */
export function toggleSurface(type: SurfaceType): void {
  const existing = manager.surfaces.find((s) => s.type === type)
  if (!existing) {
    openSurface(type)
    return
  }
  if (existing.layout.minimized) {
    manager.focus(existing.id)
    return
  }
  if (manager.focused?.id === existing.id) {
    manager.minimize(existing.id)
  } else {
    manager.focus(existing.id)
  }
}

