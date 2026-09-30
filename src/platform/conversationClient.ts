import type {
  ConversationCommandOutcome,
  ConversationMessageView,
  ConversationProjection,
  ConversationSummaryView,
  VoiceProjection,
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
 */

export interface ConversationMirror {
  readonly projection: ConversationProjection | null
  readonly voice: VoiceProjection | null
  subscribe(listener: (projection: ConversationProjection | null) => void): () => void
  subscribeVoice(listener: (voice: VoiceProjection | null) => void): () => void
  attach(): Promise<() => void>
  attachVoice(): Promise<() => void>
  /** Re-read the voice status. Called after a capture opens or closes. */
  refreshVoice(): Promise<void>

  create(): Promise<ConversationCommandOutcome>
  list(): Promise<ConversationCommandOutcome>
  read(conversationId: string): Promise<ConversationCommandOutcome>
  submitTurn(conversationId: string, text: string): Promise<ConversationCommandOutcome>
  cancelTurn(turnId: string): Promise<ConversationCommandOutcome>

  voiceCaptureStart(): Promise<{ ok: boolean; sessionId: string | null; reason: string | null }>
  voiceCaptureEnd(input: {
    sessionId: string
    audio: Uint8Array
    durationMs: number
    cancelled?: boolean
  }): Promise<{ ok: boolean; text: string | null; detail: string | null; reason: string | null }>
  voiceCaptureCancel(): Promise<void>

  /** Forget the shared mirror. For tests. */
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
  const voiceListeners = new Set<(voice: VoiceProjection | null) => void>()
  let current: ConversationProjection | null = null
  let currentVoice: VoiceProjection | null = null
  let disposeBridge: (() => void) | null = null
  let disposeVoice: (() => void) | null = null

  const publish = (projection: ConversationProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  const publishVoice = (voice: VoiceProjection | null): void => {
    currentVoice = voice
    for (const listener of [...voiceListeners]) listener(voice)
  }

  const host = () => hostBridge()

  const submit = async (command: string, payload?: unknown): Promise<ConversationCommandOutcome> => {
    const bridge = host()
    if (!bridge) {
      return { operation: 'refused', reason: 'the Core bridge is not available in this window' }
    }
    const result = await bridge.coreSubmit(command as never, payload)
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

    get voice() {
      return currentVoice
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    subscribeVoice(listener) {
      voiceListeners.add(listener)
      listener(currentVoice)
      return () => {
        voiceListeners.delete(listener)
      }
    },

    create: () => submit('conversation.create'),
    list: () => submit('conversation.list'),
    read: (conversationId) => submit('conversation.read', { conversationId }),

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

    async attachVoice(): Promise<() => void> {
      disposeVoice?.()
      const bridge = host()
      if (!bridge) {
        publishVoice(null)
        disposeVoice = () => {}
        return disposeVoice
      }
      publishVoice(await bridge.coreVoice())
      disposeVoice = () => {}
      return disposeVoice
    },

    /**
     * Re-read the voice status on demand.
     *
     * Voice status changes when a capture opens and closes, and Core has no push
     * for it — the conversation projection already tells the window when a capture
     * is over, so a second channel for the same fact would be a second thing to
     * keep in step. The button asks.
     */
    async refreshVoice(): Promise<void> {
      const bridge = host()
      if (!bridge) return
      publishVoice(await bridge.coreVoice())
    },

    async voiceCaptureStart() {
      const bridge = host()
      if (!bridge) return { ok: false, sessionId: null, reason: 'no bridge' }
      const result = await bridge.coreSubmit('voice.capture.start')
      const voice = result.voice as { operation: string; sessionId?: string; reason?: string } | undefined
      if (result.ok && voice?.operation === 'capture-started') {
        return { ok: true, sessionId: voice.sessionId ?? null, reason: null }
      }
      return {
        ok: false,
        sessionId: null,
        reason: result.refusal?.reason ?? voice?.reason ?? 'the microphone could not be opened',
      }
    },

    async voiceCaptureEnd(input) {
      const bridge = host()
      if (!bridge) return { ok: false, text: null, detail: null, reason: 'no bridge' }
      const result = await bridge.coreSubmit('voice.capture.end', {
        sessionId: input.sessionId,
        audio: input.audio,
        durationMs: input.durationMs,
        cancelled: input.cancelled === true,
      })
      const voice = result.voice as
        | { operation: string; text?: string | null; detail?: string; reason?: string }
        | undefined
      if (voice?.operation === 'capture-ended') {
        return { ok: true, text: voice.text ?? null, detail: voice.detail ?? null, reason: null }
      }
      return {
        ok: false,
        text: null,
        detail: null,
        reason: result.refusal?.reason ?? voice?.reason ?? 'the recording could not be finished',
      }
    },

    async voiceCaptureCancel() {
      const bridge = host()
      if (!bridge) return
      await bridge.coreSubmit('voice.capture.cancel')
    },

    reset() {
      disposeBridge?.()
      disposeVoice?.()
      disposeBridge = null
      disposeVoice = null
      publish(null)
      publishVoice(null)
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
