import type { OwnerAuthority } from '../authority'
import { SourceLedger } from './source-ledger'
import type { InitialToolRequest } from './tool-intent'
import { isTruncationSignal, type ModelFinishReason, type ModelMessage } from '../model/provider'
import {
  MIND_TOOL_LIMITS,
  TOOL_CALL_OPEN,
  parseToolResponse,
  renderObservation,
  type MindToolRegistry,
  type ToolObservation,
  type ToolStepRecord,
  type ToolSource,
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
 * ## The measured constraint
 *
 * Against the live endpoint, for `qwen/qwen3.8-27b-uncensored`:
 *
 * | what | output tokens |
 * |---|---|
 * | a tool call | ~35 |
 * | a plain answer | ~550 |
 * | an answer from supplied evidence | ~414 |
 *
 * Those three numbers do not fit in 1024 alongside a three-call turn. A first
 * call has to be able to answer *without* a tool, so it must be capped near 550;
 * that leaves ~474 for continuations, and a continuation answering from evidence
 * needs ~414, which fits — but only once. A second continuation has nothing left
 * and is refused by the Governor, which the loop reports as an exhausted
 * allowance rather than as an answer.
 *
 * Raising `maxOutputTokensPerTurn` is the only way to buy more room, and that is
 * a spend decision rather than an arithmetic one. It is deliberately not taken
 * here: the ceiling is code-owned and the reservation model is a security
 * boundary, and neither should move as a side effect of adding a feature.
 */
export function budgetFor(iteration: number, perTurnAllowance: number): number {
  const continuations = MIND_TOOL_LIMITS.maxProviderCalls - 1
  const first = Math.max(
    1,
    perTurnAllowance - MIND_TOOL_LIMITS.followUpOutputTokens * continuations,
  )
  return iteration === 0 ? first : Math.min(MIND_TOOL_LIMITS.followUpOutputTokens, perTurnAllowance)
}

/** One step of the loop, for the Mind's own record. Never content. */
export interface ToolIteration {
  readonly step: ToolStepRecord
  readonly observation: ToolObservation
  /** The message handed back to the model on the next iteration. */
  readonly report: ModelMessage
}

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
  readonly authority: OwnerAuthority
  readonly tools: MindToolRegistry
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
  const ledger = new SourceLedger(deps.carriedSources)
  const invoke: MindToolRegistry['invoke'] = async request => {
    if (deps.blockedTools?.includes(request.name)) {
      return { executed: false, observation: { kind: 'denied', tool: request.name,
        capability: deps.tools.list().find(tool => tool.name === request.name)?.capability ?? 'search.web',
        reason: deps.blockedToolReason ?? 'The owner explicitly declined this tool for the current turn.' } }
    }
    const invocation = await deps.tools.invoke(request)
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
      observation = {
        kind: 'failed',
        tool: 'unknown',
        capability: 'search.web',
        reason:
          `the tool request could not be read: ${parsed.reason}. ` +
          `Reply again with exactly one ${TOOL_CALL_OPEN} envelope and nothing else, and it will run.`,
      }
      iterations.push({
        step: { index: iterations.length + 1, tool: 'unknown', capability: 'search.web', outcome: 'failed', executed: false, sourceCount: 0 },
        observation,
        report: renderObservation(observation),
      })
    } else {
      // The ceiling on *executions* is separate from the ceiling on calls, so a
      // turn that spends its iterations on malformed requests still cannot run
      // more than `maxToolCalls` bodies.
      const room = toolCallsUsed < MIND_TOOL_LIMITS.maxToolCalls
      const invocation = room
        ? await invoke({ name: parsed.tool, arguments: parsed.arguments, signal: deps.signal })
        : {
            observation: {
              kind: 'failed' as const,
              tool: parsed.tool,
              capability: 'search.web' as const,
              reason: `this turn has already used all ${MIND_TOOL_LIMITS.maxToolCalls} lookups it is allowed`,
            },
            executed: false,
          }
      if (invocation.executed) toolCallsUsed += 1
      observation = invocation.observation
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

    // The transcript of the loop, in provider order: what the model said, then
    // what the tool returned, as quoted data. The owner's question is no longer
    // last, which is correct — it is no longer the only thing being answered.
    messages = [...messages, { role: 'assistant', content: outcome.text }, iterations[iterations.length - 1]!.report]
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
