import { useEffect, useRef, useState } from 'react'
import { useShell } from '../store'
import { submitCommand } from '../commandPath'

/**
 * Quick command entry, in the header.
 *
 * The chat bar at the bottom is the full surface: transcript, switcher, voice.
 * This is the one-line version for when you already know what to type, and it
 * submits through exactly the same path, so the two can never disagree about
 * what Core was told.
 */
export function CommandBar() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const listening = useShell((s) => s.listening)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <form
      className="command"
      data-live={listening}
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        const value = text.trim()
        if (!value || busy) return
        // The input clears immediately so typing is not blocked, but nothing is
        // acknowledged here. The notice appears when Core replies, and says what
        // Core said.
        setText('')
        setBusy(true)
        inputRef.current?.blur()
        void submitCommand(value, 'command-bar').finally(() => setBusy(false))
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={listening ? "I'm listening…" : 'Tell Freya what to do…'}
        aria-label="Command Freya"
        spellCheck={false}
        autoComplete="off"
        aria-describedby="command-status"
        aria-busy={busy}
      />
      <span id="command-status" className="sr-only" role="status" aria-live="polite">
        {busy ? 'Sending the command to Freya Core.' : ''}
      </span>
    </form>
  )
}
