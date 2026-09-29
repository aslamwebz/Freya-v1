import { useSyncExternalStore } from 'react'
import { manager } from '../boot'
import { Icon, type IconName } from '../icons'
import type { SurfaceType } from '../../core/surfaces/types'
import { surfaceTypes } from '../../core/surfaces/types'

/**
 * The dock is the visible half of the Surface Manager: every button is a
 * surface type, and pressing one opens or raises it. Adding a surface type to
 * the shell is adding an entry here.
 */
const DOCK: { type: SurfaceType; icon: IconName }[] = [
  { type: 'chat', icon: 'relay' },
  { type: 'search', icon: 'search' },
  { type: 'work', icon: 'work' },
  { type: 'mission', icon: 'mission' },
  { type: 'vault', icon: 'vault' },
  { type: 'harness', icon: 'harness' },
  { type: 'foundry', icon: 'foundry' },
  { type: 'team', icon: 'team' },
]

export function SurfaceDock({ onToggle }: { onToggle: (type: SurfaceType) => void }) {
  const surfaces = useSyncExternalStore(manager.subscribe, () => manager.surfaces)
  const focusedId = manager.focused?.id

  return (
    <div className="dock" role="toolbar" aria-label="Work surfaces">
      {DOCK.map(({ type, icon }) => {
        const descriptor = surfaceTypes[type]
        const open = surfaces.find((s) => s.type === type)
        const active = Boolean(open && !open.layout.minimized)
        return (
          <button
            key={type}
            type="button"
            className="dock-button"
            aria-pressed={active}
            onClick={() => onToggle(type)}
          >
            <Icon name={icon} />
            <span>{descriptor.title}</span>
            {open?.layout.minimized ? <em className="dock-badge">min</em> : null}
          </button>
        )
      })}
      <span className="sr-only" aria-live="polite">
        {focusedId ? `Focused surface ${focusedId}` : 'No surface focused'}
      </span>
    </div>
  )
}
