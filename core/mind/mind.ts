import { MindContextEnrichment } from './context-enrichment'
import type { MindSubmitInput, MindTurnResult, OwnerMessageEvent, TurnExperience } from './turn-types'
import { MindTurnCognition } from './turn-cognition'
import { MindTurnSettlement } from './turn-settlement'
import { MindTurnRunner } from './turn-runner'
export { renderTruncatedAnswer } from './content-bounds'
export { TRUNCATION_REASON } from './turn-types'
export type { MindSubmitInput, MindTurnOutcome, MindTurnResult, OwnerMessageEvent, TurnExperience } from './turn-types'
import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { OwnerAuthority } from '../authority'
import type { ModelGateway } from '../model/gateway'
import { FREYA_IDENTITY, type FreyaIdentity } from '../identity/identity'
import { type ContextBudget, type ReferenceKnowledge } from './context-compiler'
import type { TurnContextReader } from './turn-context'
import type { ConversationStore } from '../conversation/store'
import { type ExpressionMemory } from './expression'
import type { InteractionFact, RelationshipItem } from '../personality/types'
import { type MindToolRegistry } from './tools'

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
 * A turn performs **at most one** provider request *unless a tool registry is
 * wired*, in which case it performs at most
 * `MIND_TOOL_LIMITS.maxProviderCalls`. There is no retry, no summarisation call,
 * no critic and no planner in either case. A failure is a failure and is reported
 * as one.
 *
 * The default is enforced structurally by the turn runner and cognition boundary.
 * With no usable registry, a turn makes one provider call; an empty registry also
 * counts as no registry.
 *
 * ## The tool loop
 *
 * When a registry *is* wired, the turn may call a bounded set of Guard-gated
 * tools between provider requests, and then answer. Three properties hold and are
 * each enforced somewhere specific rather than hoped for:
 *
 *  - **A tool is not authority.** Every execution goes through
 *    `MindToolRegistry.invoke`, which asks Guard about that tool's single
 *    capability immediately before the body runs. A denied capability means the
 *    body never executes.
 *  - **The spend is unchanged.** The turn still creates one grant with the same
 *    `maxOutputTokens`, and the loop divides it across iterations rather than
 *    multiplying it. A fourth iteration is refused by the Governor on arithmetic.
 *  - **Stop still works between iterations.** The turn holds its own
 *    `AbortController` and the loop checks it at every boundary, because a
 *    gateway cancel cannot reach a moment when no request is in flight.
 *
 * See `core/mind/loop.ts` for the iteration boundary and `core/mind/tools.ts` for
 * why a tool result is data and never authority.
 */

