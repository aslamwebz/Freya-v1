import { useEffect, useRef } from 'react'
import type { Surface } from '../../core/surfaces/types'
import { manager } from '../boot'
import { Icon } from '../icons'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const HANDLES: { edge: Edge; className: string }[] = [
  { edge: 'n', className: 'edge-n' },
  { edge: 's', className: 'edge-s' },
  { edge: 'e', className: 'edge-e' },
  { edge: 'w', className: 'edge-w' },
  { edge: 'ne', className: 'edge-ne' },
  { edge: 'nw', className: 'edge-nw' },
  { edge: 'se', className: 'edge-se' },
  { edge: 'sw', className: 'edge-sw' },
]

const TITLEBAR_GRAB = 18

/**
 * The one and only window component in Freya.
 *
 * It knows about geometry, focus and window state. It knows nothing about what
 * a chat or a harness is — the body is rendered by the surface registry. This
 * is why a future surface type gets dragging, resizing, focus order, minimising,
 * maximising and persistence without a line of new window code.
 */
export function SurfaceWindow({
  surface,
  focused,
  children,
}: {
  surface: Surface
  focused: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  const layout = surface.layout
  const hidden = layout.minimized

  /**
   * Drag and resize both listen on `window` for the life of the gesture.
   * Pointer capture would be tidier, but it is not universally available and
   * a drag that dies the moment the cursor outruns the title bar is worse than
   * a listener that has to be cleaned up by hand.
   */
  const track = (onMove: (event: PointerEvent) => void): void => {
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    const element = ref.current
    if (!element) return

    manager.focus(surface.id)

    if (surface.layout.maximized) {
      // Grabbing a maximised surface drops it back to its own size under the
      // cursor rather than doing nothing.
      manager.unmaximize(surface.id)
      const restored = manager.get(surface.id)
      if (!restored) return
      const grab = Math.min(event.clientX - restored.layout.x, restored.layout.width / 2)
      manager.move(surface.id, event.clientX - grab, event.clientY - TITLEBAR_GRAB)
    }

    const current = manager.get(surface.id)
    if (!current) return
    const dx = Math.min(event.clientX - current.layout.x, current.layout.width - 24)
    const dy = event.clientY - current.layout.y

    track((move) => {
      manager.move(surface.id, move.clientX - dx, move.clientY - dy)
    })
  }

  const beginResize = (event: React.PointerEvent<HTMLElement>, edge: Edge) => {
    if (event.button !== 0) return
    const current = manager.get(surface.id)
    if (!current) return
    manager.focus(surface.id)
    const start = {
      x: current.layout.x,
      y: current.layout.y,
      width: current.layout.width,
      height: current.layout.height,
    }
    const originX = event.clientX
    const originY = event.clientY

    track((moveEvent) => {
      const dx = moveEvent.clientX - originX
      const dy = moveEvent.clientY - originY
      let { x, y, width, height } = start
      if (edge.includes('e')) width = start.width + dx
      if (edge.includes('s')) height = start.height + dy
      if (edge.includes('w')) {
        width = start.width - dx
        x = start.x + dx
      }
      if (edge.includes('n')) {
        height = start.height - dy
        y = start.y + dy
      }
      // Growing left or up moves the origin; once the manager clamps a shrink
      // at the minimum size, the origin is pulled back to match.
      if (width < start.width) x = start.x + (start.width - width)
      if (height < start.height) y = start.y + (start.height - height)
      manager.resize(surface.id, width, height)
      if (edge.includes('w') || edge.includes('n')) manager.move(surface.id, x, y)
    })
  }

  useEffect(() => {
    if (focused) ref.current?.focus({ preventScroll: true })
  }, [focused])

  if (hidden) return null

  return (
    <div
      ref={ref}
      className="surface"
      data-focused={focused}
      data-maximized={layout.maximized}
      style={{
        transform: `translate3d(${layout.x}px, ${layout.y}px, 0)`,
        width: layout.width,
        height: layout.height,
        zIndex: layout.z,
      }}
      role="dialog"
      aria-label={surface.title}
      tabIndex={-1}
      onPointerDown={() => manager.focus(surface.id)}
    >
      <div
        className="surface-title"
        onPointerDown={beginDrag}
        onDoubleClick={() => (layout.maximized ? manager.unmaximize(surface.id) : manager.maximize(surface.id))}
      >
        <span className="surface-grip" aria-hidden="true" />
        <h3 className="surface-title-text">{surface.title}</h3>
        {layout.pinned ? <span className="surface-pin-note">Pinned</span> : null}
        <div className="surface-controls">
          <button
            type="button"
            aria-label={`Pin ${surface.title}`}
            aria-pressed={layout.pinned}
            className="surface-btn"
            onClick={() => manager.togglePin(surface.id)}
          >
            <Icon name="pin" />
          </button>
          <button
            type="button"
            aria-label={`Minimize ${surface.title}`}
            className="surface-btn"
            onClick={() => manager.minimize(surface.id)}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            aria-label={`${layout.maximized ? 'Restore' : 'Maximize'} ${surface.title}`}
            className="surface-btn"
            onClick={() =>
              layout.maximized ? manager.unmaximize(surface.id) : manager.maximize(surface.id)
            }
          >
            <Icon name="expand" />
          </button>
          <button
            type="button"
            aria-label={`Close ${surface.title}`}
            className="surface-btn surface-btn-close"
            onClick={() => manager.close(surface.id)}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="surface-body">{children}</div>

      {HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          className={`surface-handle ${className}`}
          onPointerDown={(event) => beginResize(event, edge)}
        />
      ))}
    </div>
  )
}
