import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { ConversationTurnEvent } from '../events/envelope'
import type { OwnerAuthority } from '../authority'
import type { CognitionGrantSpec } from '../cognition/grants'
import type { ModelGateway } from '../model/gateway'
import { FREYA_IDENTITY, type FreyaIdentity } from '../identity/identity'
import {
  ContextBudgetExceeded,
  compileContext,
  type ContextBudget,
} from './context-compiler'
import { ConversationStoreError, type ConversationStore } from '../conversation/store'
import {
  CONVERSATION_LIMITS,
  deriveConversationTitle,
  type Conversation,
  type ConversationMessage,
  type ConversationTurn,
  type TerminalTurnOutcome,
} from '../conversation/types'

/**
 * The Mind.
 *
 * One job in this phase: take an explicit user conversation turn, assemble
 * Freya's context for it, obtain exactly one authorised cognition, preserve what
 * came back, and report the truth.
 *
 * ```
 *   explicit user turn
 *          ↓
 *   validate and bound it
 *          ↓
 *   persist the user message            (encrypted, before anything is spent)
 *          ↓
 *   journal conversation.turn.started    (metadata only)
 *          ↓
 *   create ONE bounded foreground grant (owner authority, trusted)
 *          ↓
 *   compile context                      (identity + history + this turn)
 *          ↓
 *   Governor → Model Gateway → provider  (exactly one call)
 *          ↓
 *   persist the assistant message        (encrypted, before it is shown)
 *          ↓
 *   journal conversation.turn.completed  (metadata only)
 * ```
 *
 * ## What the Mind is not
 *
 * It is not a wrapper around a provider. It never imports one, never names one,
 * and reaches cognition only through an `OwnerAuthority` it is given. NanoGPT
 * today and a local model tomorrow are the same call to this code, which is the
 * structural half of "the model is not Freya" — the other half being that the
 * Identity Kernel is not built here either.
 *
 * ## The one-call rule
 *
 * A turn performs **at most one** provider request. There is no retry, no
 * summarisation call, no critic, no planner, no tool loop and no follow-up. A
 * failure is a failure and is reported as one. This is Phase 3's deliberate bound
 * and it is enforced structurally: the method below contains exactly one call
 * into the cognition service, so "did we accidentally add a second call" is a
 * question about one function rather than about a system.
 */

/** How a turn finished, from the Mind's point of view. */
export type MindTurnOutcome =
  | 'completed'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

export interface MindTurnResult {
  turnId: string
  conversationId: string
  outcome: MindTurnOutcome
  /** In words a person can act on. Never content. */
  reason: string | null
  /** The stored answer, when there is one. */
  assistantMessage: ConversationMessage | null
  providerId: string | null
  model: string | null
  /** True when a provider was actually asked. Drives conservative accounting. */
  providerContacted: boolean
}

export interface MindSubmitInput {
  conversationId: string
  turnId: string
  text: string
}

/**
 * The grant a foreground conversation turn runs under.
 *
 * Built here, from constants, and issued through the owner's authority — never
 * taken from a payload, never assembled by the renderer, and never chosen by the
 * model. Every field is the narrowest thing that is still true:
 *
 * - `maxCalls: 1` — one turn, one call. A second would be refused by the budget
 *   rather than by a convention.
 * - `backgroundAllowed: false` — a conversation turn is by definition somebody
 *   watching. Nothing here can run unattended.
 * - a short expiry — an unanswered turn cannot leave a live allowance lying
 *   around, and a stale grant cannot be spent later.
 * - `actor: 'owner'` — the person pressing Send is the principal.
 */
const TURN_GRANT_TTL_MS = 120_000