export interface MindServiceOptions {
  matrixSpaceIds?: (conversationId: string) => readonly string[]
  fabric: Pick<EventFabric, 'append'>
  store: ConversationStore
  authority: Pick<OwnerAuthority, 'request' | 'createGrant'>
  /** The narrow door to the Model Gateway. Not a provider, not a client SDK. */
  gateway: Pick<ModelGateway, 'cancelRequest'>
  identity?: FreyaIdentity
  budget?: ContextBudget
  now?: () => Date
  newId?: () => string
  /** Minimal runtime facts for the compiled packet. Opaque to the Mind. */
  runtimeFacts?: () => readonly string[]
  /**
   * The model the owner has selected for subsequent turns, or null.
   *
   * Supplied by the Core, which is the only place a selection is ever stored —
   * never read from a turn payload, never chosen by the renderer's text, and
   * never decided here. It reaches the provider through the Governor-issued
   * permit like everything else: it changes *which model answers*, and nothing
   * about the grant, the budget, the gate, or the compiled context. A null
   * answer is the normal state and means "the provider's own configured model",
   * which is exactly what a turn did before any selector existed.
   */
  selectedModel?: () => string | null
  selectedProviderId?: () => string | null
  /**
   * What Freya remembers about this turn's text, if anything.
   *
   * **Retrieval is not the Mind's job and cannot be the Mind's decision.** This is a
   * function the Core supplies, and it is called with the user's own text purely to
   * build a query. Three consequences are deliberate:
   *
   *  - The Mind cannot choose what to remember. It has no store, no admission
   *    policy and no write path; it asks and the Brain answers with what it already
   *    decided was recallable.
   *  - A turn never *writes* memory. Learning is out of scope for the request path,
   *    so a prompt injection cannot become a durable fact just by being sent.
   *  - The result is reference material, rendered below the transcript and never in
   *    the system message. See `compileReference`.
   *
   * Returning null, or throwing, yields no reference block at all. A Brain that
   * cannot answer must not stop a person getting an answer.
   */
  recall?: (query: string) => ReferenceKnowledge | null
  /**
   * What the owner put in scope for *this* turn, as a bounded quoted block.
   *
   * Supplied by the Core, which owns the Context store, and shaped the same way as
   * `recall` on purpose: the Mind asks, and a function somebody else wrote answers.
   * Three consequences are deliberate:
   *
   *  - **It is only ever called on a real turn.** There is no ambient call, no
   *    subscription and no background refresh; context that is not attached to a
   *    question the owner asked costs nothing and reaches no model.
   *  - **It is data, never authority.** The result is a `user`-role message of
   *    quoted material, spliced in beside the question. It grants nothing, widens
   *    no scope, and cannot change a Guard verdict — Guard does not read it and
   *    never will. See `core/mind/turn-context.ts` for why it is a separate module
   *    rather than another field on the compiler's input.
   *  - **A turn does not depend on it.** A Context source that throws yields no
   *    block at all, exactly as a Brain that cannot recall does. Sharing something
   *    is not a precondition of being answered.
   */
  turnContext?: TurnContextReader
  /**
   * Record what this turn attempted, as metadata.
   *
   * Supplied by the Core, which owns the Brain. Aimed at the Brain, never at the
   * conversation store, and it is given **ids and outcomes only** — the Mind does not
   * pass the user's text or the answer, so the Brain physically cannot end up holding
   * a second copy of the most private text in the system.
   *
   * Failures are swallowed by the caller. An experience record is analysis, and
   * analysis is never worth failing a turn over.
   */
  onTurnExperience?: (experience: TurnExperience) => Promise<void>
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
  /**
   * The expression-memory seam for anti-repetition.
   *
   * Injected by the Core, which owns the cue ledger. The Mind reads the ledger
   * before planning and records cue use after a turn that actually reached a
   * provider — it has no store, no persistence, and no write path of its own.
   *
   * An absent seam, a seam that throws, and a seam whose `readLedger()` returns
   * `null` all mean **no expression block is produced and no cue reads or writes
   * occur**, exactly as a Brain that cannot recall produces no reference block. A
   * missing or unreadable ledger must never be mistaken for an empty one — an
   * empty ledger would re-offer the same cues forever. A wired memory represents
   * the ordinary first turn with `emptyCueLedger()`, not `null`. See
   * `expressionForTurn`.
   */
  expressionMemory?: ExpressionMemory
  /**
   * Interaction facts observed by trusted code, for social interpretation.
   *
   * Called once per turn, before the provider request. The facts are produced by
   * trusted pathways that observed something (a greeting arrived, a session
   * started) — never by model text. An empty list is the normal state.
   */
  interactionFacts?: () => readonly InteractionFact[]
  /**
   * Admitted relationship items, for social interpretation and expression planning.
   *
   * Called once per turn, before the provider request. Only admitted items are
   * meaningful; the interpretation filters to admitted status internally. An empty
   * list is the normal first-turn state.
   */
  relationshipItems?: () => readonly RelationshipItem[]
  /**
   * Code-owned tokens for preference matching, supplied by Core.
   *
   * `interpretSocialContext` decides whether an admitted preference is *relevant*
   * by intersecting its tags against these, so they are the whole of "what is this
   * turn about". They must be slugs from a closed vocabulary that trusted code
   * chose — not words extracted from the owner's message, because a matcher
   * guessing at relevance is how an unrelated preference starts steering a reply.
   *
   * Absent means no preference is ever judged relevant, which is the conservative
   * reading: the record is still held, still visible, and still withdrawable, it
   * simply does not appear in guidance.
   */
  preferenceTokens?: () => readonly string[]
  /**
   * The owner's own message, once per turn, after the terminal event is written.
   *
   * This is the Phase 11 production admission path, and it lives in the Mind
   * because the Mind is the only component that knows what the owner actually
   * said. It reports the text and decides nothing: Core reads it with a closed
   * directive table and either records an explicit standing instruction or records
   * nothing at all.
   *
   * Deliberately narrow. The Mind does not interpret, does not classify, and does
   * not keep the text anywhere. It fires *after* the turn's terminal event so a
   * relationship record can never precede the record of the exchange that produced
   * it, and a callback that throws is logged and swallowed — losing a preference
   * note is much smaller than failing a turn that already has a stored answer.
   */
  onOwnerMessage?: (message: OwnerMessageEvent) => void
  /**
   * The tools a turn may call mid-answer, or null for none.
   *
   * **Absent means one provider call, and that is the whole default.** A Mind with
   * no registry does not run a loop, does not parse a tool envelope, and issues a
   * `maxCalls: 1` grant — so the ordinary chat path is unchanged rather than
   * merely usually short-circuited. This is the "normal chat stays normal"
   * guarantee, and it is structural: there is no code path in which an unwired
   * Mind makes a second call.
   *
   * Supplied by the Core, which owns Guard and the Research seam, exactly as it
   * supplies `ExpressionMemory` and `recall`. The Mind holds no tool body, no
   * Searcher, no browser, no provider and no credential; it holds a closed list of
   * names and the one method that runs one of them under Guard.
   */
  tools?: Pick<MindToolRegistry, 'list' | 'isEmpty' | 'has' | 'invoke' | 'instructions'> | null
}

/** The existing conversation lifecycle surface, including a process-backed Mind. */
export type MindRuntime = Pick<MindService, 'runTurn' | 'activeTurn' | 'cancelTurn'>

