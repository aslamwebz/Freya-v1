import type { OwnerAuthority } from '../authority'
import { SourceLedger } from './source-ledger'
import type { InitialToolRequest } from './tool-intent'
import { isTruncationSignal, type ModelFinishReason, type ModelMessage } from '../model/provider'
import {
  MIND_TOOL_LIMITS,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  parseToolResponse,
  renderObservation,
  type MindToolRegistry,
  type ToolObservation,
  type ToolStepRecord,
  type ToolSource,
  type MindToolContext,
} from './tools'

/**
 * The bounded tool loop.
 *
 * One turn, up to `MIND_TOOL_LIMITS.maxProviderCalls` provider requests, and up
 * to `MIND_TOOL_LIMITS.maxToolCalls` tool executions inside them. The last call is
 * always the answer: a loop that spends its whole allowance asking for tools and
 * never answers has nothing honest to return, so it returns a `failed` result
 * instead of an invented answer.
 *
 * ## Where the iteration boundary is
 *
 * The boundary is *the tool observation*, not the provider response. A provider
 * response either ends the turn (an answer) or produces exactly one observation,
 * and exactly one observation is the only thing that can cause a second call.
 * There is no branch that calls a provider without having crossed a Guard
 * evaluation, and no branch that calls a tool without a Guard evaluation.
 *
 * ```
 *   compiled packet
 *        ↓
 *   authority.request  ── denied/cancelled/failed ──▶ stop, report truthfully
 *        ↓ allowed
 *   a text response
 *        ↓ not a tool envelope ──▶ answer, one call, done
 *        ↓ tool envelope
 *   parse (strict)  ── malformed ──▶ observation(kind: failed), loop
 *        ↓
 *   guard.evaluate(principal, tool.capability)   ← in the registry
 *        ↓ denied ──▶ observation(kind: denied), loop
 *        ↓ allowed
 *   tool.run(bounded args)
 *        ↓
 *   bounded, provenance-bearing observation
 *        ↓
 *   next call: packet + assistant turn + the observation as quoted data
 *        ↓  … until the ceiling, then the answer
 * ```
 *
 * ## Cancellation
 *
 * `signal` is the Mind's own per-turn controller, and it is checked at the top of
 * every iteration and again inside the registry before the tool body runs. A stop
 * that lands *between* iterations therefore prevents the next provider request
 * from being made at all, rather than cancelling a request that does not exist
 * yet — which is the window `core/research/coreIntegration.ts` closes the same
 * way.
 *
 * ## Spend — and the ceiling it runs into
 *
 * The grant this loop spends is the same single foreground grant the turn already
 * creates. `calls` bounds the iterations, and `outputTokenBudgetReserved` bounds
 * the *sum* of every iteration's ask, because that reservation is authorisation
 * arithmetic taken **before** the provider is called and deliberately never
 * released — a grant with 300 of 1000 reserved has 700 left whatever the
 * provider went on to do. So every call's ask must sum to at most
 * `maxOutputTokensPerTurn`, and `budgetFor` makes that arithmetic explicit.
 *
 * ## The measured constraint, and the three schedules that failed
 *
 * The original measurements were taken against `qwen/qwen3.8-27b-uncensored`: a
 * tool call ~35 output tokens, a plain answer ~550, an answer grounded in a tool
 * report ~414. Every schedule derived from those numbers has since failed against
 * `MiniMax-M3`, in three different directions:
 *
 *  - **Even, with a slice withheld for a final synthesis call.** Left every
 *    answer-bearing call at 384. `MiniMax-M3` returns `length` at every budget
 *    below 2048, so the turn died holding its own evidence.
 *  - **Flat 512 for every continuation.** The same failure, less politely.
 *  - **Weighted 2:1, answer calls double.** That fixed the answer and starved the
 *    envelope calls instead. `MiniMax-M3` writes its reasoning *inline*, into the
 *    same content field as the envelope, so an envelope call budgeted at 1638
 *    spent the lot on reasoning, never reached the JSON, and ended truncated —
 *    which reaches the rest of the system as a malformed request. A turn lost three
 *    of its eight calls that way.
 *
 * Turning reasoning down was tried alongside the weighting, as
 * `reasoning_effort: 'minimal'` on envelope calls. Measured on the endpoint it moves
 * the output by a few hundred characters and changes nothing that matters: the model
 * still spends the budget thinking. The lever that works is not a parameter. It is
 * the size of the slice.
 *
 * So the schedule is uniform: one share, large enough that *every* call can finish.
 * A turn's calls are not all the same kind — one may have to write prose, another
 * may have to think first and then emit JSON — and the only budget that serves both
 * is one both can use. The ceiling is still the Governor's, and the calls still sum
 * to it. What changed is that the ceiling now bounds the *turn* rather than any
 * single call.
 */