function foregroundGrantSpec(turnId: string, now: Date, maxOutputTokens: number): CognitionGrantSpec {
  return {
    // Turn-scoped and deterministic, so the grant this turn spends is the grant
    // this turn created. The pattern is a legal event id (`:` is allowed).
    grantId: `turn:${turnId}`,
    expiresAt: new Date(now.getTime() + TURN_GRANT_TTL_MS).toISOString(),
    allowedOrigins: ['user'],
    allowedCauses: ['user_message'],
    backgroundAllowed: false,
    maxCalls: 1,
    maxOutputTokens,
    actor: 'owner',
    goalId: null,
    runId: null,
    parentGrantId: null,
  }
}

export interface MindServiceOptions {
  fabric: EventFabric
  store: ConversationStore
  authority: OwnerAuthority
  /** The narrow door to the Model Gateway. Not a provider, not a client SDK. */
  gateway: ModelGateway
  identity?: FreyaIdentity
  budget?: ContextBudget
  now?: () => Date
  newId?: () => string
  /** Minimal runtime facts for the compiled packet. Opaque to the Mind. */
  runtimeFacts?: () => readonly string[]
  /**
   * Called when a turn starts and when it settles.
   *
   * A function rather than an event, and it fires at the *start* as well as the
   * end, because the start is the moment a window most needs to hear about: a
   * projection published only on completion would make "Freya is answering"
   * impossible to display, since by the time it arrived the answer already
   * existed.
   */
  onTurnStateChange?: () => void
}

export class MindService {
  private readonly fabric: EventFabric
  private readonly store: ConversationStore
  private readonly authority: OwnerAuthority
  private readonly gateway: ModelGateway
  private readonly identity: FreyaIdentity
  private readonly budget: ContextBudget | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly runtimeFacts: () => readonly string[]
  private readonly onTurnStateChange: () => void

  /**
   * One actively running turn per conversation.
   *
   * Phase 3 refuses a second send rather than queueing it. A queue is a hidden
   * ordering guarantee, and hidden ordering is exactly how two answers end up
   * attached to the wrong questions; a visible refusal costs one click and cannot
   * reorder a transcript.
   */
  private readonly activeTurns = new Map<string, string>()

  constructor(options: MindServiceOptions) {
    this.fabric = options.fabric
    this.store = options.store
    this.authority = options.authority
    this.gateway = options.gateway
    this.identity = options.identity ?? FREYA_IDENTITY
    this.budget = options.budget
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.runtimeFacts = options.runtimeFacts ?? (() => [])
    this.onTurnStateChange = options.onTurnStateChange ?? (() => {})
  }

  /** Whether a conversation already has a turn generating. */
  isTurnActive(conversationId: string): boolean {
    return this.activeTurns.has(conversationId)
  }

  /** The running turn for a conversation, or null. */
  activeTurnId(conversationId: string): string | null {
    return this.activeTurns.get(conversationId) ?? null
  }

