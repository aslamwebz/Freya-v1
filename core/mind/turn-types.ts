import type { ConversationMessage } from '../conversation/types'
import type { ModelAttachment } from '../model/provider'
import type { TurnIntentHints } from './tool-intent'

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
  attachments?: readonly ModelAttachment[]
  /**
   * Composer-held tool directives that travel as structured metadata.
   *
   * The two intent buttons used to prepend "find on the web: " and "use your
   * browser: " onto the owner's text. That mutated the words the owner actually
   * said — the stored user message, the journaled event, and the next turn's
   * history all carried text the owner never typed. Hints now travel as a
   * separate object: the text is stored verbatim, and the hint is read here by
   * `initialToolRequestForOwnerText` to derive an initial tool call.
   *
   * Absent means the normal text-derived path. Explicit false values prohibit
   * that retrieval lane for the whole turn, including model-requested calls.
   */
  intents?: TurnIntentHints
}

/**
 * Why a turn ended because the model ran out of room.
 *
 * One string, in plain words, with no numbers and no jargon, because it goes into
 * the turn record next to an outcome of `failed` and a person reads it. It says
 * what happened and it does not apologise for it or blame a model by name: the
 * output budget is Freya's own ceiling, and the owner pressed send.
 */
export const TRUNCATION_REASON =
  "Freya's answer was cut off before it finished: the model reached the limit set for one " +
  "answer and stopped mid-reply. Nothing after the cut was ever generated."

/**
 * One turn's outcome, as metadata the Brain may keep.
 *
 * Note what is *not* here. No `text`, no `assistantText`, no excerpt, no summary
 * anybody wrote. The question and the answer live in the encrypted conversation
 * store and are referenced by id, so the Brain can reason about what Freya has done
 * without becoming a second, less-protected copy of what was said.
 *
 * `providerContacted` comes from the gateway's own account rather than from whether
 * the turn "got far enough to have cost something". A cancelled turn that had
 * already reached a provider was very probably billed, and cancelling does not make
 * it free.
 */
export interface TurnExperience {
  conversationId: string
  turnId: string
  startedAt: string
  endedAt: string
  outcome: MindTurnOutcome
  reason: string | null
  providerId: string | null
  model: string | null
  providerContacted: boolean
  /** Lengths, for analysis. Never the content they measure. */
  requestLength: number
  answerLength: number
  /** Whether a reference pack contributed to this turn's context. */
  referenceUsed: boolean
  referenceItemCount: number
  /** True when an answer reached the encrypted store. Says nothing about being right. */
  answerPersisted: boolean
}

/**
 * One owner turn, as the relationship domain may hear about it.
 *
 * `text` is the owner's own words, in the owner's own conversation, and it is
 * handed over once and forgotten: nothing in Core stores this field, and the only
 * thing that may survive a turn is a bounded clause the closed directive table
 * recognised.
 */
export interface OwnerMessageEvent {
  readonly turnId: string
  readonly conversationId: string
  readonly text: string
  readonly startedAt: string
  readonly endedAt: string
  /** The gateway's own account of contact. Never inferred from the outcome. */
  readonly providerContacted: boolean
}

