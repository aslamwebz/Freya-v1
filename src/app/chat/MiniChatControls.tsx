import { useRef, useState, useSyncExternalStore } from 'react'
import type { ConversationCommandOutcome } from '../../../core/protocol/conversation'
import { conversationList, conversationMirror } from '../../platform/conversationClient'
import { hostBridge } from '../../platform/host'

/** Compact controls over the existing composer and conversation store. */
export function MiniChatControls({ busy, onPendingChange }: {
  busy: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState('')
  const sessions = conversationList(projection)
  const active = projection?.activeConversationId ?? ''
  const disabled = busy || pending || projection === null || projection.persistence.mode === 'unavailable' || projection.activeTurn != null

  const perform = async (action: () => Promise<ConversationCommandOutcome>): Promise<void> => {
    if (disabled || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    onPendingChange(true)
    setError('')
    try {
      const outcome = await action()
      if (outcome.operation === 'refused') setError(outcome.reason)
      else if (outcome.operation === 'read' && outcome.conversation === null) setError('That session is no longer available.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Freya could not open that session.')
    } finally {
      pendingRef.current = false
      setPending(false)
      onPendingChange(false)
    }
  }

  return <div className="hd-mini-controls">
    <select aria-label="Chat session" value={active} disabled={disabled} onChange={event => {
      const id = event.target.value
      if (id && id !== active) void perform(() => mirror.read(id))
    }}>
      {!active ? <option value="">Select a session</option> : null}
      {sessions.map(session => <option key={session.conversationId} value={session.conversationId}>{session.title}</option>)}
    </select>
    <button type="button" disabled={disabled} onClick={() => void perform(() => mirror.create())}>New session</button>
    <button type="button" aria-label="Close mini chat" title="Close mini chat" onClick={() => void hostBridge()?.windowClose()}>×</button>
    {error ? <span className="hd-mini-error" role="alert" title={error}>{error}</span> : null}
  </div>
}
