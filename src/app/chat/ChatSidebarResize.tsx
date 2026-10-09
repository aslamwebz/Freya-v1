import { useRef } from 'react'

/** Presentation-only resizing; conversation state remains in Core. */
export function ChatSidebarResize({ width, max, onChange }: {
  width: number; max: number; onChange: (width: number) => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const change = (next: number) => onChange(Math.max(192, Math.min(max, next)))
  return <div className="chats-sidebar-resize" role="separator" tabIndex={0}
    aria-label="Resize conversation sidebar" aria-orientation="vertical"
    aria-valuemin={192} aria-valuemax={max} aria-valuenow={width}
    onDoubleClick={() => change(216)}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      change(event.key === 'Home' ? 192 : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? -16 : 16))
    }}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      drag.current = { x: event.clientX, width }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => { if (drag.current) change(drag.current.width + event.clientX - drag.current.x) }}
    onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
    onLostPointerCapture={() => { drag.current = null }} />
}
