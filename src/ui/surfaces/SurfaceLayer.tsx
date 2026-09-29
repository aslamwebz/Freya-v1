import { useSyncExternalStore } from 'react'
import { surfaceManager } from '../surfaceActions'
import type { Surface } from '../../core/surfaces/types'
import { SurfaceWindow } from './SurfaceWindow'
import { SurfaceBody } from './registry'

/**
 * Renders every open surface from the manager's list. The layer holds no
 * surface state of its own — it reads the manager and renders it.
 */
export function SurfaceLayer() {
  const manager = surfaceManager()
  const surfaces = useSyncExternalStore(
    (listener) => manager?.subscribe(listener) ?? (() => {}),
    () => manager?.surfaces ?? [],
  )
  const focusedId = manager?.focused?.id

  return (
    <div className="surface-layer" aria-label="Work surfaces">
      {[...surfaces]
        .sort((a, b) => a.layout.z - b.layout.z)
        .map((surface: Surface) => (
          <SurfaceWindow key={surface.id} surface={surface} focused={surface.id === focusedId}>
            <SurfaceBody type={surface.type} />
          </SurfaceWindow>
        ))}
    </div>
  )
}
