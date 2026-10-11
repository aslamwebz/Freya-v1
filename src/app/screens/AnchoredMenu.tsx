import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import './AnchoredMenu.css'

/** A composer menu positioned against the viewport, outside clipping parents. */
export function AnchoredMenu({ anchorRef, onClose, label, children, className = '' }: {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  label: string
  children: ReactNode
  className?: string
}) {
  const menuRef = useRef<HTMLUListElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const restoreFocus = useRef(true)
  const [position, setPosition] = useState({ left: 8, top: 8, width: 340, maxHeight: 400 })

  useLayoutEffect(() => {
    const menu = menuRef.current
    const anchor = anchorRef.current
    if (!menu || !anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.max(0, Math.min(340, window.innerWidth - 16))
      const above = Math.max(0, rect.top - 16)
      const below = Math.max(0, window.innerHeight - rect.bottom - 16)
      const height = menu.getBoundingClientRect().height || menu.scrollHeight
      const useAbove = above >= height || above >= below
      const maxHeight = Math.min(window.innerHeight - 16, useAbove ? above : below)
      const shownHeight = Math.min(height, maxHeight)
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(useAbove ? rect.top - shownHeight - 8 : rect.bottom + 8, window.innerHeight - shownHeight - 8)),
        width,
        maxHeight: Math.max(0, maxHeight),
      })
    }
    place()
    const selected = menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('[role^="menuitem"]')
    selected?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) {
        restoreFocus.current = false
        closeRef.current()
      }
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', outside)
      if (restoreFocus.current) anchor.focus()
    }
  }, [anchorRef])

  return createPortal(
    <ul ref={menuRef} role="menu" aria-label={label} className={`freya-anchored-menu ${className}`} style={{ position: 'fixed', ...position }} onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        closeRef.current()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((node) => !node.hasAttribute('disabled'))
      const current = options.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next]?.focus()
    }}>{children}</ul>, document.body,
  )
}
