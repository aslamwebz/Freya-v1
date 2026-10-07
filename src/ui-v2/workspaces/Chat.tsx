import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { conversationMirror, ensureConversationAttached } from '../../platform/conversationClient'
import { ChatView } from '../chat/ChatView'

/**
 * Chat — a real conversation with a real Freya behind it.
 *
 * The mirror is the renderer's only window onto the conversation, and it is a
 * mirror in the strict sense: it holds what Core pushed and the renderer writes
 * nothing into it. The composer that sends lives in the shell's dock; this
 * workspace shows the transcript, the running turn, and the sentences Core gave
 * for the states that would otherwise be faked.
 */
export function Chat() {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(
    mirror.subscribe,
    () => mirror.projection,
    () => null,
  )
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    void ensureConversationAttached().then((attached) => {
      if (cancelled) return
      // Load whatever history exists so a window opened later is not blank. A
      // refusal is reported, not thrown: the view already renders what Core said.
      void attached.list().then((outcome) => {
        if (outcome.operation === 'refused') setNotice(outcome.reason)
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const activeTurn = projection?.activeTurn ?? null
  const onStop = () => {
    if (activeTurn) void mirror.cancelTurn(activeTurn.turnId)
  }
  const onCreateConversation = useCallback(() => {
    void mirror.create()
    setNotice('')
  }, [mirror])
  const onOpenConversation = useCallback((conversationId: string) => {
    void mirror.read(conversationId)
  }, [mirror])

  return (
    <ChatView
      projection={projection}
      notice={notice}
      onStop={onStop}
      onOpenConversation={onOpenConversation}
      onCreateConversation={onCreateConversation}
    />
  )
}
