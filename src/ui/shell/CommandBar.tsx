import { useEffect, useRef, useState } from 'react'
import { shellStore, useShell } from '../store'
import { Icon } from '../icons'
import { PRESENCE_TONE } from '../../core/presence'

const BARS = 22

export function CommandBar() {
  const [text, setText] = useState('')
  const listening = useShell((s) => s.listening)
  const presence = useShell((s) => s.presence.state)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const tone = PRESENCE_TONE[presence]

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
        if (!value) return
        setText('')
        shellStore.dispatch({ type: 'command.submit', text: value })
        inputRef.current?.blur()
      }}
    >
      <button
        type="button"
        className="command-mic"
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Start listening'}
        title="Voice input boundary — Phase 0 does not record audio"
        onClick={() => shellStore.dispatch({ type: 'voice.toggle', listening: !listening })}
      >
        <Icon name="mic" />
      </button>
      <span className="command-sep" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={listening ? "I'm listening…" : 'Tap the mic, or tell Freya what to do.'}
        aria-label="Command Freya"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="command-wave" data-active={listening} aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} style={{ animationDelay: `${((Math.sin(i * 1.7) * 0.5 + 0.5) * 1.1).toFixed(2)}s` }} />
        ))}
      </span>
      <span className="command-state" style={{ color: tone.accent }} aria-hidden="true">
        {tone.label}
      </span>
    </form>
  )
}