  /**
   * Run one turn.
   *
   * The order below is the phase's durability contract and each step earns its
   * place. The user message is stored *before* cognition starts, so a crash
   * mid-generation leaves the question on disk with no answer — recoverable and
   * honest. The answer is stored *before* the turn is reported complete, so the
   * transcript can never show a message that is not durable. And the terminal
   * journal event comes after both, so an audit reader never sees a completed
   * turn whose answer is missing.
   */
  async runTurn(input: MindSubmitInput): Promise<MindTurnResult> {
    const startedAt = this.now().toISOString()
    const text = input.text.trim()
    const maxOutputTokens = CONVERSATION_LIMITS.maxOutputTokensPerTurn

    if (text.length === 0) {
      return this.refuse(input, 'the message is empty')
    }
    if (text.length > CONVERSATION_LIMITS.maxMessageCharacters) {
      // Failed visibly, at the edge, rather than becoming one enormous request.
      return this.refuse(
        input,
        `the message is ${text.length} characters; the limit is ` +
          `${CONVERSATION_LIMITS.maxMessageCharacters}`,
      )
    }
    if (this.activeTurns.has(input.conversationId)) {
      return this.refuse(input, 'a response is already in progress for this conversation')
    }

    const record = await this.store.readConversation(input.conversationId)
    if (record === null) {
      return this.refuse(input, 'no such conversation')
    }

    const turnId = input.turnId || this.newId()
    this.activeTurns.set(input.conversationId, turnId)
    // Before any await, so the window is told a turn is running before it can
    // possibly finish. A projection that only arrived afterwards would make the
    // generating state unreachable.
    this.onTurnStateChange()

    try {
      // --- 1. the user's words, stored before anything is spent ------------
      const userMessage: ConversationMessage = {
        messageId: this.newId(),
        conversationId: input.conversationId,
        role: 'user',
        content: text,
        createdAt: startedAt,
        turnId,
      }
      try {
        await this.store.appendMessage(userMessage)
        await this.touchConversation(input.conversationId, startedAt, deriveConversationTitle(text))
        // Published again now that the words are stored.
        //
        // The publish above the try says a turn is running, but it fires before the
        // message exists, so the transcript a window is holding does not yet
        // contain the question. Without this second push the person would not see
        // what they had asked for until the answer had already arrived — which
        // defeats storing the question first, and hides the whole five seconds a
        // slow provider spends thinking.
        this.onTurnStateChange()
      } catch (error) {
        // Nothing has been spent and nothing is claimed. A conversation that
        // cannot be written is a conversation that cannot be had.
        return this.refuse(input, conversationFault(error))
      }

      // --- 2. the turn exists, before it does anything ----------------------
      const turn: ConversationTurn = {
        turnId,
        conversationId: input.conversationId,
        userMessageId: userMessage.messageId,
        assistantMessageId: null,
        outcome: 'pending',
        startedAt,
        endedAt: null,
        // The turn id *is* the request id. One turn, one request, and a scoped
        // cancel is a lookup rather than a guess.
        requestId: turnId,
        providerId: null,
        model: null,
        reason: null,
      }
      try {
        await this.store.recordTurnStart(turn)
      } catch (error) {
        return this.refuse(input, conversationFault(error))
      }
      await this.fabric.append(
        'conversation.turn.started',
        this.turnEvent(input.conversationId, turn, {
          outcome: 'pending',
          contentLength: text.length,
        }),
        { actor: 'owner', correlationId: turnId },
      )

      // --- 3. one bounded grant, from the owner's own authority -------------
      const grant = foregroundGrantSpec(turnId, this.now(), maxOutputTokens)
      try {
        await this.authority.createGrant(grant)
      } catch (error) {
        return this.finishTurn(input, turn, 'denied', {
          reason: `the turn could not be authorised: ${describe(error)}`,
        })
      }

      // --- 4. compile, deterministically -----------------------------------
      let compiled
      try {
        compiled = compileContext(
          {
            identity: this.identity,
            history: record.messages,
            currentUserMessage: userMessage,
            runtimeFacts: this.runtimeFacts(),
          },
          this.budget,
        )
      } catch (error) {
        if (error instanceof ContextBudgetExceeded) {
          return this.finishTurn(input, turn, 'failed', { reason: error.message })
        }
        throw error
      }

      // --- 5. exactly one authorised cognition ------------------------------
      const outcome = await this.authority.request({
        kind: 'user_turn',
        prompt: compiled.messages.map((m) => m.content).join('\n\n'),
        messages: compiled.messages,
        maxOutputTokens,
        grantId: grant.grantId,
        correlationId: turnId,
        cognitionRequestId: turnId,
        requestedModel: null,
        goalId: null,
      })

      if (outcome.status === 'denied') {
        // The Governor refused. Nobody was asked, and the turn says so.
        return this.finishTurn(input, turn, 'denied', { reason: outcome.reason })
      }
      if (outcome.status === 'cancelled') {
        return this.finishTurn(input, turn, 'cancelled', {
          reason: outcome.reason,
          providerContacted: outcome.providerContacted,
        })
      }
      if (outcome.status === 'failed') {
        return this.finishTurn(input, turn, 'failed', {
          reason: outcome.reason,
          providerContacted: outcome.providerContacted,
        })
      }

      // --- 6. the answer, stored before anyone is told it exists ------------
      const endedAt = this.now().toISOString()
      const assistantMessage: ConversationMessage = {
        messageId: this.newId(),
        conversationId: input.conversationId,
        role: 'assistant',
        content: outcome.text,
        createdAt: endedAt,
        turnId,
      }
      try {
        await this.store.appendMessage(assistantMessage)
      } catch (error) {
        // The answer exists in memory and cannot be kept. Reporting the turn as
        // completed would put text in the transcript that is not durable, which
        // is the one state this ordering exists to prevent.
        return this.finishTurn(input, turn, 'failed', {
          reason: `the answer could not be stored: ${conversationFault(error)}`,
          providerId: outcome.providerId,
          model: outcome.model,
        })
      }

      return this.finishTurn(
        input,
        turn,
        'completed',
        {
          endedAt,
          assistantMessageId: assistantMessage.messageId,
          providerId: outcome.providerId,
          model: outcome.model,
        },
        assistantMessage,
      )
    } finally {
      // Whatever happened, the conversation is free again. A turn that left
      // itself marked active would make every later send fail.
      this.activeTurns.delete(input.conversationId)
      this.onTurnStateChange()
    }
  }