/**
 * How many times one turn may spend a call re-asking for a tool request that was
 * cut off by the output ceiling.
 *
 * One is enough for a request that was merely long. Two covers a model that needs
 * the size constraint restated. Beyond that the arguments are not the problem and
 * continuing would burn the turn's allowance on a request that cannot fit.
 */
const MAX_TRUNCATION_RECOVERIES = 2

/**
 * How many times one turn may spend a call re-asking for a tool request that could
 * not be parsed, before the loop stops asking and tells the model to answer
 * directly.
 *
 * The point is not to punish a slip. It is that a model which cannot produce a
 * readable envelope should not be able to spend a whole turn failing to: after
 * this many attempts the next correction asks for an answer instead, so the turn
 * ends with whatever Freya genuinely knows rather than with an exhausted
 * allowance.
 */
const MAX_MALFORMED_RECOVERIES = 2

/**
 * The output budget for one provider call in a turn.
 *
 * Uniform on purpose — the schedule history is in the file header. Every call gets
 * the same share, sized so a call can finish whether it is writing prose or
 * thinking and then emitting an envelope. The calls sum to the Governor's
 * allowance; the ceiling now bounds the *turn* rather than any single call.
 */
export function budgetFor(iteration: number, perTurnAllowance: number): number {
  const maxCalls = MIND_TOOL_LIMITS.maxProviderCalls
  if (maxCalls <= 1) return perTurnAllowance
  void iteration
  return Math.max(1, Math.floor(perTurnAllowance / maxCalls))
}

/** One step of the loop, for the Mind's own record. Never content. */
export interface ToolIteration {
  readonly step: ToolStepRecord
  readonly observation: ToolObservation
  /** The message handed back to the model on the next iteration. */
  readonly report: ModelMessage
}

import { renderMissionProposal } from './mission-proposal'
import { deferredActionCorrection } from './deferred-action'
export type LoopOutcome =
  /** The model produced an answer. `text` is what it said, plus the tool footer. */
  | { readonly kind: 'answer'; readonly text: string; readonly providerId: string; readonly model: string; readonly iterations: readonly ToolIteration[] }
  /**
   * The answer was cut off by the output budget.
   *
   * Its own outcome rather than an `answer`, because the loop must never spend a
   * further call on a reply that is known to be incomplete: the text is partial,
   * and in the tool case so are the tool arguments. `text` is whatever the model
   * had produced when the ceiling landed — kept so the transcript can show what
   * was generated alongside the sentence that says it was not finished, never as
   * an answer.
   */
  | {
      readonly kind: 'truncated'
      readonly text: string
      readonly finishReason: ModelFinishReason
      readonly providerId: string
      readonly model: string
      readonly iterations: readonly ToolIteration[]
    }
  /** The Governor refused. Nobody was asked, and the turn says so. */
  | { readonly kind: 'denied'; readonly reason: string }
  /** Somebody stopped it. `providerContacted` is the gateway's own account. */
  | { readonly kind: 'cancelled'; readonly reason: string; readonly providerContacted: boolean; readonly iterations: readonly ToolIteration[] }
  /** It was attempted and did not work. Includes running out of iterations. */
  | { readonly kind: 'failed'; readonly reason: string; readonly providerContacted: boolean; readonly iterations: readonly ToolIteration[] }

