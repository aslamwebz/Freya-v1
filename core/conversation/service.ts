import type { ModelAttachment } from '../model/provider'
import type { MediaItem } from '../media/types'
import type { ToolSource, ToolStepRecord, ChartSpec, CanvasSpec } from '../mind/tools'
import type { TurnIntentHints } from '../mind/tool-intent'
import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { ModelGateway } from '../model/gateway'
import type { MindRuntime, MindTurnResult } from '../mind/mind'
import { ConversationStoreError, type ConversationStore } from './store'
import { CONVERSATION_LIMITS, type Conversation, type ConversationSummary } from './types'
import type {
  ActiveTurnView,
  CognitionAvailability,
  ConversationMessageView,
  ConversationProjection,
  ConversationSummaryView,
} from '../protocol/conversation'

/**
 * The Conversation Service.
 *
 * The command surface for conversation, and the owner of the projection the
 * window renders. It sits between the renderer and the Mind so the renderer never
 * touches either: the window can ask for a conversation, submit a turn and stop a
 * response, and cannot reach the store, the gateway, the identity or the
 * Governor.
 *
 * It is a thin layer on purpose. The interesting decisions — what context to
 * compile, what grant to create, whether a provider may be contacted at all —
 * belong to the Mind, the Governor and the Gateway respectively, and duplicating
 * any of them here would create a second place for them to be wrong.
 */

import type { ChatMissionProposal, ConversationMissionView } from '../missions/chat-types'
export interface ConversationServiceOptions {
  missionViews?: (conversationId: string) => Promise<readonly ConversationMissionView[]>
  fabric: EventFabric
  store: ConversationStore
  /**
   * The Mind, which owns turn lifecycle.
   *
   * Built by Core and handed over rather than constructed here, so the Mind has
   * exactly one owner and this service cannot end up with a second one.
   */
  mind: MindRuntime
  gateway: ModelGateway
  now?: () => Date
  newId?: () => string
  /**
   * Whether a provider could serve a request right now, and why not.
   *
   * A function because it is a live fact about this process, read per projection
   * rather than captured. The Mind never sees it — a turn that cannot run still
   * stores the user's words and reports a truthful failure, rather than being
   * refused before the person has said it.
   */
  cognitionAvailability: () => CognitionAvailability
  stopAll: () => { active: boolean; activatedAt: string | null }
}

/**
 * Each operation returns its own precise shape rather than one wide union.
 *
 * A single union across five operations means every caller narrows away shapes
 * that belong to a *different* operation, and the compiler cannot tell a
 * `conversationId` it is entitled to from one it is not. Five small types are
 * easier to read and impossible to mis-narrow.
 */
export type CreateResult =
  | { ok: true; conversation: ConversationSummaryView }
  | { ok: false; reason: string }

export type ListResult =
  | { ok: true; conversations: ConversationSummaryView[] }
  | { ok: false; reason: string }

export type ReadResult =
  | { ok: true; conversation: ConversationSummaryView | null; messages: ConversationMessageView[] }
  | { ok: false; reason: string }

export type TurnResult =
  | { ok: true; turn: MindTurnResult }
  | { ok: false; reason: string }

export type CancelResult = { ok: true; cancelled: boolean }

export type ArchiveResult =
  | { ok: true; archived: boolean }
  | { ok: false; reason: string }

export class ConversationService {
  private readonly missionViews: ConversationServiceOptions['missionViews']
  private readonly fabric: EventFabric
  private readonly store: ConversationStore
  private readonly mind: MindRuntime
  private readonly gateway: ModelGateway
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly cognitionAvailability: () => CognitionAvailability
  private readonly stopAll: () => { active: boolean; activatedAt: string | null }

  private readonly listeners = new Set<(projection: ConversationProjection) => void>()
  private activeConversationId: string | null = null
  private faults: string[] = []
  private publicationVersion = 0