  /**
   * Stop one turn's response.
   *
   * Scoped on purpose. It aborts this turn's provider request and touches
   * nothing else: the contact gate stays open, the cognition generation does not
   * move, STOP ALL is not latched, no other conversation is affected, and the
   * already-spent reservation stays spent.
   *
   * The turn's own terminal bookkeeping happens in `runTurn`, which is still
   * awaiting the provider and will settle normally. This method only signals.
   */
  cancelTurn(turnId: string, reason = 'the owner stopped this response'): number {
    return this.gateway.cancelRequest(turnId, reason)
  }

  /* ---------------------------------------------------------------- private */

  /**
   * A turn that never started.
   *
   * No user message, no journal event, no cognition, no spend. The caller's own
   * input was the problem — too long, empty, or racing another turn — and writing
   * a turn record for it would put a question in the transcript that has no
   * answer and never will.
   */
  private async refuse(input: MindSubmitInput, reason: string): Promise<MindTurnResult> {
    await this.fabric.append(
      'conversation.turn.denied',
      {
        conversationId: input.conversationId,
        turnId: input.turnId || this.newId(),
        userMessageId: null,
        assistantMessageId: null,
        contentLength: input.text.trim().length,
        requestId: null,
        providerId: null,
        model: null,
        outcome: 'denied',
        reason,
      },
      { actor: 'owner', correlationId: input.turnId || this.newId() },
    )
    return {
      turnId: input.turnId,
      conversationId: input.conversationId,
      outcome: 'denied',
      reason,
      assistantMessage: null,
      providerId: null,
      model: null,
      providerContacted: false,
    }
  }

