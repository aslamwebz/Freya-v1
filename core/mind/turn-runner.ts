import { boundAssistantMessageContent, canvasField, chartsField, mediaField, renderTruncatedAnswer, sourcesField } from './content-bounds'
import type { MindContextEnrichment } from './context-enrichment'
import { TRUNCATION_REASON, type MindSubmitInput, type MindTurnOutcome, type MindTurnResult } from './turn-types'
import type { MindTurnCognition, MindCognitionOutcome } from './turn-cognition'
import { conversationFault, describe, type MindTurnSettlement, type MindTurnSettlementDetail } from './turn-settlement'
import { validateModelAttachments, type ModelAttachment } from '../model/provider'
import type { ModelMessage } from '../model/provider'
import type { EventFabric } from '../events/fabric'
import type { ConversationTurnEvent } from '../events/envelope'
import type { OwnerAuthority } from '../authority'
import type { CognitionGrantSpec } from '../cognition/grants'
import type { FreyaIdentity } from '../identity/identity'
import { ContextBudgetExceeded, compileContext, type ContextBudget } from './context-compiler'
import type { ConversationStore } from '../conversation/store'
import { CONVERSATION_LIMITS, deriveConversationTitle, type Conversation, type ConversationMessage, type ConversationTurn } from '../conversation/types'
import { withExpressionBlock } from './expression'
import { MIND_TOOL_LIMITS, renderToolFooter } from './tools'
import { iterationsAsStepRecords } from './footerGuard'

export interface MindTurnRunnerOptions {
  readonly fabric: Pick<EventFabric, 'append'>
  readonly store: ConversationStore
  readonly authority: Pick<OwnerAuthority, 'request' | 'createGrant'>
  readonly identity: FreyaIdentity
  readonly budget: ContextBudget | undefined
  readonly now: () => Date
  readonly newId: () => string
  readonly runtimeFacts: () => readonly string[]
  readonly contextEnrichment: MindContextEnrichment
  readonly turnCognition: MindTurnCognition
  readonly turnSettlement: MindTurnSettlement
  readonly onTurnStateChange: () => void
  readonly toolLoopEnabled: boolean
}

/** Owns the durable workflow from an accepted message through its terminal record. */
export class MindTurnRunner {
  private readonly fabric: Pick<EventFabric, 'append'>
  private readonly store: ConversationStore
  private readonly authority: MindTurnRunnerOptions['authority']
  private readonly identity: FreyaIdentity
  private readonly budget: ContextBudget | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly runtimeFacts: () => readonly string[]
  private readonly contextEnrichment: MindContextEnrichment
  private readonly turnCognition: MindTurnCognition
  private readonly turnSettlement: MindTurnSettlement
  private readonly onTurnStateChange: () => void
  private readonly toolLoopEnabled: boolean

  constructor(options: MindTurnRunnerOptions) {
    this.fabric = options.fabric
    this.store = options.store
    this.authority = options.authority
    this.identity = options.identity
    this.budget = options.budget
    this.now = options.now
    this.newId = options.newId
    this.runtimeFacts = options.runtimeFacts
    this.contextEnrichment = options.contextEnrichment
    this.turnCognition = options.turnCognition
    this.turnSettlement = options.turnSettlement
    this.onTurnStateChange = options.onTurnStateChange
    this.toolLoopEnabled = options.toolLoopEnabled
  }