export interface ToolLoopDeps {
  readonly toolContext?: MindToolContext
  readonly reasoningEffort?: string
  readonly authority: Pick<OwnerAuthority, 'request'>
  readonly tools: Pick<MindToolRegistry, 'list' | 'isEmpty' | 'has' | 'invoke' | 'instructions'>
  /** The turn's grant. Named explicitly, so this loop can only spend this turn's. */
  readonly grantId: string
  /** The turn id. Doubles as the request id, so a scoped cancel is a lookup. */
  readonly turnId: string
  /** The owner's model selection, read per iteration like any other request. */
  readonly selectedModel: () => string | null
  readonly selectedProviderId?: () => string | null
  readonly modelCapability?: 'chat' | 'browser'
  /** The whole turn's output allowance. Never raised by this loop. */
  readonly perTurnAllowance: number
  /** This turn's cancellation signal. Checked at every iteration boundary. */
  readonly signal: AbortSignal
  /**
   * A Core-owned deterministic first tool request derived from the owner's explicit
   * instruction. It grants nothing: invocation still goes through this registry's
   * Guard check. Used only when the owner already chose the tool and supplied its
   * concrete target, so model preference cannot silently override that choice.
   */
  readonly initialToolRequest?: InitialToolRequest | null
  /** Core-derived restrictions for this turn. Can only narrow the registry. */
  readonly blockedTools?: readonly string[]
  readonly blockedToolReason?: string
  /** Actual evidence supplied by the same conversation's compiled follow-up. */
  readonly carriedSources?: readonly ToolSource[]
}

/**
 * Run the loop.
 *
 * Never throws for anything a provider, a tool or a stop can do. Every failure is
 * an outcome, because a turn that threw would leave a stored question with no
 * stored answer and no terminal event.
 */
