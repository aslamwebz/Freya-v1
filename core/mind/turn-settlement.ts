import type { EventFabric } from '../events/fabric'
import type { ConversationTurnEvent } from '../events/envelope'
import { ConversationStoreError, type ConversationStore } from '../conversation/store'
import type { ConversationMessage, ConversationTurn, TerminalTurnOutcome } from '../conversation/types'
import type { MindSubmitInput, MindTurnOutcome, MindTurnResult, OwnerMessageEvent, TurnExperience } from './turn-types'

export interface MindTurnSettlementOptions {
  readonly fabric: EventFabric
  readonly store: ConversationStore
  readonly now: () => Date
  readonly newId: () => string
  readonly onTurnStateChange: () => void
  readonly onTurnExperience: ((experience: TurnExperience) => Promise<void>) | null
  readonly onOwnerMessage: ((message: OwnerMessageEvent) => void) | null
}

export interface TurnExperienceMeasurement {
  startedAt: string
  referenceUsed: boolean
  referenceItemCount: number
  requestLength: number
}

export interface MindTurnSettlementDetail {
  reason?: string
  endedAt?: string
  startedAt?: string
  assistantMessageId?: string | null
  providerId?: string | null
  model?: string | null
  providerContacted?: boolean
  ownerText?: string
}

/** Owns per-turn settlement, terminal records and bounded outcome metadata. */
export class MindTurnSettlement {
  private readonly fabric: EventFabric
  private readonly store: ConversationStore
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly onTurnStateChange: () => void
  private readonly onTurnExperience: ((experience: TurnExperience) => Promise<void>) | null
  private readonly onOwnerMessage: ((message: OwnerMessageEvent) => void) | null
  private readonly activeTurns = new Map<string, { turnId: string; startedAt: string }>()
  private readonly experienceByTurn = new Map<string, TurnExperienceMeasurement>()

  constructor(options: MindTurnSettlementOptions) {
    this.fabric = options.fabric
    this.store = options.store
    this.now = options.now
    this.newId = options.newId
    this.onTurnStateChange = options.onTurnStateChange
    this.onTurnExperience = options.onTurnExperience
    this.onOwnerMessage = options.onOwnerMessage
  }

  beginTurn(conversationId: string, turnId: string, startedAt: string, requestLength: number): void {
    this.activeTurns.set(conversationId, { turnId, startedAt })
    this.experienceByTurn.set(turnId, {
      startedAt,
      referenceUsed: false,
      referenceItemCount: 0,
      requestLength,
    })
  }

  setExperience(turnId: string, measurement: TurnExperienceMeasurement): void {
    this.experienceByTurn.set(turnId, measurement)
  }

  experience(turnId: string): TurnExperienceMeasurement | undefined {
    return this.experienceByTurn.get(turnId)
  }

  isTurnActive(conversationId: string): boolean {
    return this.activeTurns.has(conversationId)
  }

  activeTurn(conversationId: string): { turnId: string; startedAt: string } | null {
    const active = this.activeTurns.get(conversationId)
    return active ? { ...active } : null
  }

  activeTurnId(conversationId: string): string | null {
    return this.activeTurns.get(conversationId)?.turnId ?? null
  }

  releaseTurn(conversationId: string, turnId: string): void {
    this.activeTurns.delete(conversationId)
    this.onTurnStateChange()
    this.experienceByTurn.delete(turnId)
  }

  /**
   * Report the owner's own message to the relationship lane.
   *
   * Best effort by construction, like the experience hook: this is enrichment of a
   * turn that already has its answer, and a personality lane that throws must not
   * be able to fail a conversation. It fires after the terminal event, so the
   * journal already says the turn happened before anything is recorded about it.
   */
  reportOwnerMessage(message: OwnerMessageEvent): void {
    if (this.onOwnerMessage === null) return
    try {
      this.onOwnerMessage(message)
    } catch (error) {
      console.error('[freya.mind] the owner message could not be reported', error)
    }
  }

  /**
   * A turn that never started.
   *
   * No user message, no journal event, no cognition, no spend. The caller's own
   * input was the problem — too long, empty, or racing another turn — and writing
   * a turn record for it would put a question in the transcript that has no
   * answer and never will.
   */
  async refuse(input: MindSubmitInput, reason: string): Promise<MindTurnResult> {
    const refusedTurnId = input.turnId || this.newId()
    await this.fabric.append(
      'conversation.turn.denied',
      {
        conversationId: input.conversationId,
        turnId: refusedTurnId,
        userMessageId: null,
        assistantMessageId: null,
        contentLength: input.text.trim().length,
        requestId: null,
        providerId: null,
        model: null,
        outcome: 'denied',
        reason,
      },
      { actor: 'owner', correlationId: refusedTurnId },
    )
    return {
      turnId: refusedTurnId,
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
  async finishTurn(
    input: MindSubmitInput,
    turn: ConversationTurn,
    outcome: MindTurnOutcome,
    detail: MindTurnSettlementDetail,
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

    const providerContacted = detail.providerContacted ?? outcome === 'completed'
    const experience = this.experience(turn.turnId)

    // Experience is recorded after the terminal event, so the journal and the store
    // are already truthful about this turn and the Brain's account of it is the last
    // thing written rather than the first.
    await this.recordExperience({
      conversationId: input.conversationId,
      turnId: turn.turnId,
      startedAt: detail.startedAt ?? experience?.startedAt ?? turn.startedAt,
      endedAt,
      outcome,
      reason: storedReason,
      providerId,
      model,
      // The gateway's own account of contact, never inferred from how far the turn
      // got. A cancelled turn that had already reached a provider was very probably
      // billed, and cancelling does not make it free.
      providerContacted,
      requestLength: experience?.requestLength ?? 0,
      answerLength: assistantMessage?.content.length ?? 0,
      referenceUsed: experience?.referenceUsed ?? false,
      referenceItemCount: experience?.referenceItemCount ?? 0,
      answerPersisted: assistantMessage !== null,
    })

    // The relationship lane hears about the owner's message last, after the
    // journal and the Brain already describe the turn truthfully. Nothing here can
    // change the turn's outcome, and nothing here can make the record exist before
    // the exchange that produced it.
    if (detail.ownerText !== undefined) {
      this.reportOwnerMessage({
        turnId: turn.turnId,
        conversationId: input.conversationId,
        text: detail.ownerText,
        startedAt: detail.startedAt ?? experience?.startedAt ?? turn.startedAt,
        endedAt,
        providerContacted,
      })
    }

    return {
      turnId: turn.turnId,
      conversationId: input.conversationId,
      outcome,
      reason: storedReason,
      assistantMessage,
      providerId,
      model,
      providerContacted,
    }
  }

  /**
   * Hand this turn's metadata to the Brain.
   *
   * Best effort by construction. An experience record is analysis of what happened,
   * and losing one is a much smaller problem than failing a turn that already has a
   * stored answer and a terminal event.
   */
  async recordExperience(experience: TurnExperience): Promise<void> {
    if (this.onTurnExperience === null) return
    try {
      await this.onTurnExperience(experience)
    } catch (error) {
      console.error('[freya.mind] an experience record could not be stored', error)
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
  turnEvent(
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

export function conversationFault(error: unknown): string {
  if (error instanceof ConversationStoreError) {
    return `conversation store: ${error.code} (${error.message})`
  }
  return describe(error)
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
