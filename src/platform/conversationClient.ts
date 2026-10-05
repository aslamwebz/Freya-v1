import type {
  ConversationCommandOutcome,
  ConversationMessageView,
  ConversationProjection,
  ConversationSummaryView,
} from '../../core/protocol/conversation'
import { hostBridge } from './host'

/**
 * The renderer's view of conversation.
 *
 * A **mirror**, in exactly the sense `coreClient` is one: every field here
 * arrived over IPC from Core, and the renderer cannot write a field of it. There
 * is no renderer-side transcript, no local message list, and no "optimistic"
 * message inserted before Core has stored it — which is what makes the durability
 * ordering in the Mind visible here rather than merely claimed in a comment.
 *
 * The one thing the renderer *does* own is the composer's draft, because an
 * unsent sentence is not conversation state and belongs to the window.
 *
 * ## No voice here
 *
 * Phase 3 kept the voice status on this mirror because there was nowhere else for
 * it. Phase 45 gives it its own client (`voiceClient`) because the two have
 * opposite shapes: a conversation changes when somebody thinks, and a voice
 * projection changes when a permission prompt resolves or a device is released.
 * Folding the second into the first would mean rebuilding a transcript read
 * because a microphone closed.
 */

export interface ConversationMirror {
  readonly projection: ConversationProjection | null
  subscribe(listener: (projection: ConversationProjection | null) => void): () => void
  attach(): Promise<() => void>

  create(): Promise<ConversationCommandOutcome>
  list(): Promise<ConversationCommandOutcome>
  read(conversationId: string): Promise<ConversationCommandOutcome>
  archive(conversationId: string): Promise<ConversationCommandOutcome>
  submitTurn(conversationId: string, text: string): Promise<ConversationCommandOutcome>
  cancelTurn(turnId: string): Promise<ConversationCommandOutcome>

  /**
   * Forget the shared mirror. For tests.
   */
  reset(): void
}

/**
 * Shown before Core has ever reported.
 *
 * `availability: 'core-absent'` rather than a zero or an empty list pretending to
 * be an answer. Every panel that reads this has to be able to say "I don't know"
 * distinctly from "there is nothing", because in a chat window those are very
 * different states.
 */
const ABSENT_PROJECTION: ConversationProjection = {
  persistence: { mode: 'unavailable', reason: 'Core has not reported yet' },
  conversations: [],
  activeConversationId: null,
  messages: [],
  activeTurn: null,
  cognition: { available: false, reason: 'Core has not reported yet' },
  stopAll: { active: false, activatedAt: null },
  maxMessageCharacters: 0,
  faults: ['conversation is not reachable from this window'],
}

let shared: ConversationMirror | null = null
let attachPromise: Promise<ConversationMirror> | null = null

export function conversationMirror(): ConversationMirror {
  shared ??= createConversationMirror()
  return shared
}

export function ensureConversationAttached(): Promise<ConversationMirror> {
  attachPromise ??= conversationMirror().attach().then(() => conversationMirror())
  return attachPromise
}

export function resetConversationMirror(): void {
  shared = null
  attachPromise = null
}

export function createConversationMirror(): ConversationMirror {
  const listeners = new Set<(projection: ConversationProjection | null) => void>()
  let current: ConversationProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: ConversationProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  const host = () => hostBridge()

  const submit = async (command: string, payload?: unknown): Promise<ConversationCommandOutcome> => {
    const bridge = host()
    if (!bridge) {
      return { operation: 'refused', reason: 'the Core bridge is not available in this window' }
    }
    // A Core that cannot be reached is a *state the UI already models*, not an
    // exception every call site has to remember to catch. Resolving with a refusal
    // here is what stops a window that reloads mid-call from producing an unhandled
    // rejection in a React effect instead of a sentence saying Freya is unreachable.
    let result
    try {
      result = await bridge.coreSubmit(command as never, payload)
    } catch (error) {
      return {
        operation: 'refused',
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    // Nothing is patched locally from this reply. The status it carries is
    // published by the status subscription, and the transcript arrives as a
    // projection push — so the only thing read here is the conversation outcome
    // Core built, and the renderer contributes nothing of its own.
    return (result.conversation as ConversationCommandOutcome | undefined) ?? {
      operation: 'refused',
      reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no conversation result',
    }
  }

  return {
    get projection() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    create: () => {
      const empty = current?.conversations?.find((conversation) => conversation.messageCount === 0)
      if (empty) {
        if (current?.activeConversationId !== empty.conversationId) {
          void submit('conversation.read', { conversationId: empty.conversationId })
        }
        return Promise.resolve({ operation: 'refused', reason: 'An empty conversation already exists — it is open now.' })
      }
      return submit('conversation.create')
    },
    list: () => submit('conversation.list'),
    read: (conversationId) => submit('conversation.read', { conversationId }),
    archive: (conversationId) => submit('conversation.archive', { conversationId }),

    submitTurn: (conversationId, text) => submit('conversation.turn.submit', { conversationId, text }),

    cancelTurn: (turnId) => submit('conversation.turn.cancel', { turnId }),

    async attach(): Promise<() => void> {
      disposeBridge?.()
      const bridge = host()
      if (!bridge) {
        publish(ABSENT_PROJECTION)
        return () => {}
      }
      disposeBridge = bridge.onCoreConversation((projection) => publish(projection))
      // Backstop for a push that raced the subscription, same as for status.
      publish((await bridge.coreConversation()) ?? ABSENT_PROJECTION)
      return disposeBridge
    },

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}

/** Narrow helpers so panels cannot reach into the projection's shape by accident. */
export function visibleMessages(projection: ConversationProjection | null): ConversationMessageView[] {
  return projection?.messages ?? []
}

export function conversationList(projection: ConversationProjection | null): ConversationSummaryView[] {
  return projection?.conversations ?? []
}