export async function runToolLoop(
  deps: ToolLoopDeps,
  baseMessages: readonly ModelMessage[],
): Promise<LoopOutcome> {
  const iterations: ToolIteration[] = []
  let messages = baseMessages
  let providerContacted = false
  let toolCallsUsed = 0
  let deferredCorrections = 0
  let truncationRecoveries = 0
  let malformedRecoveries = 0
  let lastToolCallRequest: { tool: string; argsJson: string } | null = null
  const ledger = new SourceLedger(deps.carriedSources)
  const invoke: MindToolRegistry['invoke'] = async request => {
    if (deps.blockedTools?.includes(request.name)) {
      return { executed: false, observation: { kind: 'denied', tool: request.name,
        capability: deps.tools.list().find(tool => tool.name === request.name)?.capability ?? 'search.web',
        reason: deps.blockedToolReason ?? 'The owner explicitly declined this tool for the current turn.' } }
    }
    const invocation = await deps.tools.invoke({ ...request, context: deps.toolContext })
    return { ...invocation, observation: ledger.observation(invocation.observation) }
  }

  // When the owner explicitly chose Freya's own browser and supplied the exact
  // address, do not ask a stochastic model whether it feels like honouring that
  // choice. Execute that one bounded request through the same registry/Guard path
  // every other tool uses, then let the model answer from the resulting evidence.
  //
  // This is not a bypass and it is not renderer authority: the directive was
  // derived in Core from the owner's current text, and invoke() can still deny it.
  if (deps.initialToolRequest !== undefined && deps.initialToolRequest !== null) {
    if (deps.signal.aborted) {
      return { kind: 'cancelled', reason: cancellationReason(deps.signal), providerContacted, iterations }
    }

    const invocation = await invoke({
      name: deps.initialToolRequest.name,
      arguments: deps.initialToolRequest.arguments,
      signal: deps.signal,
    })
    if (invocation.executed) toolCallsUsed += 1
    const observation = invocation.observation
    iterations.push({
      step: {
        index: 1,
        tool: observation.tool,
        capability: observation.capability,
        outcome: observation.kind,
        executed: invocation.executed,
        sourceCount: observation.kind === 'ok' ? observation.sources.length : 0,
      },
      observation,
      report: renderObservation(observation),
    })
    messages = [...messages, renderObservation(observation)]

    if (deps.signal.aborted) {
      return { kind: 'cancelled', reason: cancellationReason(deps.signal), providerContacted, iterations }
    }
  }

  for (let iteration = 0; iteration < MIND_TOOL_LIMITS.maxProviderCalls; iteration += 1) {
    // Between iterations, before anything is asked. A stop that landed while a
    // tool was running must prevent the next request, not merely end this one.
    if (deps.signal.aborted) {
      return { kind: 'cancelled', reason: cancellationReason(deps.signal), providerContacted, iterations }
    }

    const ask = budgetFor(iteration, deps.perTurnAllowance)
    const outcome = await deps.authority.request({
      kind: 'user_turn',
      reasoningEffort: deps.reasoningEffort,
      prompt: messages.map((message) => message.content).join('\n\n'),
      messages,
      maxOutputTokens: ask,
      grantId: deps.grantId,
      correlationId: deps.turnId,
      // The first iteration is the turn's request, so it keeps the turn's own id:
      // a scoped cancel, the turn's journal line and `cancelRequest` all mean what
      // they meant before the loop existed. Continuations are suffixed so each is
      // separately accounted for and separately cancellable, and so usage
      // accounting can attribute tokens to the call that produced them.
      // The separator is `:`, not `#`, and that is load-bearing rather than
      // stylistic. A `cognition.requested` event's `requestId` is validated by
      // `isEventId`, whose pattern is `[A-Za-z0-9._:-]` — so an id containing `#`
      // is an event Core writes and then cannot read back. The next launch finds
      // its own journal corrupt, quarantines it, and refuses every command, which
      // is exactly what happened to a real profile. `:` is already the house
      // separator for "the same thing, attempt N" (`wakeId:attempt` in the life
      // loop, `scheduleId:repeats` in the attention engine) and is valid in an id.
      cognitionRequestId: iteration === 0 ? deps.turnId : `${deps.turnId}:${iteration}`,
      requestedModel: deps.selectedModel(),
      requestedProviderId: deps.selectedProviderId?.(),
      modelCapability: deps.modelCapability,
      goalId: null,
      signal: deps.signal,
    })

    if (outcome.status === 'denied') {
      return { kind: 'denied', reason: outcome.reason }
    }
    if (outcome.status === 'cancelled') {
      return {
        kind: 'cancelled',
        reason: outcome.reason,
        providerContacted: outcome.providerContacted,
        iterations,
      }
    }
    if (outcome.status === 'failed') {
      return {
        kind: 'failed',
        reason: outcome.reason,
        providerContacted: outcome.providerContacted,
        iterations,
      }
    }
    providerContacted = true

    /**
     * Truncation is decided before the tool envelope is parsed, and that ordering
     * is the whole correctness of this branch.
     *
     * A reply that hit the output ceiling is incomplete *whatever it looks like*.
     * If it happens to be readable text, the answer stops mid-sentence; if it
     * happens to open a tool envelope, the arguments are as likely to be a JSON
     * fragment as a complete request. Parsing first would turn the second case
     * into a malformed-tool observation, the loop would tell the model its request
     * could not be read, and the turn would end as though Freya had merely made a
     * formatting mistake — which is the silent downgrade this rule exists to
     * prevent. So: no tool is executed from a reply known to be cut off, and no
     * further call is spent trying to repair it.
     *
     * The converse is the important half. A reply that stopped to *ask* for a tool
     * reports `tool_calls` and is not truncation, so it falls through to exactly
     * the observation it always produced.
     */
    if (isTruncationSignal(outcome)) {
      // Two different things arrive here wearing the same shape.
      //
      // A reply that was cut off while *opening a tool request* is recoverable: the
      // arguments are truncated rather than wrong, and the model can be asked for a
      // shorter one. Nothing is executed from the partial text — that ordering is
      // the whole correctness of this branch, and it is kept. What happens instead is
      // that the model is told its request was cut off, which is the truth, and
      // spends one more call producing one that fits.
      //
      // "Unterminated" is the test, and it is deliberately narrow: the envelope
      // opened and never closed. A reply carrying a *complete* envelope is not
      // truncated in the part that matters — the request is whole — so it is left
      // alone and reported as truncation, exactly as before. Recovery is for a
      // request that cannot be read because it ran out mid-write, not for one whose
      // finish reason is merely `length`.
      const unterminatedEnvelope =
        outcome.text.includes(TOOL_CALL_OPEN) && !outcome.text.includes(TOOL_CALL_CLOSE)
      const recoveringEnvelope =
        iteration < MIND_TOOL_LIMITS.maxProviderCalls - 1 &&
        truncationRecoveries < MAX_TRUNCATION_RECOVERIES &&
        unterminatedEnvelope
      if (recoveringEnvelope) {
        truncationRecoveries += 1
        const observation: ToolObservation = {
          kind: 'failed',
          tool: 'unknown',
          capability: 'search.web',
          reason:
            `the tool request was cut off before it finished, so nothing was run. ` +
            `Reply again with exactly one ${TOOL_CALL_OPEN} envelope and nothing else, ` +
            `keeping the arguments short enough to fit.`,
        }
        const report = renderObservation(observation)
        iterations.push({
          step: { index: iterations.length + 1, tool: 'unknown', capability: 'search.web', outcome: 'failed', executed: false, sourceCount: 0 },
          observation,
          report,
        })
        messages = [...messages, { role: 'assistant', content: outcome.text }, report]
        continue
      }
      // Everything else that arrives here is not recoverable. A reply cut off while
      // answering is simply incomplete, and a reply carrying a complete envelope
      // with a `length` finish reason is a request the loop was told not to trust.
      // The turn ends as `truncated` so the transcript presents it as unfinished
      // rather than as Freya's reply.
      return {
        kind: 'truncated',
        text: outcome.text,
        finishReason: outcome.finishReason ?? 'length',
        providerId: outcome.providerId,
        model: outcome.model,
        iterations,
      }
    }

    const parsed = parseToolResponse(outcome.text, (name) => deps.tools.has(name))
    if (parsed.kind === 'answer') {
      // A reply that describes an action rather than taking it is not an answer.
      // The tool instructions forbid it, but a model that ignores them would
      // otherwise end the turn with a promise the transcript would then record as
      // a reply — so the loop spends one more call making it act.
      //
      // Bounded twice over: `deferredActionCorrection` caps how many corrections a
      // turn may spend, and the call check below means the correction is never
      // attempted on the last available call. A model that keeps promising simply
      // gets its promise stored as an answer, which is the pre-existing
      // behaviour and is at least not a fabricated result.
      const correction = deferredActionCorrection(outcome.text, deferredCorrections)
      if (correction !== null && iteration < MIND_TOOL_LIMITS.maxProviderCalls - 1) {
        deferredCorrections += 1
        const observation: ToolObservation = {
          kind: 'failed',
          tool: 'none',
          capability: 'search.web',
          reason: correction,
        }
        const report = renderObservation(observation)
        iterations.push({
          step: { index: iterations.length + 1, tool: 'none', capability: 'search.web', outcome: 'failed', executed: false, sourceCount: 0 },
          observation,
          report,
        })
        // The model's own sentence goes back to it as the last thing it said, so
        // the correction is answering what it actually wrote rather than a turn
        // that never happened.
        messages = [...messages, { role: 'assistant', content: outcome.text }, report]
        continue
      }
      return {
        kind: 'answer',
        text: outcome.text,
        providerId: outcome.providerId,
        model: outcome.model,
        iterations,
      }
    }

    // A tool request on the last available call. There is no call left to answer
    // it, so the turn ends now with a truthful failure rather than a summary of
    // a lookup nobody was shown.
    if (iteration === MIND_TOOL_LIMITS.maxProviderCalls - 1) {
      return {
        kind: 'failed',
        reason:
          `Freya asked to use a lookup tool but had already used all ` +
          `${MIND_TOOL_LIMITS.maxProviderCalls} calls allowed for one turn, so it could not read the result`,
        providerContacted,
        iterations,
      }
    }

    let observation: ToolObservation
    if (parsed.kind === 'invalid') {
      // A model that meant to ask and wrote something unreadable gets told so, and
      // gets one more chance. It is a bounded failure like any other, and it does
      // not execute a tool.
      //
      // The instruction changes once the model has proved it cannot produce a
      // readable envelope: past {@link MAX_MALFORMED_RECOVERIES} attempts it is told
      // to stop asking and answer. A turn that ends with Freya's actual knowledge is
      // worth more than one that ends by exhausting its allowance on formatting.
      const giveUpAsking = malformedRecoveries >= MAX_MALFORMED_RECOVERIES
      malformedRecoveries += 1
      observation = {
        kind: 'failed',
        tool: 'unknown',
        capability: 'search.web',
        reason: giveUpAsking
          ? `the tool request could not be read: ${parsed.reason}. No lookup was made. ` +
            `Do not try to call a tool again for this turn — answer the owner now with what ` +
            `you have, and say plainly that you could not check it.`
          : `the tool request could not be read: ${parsed.reason}. ` +
            `Reply again with exactly one ${TOOL_CALL_OPEN} envelope and nothing else, and it will run.`,
      }
      iterations.push({
        step: { index: iterations.length + 1, tool: 'unknown', capability: 'search.web', outcome: 'failed', executed: false, sourceCount: 0 },
        observation,
        report: renderObservation(observation),
      })
    } else {
      const argsJson = JSON.stringify(parsed.arguments)
      const lastOkIteration = iterations[iterations.length - 1]
      const isConsecutiveDuplicate =
        lastToolCallRequest !== null &&
        lastToolCallRequest.tool === parsed.tool &&
        lastToolCallRequest.argsJson === argsJson &&
        lastOkIteration?.observation.kind === 'ok'

      // The ceiling on *executions* is separate from the ceiling on calls, so a
      // turn that spends its iterations on malformed requests still cannot run
      // more than `maxToolCalls` bodies.
      const room = toolCallsUsed < MIND_TOOL_LIMITS.maxToolCalls
      const invocation = room
        ? await invoke({
            name: parsed.tool,
            arguments: parsed.arguments,
            signal: deps.signal,
            skipExecution: isConsecutiveDuplicate,
          })
        : {
            observation: {
              kind: 'failed' as const,
              tool: parsed.tool,
              capability: 'search.web' as const,
              reason: `this turn has already used all ${MIND_TOOL_LIMITS.maxToolCalls} lookups it is allowed`,
            },
            executed: false,
          }

      if (invocation.observation.kind === 'denied') {
        observation = invocation.observation
        lastToolCallRequest = null
      } else {
        lastToolCallRequest = { tool: parsed.tool, argsJson }
        if (invocation.executed) toolCallsUsed += 1
        observation = invocation.observation
      }

      iterations.push({
        step: {
          index: iterations.length + 1,
          tool: observation.tool,
          capability: observation.capability,
          outcome: observation.kind,
          executed: invocation.executed,
          sourceCount: observation.kind === 'ok' ? observation.sources.length : 0,
        },
        observation,
        report: renderObservation(observation),
      })
    }

    // A stop that landed *during* the tool run. Checked here, before the next
    // request is built, so the loop exits with the stop's own words rather than
    // an invented one.
    if (deps.signal.aborted) {
      return { kind: 'cancelled', reason: cancellationReason(deps.signal), providerContacted, iterations }
    }

    if (observation.kind === 'ok' && observation.missionProposal) {
      return { kind: 'answer', text: renderMissionProposal(observation.missionProposal), providerId: outcome.providerId, model: outcome.model, iterations }
    }

    // The transcript of the loop, in provider order: what the model said, then
    // what the tool returned, as quoted data. The owner's question is no longer
    // last, which is correct — it is no longer the only thing being answered.
    let nextReport = iterations[iterations.length - 1]!.report
    if (iteration >= MIND_TOOL_LIMITS.maxProviderCalls - 3) {
      nextReport = {
        role: nextReport.role,
        content: `${nextReport.content}\n\n[System guidance: You have performed ${iterations.length} tool operations and are approaching the turn limit. Please synthesize your final response now using the evidence collected, without requesting further tools.]`,
      }
    }
    messages = [...messages, { role: 'assistant', content: outcome.text }, nextReport]
  }

  // Unreachable while `maxProviderCalls > 0`, and stated rather than left
  // implicit so that lowering the ceiling cannot produce a silent `undefined`.
  return {
    kind: 'failed',
    reason: `the tool loop ended without an answer after ${MIND_TOOL_LIMITS.maxProviderCalls} calls`,
    providerContacted,
    iterations,
  }
}

function cancellationReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.message !== '') return reason.message
  return 'the owner stopped this response'
}
