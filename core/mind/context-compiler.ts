import type { FreyaIdentity } from '../identity/identity'
import type { ModelMessage } from '../model/provider'
import type { ConversationMessage } from '../conversation/types'

/**
 * The Context Compiler.
 *
 * One pure function from authoritative Freya state to a provider-shaped packet.
 * No I/O, no clock, no randomness, no model — so it can be tested against a table
 * of cases rather than by watching a window, and so a phase that changes how
 * context is *chosen* changes only this file.
 *
 * ## Why a compiler and not a prompt file
 *
 * A `system-prompt.md` makes the prompt the definition of Freya. This inverts
 * that: the Identity Kernel is the definition, and the text a provider receives is
 * a **serialisation** produced here. Swap the provider and the serialiser
 * changes; the identity does not. Swap the identity and one constant changes.
 *
 * ## What it will not do
 *
 * - It never invents history. Every message it emits came from the conversation
 *   store, and every message it drops is reported by id so the caller can say so.
 * - It never silently drops the current user message. If identity plus the
 *   current turn cannot fit the budget, compilation *fails* and no provider is
 *   contacted — a truncated question answered as though it were the whole question
 *   is worse than no answer.
 * - It never includes anything the caller did not pass it. There is no ambient
 *   state, no filesystem, no environment, no "always include the current time"
 *   unless a runtime fact is explicitly supplied.
 *
 * ## The budget
 *
 * Bounded in *estimated* tokens, using a deliberately crude local estimate. It is
 * an estimate and is named as one everywhere it surfaces: it is a safety bound on
 * what Freya is willing to assemble, not a prediction of what a provider will
 * bill. Real billing comes from what the provider reports, through the usage
 * accounting that already exists.
 */

export interface ContextBudget {
  /**
   * The ceiling, in estimated tokens, for everything the compiler emits
   * including identity and the current turn.
   */
  maxEstimatedTokens: number
  /**
   * A hard ceiling on how many history messages may be included, independent of
   * size. Two bounds rather than one, because a transcript of many tiny messages
   * and one of a few enormous ones are different problems.
   */
  maxHistoryMessages: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  maxEstimatedTokens: 3_000,
  maxHistoryMessages: 24,
})

/**
 * A local token estimate.
 *
 * Four characters per token is the rule of thumb used everywhere, and it is wrong
 * for every model. That is acceptable *here* because this number decides what
 * Freya is willing to assemble, not what a provider charges. It is never added to
 * a usage total — provider-reported figures are the only thing that reaches
 * accounting.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export interface MindContextInput {
  identity: FreyaIdentity
  /**
   * Prior messages, oldest first, excluding the current user message.
   *
   * Passed separately rather than as the tail of one list, because the trimming
   * policy is *asymmetric*: history is dropped newest-last while the current turn
   * is never dropped, and a compiler that could not tell them apart could not
   * implement that.
   */
  history: readonly ConversationMessage[]
  /** The message being answered. Always included, or compilation fails. */
  currentUserMessage: ConversationMessage
  /**
   * Minimal runtime facts, e.g. that a cognition provider is unavailable.
   *
   * Opaque to the compiler and passed through verbatim, because which facts
   * exist is a Mind question and not a context-shaping one.
   */
  runtimeFacts?: readonly string[]
}

export interface CompiledContext {
  /** The packet, in provider order. */
  messages: readonly ModelMessage[]
  /** Estimated size of the packet. An estimate, and only ever used for display. */
  estimatedTokens: number
  /** Which history messages made it in, oldest first. */
  includedMessageIds: readonly string[]
  /** Which were dropped, oldest first. Reported rather than happening silently. */
  droppedMessageIds: readonly string[]
  budget: ContextBudget
}

/**
 * Raised when even the irreducible part does not fit.
 *
 * A distinct type rather than a string, because the caller's response to this is
 * different from its response to a provider failure: nothing was attempted, and
 * the honest outcome is to say the message is too long for one turn.
 */
export class ContextBudgetExceeded extends Error {
  constructor(
    readonly requiredTokens: number,
    readonly budgetTokens: number,
  ) {
    super(
      `this turn needs about ${requiredTokens} estimated tokens but the context budget is ` +
        `${budgetTokens}. Identity and the current message are never dropped, so nothing was sent.`,
    )
    this.name = 'ContextBudgetExceeded'
  }
}

/**
 * Assemble the packet.
 *
 * Deterministic by construction: the same input produces byte-identical output,
 * the ordering is fixed, and nothing is read from outside the arguments. That is
 * what makes a trim decision reproducible after a restart and reviewable in a
 * test rather than only visible as "Freya forgot something".
 */
export function compileContext(
  input: MindContextInput,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): CompiledContext {
  const system = renderIdentity(input.identity, input.runtimeFacts)
  const systemCost = estimateTokens(system)

  const current = input.currentUserMessage
  const currentCost = estimateTokens(current.content)

  // The irreducible part. If this does not fit, nothing is sent at all.
  const floor = systemCost + currentCost
  if (floor > budget.maxEstimatedTokens) {
    throw new ContextBudgetExceeded(floor, budget.maxEstimatedTokens)
  }

  // Walk history newest → oldest, keeping messages while there is room, then
  // restore chronological order. Newest-first is what makes the policy
  // well-defined: recency is the signal, and the oldest turns are what go.
  const kept: ConversationMessage[] = []
  const dropped: ConversationMessage[] = []
  let running = floor

  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const message = input.history[i]
    if (!message) continue
    if (kept.length >= budget.maxHistoryMessages) {
      dropped.unshift(message)
      continue
    }
    // A per-message allowance, so one enormous earlier message cannot consume
    // the whole budget and starve everything after it.
    const cost = estimateTokens(message.content)
    if (running + cost > budget.maxEstimatedTokens) {
      dropped.unshift(message)
      continue
    }
    running += cost
    kept.unshift(message)
  }

  const messages: ModelMessage[] = [
    { role: 'system', content: system },
    ...kept.map((message) => ({ role: message.role, content: message.content }) as ModelMessage),
    { role: 'user', content: current.content },
  ]

  return {
    messages,
    estimatedTokens: running,
    includedMessageIds: kept.map((message) => message.messageId),
    droppedMessageIds: dropped.map((message) => message.messageId),
    budget,
  }
}

/**
 * Render the identity and any runtime facts into one system message.
 *
 * A serialisation, and the only place a system message is built. It is written
 * as labelled sections rather than prose so that a reader of a provider's request
 * log can tell which part is Freya's identity and which is a fact about right
 * now — and so that a later phase can change the wording without the structure
 * becoming load-bearing.
 *
 * Note what is absent: no authority, no capability, no budget, no instruction
 * that could be mistaken for one. If it said "you may stop Freya", that would be
 * a lie, because no model can.
 */
export function renderIdentity(identity: FreyaIdentity, runtimeFacts?: readonly string[]): string {
  const sections: string[] = [
    `You are ${identity.name}, ${identity.role}.`,
    `Your purpose: ${identity.purpose}.`,
    '',
    'What is true about you:',
    ...identity.stableTraits.map((trait) => `- ${trait}`),
    '',
    'How to communicate:',
    ...identity.communicationPrinciples.map((principle) => `- ${principle}`),
    '',
    'How to behave across sessions:',
    ...identity.continuityPrinciples.map((principle) => `- ${principle}`),
  ]

  const facts = (runtimeFacts ?? []).filter((fact) => fact.trim().length > 0)
  if (facts.length > 0) {
    sections.push('', 'Right now:', ...facts.map((fact) => `- ${fact}`))
  }

  return sections.join('\n')
}