  private async think(input: Parameters<MindTurnCognition['think']>[0]): Promise<MindCognitionOutcome> {
    return await this.turnCognition.think(input)
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
    let attachments: readonly ModelAttachment[]
    try { attachments = validateModelAttachments(input.attachments) }
    catch { return this.refuse(input, 'Conversation attachments are invalid or too large.') }

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
    if (this.turnSettlement.isTurnActive(input.conversationId)) {
      return this.refuse(input, 'a response is already in progress for this conversation')
    }

    const record = await this.store.readConversation(input.conversationId)
    if (record === null) {
      return this.refuse(input, 'no such conversation')
    }

    const turnId = input.turnId || this.newId()
    this.turnSettlement.beginTurn(input.conversationId, turnId, startedAt, text.length)
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
        return await this.refuse(input, conversationFault(error))
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
        return await this.refuse(input, conversationFault(error))
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
      //
      // One grant per turn whatever the loop does. `maxCalls` is 1 unless a tool
      // registry is wired, in which case it is the iteration ceiling — and
      // `maxOutputTokens` is `maxOutputTokensPerTurn` in both cases, so the turn's
      // total is what it always was and the loop divides it rather than
      // multiplying it.
      const grant = foregroundGrantSpec(
        turnId,
        this.now(),
        maxOutputTokens,
        this.toolLoopEnabled ? MIND_TOOL_LIMITS.maxProviderCalls : 1,
      )
      try {
        await this.authority.createGrant(grant)
      } catch (error) {
        return await this.finishTurn(input, turn, 'denied', {
          reason: `the turn could not be authorised: ${describe(error)}`,
          ownerText: text,
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
            // Read-only, and inside the same try as compilation so that a Brain which
            // cannot answer degrades to no reference block rather than failing a
            // turn. Forgetting is not a reason to refuse to answer.
            referenceKnowledge: this.contextEnrichment.recalledFor(text),
          },
          this.budget,
        )
      } catch (error) {
        if (error instanceof ContextBudgetExceeded) {
          return await this.finishTurn(input, turn, 'failed', { reason: error.message, ownerText: text })
        }
        throw error
      }

      // The block goes in *after* compilation rather than through the compiler,
      // so the Context Compiler's input stays the closed set of five explicit
      // fields the Phase 9 red-team suite asserts, and this block arrives as a
      // separate `user`-role message the compiler was never asked to trust.
      const carriedMessages = attachments.length ? compiled.messages.map((message, index) => index === compiled.messages.length - 1 ? { ...message, attachments } : message) : compiled.messages
      const withContext = withTurnContext(carriedMessages, this.contextEnrichment.sharedContextFor(text, input.conversationId))

      // --- 4b. expression planning, into the SAME provider call --------------
      //
      // Deterministic social interpretation and bounded expression planning,
      // spliced into the packet the Mind was already going to send. No second
      // provider call, no persistence, no clock read. The block is style guidance
      // only — it cannot grant capability, bypass Guard, or weaken STOP ALL.
      //
      // Without a usable expression-memory seam there is no block at all: the
      // personality layer enters through that seam and nowhere else. See
      // `expressionForTurn`.
      const expression = this.contextEnrichment.expressionForTurn(startedAt)
      const priorLearning = this.contextEnrichment.learnedFor(text)
      const withLearning = priorLearning === null ? withContext : [
        ...withContext.slice(0, -1), priorLearning, withContext[withContext.length - 1]!,
      ]
      const messages = withExpressionBlock(withLearning, expression?.block ?? null)

      // Record what context was actually assembled before the provider is asked.
      // This remains true for failure/cancellation outcomes too; a turn does not
      // need to complete successfully for its Experience metadata to be accurate.
      this.turnSettlement.setExperience(turnId, {
        startedAt,
        referenceUsed: compiled.reference.included,
        referenceItemCount: compiled.reference.itemCount,
        requestLength: text.length,
      })

  // --- 5. authorised cognition: one call, or a bounded tool loop ---------
      const cognition = await this.think({
        turnId,
        conversationId: input.conversationId,
        grantId: grant.grantId,
        messages,
        ownerText: text,
        intents: input.intents ?? {},
        carriedSources: compiled.research?.sources ?? [],
        researchFollowUp: compiled.researchReference === true,
        perTurnAllowance: maxOutputTokens,
      })

      // Preserve the loop's actual tool outcomes, even if the final answer failed.
      // No arguments, content or user data are copied into the experience record.
      if ('steps' in cognition && cognition.steps) {
        const measurement = this.turnSettlement.experience(turnId)
        if (measurement) this.turnSettlement.setExperience(turnId, {
          ...measurement,
          toolSteps: cognition.steps.map(({ step }) => ({
            name: step.tool, capability: step.capability, outcome: step.outcome, executed: step.executed,
          })),
        })
      }

      // Record cue use only when a provider was actually reached. A Governor
      // denial never dispatches, and a cancellation that arrived before contact
      // never dispatched either — no cue was spent, and recording one would
      // suppress a gesture the owner never saw. The loop reports contact the same
      // way the gateway reports it, never inferred from how far the turn got.
      if (expression !== null && cognition.kind !== 'denied' && cognition.providerContacted) {
        for (const cue of expression.offeredCueIds) {
          this.contextEnrichment.recordCueUse(cue.cueId, cue.kind, startedAt)
        }
      }

      if (cognition.kind === 'denied') {
        // The Governor refused. Nobody was asked, and the turn says so.
        return await this.finishTurn(input, turn, 'denied', { reason: cognition.reason, ownerText: text })
      }
      if (cognition.kind === 'cancelled') {
        return await this.finishTurn(input, turn, 'cancelled', {
          reason: cognition.reason,
          providerContacted: cognition.providerContacted,
          ownerText: text,
        })
      }
      if (cognition.kind === 'failed') {
        return await this.finishTurn(input, turn, 'failed', {
          reason: cognition.reason,
          providerContacted: cognition.providerContacted,
          ownerText: text,
        })
      }

      if (cognition.kind === 'truncated') {
        return await this.finishTruncatedTurn(input, turn, cognition, text)
      }

      // --- 6. the answer, stored before anyone is told it exists ------------
      const endedAt = this.now().toISOString()
      const stepRecords = iterationsAsStepRecords(cognition.steps)
      const assistantMessage: ConversationMessage = {
        messageId: this.newId(),
        conversationId: input.conversationId,
        role: 'assistant',
        // The model's own words, plus the tool footer the model cannot remove. A
        // turn that looked something up says so in the transcript, and a turn
        // whose lookup was refused or failed says that too — the "no silent
        // downgrade" rule enforced by code rather than by an instruction.
        //
        // `cognition.text` is already stripped of any model-written footer block
        // by the time we reach this branch (see `think`), so the prose stored
        // here is the model's own words without any block shaped like the
        // code's footer. A forge is therefore impossible from the store side.
        content: boundAssistantMessageContent(cognition.text),
        createdAt: endedAt,
        turnId,
        // What the lookups really returned, kept as typed items beside the prose. The
        // answer is the model's account of the search; this is the search.
        ...mediaField(cognition.steps.map((iteration) => iteration.observation)),
        ...sourcesField(cognition.steps.map((iteration) => iteration.observation), 100, compiled.research?.sources),
        ...chartsField(cognition.steps.map((iteration) => iteration.observation)),
        ...canvasField(cognition.steps.map((iteration) => iteration.observation)),
        ...cognition.steps.reduce((fields, iteration) => iteration.observation.kind === 'ok' && iteration.observation.missionProposal ? { missionProposal: iteration.observation.missionProposal } : fields, {}),
        // The loop's own record of what it did, carried beside the prose so the
        // renderer can draw the "What Freya did" section from the loop rather
        // than from the model's text. Absent on a turn that looked nothing up.
        ...(stepRecords === undefined ? {} : { steps: stepRecords }),
      }
      try {
        await this.store.appendMessage(assistantMessage)
      } catch (error) {
        // The answer exists in memory and cannot be kept. Reporting the turn as
        // completed would put text in the transcript that is not durable, which is
        // the one state this ordering exists to prevent.
        return await this.finishTurn(input, turn, 'failed', {
          reason: `the answer could not be stored: ${conversationFault(error)}`,
          providerId: cognition.providerId,
          model: cognition.model,
          ownerText: text,
        })
      }

      return await this.finishTurn(
        input,
        turn,
        'completed',
        {
          endedAt,
          assistantMessageId: assistantMessage.messageId,
          providerId: cognition.providerId,
          model: cognition.model,
          ownerText: text,
        },
        assistantMessage,
      )
    } finally {
      // Important: every asynchronous terminal return above is awaited before
      // this finally block runs. Returning the promise directly would execute
      // this cleanup first, deleting per-turn Experience measurements while
      // finishTurn was still awaiting its durable writes.
      //
      // Whatever happened, the conversation is free again. A turn that left
      // itself marked active would make every later send fail.
      // Cleared after the terminal event so this turn can never leak measurements
      // into a later one.
      this.turnSettlement.releaseTurn(input.conversationId, turnId)
    }
  }
  /* ---------------------------------------------------------------- private */

  /**
   * A turn whose answer was cut off by the output budget.
   *
   * ### The outcome is `failed`, and that is the only truthful one
   *
   * `failed` in the existing vocabulary means "it was attempted and did not
   * work", which is exactly what happened: a provider was asked, it answered, and
   * what it answered is not an answer. The other four are all wrong in a way that
   * would put a false claim in the transcript:
   *
   *  - `completed` claims an answer exists and is stored. It does not.
   *  - `denied` claims the Governor refused and nobody was asked. A provider was
   *    asked, generated, and was very probably billed.
   *  - `cancelled` claims somebody stopped it deliberately. Nobody did. The budget
   *    is not a person.
   *  - `interrupted` is recovery's word for a turn that was still running when the
   *    process died. Nothing died, and a Mind that claimed otherwise would be
   *    taking a durable state it has no evidence for.
   *
   * So the reason field carries the truth in words instead, and the terminal event
   * is `conversation.turn.failed` — the same event a provider error produces,
   * which is correct: both are turns that were attempted and did not yield an
   * answer.
   *
   * ### What is stored
   *
   * One assistant message holding what the model produced *and* the sentence that
   * says it did not finish. Not stored instead of the partial text — the partial
   * text is real and throwing it away would be its own dishonesty — and never
   * stored without the sentence. `assistantMessageId` is set so the transcript and
   * the turn agree, which also means recovery will not later find a terminal turn
   * with no message and re-report it as `interrupted`.
   *
   * There is no retry here and no larger budget asked for. What a turn costs is
   * not a decision this method gets to take.
   */
  private async finishTruncatedTurn(
    input: MindSubmitInput,
    turn: ConversationTurn,
    cognition: Extract<MindCognitionOutcome, { kind: 'truncated' }>,
    ownerText: string,
  ): Promise<MindTurnResult> {
    const endedAt = this.now().toISOString()
    // A turn that looked something up before being cut off still says so, so the
    // footer is rendered exactly as it is for a finished answer.
    const footer = renderToolFooter(
      cognition.steps.map((iteration) => iteration.step),
      cognition.steps.map((iteration) => iteration.observation),
    )
    const stepRecords = iterationsAsStepRecords(cognition.steps)
    const assistantMessage: ConversationMessage = {
      messageId: this.newId(),
      conversationId: input.conversationId,
      role: 'assistant',
      content: boundAssistantMessageContent(renderTruncatedAnswer(cognition.text, footer)),
      createdAt: endedAt,
      turnId: turn.turnId,
      // A cut-off answer still looked things up, and the cards it earned are still real.
      ...mediaField(cognition.steps.map((iteration) => iteration.observation)),
      ...sourcesField(cognition.steps.map((iteration) => iteration.observation), 100),
      ...chartsField(cognition.steps.map((iteration) => iteration.observation)),
      ...canvasField(cognition.steps.map((iteration) => iteration.observation)),
      // A truncated turn's loop record is kept beside the prose for the same
      // reason a finished answer's is: the renderer draws "What Freya did" from
      // the loop, not from the model's text.
      ...(stepRecords === undefined ? {} : { steps: stepRecords }),
    }

    try {
      await this.store.appendMessage(assistantMessage)
    } catch (error) {
      // Nothing survived, not even the correction, so the turn is reported with
      // the reason it has and no message id — the same state a store failure on a
      // complete answer produces, which is the honest one.
      return await this.finishTurn(input, turn, 'failed', {
        reason: `${TRUNCATION_REASON} (the explanation could not be stored: ${conversationFault(error)})`,
        providerId: cognition.providerId,
        model: cognition.model,
        providerContacted: true,
        ownerText,
      })
    }

    return await this.finishTurn(
      input,
      turn,
      'failed',
      {
        endedAt,
        assistantMessageId: assistantMessage.messageId,
        reason: TRUNCATION_REASON,
        providerId: cognition.providerId,
        model: cognition.model,
        // Passed explicitly because the default for a `failed` turn is `false`, and
        // "did not yield an answer" is not the same claim as "nothing was spent".
        // The provider generated whatever the transcript now shows.
        providerContacted: true,
        ownerText,
      },
      assistantMessage,
    )
  }
  /**
   * A turn that never started.
   *
   * No user message, no journal event, no cognition, no spend. The caller's own
   * input was the problem — too long, empty, or racing another turn — and writing
   * a turn record for it would put a question in the transcript that has no
   * answer and never will.
   */
  private async refuse(input: MindSubmitInput, reason: string): Promise<MindTurnResult> {
    return await this.turnSettlement.refuse(input, reason)
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
    detail: MindTurnSettlementDetail,
    assistantMessage: ConversationMessage | null = null,
  ): Promise<MindTurnResult> {
    return await this.turnSettlement.finishTurn(input, turn, outcome, detail, assistantMessage)
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
    return this.turnSettlement.turnEvent(conversationId, turn, detail)
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
      title: isFirstMessage && record.conversation.title === 'New conversation' ? firstMessageTitle : record.conversation.title,
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
 *
 * ## The ceiling under a tool loop
 *
 * `maxCalls` becomes the loop's iteration ceiling **only when a tool registry is
 * wired**, and `maxOutputTokens` stays `maxOutputTokensPerTurn` either way. That
 * combination is the point: the grant still bounds the *whole turn* to the number
 * one turn could always spend, and the loop divides it across iterations
 * (`budgetFor`) rather than multiplying it. A fourth iteration is refused by the
 * Governor on arithmetic, before a provider is chosen.
 *
 * A Mind with no registry keeps `maxCalls: 1` exactly, because a Mind with no
 * registry makes one call.
 */
const TURN_GRANT_TTL_MS = 120_000

function foregroundGrantSpec(
  turnId: string,
  now: Date,
  maxOutputTokens: number,
  maxCalls: number,
): CognitionGrantSpec {
  return {
    // Turn-scoped and deterministic, so the grant this turn spends is the grant
    // this turn created. The pattern is a legal event id (`:` is allowed).
    grantId: `turn:${turnId}`,
    expiresAt: new Date(now.getTime() + TURN_GRANT_TTL_MS).toISOString(),
    allowedOrigins: ['user'],
    allowedCauses: ['user_message'],
    backgroundAllowed: false,
    maxCalls,
    maxOutputTokens,
    actor: 'owner',
    goalId: null,
    runId: null,
    parentGrantId: null,
  }
}

/**
 * Place a turn's shared Context block in front of the conversation history.
 *
 * Position is a truthfulness decision, not a formatting one. The compiler's last
 * message is always the current user message and it stays last, so the material a
 * question refers to never arrives *after* the reference — and the question is
 * still the final thing a provider reads, which is what keeps the person's own
 * words at the end of the packet rather than a file's.
 *
 * The block goes *before the history* rather than beside the question because it
 * is standing material, and the owner's recency window is theirs: the first call
 * of a conversation has no history, so there the block lands immediately before
 * the question exactly as it always did, but a follow-up such as "what did I just
 * say?" must not find a shared-context paragraph sitting in the position the
 * answer to "what I just said" is read from. Measured on the live endpoint: a
 * block spliced next to the question is answered as if the owner had said it.
 *
 * A null block returns the compiler's array untouched, so a turn with nothing
 * shared produces exactly the packet it produced before Context existed.
 */
function withTurnContext(
  messages: readonly ModelMessage[],
  block: ModelMessage | null,
): readonly ModelMessage[] {
  if (block === null) return messages
  // After the compiler's own framing system message, if it has one; otherwise first.
  const anchor = messages.findIndex((message) => message.role === 'system')
  if (anchor === -1) return [block, ...messages]
  return [...messages.slice(0, anchor + 1), block, ...messages.slice(anchor + 1)]
}