  constructor(options: ConversationServiceOptions) {
    this.missionViews = options.missionViews
    this.fabric = options.fabric
    this.store = options.store
    this.mind = options.mind
    this.gateway = options.gateway
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.cognitionAvailability = options.cognitionAvailability
    this.stopAll = options.stopAll
  }

  /* ------------------------------------------------------------- recovery */

  /**
   * Mark unfinished turns interrupted, and say so in the journal.
   *
   * Runs once at start-up, before any window can ask a question. It never
   * completes a turn, never retries one, and never spends anything: a turn that
   * was running when the process died has exactly one true state, which is that a
   * question is on disk and no answer is.
   */
  async recoverInterruptedTurns(): Promise<{ turnId: string; conversationId: string }[]> {
    const at = this.now().toISOString()
    let recovered: { turnId: string; conversationId: string }[] = []

    try {
      recovered = await this.store.recoverInterruptedTurns(at)
    } catch (error) {
      // A conversation-data fault. Reported, and deliberately not allowed to change
      // any security state: unreadable history is neither permission nor lockout.
      this.faults = [
        ...this.faults,
        `interrupted-turn recovery failed: ${describeStore(error)}`,
      ]
    }

    for (const recoveredTurn of recovered) {
      const { turnId, conversationId } = recoveredTurn
      await this.fabric.append(
        'conversation.turn.interrupted',
        {
          conversationId,
          turnId,
          userMessageId: null,
          assistantMessageId: null,
          contentLength: 0,
          requestId: null,
          providerId: null,
          model: null,
          outcome: 'interrupted',
          reason: 'the application stopped while this turn was running; no answer was stored',
        },
        { actor: 'system', correlationId: turnId },
      )
    }

    // A process restart loses only in-memory selection, not the conversation.
    // Restore the most recently updated visible conversation before any window can
    // attach. The store owns ordering and already excludes archived conversations,
    // so this is deterministic and cannot resurrect a closed chat.
    const restored = await this.restoreActiveConversation()
    if (recovered.length > 0 || restored) this.publish()
    return recovered
  }

  /* ------------------------------------------------------------- commands */

  /** Create an empty conversation. Named locally; no model call, ever. */
  async create(title?: string): Promise<CreateResult> {
    const at = this.now().toISOString()
    const conversation: Conversation = {
      conversationId: this.newId(),
      title: clampTitle(title) ?? 'New conversation',
      createdAt: at,
      updatedAt: at,
    }
    try {
      await this.store.putConversation(conversation)
    } catch (error) {
      return { ok: false, reason: describeStore(error) }
    }
    await this.fabric.append(
      'conversation.created',
      { conversationId: conversation.conversationId, titleLength: conversation.title.length },
      { actor: 'owner', correlationId: conversation.conversationId },
    )
    this.activeConversationId = conversation.conversationId
    this.publish()
    // Read back rather than echoed: a store that accepted the record but cannot
    // return it is a broken store, and claiming success here would be a lie the
    // window would contradict one push later.
    const summary = await this.summaryOf(conversation.conversationId)
    return summary === null
      ? { ok: false, reason: 'the conversation could not be read back' }
      : { ok: true, conversation: summary }
  }

  async list(): Promise<ListResult> {
    try {
      const summaries = await this.store.listConversations(
        CONVERSATION_LIMITS.maxConversationsListed,
      )
      return { ok: true, conversations: summaries.map(toSummaryView) }
    } catch (error) {
      return { ok: false, reason: describeStore(error) }
    }
  }

