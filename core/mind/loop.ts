import type { OwnerAuthority } from '../authority'
import type { ModelMessage } from '../model/provider'
import {
  MIND_TOOL_LIMITS,
  parseToolResponse,
  renderObservation,
  type MindToolRegistry,
  type ToolObservation,
  type ToolStepRecord,
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
 * ## Spend
 *
 * The grant this loop spends is the same single foreground grant the turn already
 * creates. `calls` bounds the iterations; `maxOutputTokens` bounds the *sum* of
 * every iteration's reservation, so the ceiling is per turn and not per call.
 * `budgetFor` below is what makes that arithmetic explicit rather than implicit.
 */

/**
 * Split the turn's whole output allowance across its calls.
 *
 * The existing per-turn ceiling (`CONVERSATION_LIMITS.maxOutputTokensPerTurn`)
 * is a **total for the turn**, and it was sized for one call. Rather than raise
 * it — which would silently multiply what one turn can cost — the loop divides
 * it, and the sum of every iteration's ask is exactly the number that was
 * already the ceiling.
 *
 * - **The first call** gets the remainder after reserving what the two possible
 *   continuations will need. On the configured numbers that is
 *   `1024 - 2 × 256 = 512`.
 * - **Each continuation** gets `followUpOutputTokens`, because a continuation's
 *   only job is to read a short observation and answer from it.
 *
 * The grant's own `maxOutputTokens` stays at `maxOutputTokensPerTurn` and its
 * `maxCalls` is the iteration ceiling, so the Governor refuses a fourth
 * iteration on **arithmetic alone** — the grant cannot cover it — before a
 * provider is chosen. There is no path by which the loop spends more than one
 * turn spent before the loop existed.
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
  /** The whole turn's output allowance. Never raised by this loop. */
  readonly perTurnAllowance: number
  /** This turn's cancellation signal. Checked at every iteration boundary. */
  readonly signal: AbortSignal
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
      cognitionRequestId: iteration === 0 ? deps.turnId : `${deps.turnId}#${iteration}`,
      requestedModel: deps.selectedModel(),
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
        reason: `the tool request could not be read: ${parsed.reason}`,
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
        ? await deps.tools.invoke({ name: parsed.tool, arguments: parsed.arguments, signal: deps.signal })
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