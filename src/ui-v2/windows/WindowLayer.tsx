import { useEffect, useRef, useSyncExternalStore, type ReactNode, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react'
import { Button } from '../primitives/Controls'
import { workspaceLabel, type WorkspaceId } from '../workspaces/catalog'
import type { WindowsStore, UiWindow } from './model'

export function WindowLayer({ store, render }: { store: WindowsStore; render: (id: WorkspaceId) => ReactNode }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const area = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const measure = () => {
      const box = area.current?.getBoundingClientRect()
      if (box && box.width > 0 && box.height > 0) store.setViewport({ width: box.width, height: box.height })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (area.current) observer?.observe(area.current)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [store])
  return <div className="f-window-area" ref={area} aria-label="Immersive workspace">
    {snapshot.windows.map((window) => <WindowFrame key={window.id} window={window} store={store}
      hidden={window.minimized || (store.narrow && snapshot.active !== window.id)}
      active={snapshot.active === window.id}>{render(window.id)}</WindowFrame>)}
    {snapshot.windows.length === 0 && <div className="f-immersive-empty">
      <span className="f-orbit-mark" aria-hidden="true" /><h2>Your space, your rhythm.</h2>
      <p>Open a workspace from the navigation. Arrange and pin what matters.</p>
    </div>}
  </div>
}
function WindowFrame({ window: item, store, children, hidden, active }:
  { window: UiWindow; store: WindowsStore; children: ReactNode; hidden: boolean; active: boolean }) {
  const cleanup = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => cleanup.current?.(), [])
  const bounds = store.boundsFor(item.id)
  if (!bounds) return null
  const title = workspaceLabel(item.id)
  const track = (event: ReactPointerEvent, action: 'move' | 'resize') => {
    if (event.button !== 0 || store.narrow || item.maximized) return
    if (action === 'move' && (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    store.focus(item.id)
    const origin = { x: event.clientX, y: event.clientY }
    cleanup.current?.()
    const move = (next: PointerEvent) => {
      const dx = next.clientX - origin.x, dy = next.clientY - origin.y
      if (action === 'move') store.move(item.id, bounds.x + dx, bounds.y + dy)
      else store.resize(item.id, bounds.width + dx, bounds.height + dy)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      cleanup.current = undefined
    }
    cleanup.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const keyboard = (event: KeyboardEvent, action: 'move' | 'resize') => {
    if (!(event.target === event.currentTarget) || !event.key.startsWith('Arrow')) return
    event.preventDefault()
    const amount = event.shiftKey ? 40 : 10
    const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0
    const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0
    if (action === 'move') store.move(item.id, bounds.x + dx, bounds.y + dy)
    else store.resize(item.id, bounds.width + dx, bounds.height + dy)
  }
  return <section role="dialog" aria-label={title} aria-describedby={`window-help-${item.id}`}
    hidden={hidden} className="f-window" data-active={active} data-pinned={item.pinned}
    style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, zIndex: store.layerFor(item.id) }}
    onPointerDown={() => { if (!active) store.focus(item.id) }} onFocus={() => { if (!active) store.focus(item.id) }}>
    <header className="f-window-title" tabIndex={0} aria-label={`Move ${title}`}
      onPointerDown={(event) => track(event, 'move')} onKeyDown={(event) => keyboard(event, 'move')}>
      <span>{title}</span><div className="f-window-actions">
        <Button aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${title}`} aria-pressed={item.pinned} onClick={() => store.pin(item.id)}>⌖</Button>
        <Button aria-label={`Minimize ${title}`} onClick={() => store.minimize(item.id)}>−</Button>
        <Button aria-label={`${item.maximized ? 'Restore' : 'Maximize'} ${title}`} onClick={() => store.maximize(item.id)}>□</Button>
        <Button aria-label={`Close ${title}`} onClick={() => store.close(item.id)}>×</Button>
      </div>
    </header>
    <p className="f-sr-only" id={`window-help-${item.id}`}>Use arrow keys on the title to move. Use arrow keys on the resize handle to resize. Hold Shift for larger steps.</p>
    <div className="f-window-body">{children}</div>
    {!item.maximized && !store.narrow && <button className="f-window-resize" aria-label={`Resize ${title}`}
      onPointerDown={(event) => track(event, 'resize')} onKeyDown={(event) => keyboard(event, 'resize')}>⌟</button>}
  </section>
}
