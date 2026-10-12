import { requestsNewLookup, retrievalRestrictions, routeChatIntent } from '../research/chat-intent'
import type { OwnerAuthority } from '../authority'
import { cognitionOutcomeTruncated } from '../cognition/service'
import type { ModelGateway } from '../model/gateway'
import type { ModelMessage } from '../model/provider'
import { CONVERSATION_LIMITS } from '../conversation/types'
import { runToolLoop, type ToolIteration } from './loop'
import { initialToolRequestForOwnerText, type TurnIntentHints } from './tool-intent'
import { renderToolFooter, type MindToolRegistry, type ToolSource } from './tools'
import { stripModelWrittenFooter } from './footerGuard'

export interface MindThinkInput {
  turnId: string
  conversationId: string
  grantId: string
  messages: readonly ModelMessage[]
  ownerText: string
  intents: TurnIntentHints
  carriedSources: readonly ToolSource[]
  researchFollowUp: boolean
  perTurnAllowance: number
}

export interface MindTurnCognitionOptions {
  readonly authority: Pick<OwnerAuthority, 'request'>
  readonly gateway: Pick<ModelGateway, 'cancelRequest'>
  readonly tools: Pick<MindToolRegistry, 'list' | 'isEmpty' | 'has' | 'invoke' | 'instructions'> | null
  readonly selectedModel: () => string | null
  readonly selectedProviderId: () => string | null
  readonly matrixSpaceIds: (conversationId: string) => readonly string[]
}
/**
 * One turn's cognition, as the Mind's own bookkeeping needs it.
 *
 * A closed union on `kind`, so no caller can read an answer out of a denial.
 * `providerContacted` appears on every terminal branch that could have reached a
 * provider, and is never inferred from how far the turn got: it is the gateway's
 * own account, or the fact that a text answer exists.
 */
export type MindCognitionOutcome =
  | {
      kind: 'answer'
      text: string
      providerId: string
      model: string
      providerContacted: true
      steps: readonly ToolIteration[]
      /**
       * True when the model's reply contained a block shaped like the code's
       * footer and the strip removed it before the answer was stored. The flag
       * rides on the `Cognition` so the turn finish can annotate the stored
       * message: a turn whose model wrote a footer but whose loop produced no
       * iterations is a turn that narrated an act the Mind did not perform.
       */
      modelWroteFooter: boolean
    }
  /**
   * The provider answered, and its answer did not finish.
   *
   * Separate from `answer` because the difference is not cosmetic: an `answer`
   * is something the transcript may present as Freya's reply, and this is not.
   * `text` is whatever existed when the output ceiling landed and must never be
   * stored or shown as a complete reply on its own.
   */
  | {
      kind: 'truncated'
      text: string
      providerId: string
      model: string
      /** True: a truncated reply is a reply, so a provider was reached and paid. */
      providerContacted: true
      steps: readonly ToolIteration[]
      /** See the matching field on `answer`. A truncated reply can be a forgery too. */
      modelWroteFooter: boolean
    }
  | { kind: 'denied'; reason: string }
  | { kind: 'cancelled'; reason: string; providerContacted: boolean; steps?: readonly ToolIteration[] }
  | { kind: 'failed'; reason: string; providerContacted: boolean; steps?: readonly ToolIteration[] }


export class MindTurnCognition {
  private readonly turnControllers = new Map<string, AbortController>()

  constructor(private readonly options: MindTurnCognitionOptions) {}

