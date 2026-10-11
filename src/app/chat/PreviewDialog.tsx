import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './PreviewDialog.css'

const openDialogs: HTMLDivElement[] = []

/** Shared dismissal and focus lifecycle for media and saved Eye previews. */
export function PreviewDialog({ label, onClose, children, className = '' }: {
  label: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (dialog) openDialogs.push(dialog)
    dialog?.querySelector<HTMLElement>('[data-dialog-close]')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], iframe, video[controls], audio[controls], [tabindex="0"]')]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (dialog) {
        const index = openDialogs.indexOf(dialog)
        if (index >= 0) openDialogs.splice(index, 1)
      }
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  return createPortal(<div ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} className={`freya-preview-dialog ${className}`} onClick={(event) => {
    if (event.target === event.currentTarget) closeRef.current()
  }}>{children}</div>, document.body)
}