  async rename(conversationId: string, title: string): Promise<CreateResult> {
    const normalized = title.replace(/\s+/g, ' ').trim()
    if (!normalized || normalized.length > CONVERSATION_LIMITS.maxTitleCharacters) {
      return { ok: false, reason: `Conversation title must contain 1–${CONVERSATION_LIMITS.maxTitleCharacters} characters.` }
    }
    try {
      const record = await this.store.readConversation(conversationId)
      if (!record) return { ok: false, reason: 'Conversation was not found.' }
      await this.store.putConversation({ ...record.conversation, title: normalized, updatedAt: this.now().toISOString() })
      await this.fabric.append('conversation.renamed', { conversationId, titleLength: normalized.length }, { actor: 'owner', correlationId: conversationId })
      const summary = await this.summaryOf(conversationId)
      this.publish()
      return summary === null ? { ok: false, reason: 'The renamed conversation could not be read back.' } : { ok: true, conversation: summary }
    } catch (error) {
      return { ok: false, reason: describeStore(error) }
    }
  }

  async read(conversationId: string): Promise<ReadResult> {
    try {
      const record = await this.store.readConversation(conversationId)
      if (record === null) {
        return { ok: true, conversation: null, messages: [] }
      }
      this.activeConversationId = conversationId
      // Bounded: the most recent messages, so a very long transcript cannot
      // become an unbounded IPC payload.
      const messages = record.messages
        .slice(-CONVERSATION_LIMITS.maxMessagesInProjection)
        .map(toMessageView)
      this.publish()
      return { ok: true, conversation: summariseRecord(record), messages }
    } catch (error) {
      return { ok: false, reason: describeStore(error) }
    }
  }

  /**
   * Close a conversation without destroying its encrypted history.
   *
   * A running turn is scoped-cancelled first. Its eventual terminal bookkeeping
   * remains attached to this conversation and can never land in whichever chat the
   * owner opens next. Archiving is metadata only: no model call and no authority
   * widening.
   */
  async archive(conversationId: string): Promise<ArchiveResult> {
    const active = this.mind.activeTurn(conversationId)
    if (active !== null) {
      this.mind.cancelTurn(active.turnId, 'the owner closed this conversation')
    }

    let record
    try {
      record = await this.store.readConversation(conversationId)
    } catch (error) {
      return { ok: false, reason: describeStore(error) }
    }
    if (record === null) return { ok: true, archived: false }

    const at = this.now().toISOString()
    try {
      await this.store.putConversation({
        ...record.conversation,
        updatedAt: at,
        archivedAt: at,
      })
    } catch (error) {
      return { ok: false, reason: describeStore(error) }
    }

    await this.fabric.append(
      'conversation.archived',
      { conversationId, titleLength: record.conversation.title.length },
      { actor: 'owner', correlationId: conversationId },
    )
    if (this.activeConversationId === conversationId) this.activeConversationId = null
    this.publish()
    return { ok: true, archived: true }
  }

  /**
   * Submit a user turn.
   *
   * The single door from the window into cognition. It returns the turn's real
   * outcome rather than "accepted", because a window that has been told a message
   * was received will otherwise wait for an answer that is not coming — and here
   * an answer genuinely is on its way.
   *
   * Note what the caller cannot influence: the turn id is ours, the grant is ours,
   * the context is compiled by ours, and the provider is chosen by the Gateway.
   *
   * `intents` travels as structured metadata only. The Mind reads it to seed an
   * initial tool request; the stored user message is still `text`, unchanged.
   */
  async submitTurn(input: {
    conversationId: string
    text: string
    attachments?: readonly ModelAttachment[]
    requestId: string
    intents?: TurnIntentHints
  }): Promise<TurnResult> {
    const result = await this.mind.runTurn({
      conversationId: input.conversationId,
      turnId: this.newId(),
      text: input.text,
      attachments: input.attachments,
      ...(input.intents !== undefined ? { intents: input.intents } : {}),
    })
    this.publish()
    return { ok: true, turn: result }
  }

  /**
   * Stop this turn's response.
   *
   * Scoped, and the distinction from STOP ALL is the whole point: this aborts one
   * provider request, leaves the contact gate open, latches nothing, and leaves
   * every other conversation free to think. The turn's own outcome is written by
   * the Mind when the request settles — this method only signals.
   */
  async cancelTurn(turnId: string): Promise<CancelResult> {
    const aborted = this.mind.cancelTurn(turnId, 'the owner stopped this response')
    this.publish()
    return { ok: true, cancelled: aborted > 0 }
  }