  /**
   * Write the turn's terminal state, to both stores.
   *
   * The conversation store gets the truth about the turn; the Event Fabric gets
   * metadata about the same event. Neither gets content, and the ordering is
   * store-then-journal so an audit reader never sees a terminal event for a turn
   * the conversation store has not caught up with.
   */
  private async finishTurn(
    input: MindSubmitInput,
    turn: ConversationTurn,
    outcome: MindTurnOutcome,
    detail: {
      reason?: string
      endedAt?: string
      assistantMessageId?: string
      providerId?: string | null
      model?: string | null
      /**
       * What the gateway reported, passed straight through. The Mind does not
       * re-derive it: only the gateway knows whether a provider had the request,
       * and a Mind that guessed would report a paid call as free.
       */
      providerContacted?: boolean
    },
    assistantMessage: ConversationMessage | null = null,
  ): Promise<MindTurnResult> {
    const endedAt = detail.endedAt ?? this.now().toISOString()
    const reason = detail.reason ?? null
    const providerId = detail.providerId ?? null
    const model = detail.model ?? null

    // The turn is over for the Mind whatever the store says. A store that cannot
    // record the outcome must not leave the conversation permanently busy.
    this.activeTurns.delete(input.conversationId)
    this.onTurnStateChange()

    let storedReason = reason
    try {
      await this.store.recordTurnOutcome(turn.turnId, outcome as TerminalTurnOutcome, {
        endedAt,
        assistantMessageId: detail.assistantMessageId ?? null,
        providerId,
        model,
        reason,
      })
    } catch (error) {
      storedReason = `${reason ? `${reason} ` : ''}(the conversation store could not record this: ${conversationFault(error)})`
    }

    await this.fabric.append(
      terminalEventFor(outcome),
      this.turnEvent(input.conversationId, turn, {
        outcome,
        reason: storedReason,
        assistantMessageId: detail.assistantMessageId ?? null,
        providerId,
        model,
        contentLength: assistantMessage?.content.length ?? 0,
      }),
      { actor: 'owner', correlationId: turn.turnId },
    )

    return {
      turnId: turn.turnId,
      conversationId: input.conversationId,
      outcome,
      reason: storedReason,
      assistantMessage,
      providerId,
      model,
      // Taken from the gateway's own account of contact, and never inferred from
      // whether the turn "got far enough to have cost something". A cancelled
      // turn that had already reached a provider was very probably billed, and
      // cancelling does not make it free.
      providerContacted: detail.providerContacted ?? outcome === 'completed',
    }
  }

  /**
   * The durable metadata for a turn.
   *
   * One builder, used for the started event and for every terminal one, so the
   * audit record of a turn cannot disagree with itself: the same ids, the same
   * request, the same provider. It is built from the turn record rather than from
   * local variables, which is what stops a terminal event being written with a
   * provider that never answered it.
   */
  private turnEvent(
    conversationId: string,
    turn: ConversationTurn,
    detail: {
      outcome: string
      reason?: string | null
      assistantMessageId?: string | null
      providerId?: string | null
      model?: string | null
      contentLength?: number
    },
  ): ConversationTurnEvent {
    return {
      conversationId,
      turnId: turn.turnId,
      userMessageId: turn.userMessageId,
      assistantMessageId: detail.assistantMessageId ?? turn.assistantMessageId,
      contentLength: detail.contentLength ?? 0,
      requestId: turn.requestId,
      providerId: detail.providerId ?? turn.providerId,
      model: detail.model ?? turn.model,
      outcome: detail.outcome,
      reason: detail.reason ?? null,
    }
  }

  /** Move a conversation's updatedAt forward, and name it on its first message. */
  private async touchConversation(
    conversationId: string,
    at: string,
    firstMessageTitle: string,
  ): Promise<void> {
    const record = await this.store.readConversation(conversationId)
    if (!record) return
    const isFirstMessage = record.messages.filter((m) => m.role === 'user').length <= 1
    const next: Conversation = {
      ...record.conversation,
      updatedAt: at,
      title: isFirstMessage ? firstMessageTitle : record.conversation.title,
    }
    await this.replaceConversation(next)
  }

  private async replaceConversation(conversation: Conversation): Promise<void> {
    // The store interface is append-only by design, so a metadata change is a
    // fresh conversation record. Later versions of this record win, which is
    // exactly the fold a reader already performs.
    await this.store.putConversation(conversation)
  }
}

function terminalEventFor(outcome: MindTurnOutcome) {
  switch (outcome) {
    case 'completed':
      return 'conversation.turn.completed' as const
    case 'cancelled':
    case 'interrupted':
      return 'conversation.turn.cancelled' as const
    default:
      return 'conversation.turn.failed' as const
  }
}

function conversationFault(error: unknown): string {
  if (error instanceof ConversationStoreError) {
    return `conversation store: ${error.code} (${error.message})`
  }
  return describe(error)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

