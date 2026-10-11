import type { ModelAttachment } from '../../core/model/provider'
import type { TurnIntentHints } from '../../core/mind/tool-intent'
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
  rename(conversationId: string, title: string): Promise<ConversationCommandOutcome>
  submitTurn(
    conversationId: string,
    text: string,
    intents?: TurnIntentHints,
    attachments?: readonly ModelAttachment[],
  ): Promise<ConversationCommandOutcome>
  cancelTurn(turnId: string): Promise<ConversationCommandOutcome>
  decideMission(conversationId: string, proposalMessageId: string, decision: 'approve' | 'reject' | 'cancel' | 'resume'): Promise<ConversationCommandOutcome>

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

/** Apply the workspace's explicit selection before the desktop shell accepts input. */
export async function restoreConversationSelection(savedId: string | null): Promise<void> {
  const mirror = await ensureConversationAttached()
  if (!savedId) return
  if (mirror.projection === ABSENT_PROJECTION && hostBridge()) {
    // Electron deliberately opens its window before Core starts. A null snapshot
    // is not proof that saved history is missing. Bound the startup wait so a
    // failed Core still opens the shell's unavailable/retry state.
    let unsubscribe = () => {}
    let timeout: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>(resolve => {
      timeout = setTimeout(resolve, 12_000)
      unsubscribe = mirror.subscribe(next => { if (next && next !== ABSENT_PROJECTION) resolve() })
    })
    clearTimeout(timeout)
    unsubscribe()
  }
  const projection = mirror.projection
  if (projection?.activeConversationId === savedId) return
  // An archived/deleted thread must not displace Core's valid startup fallback.
  if (projection?.conversations.some(item => item.conversationId === savedId)) {
    await mirror.read(savedId)
  }
}

export function resetConversationMirror(): void {
  shared = null
  attachPromise = null
}

/**
 * Narrow a hint set to the closed names `TurnIntentHints` accepts, dropping
 * anything else on the floor so the renderer cannot smuggle routing through
 * the field. The composer emits two keys and nothing else; the wire carries
 * exactly those keys, and the rest of the system treats them as opaque
 * metadata the Mind reads alongside the text.
 *
 * Both `true` and `false` are carried. An explicit `false` used to be dropped
 * here, on the reasoning that an absent value already means "not requested" —
 * which quietly reversed an owner's decision. The owner turning Web search off
 * sent `false`, the transport deleted it, and Core saw an absent hint, which it
 * reads as permission to look things up. The switch on the surface was
 * decorative: it could raise a permission but never lower one.
 *
 * A caller that has *no* opinion sends `undefined`, and that is still a distinct
 * case from `false` end to end.
 */
function normaliseIntents(
  value: TurnIntentHints | undefined,
): { readonly webSearch?: boolean; readonly browserUse?: boolean } | undefined {
  if (value === undefined) return undefined
  const webSearch = typeof value.webSearch === 'boolean' ? value.webSearch : undefined
  const browserUse = typeof value.browserUse === 'boolean' ? value.browserUse : undefined
  if (webSearch === undefined && browserUse === undefined) return undefined
  return {
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(browserUse === undefined ? {} : { browserUse }),
  }
}

export function createConversationMirror(): ConversationMirror {
  const listeners = new Set<(projection: ConversationProjection | null) => void>()
  let current: ConversationProjection | null = null
  let disposeBridge: (() => void) | null = null
  let generation = 0

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

    // "Create" is a user action, not a reuse hint. Only an explicit
    // conversation.read may select history; every New/Dashboard entry gets a
    // distinct conversation id from Core.
    create: () => submit('conversation.create'),
    list: () => submit('conversation.list'),
    read: (conversationId) => submit('conversation.read', { conversationId }),
    archive: (conversationId) => submit('conversation.archive', { conversationId }),
    rename: (conversationId, title) => submit('conversation.rename', { conversationId, title }),

    submitTurn: (conversationId, text, intents, attachments) => {
      // The renderer's exact text reaches Core as `text`; the button directive
      // travels as structured metadata under `intents`. The text is never
      // mutated here — the contamination that used to live in this layer is
      // closed by construction.
      const payload: Record<string, unknown> = { conversationId, text }
      const normalised = normaliseIntents(intents)
      if (normalised !== undefined) payload['intents'] = normalised
      if (attachments && attachments.length > 0) payload['attachments'] = attachments
      return submit('conversation.turn.submit', payload)
    },

    cancelTurn: (turnId) => submit('conversation.turn.cancel', { turnId }),
    decideMission: (conversationId, proposalMessageId, decision) => submit('conversation.mission.decide', { conversationId, proposalMessageId, decision }),

    async attach(): Promise<() => void> {
      const attachment = ++generation
      disposeBridge?.()
      disposeBridge = null
      const bridge = host()
      if (!bridge) {
        publish(ABSENT_PROJECTION)
        return () => {}
      }
      let pushed = false
      try {
        const unsubscribe = bridge.onCoreConversation((projection) => {
          if (attachment !== generation) return
          pushed = true
          publish(projection)
        })
        disposeBridge = unsubscribe
        // A snapshot requested before a push may finish after it. Never replace
        // the newer transcript with that old snapshot (or a failed snapshot).
        const snapshot = await bridge.coreConversation()
        if (attachment === generation && !pushed) publish(snapshot ?? ABSENT_PROJECTION)
        return () => {
          unsubscribe()
          if (attachment === generation) { generation++; disposeBridge = null }
        }
      } catch (error) {
        if (attachment === generation && !pushed) {
          const reason = `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`
          publish({ ...ABSENT_PROJECTION, persistence: { mode: 'unavailable', reason }, faults: [reason] })
        }
        return () => {
          if (attachment === generation) { generation++; disposeBridge?.(); disposeBridge = null }
        }
      }
    },

    reset() {
      generation++
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