  /* ----------------------------------------------------------- projection */

  subscribe(listener: (projection: ConversationProjection) => void): () => void {
    this.listeners.add(listener)
    const version = this.publicationVersion
    // Built asynchronously because it reads the store, and pushed immediately so a
    // window that attaches late is already correct rather than briefly empty.
    void this.projection()
      .then((projection) => {
        if (version !== this.publicationVersion || !this.listeners.has(listener)) return
        try {
          listener(projection)
        } catch (error) {
          console.error('[freya.conversation] projection subscriber threw', error)
        }
      })
      .catch(() => {})
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Build the projection.
   *
   * Assembled from the store, the Mind's live bookkeeping and Core's status. The
   * only asynchronous part is the conversation read, and it is bounded — the
   * projection is pushed on every change, so it must not become a way to move the
   * whole history around on each keystroke.
   */
  async projection(): Promise<ConversationProjection> {
    const conversationId = this.activeConversationId
    let messages: ConversationMessageView[] = []
    let conversations: ConversationSummaryView[] = []

    try {
      conversations = (await this.store.listConversations(CONVERSATION_LIMITS.maxConversationsListed)).map(
        toSummaryView,
      )
      if (conversationId !== null) {
        const record = await this.store.readConversation(conversationId)
        if (record !== null) {
          messages = record.messages
            .slice(-CONVERSATION_LIMITS.maxMessagesInProjection)
            .map(toMessageView)
        }
      }
    } catch (error) {
      this.faults = [...this.faults, `conversation store could not be read: ${describeStore(error)}`]
    }

    const activeTurn = this.activeTurnView()
    const stop = this.stopAll()

    return {
      persistence: { mode: this.store.mode, reason: this.store.faultReason },
      conversations,
      activeConversationId: conversationId,
      messages,
      ...(conversationId && this.missionViews ? { missions: await this.missionViews(conversationId) } : {}),
      activeTurn,
      cognition: this.cognitionAvailability(),
      stopAll: { active: stop.active, activatedAt: stop.activatedAt },
      maxMessageCharacters: CONVERSATION_LIMITS.maxMessageCharacters,
      faults: [...new Set(this.faults)],
    }
  }

  /** The conversation a new turn would go into, creating one if needed. */
  async ensureConversation(): Promise<string | null> {
    if (this.activeConversationId !== null) return this.activeConversationId
    const created = await this.create()
    return created.ok ? created.conversation.conversationId : null
  }

  private async restoreActiveConversation(): Promise<boolean> {
    if (this.activeConversationId !== null) return false
    try {
      const listed = await this.store.listConversations(1)
      const next = listed[0]?.conversationId ?? null
      if (next === null) return false
      this.activeConversationId = next
      return true
    } catch (error) {
      this.faults = [
        ...this.faults,
        `conversation restoration failed: ${describeStore(error)}`,
      ]
      return false
    }
  }

  private activeTurnView(): ActiveTurnView | null {
    const conversationId = this.activeConversationId
    if (conversationId === null) return null
    const active = this.mind.activeTurn(conversationId)
    if (active === null) return null
    return {
      turnId: active.turnId,
      conversationId,
      // Stable for the lifetime of the turn. Rebuilding a projection must not
      // make it look as though the same response started again just now.
      startedAt: active.startedAt,
      // Request-scoped live truth: another conversation using a provider cannot
      // make this one appear to be generating.
      providerExecuting: this.gateway.isProviderRequestInFlight(active.turnId),
    }
  }

  private async summaryOf(conversationId: string): Promise<ConversationSummaryView | null> {
    try {
      const listed = await this.store.listConversations(CONVERSATION_LIMITS.maxConversationsListed)
      const found = listed.find((summary) => summary.conversationId === conversationId)
      return found ? toSummaryView(found) : null
    } catch {
      return null
    }
  }

  /**
   * Push the current projection.
   *
   * Fire-and-forget by design: a subscriber is a window, and a window that has
   * gone away must not be able to make a turn's completion wait. The projection is
   * rebuilt on the next change regardless, so a dropped push is self-healing.
   *
   * Public because the Mind calls it: a turn starting and a turn settling are the
   * two moments a window most needs to hear about, and only the Mind knows when
   * they happen.
   */
  publish(): void {
    const version = ++this.publicationVersion
    void this.projection()
      .then((projection) => {
        if (version !== this.publicationVersion) return
        for (const listener of [...this.listeners]) {
          try {
            listener(projection)
          } catch (error) {
            console.error('[freya.conversation] projection subscriber threw', error)
            this.listeners.delete(listener)
          }
        }
      })
      .catch((error: unknown) => {
        console.error('[freya.conversation] projection could not be built', error)
      })
  }
}

function toMessageView(message: {
  missionProposal?: ChatMissionProposal
  missionId?: string
  missionDecision?: { proposalMessageId: string; decision: 'approved' | 'rejected' }
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  turnId: string
  media?: readonly MediaItem[]
  sources?: readonly ToolSource[]
  charts?: readonly ChartSpec[]
  canvas?: CanvasSpec
  steps?: readonly ToolStepRecord[]
}): ConversationMessageView {
  return {
    messageId: message.messageId,
    ...(message.missionProposal ? { missionProposal: message.missionProposal } : {}),
    ...(message.missionId ? { missionId: message.missionId } : {}),
    ...(message.missionDecision ? { missionDecision: message.missionDecision } : {}),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    turnId: message.turnId,
    // The key is omitted rather than set to an empty list when there is nothing, so
    // "no lookup found anything" and "a lookup found an empty list" stay distinct all
    // the way to the renderer.
    ...(message.media === undefined || message.media.length === 0 ? {} : { media: message.media }),
    ...(message.sources === undefined || message.sources.length === 0 ? {} : { sources: message.sources }),
    ...(message.charts === undefined || message.charts.length === 0 ? {} : { charts: message.charts }),
    ...(message.canvas === undefined ? {} : { canvas: message.canvas }),
    // The loop's step records are kept absent on a turn that looked nothing up.
    // Their presence is the renderer-side signal that the transcript's "What
    // Freya did" section can be drawn from the loop rather than from the
    // model's prose, and a turn whose model narrated a tool act but whose
    // `steps` are absent is a turn the reader can see did not run one.
    ...(message.steps === undefined || message.steps.length === 0 ? {} : { steps: message.steps }),
  }
}

/** The list-view shape, computed from a full record. */
function summariseRecord(record: {
  conversation: Conversation
  messages: readonly unknown[]
  turns: readonly { outcome: ConversationSummary['lastTurnOutcome'] }[]
}): ConversationSummaryView {
  const turns = record.turns
  return {
    conversationId: record.conversation.conversationId,
    title: record.conversation.title,
    updatedAt: record.conversation.updatedAt,
    messageCount: record.messages.length,
    lastTurnOutcome: turns[turns.length - 1]?.outcome ?? null,
  }
}

function toSummaryView(summary: ConversationSummary): ConversationSummaryView {
  return {
    conversationId: summary.conversationId,
    title: summary.title,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    lastTurnOutcome: summary.lastTurnOutcome ?? null,
  }
}

function clampTitle(title: string | undefined): string | null {
  if (title === undefined) return null
  const collapsed = title.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return null
  return collapsed.length <= CONVERSATION_LIMITS.maxTitleCharacters
    ? collapsed
    : `${collapsed.slice(0, CONVERSATION_LIMITS.maxTitleCharacters).trimEnd()}…`
}

function describeStore(error: unknown): string {
  if (error instanceof ConversationStoreError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : 'unknown conversation store error'
}