  cancelTurn(turnId: string, reason: string): number {
    const aborted = this.options.gateway.cancelRequest(turnId, reason)
    const controller = this.turnControllers.get(turnId)
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort(new Error(reason))
    }
    return aborted
  }

  /**
   * One turn's cognition: exactly one call, or a bounded tool loop.
   *
   * The branch is on the *seam*, not on the question. A Mind with no tool registry
   * takes the first path, which is the code that existed before this loop did —
   * one `authority.request`, `cognitionRequestId: turnId`, the full
   * `maxOutputTokens`, no envelope parsing and no second call. That is what makes
   * "normal chat stays normal" structural rather than probabilistic: there is no
   * branch in which an unwired Mind can reach a provider twice.
   *
   * A Mind with a registry takes the loop. The first iteration still uses
   * `cognitionRequestId: turnId` so that a scoped cancel and the turn's own
   * journal line mean the same thing they always did; continuations are suffixed
   * so that each is separately accounted and separately cancellable.
   */
  async think(input: MindThinkInput): Promise<MindCognitionOutcome> {
    // The owner's own words are routed to a first lookup deterministically, on every
    // turn and regardless of what else is registered.
    //
    // It used to be suppressed whenever `propose_mission` was in the registry, so that
    // a Mind carrying the Mission tool left `initialToolRequest` null for any turn
    // where no composer button was held. That made the loop unreachable through
    // anything but a spontaneous envelope from the model, and it also silently killed
    // the explicit-browser branch below, because `initialToolRequestForOwnerText` was
    // never called at all. Registering a tool must not decide whether another tool is
    // offered: that is a routing decision, and it belongs to the router.
    const inferredRequest = initialToolRequestForOwnerText(input.ownerText, input.intents)
    // A follow-up about an already-carried source still refuses a fresh lookup, which
    // is unchanged: a new search cannot stand in for the reference that was asked for.
    const initialToolRequest = input.researchFollowUp && input.intents.webSearch !== true && input.intents.browserUse !== true
      && inferredRequest?.name === 'web_search' && !requestsNewLookup(input.ownerText)
      ? null : inferredRequest
    const modelCapability = input.intents.browserUse === true || initialToolRequest?.name === 'browser_read' || routeChatIntent(input.ownerText, { activeEyeSession: false }).kind === 'native_browser_task' ? 'browser' : 'chat'

    if (initialToolRequest !== null && !this.options.tools?.has(initialToolRequest.name)) {
      return {
        kind: 'failed',
        reason: initialToolRequest.name === 'web_search'
          ? 'Web search is not available for this turn, so no current sources were retrieved.'
          : "Freya's own browser is not available for this turn, so it was not opened.",
        providerContacted: false,
      }
    }
    if (this.options.tools === null) {
      const outcome = await this.options.authority.request({
        kind: 'user_turn',
        reasoningEffort: input.intents.reasoningEffort,
        prompt: input.messages.map((m) => m.content).join('\n\n'),
        messages: input.messages,
        // One call, so one answer's worth — not the loop's whole allowance. See
        // `maxOutputTokensPerAnswer`; the Governor would refuse the larger number
        // anyway, and a plain conversation should not cost what a nine-lookup turn does.
        maxOutputTokens: Math.min(
          input.perTurnAllowance,
          CONVERSATION_LIMITS.maxOutputTokensPerAnswer,
        ),
        grantId: input.grantId,
        correlationId: input.turnId,
        cognitionRequestId: input.turnId,
        // The owner's selection, when there is one. It is a *request*, not a
        // decision: the Governor still authors, the Gateway still refuses any
        // model it cannot serve, and a null here is the ordinary default.
        requestedModel: this.options.selectedModel(),
        requestedProviderId: this.options.selectedProviderId(),
        modelCapability,
        goalId: null,
      })
      if (outcome.status === 'denied') return { kind: 'denied', reason: outcome.reason }
      if (outcome.status === 'cancelled') {
        return { kind: 'cancelled', reason: outcome.reason, providerContacted: outcome.providerContacted }
      }
      if (outcome.status === 'failed') {
        return { kind: 'failed', reason: outcome.reason, providerContacted: outcome.providerContacted }
      }
      // Checked before the text is read as an answer, and on the same helper the
      // tool loop uses, so "truncated" means one thing in both paths. The single
      // call has no tool envelope to protect and no second call to spend, so this
      // is the whole of what it does about a cut-off reply: refuse to present it
      // as an answer.
      if (cognitionOutcomeTruncated(outcome)) {
        const cleanedTrunc = stripModelWrittenFooter(outcome.text)
        return {
          kind: 'truncated',
          text: cleanedTrunc.text,
          providerId: outcome.providerId,
          model: outcome.model,
          providerContacted: true,
          steps: [],
          modelWroteFooter: cleanedTrunc.forgery,
        }
      }
      const cleanedAnswer = stripModelWrittenFooter(outcome.text)
      return {
        kind: 'answer',
        text: cleanedAnswer.text,
        providerId: outcome.providerId,
        model: outcome.model,
        providerContacted: true,
        steps: [],
        modelWroteFooter: cleanedAnswer.forgery,
      }
    }

    const tools = this.options.tools as MindToolRegistry
    const restrictions = retrievalRestrictions(input.ownerText)
    const unresolvedResearch = input.researchFollowUp && input.carriedSources.length === 0
      && !requestsNewLookup(input.ownerText) && input.intents.webSearch !== true && input.intents.browserUse !== true
    const blockedTools = tools.list().filter(tool =>
      (tool.name === 'web_search' && (input.intents.webSearch === false || ((restrictions.webSearch || unresolvedResearch) && input.intents.webSearch !== true)))
      || (tool.capability.startsWith('browser.') && (input.intents.browserUse === false || ((restrictions.browser || unresolvedResearch) && input.intents.browserUse !== true))),
    ).map(tool => tool.name)
    const controller = new AbortController()
    this.turnControllers.set(input.turnId, controller)
    try {
      const outcome = await runToolLoop(
        {
          authority: this.options.authority,
          tools,
          grantId: input.grantId,
          turnId: input.turnId,
          selectedModel: this.options.selectedModel,
          selectedProviderId: this.options.selectedProviderId,
          modelCapability,
          reasoningEffort: input.intents.reasoningEffort,
          perTurnAllowance: input.perTurnAllowance,
          signal: controller.signal,
          initialToolRequest,
          // The objective, in the owner's words. It is what "finished" is judged
          // against once the turn has run tools, so it travels with the turn rather
          // than being re-derived from whatever the model last said.
          objective: input.ownerText,
          toolContext: { conversationId: input.conversationId, ownerText: input.ownerText, matrixSpaceIds: this.options.matrixSpaceIds(input.conversationId) },
          blockedTools,
          ...(unresolvedResearch ? { blockedToolReason: 'The requested stored source is not available in this turn context. A new lookup cannot substitute for that reference; ask the owner to identify it.' } : {}),
          carriedSources: input.carriedSources,
        },
        // Keep the owner's actual question last. Placing tool guidance after
        // it made the provider see a synthetic system block as the most recent
        // turn, weakening multi-turn relevance and personality preferences.
        input.messages[0]?.role === 'system'
          ? [input.messages[0], tools.instructions(blockedTools), ...input.messages.slice(1)]
          : [tools.instructions(blockedTools), ...input.messages],
      )
      if (outcome.kind === 'denied') return { kind: 'denied', reason: outcome.reason }
      if (outcome.kind === 'cancelled') {
        return { kind: 'cancelled', reason: outcome.reason, providerContacted: outcome.providerContacted, steps: outcome.iterations }
      }
      if (outcome.kind === 'failed') {
        return { kind: 'failed', reason: outcome.reason, providerContacted: outcome.providerContacted, steps: outcome.iterations }
      }
      // Carried through rather than re-decided: the loop already refused to spend
      // a further call or execute a tool from a reply it knew was incomplete, and
      // it still holds the iterations it had legitimately made before that. The
      // Mind's job is only to render what they did and what is missing.
      if (outcome.kind === 'truncated') {
        const cleanedTrunc = stripModelWrittenFooter(outcome.text)
        return {
          kind: 'truncated',
          text: cleanedTrunc.text,
          providerId: outcome.providerId,
          model: outcome.model,
          providerContacted: true,
          steps: outcome.iterations,
          modelWroteFooter: cleanedTrunc.forgery,
        }
      }
      // The footer is appended here, in code, from the loop's own record of what
      // it did. The model's text is stored exactly as it answered; the truth about
      // the tools is added beside it and cannot be edited away by anything the
      // model said.
      //
      // The model's text is run through `stripModelWrittenFooter` first because a
      // model that has seen a previous turn's footer sometimes reproduces the
      // format in its own reply. Without the strip, a turn whose loop produced no
      // iterations would store a model-written block that *looks* like a code
      // footer — the transcript would name an act the loop never performed, and
      // no reader could tell the difference. The strip removes the forgery so
      // the code's footer is the only footer the transcript can hold.
      const cleaned = stripModelWrittenFooter(outcome.text)
      const footer = renderToolFooter(
        outcome.iterations.map((iteration) => iteration.step),
        outcome.iterations.map((iteration) => iteration.observation),
        input.carriedSources,
      )
      return {
        kind: 'answer',
        text: footer === '' ? cleaned.text : `${cleaned.text}\n${footer}`,
        providerId: outcome.providerId,
        model: outcome.model,
        providerContacted: true,
        steps: outcome.iterations,
        // Carried so the conversation store can persist the loop's record of
        // what it did beside the message. The renderer uses this to draw the
        // "What Freya did" section from the loop, not from the model's prose.
        modelWroteFooter: cleaned.forgery,
      }
    } finally {
      this.turnControllers.delete(input.turnId)
    }
  }

}
