import { useSyncExternalStore } from 'react'
import { manager } from '../boot'
import type { Surface } from '../../core/surfaces/types'
import { SurfaceWindow } from './SurfaceWindow'
import { SurfaceBody } from './registry'

/**
 * Renders every open surface from the manager's list. The layer holds no
 * surface state of its own — it reads the manager and renders it.
 *
 * DOM order is insertion order and never changes. Stacking is handled entirely
 * by the `z-index` each window carries in its layout, because re-ordering the
 * DOM on focus makes a browser drop the click that was meant to focus the
 * window: pointerdown reorders the node, so the matching pointerup lands on a
 * different target and the button never activates.
 */
export function SurfaceLayer() {
  const surfaces = useSyncExternalStore(manager.subscribe, () => manager.surfaces)
  const focusedId = manager.focused?.id

  return (
    <div className="surface-layer" aria-label="Work surfaces">
      {surfaces.map((surface: Surface) => (
        <SurfaceWindow key={surface.id} surface={surface} focused={surface.id === focusedId}>
          <SurfaceBody type={surface.type} />
        </SurfaceWindow>
      ))}
    </div>
  )
}