export class MindService {
  private readonly fabric: Pick<EventFabric, 'append'>
  private readonly store: ConversationStore
  private readonly authority: MindServiceOptions['authority']
  private readonly gateway: MindServiceOptions['gateway']
  private readonly identity: FreyaIdentity
  private readonly budget: ContextBudget | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly runtimeFacts: () => readonly string[]
  private readonly selectedModel: () => string | null
  private readonly selectedProviderId: () => string | null
  private readonly onTurnStateChange: () => void
  private readonly tools: NonNullable<MindServiceOptions['tools']> | null
  private readonly turnRunner: MindTurnRunner
  private readonly matrixSpaceIds: (conversationId: string) => readonly string[]
  private readonly contextEnrichment: MindContextEnrichment
  private readonly turnCognition: MindTurnCognition
  private readonly turnSettlement: MindTurnSettlement

  /**
   * Per-turn cancellation, for turns that may make more than one call.
   *
   * `cancelTurn` reaches the Model Gateway, which owns the AbortController for a
   * request that is *in flight*. A loop can also be sitting between iterations —
   * waiting on a tool, or between the observation arriving and the next call —
   * and there is no gateway request at that moment for a scoped cancel to find.
   *
   * So the Mind holds one controller per running turn, and the loop checks it at
   * every iteration boundary. A turn with no registry does not use it, so nothing
   * about the single-call path changes.
   *
   * Keyed by turn, never held in a singleton, so two conversations may overlap
   * without one overwriting the other's signal.
   */

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
    this.selectedModel = options.selectedModel ?? (() => null)
    this.selectedProviderId = options.selectedProviderId ?? (() => null)
    this.matrixSpaceIds = options.matrixSpaceIds ?? (() => [])
    this.onTurnStateChange = options.onTurnStateChange ?? (() => {})
    this.turnSettlement = new MindTurnSettlement({
      fabric: this.fabric,
      store: this.store,
      now: this.now,
      newId: this.newId,
      onTurnStateChange: this.onTurnStateChange,
      onTurnExperience: options.onTurnExperience ?? null,
      onOwnerMessage: options.onOwnerMessage ?? null,
    })
    this.contextEnrichment = new MindContextEnrichment({
      recall: options.recall ?? null,
      turnContext: options.turnContext ?? null,
      now: this.now,
      expressionMemory: options.expressionMemory ?? null,
      interactionFacts: options.interactionFacts ?? (() => []),
      relationshipItems: options.relationshipItems ?? (() => []),
      preferenceTokens: options.preferenceTokens ?? (() => []),
    })
    const tools = options.tools ?? null
    // An empty registry is treated as no registry. A Core that wired the seam and
    // found no search provider configured must get the single-call path, not a
    // loop whose every tool request is guaranteed to be refused.
    this.tools = tools !== null && !tools.isEmpty() ? tools : null
    this.turnCognition = new MindTurnCognition({
      authority: this.authority,
      gateway: this.gateway,
      tools: this.tools,
      selectedModel: this.selectedModel,
      selectedProviderId: this.selectedProviderId,
      matrixSpaceIds: this.matrixSpaceIds,
    })
    this.turnRunner = new MindTurnRunner({
      fabric: this.fabric,
      store: this.store,
      authority: this.authority,
      identity: this.identity,
      budget: this.budget,
      now: this.now,
      newId: this.newId,
      runtimeFacts: this.runtimeFacts,
      contextEnrichment: this.contextEnrichment,
      turnCognition: this.turnCognition,
      turnSettlement: this.turnSettlement,
      onTurnStateChange: this.onTurnStateChange,
      toolLoopEnabled: this.tools !== null,
    })
  }

  /** Whether a conversation already has a turn generating. */
  isTurnActive(conversationId: string): boolean {
    return this.turnSettlement.isTurnActive(conversationId)
  }

  /** The running turn for a conversation, or null. */
  activeTurn(conversationId: string): { turnId: string; startedAt: string } | null {
    return this.turnSettlement.activeTurn(conversationId)
  }

  /** Compatibility helper for cancellation/tests that only need the id. */
  activeTurnId(conversationId: string): string | null {
    return this.turnSettlement.activeTurnId(conversationId)
  }
  /** Runs one conversation turn through the dedicated lifecycle owner. */
  async runTurn(input: MindSubmitInput): Promise<MindTurnResult> {
    return await this.turnRunner.runTurn(input)
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
   *
   * A tool-loop turn is signalled **twice**, on purpose. `gateway.cancelRequest`
   * reaches a request that is in flight *right now*; the turn's own controller
   * reaches the moments the gateway cannot see — between iterations, or while a
   * tool is running. Both fire, both are idempotent, and neither touches anything
   * outside this turn. The returned count is the gateway's, unchanged, so a caller
   * reporting "stopped" means exactly what it meant before the loop existed.
   */
  cancelTurn(turnId: string, reason = 'the owner stopped this response'): number {
    return this.turnCognition.cancelTurn(turnId, reason)
  }

}
