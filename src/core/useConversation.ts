import { useCallback, useEffect, useMemo, useState } from 'react'
import { shellStore } from '../ui/store'
import {
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../platform/conversationClient'
import type {
  ConversationMessageView,
  ConversationProjection,
} from '../../core/protocol/conversation'

/**
 * The conversation projection, as a React value.
 *
 * One subscription per surface rather than per panel, and it attaches lazily: a
 * window that never opens Chat never subscribes, so the transcript is not
 * assembled and shipped for a pane nobody is looking at.
 *
 * Nothing here derives conversation truth. Every field came from Core, and
 * `ensureConversationId` asks Core rather than minting an id — a window that
 * invented a conversation id would be creating state it has no authority over.
 */
export function useConversation(): ConversationProjection | null {
  const [projection, setProjection] = useState<ConversationProjection | null>(null)
  const mirror = conversationMirror()

  useEffect(() => {
    let dispose: (() => void) | undefined
    let cancelled = false
    void ensureConversationAttached().then((attached) => {
      if (cancelled) return
      dispose = attached.subscribe((next) => {
        setProjection(next)
        // Core decides which conversation is open; the store only remembers it so
        // the window can re-open the same one after a reload. Dispatching rather
        // than writing directly keeps one path into the state.
        shellStore.dispatch({
          type: 'conversation.selected',
          conversationId: next?.activeConversationId ?? null,
        })
      })
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [mirror])

  return projection
}

/** The transcript, or nothing. A convenience over the projection, not a copy of it. */
export function useConversationMessages(): ConversationMessageView[] {
  const projection = useConversation()
  return useMemo(() => visibleMessages(projection), [projection])
}

/**
 * The conversation to send into, creating one if the window has none.
 *
 * Returns `null` rather than an empty string when Core refuses, because "no
 * conversation" and "a conversation with an empty id" are different failures and
 * only one of them should reach a submit.
 */
export function useConversationId(): () => Promise<string | null> {
  const projection = useConversation()
  const mirror = conversationMirror()
  const active = projection?.activeConversationId ?? null

  return useCallback(async () => {
    if (active) return active
    const created = await mirror.create()
    return created.operation === 'created' ? created.conversation.conversationId : null
  }, [active, mirror])
}
