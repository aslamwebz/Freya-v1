import { routeChatIntent } from '../research/chat-intent'
import { validateModelAttachments, type ModelAttachment } from '../model/provider'
import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { ConversationTurnEvent } from '../events/envelope'
import type { OwnerAuthority } from '../authority'
import type { CognitionGrantSpec } from '../cognition/grants'
import { cognitionOutcomeTruncated } from '../cognition/service'
import type { ModelGateway } from '../model/gateway'
import type { ModelMessage } from '../model/provider'
import { FREYA_IDENTITY, type FreyaIdentity } from '../identity/identity'
import {
  ContextBudgetExceeded,
  compileContext,
  type ContextBudget,
  type ReferenceKnowledge,
} from './context-compiler'
import type { TurnContextReader } from './turn-context'
import { ConversationStoreError, type ConversationStore } from '../conversation/store'
import {
  CONVERSATION_LIMITS,
  deriveConversationTitle,
  type Conversation,
  type ConversationMessage,
  type ConversationTurn,
  type TerminalTurnOutcome,
} from '../conversation/types'
import {
  buildExpressionForTurn,
  withExpressionBlock,
  type ExpressionMemory,
  type ExpressionTurnResult,
} from './expression'
import type { CueKind, CueUsageLedger, InteractionFact, RelationshipItem } from '../personality/types'
import { runToolLoop, type ToolIteration } from './loop'
import { initialToolRequestForOwnerText, type TurnIntentHints } from './tool-intent'
import { MIND_TOOL_LIMITS, renderToolFooter, type MindToolRegistry, type ToolObservation } from './tools'
import { iterationsAsStepRecords, stripModelWrittenFooter } from './footerGuard'
import { mediaFromObservations } from '../media/collect'
import type { MediaItem } from '../media/types'
import type { ToolSource, ChartSpec, CanvasSpec } from './tools'

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
 * The default is enforced structurally, which is the part worth being precise
 * about. With no registry there is no branch in `think` that can reach a provider
 * twice: the tool-loop path is behind `if (!this.toolLoopEnabled)`, and an empty
 * registry counts as no registry. So "did we accidentally add a second call to
 * ordinary chat" is answered by the shape of one `if`, not by a test that hopes a
 * model behaves.
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
   * Absent, or all `false`, means the normal text-derived path. Present-but-all-
   * `false` is the same thing, written explicitly; either way, no intent
   * overrides are applied.
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
 * The stored transcript entry for a turn whose answer was cut off.
 *
 * Two parts, and the second is the reason this function exists at all.
 *
 * **What the model actually produced**, unchanged, because throwing it away would
 * be its own kind of dishonesty — the owner can see that the first half of an
 * answer was real. It is placed first and immediately followed by the notice, so
 * there is no reading of the transcript in which the text above looks finished.
 * (This is the same shape as `renderToolFooter`: the model's words, then a truth
 * about them that the model cannot remove and no instruction can suppress.)
 *
 * **The notice**, written here in code from the provider's own finish reason. It
 * never guesses at the missing text, never paraphrases it, and never implies a
 * different answer was received. There is nothing to complete it with, so it
 * completes nothing: it says the answer stopped, and that the rest was never
 * generated.
 *
 * No retry happens here, and none is implied by the wording. Raising the ceiling
 * would change what a turn costs, which is a decision this code does not get to
 * make on the owner's behalf.
 */
export function renderTruncatedAnswer(text: string, footer = ''): string {
  const produced = text.trim()
  const body = [produced, footer.trim()].filter((part) => part !== '').join('\n\n')
  const lead = body === '' ? '' : `${body}\n\n—\n`
  const before = produced === '' ? 'Freya produced no text at all. ' : 'Everything above is all that was produced. '
  return `${lead}${before}The reply was cut off before it finished, so it is incomplete and is not ` +
    `Freya's finished answer. The rest was never generated and has not been guessed at.`
}

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
  tools?: MindToolRegistry | null
}

/**
 * One turn's cognition, as the Mind's own bookkeeping needs it.
 *
 * A closed union on `kind`, so no caller can read an answer out of a denial.
 * `providerContacted` appears on every terminal branch that could have reached a
 * provider, and is never inferred from how far the turn got: it is the gateway's
 * own account, or the fact that a text answer exists.
 */
type Cognition =
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
  | { kind: 'cancelled'; reason: string; providerContacted: boolean }
  | { kind: 'failed'; reason: string; providerContacted: boolean }

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

/**
 * The `media` field for a stored answer, or nothing at all.
 *
 * Spread rather than assigned, so a turn that looked nothing up stores no `media` key
 * at all instead of an empty array — the difference between "there was nothing" and
 * "there was an empty list", which a later reader cannot otherwise tell apart.
 */
function mediaField(observations: readonly ToolObservation[]): { media?: readonly MediaItem[] } {
  const media = mediaFromObservations(observations)
  return media.length === 0 ? {} : { media }
}

/**
 * The web search sources behind this turn, as typed rows beside the prose.
 *
 * Every observation the tools returned contributes its `sources`; the list is
 * flattened, de-duplicated by URL, and capped so an unusually rich search does
 * not blow up the journal. The renderer splits it at draw time into "matched"
 * (cited in the answer prose) and "related" (the rest of what came back).
 *
 * Returns an empty object — not an empty list — when nothing was found, so the
 * field's absence stays distinct from "found an empty list".
 */
function sourcesField(observations: readonly ToolObservation[], cap: number): { sources?: readonly ToolSource[] } {
  const seen = new Set<string>()
  const collected: ToolSource[] = []
  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    for (const source of observation.sources) {
      if (collected.length >= cap) return { sources: collected }
      if (seen.has(source.url)) continue
      seen.add(source.url)
      collected.push(source)
    }
  }
  return collected.length === 0 ? {} : { sources: collected }
}

/**
 * The typed charts the model produced for this turn.
 *
 * Like `media` and `sources`, the data travels beside the prose as a typed
 * artifact the renderer can draw without re-parsing. The journal keeps the
 * literal model text; the chart is the only honest way to display the
 * numbers, because a renderer that read numbers out of a paragraph would be
 * drawing from a guess, not a measurement.
 */
function chartsField(observations: readonly ToolObservation[]): { charts?: readonly ChartSpec[] } {
  const collected: ChartSpec[] = []
  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    if (observation.chart === undefined) continue
    collected.push(observation.chart)
  }
  return collected.length === 0 ? {} : { charts: collected }
}

/**
 * The long-form artifact the model opened beside this turn, if any.
 *
 * Only one canvas per turn is kept — the chat says "I made X" and the canvas
 * carries the thing, so a turn that opened more than one is the kind of
 * answer that does not know what it is. The renderer opens a side panel for
 * the latest one, so the chat and the panel stay in sync.
 */
function canvasField(observations: readonly ToolObservation[]): { canvas?: CanvasSpec } {
  let latest: CanvasSpec | null = null
  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    if (observation.canvas === undefined) continue
    latest = observation.canvas
  }
  return latest === null ? {} : { canvas: latest }
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
  private readonly selectedModel: () => string | null
  private readonly selectedProviderId: () => string | null
  private readonly recall: ((query: string) => ReferenceKnowledge | null) | null
  private readonly turnContext: TurnContextReader | null
  private readonly onTurnStateChange: () => void
  private readonly onTurnExperience: ((experience: TurnExperience) => Promise<void>) | null
  private readonly expressionMemory: ExpressionMemory | null
  private readonly interactionFacts: () => readonly InteractionFact[]
  private readonly relationshipItems: () => readonly RelationshipItem[]
  private readonly preferenceTokens: () => readonly string[]
  private readonly onOwnerMessage: ((message: OwnerMessageEvent) => void) | null
  private readonly tools: MindToolRegistry | null

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
   * Keyed by turn, never held in a singleton, for the same reason
   * `experienceByTurn` is: two conversations may overlap and one must not
   * overwrite the other's signal.
   */
  private readonly turnControllers = new Map<string, AbortController>()

  /**
   * Experience measurements are keyed by turn, not stored in singleton fields.
   *
   * Phase 3 only forbids two simultaneous turns in the *same* conversation.
   * Different conversations can therefore overlap. A singleton "current turn"
   * buffer lets one conversation overwrite another's recall/request metadata and
   * produces a plausible but false Experience record. This map keeps the
   * bookkeeping attached to the turn that produced it.
   */
  private readonly experienceByTurn = new Map<string, {
    startedAt: string
    referenceUsed: boolean
    referenceItemCount: number
    requestLength: number
  }>()

  /**
   * One actively running turn per conversation.
   *
   * Phase 3 refuses a second send rather than queueing it. A queue is a hidden
   * ordering guarantee, and hidden ordering is exactly how two answers end up
   * attached to the wrong questions; a visible refusal costs one click and cannot
   * reorder a transcript.
   */
  private readonly activeTurns = new Map<string, { turnId: string; startedAt: string }>()

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
    this.recall = options.recall ?? null
    this.turnContext = options.turnContext ?? null
    this.onTurnStateChange = options.onTurnStateChange ?? (() => {})
    this.onTurnExperience = options.onTurnExperience ?? null
    this.expressionMemory = options.expressionMemory ?? null
    this.interactionFacts = options.interactionFacts ?? (() => [])
    this.relationshipItems = options.relationshipItems ?? (() => [])
    this.preferenceTokens = options.preferenceTokens ?? (() => [])
    this.onOwnerMessage = options.onOwnerMessage ?? null
    const tools = options.tools ?? null
    // An empty registry is treated as no registry. A Core that wired the seam and
    // found no search provider configured must get the single-call path, not a
    // loop whose every tool request is guaranteed to be refused.
    this.tools = tools !== null && !tools.isEmpty() ? tools : null
  }

  /** Whether this Mind may call a tool mid-turn. Off unless a registry is wired. */
  private get toolLoopEnabled(): boolean {
    return this.tools !== null
  }

  /**
   * Report the owner's own message to the relationship lane.
   *
   * Best effort by construction, like the experience hook: this is enrichment of a
   * turn that already has its answer, and a personality lane that throws must not
   * be able to fail a conversation. It fires after the terminal event, so the
   * journal already says the turn happened before anything is recorded about it.
   */
  private reportOwnerMessage(message: OwnerMessageEvent): void {
    if (this.onOwnerMessage === null) return
    try {
      this.onOwnerMessage(message)
    } catch (error) {
      console.error('[freya.mind] the owner message could not be reported', error)
    }
  }

  /**
   * What Freya remembers about this text, as reference material.
   *
   * Never throws. A Brain that is unavailable, empty or unhappy returns null, and
   * the turn proceeds with no reference block. The alternative — letting a memory
   * failure become a turn failure — would mean a corrupt Brain stops Freya
   * answering, which would be a security-relevant failure mode dressed up as a
   * reliability one.
   */
  private recalledFor(text: string): ReferenceKnowledge | null {
    if (this.recall === null) return null
    try {
      return this.recall(text)
    } catch (error) {
      // Logged and swallowed. The fault is the Brain's to report through its own
      // health; here it must only mean "no reference material this turn".
      console.error('[freya.mind] recall failed; continuing without reference memory', error)
      return null
    }
  }

  /**
   * What the owner put in scope for this turn, as a provider message.
   *
   * Never throws. A Context source that is unavailable, empty or unhappy returns
   * null, and the turn proceeds with no shared material — the same degradation as a
   * Brain that cannot recall. A shared file is an enrichment, and letting its
   * failure become a turn failure would mean a damaged Context store stops Freya
   * answering questions that never needed it.
   *
   * Called exactly once per turn, here, on the way to a call the Mind was already
   * going to make. Nothing in Core reads the Context store in the background, so
   * idle Freya compiles nothing and spends nothing.
   */
  private sharedContextFor(text: string, conversationId: string): ModelMessage | null {
    if (this.turnContext === null) return null
    try {
      return this.turnContext({ text, conversationId, now: this.now() })?.message ?? null
    } catch (error) {
      // Logged and swallowed, for the reason above: a turn must not be lost to its
      // enrichment. The fault belongs to the Context domain's own health reporting.
      console.error('[freya.mind] turn context compile failed; continuing without it', error)
      return null
    }
  }

  /**
   * Plan this turn's expression, or null when there is no usable ledger.
   *
   * Personality expression enters the Mind through the injected
   * `ExpressionMemory`, and nowhere else. The contract is fail-closed: **no
   * readable ledger means no expression block and no cue reads or writes**.
   *
   *  - **No seam** — the Core has not wired personality expression, so the Mind
   *    emits exactly the packet it produced before this feature existed.
   *  - **A seam that throws** — an unreadable ledger is never treated as an empty
   *    one.
   *  - **A seam that reports `null`** — the ledger is unavailable, which is the
   *    same claim as throwing for this purpose. An empty ledger would re-offer
   *    the same cues on every turn forever, and the Mind cannot distinguish
   *    "nothing was used" from "I cannot tell what was used" once the answer is
   *    `null`.
   *
   * A wired memory therefore represents the ordinary first turn with
   * `emptyCueLedger()`, not `null`. Never throws; a turn is never lost to its
   * style enrichment.
   */
  private expressionForTurn(at: string): ExpressionTurnResult | null {
    if (this.expressionMemory === null) return null
    let ledger: CueUsageLedger | null
    try {
      ledger = this.expressionMemory.readLedger()
    } catch (error) {
      console.error(
        '[freya.mind] expression memory read failed; continuing without expression guidance',
        error,
      )
      return null
    }
    if (ledger === null) return null
    try {
      return buildExpressionForTurn({
        now: at,
        facts: this.interactionFacts(),
        relationship: this.relationshipItems(),
        contextTokens: this.preferenceTokens(),
        ledger,
      })
    } catch (error) {
      console.error('[freya.mind] expression planning failed; continuing without it', error)
      return null
    }
  }

  /**
   * Record cue use after a turn, once a provider was actually reached.
   *
   * Never throws. A memory that cannot record is logged and swallowed — a failed
   * anti-repetition record must not fail a turn that already has a stored answer.
   * The caller decides *whether* a cue was spent; this only performs the write.
   */
  private recordCueUse(cueId: string, kind: CueKind, at: string): void {
    if (this.expressionMemory === null) return
    try {
      this.expressionMemory.recordCueUse(cueId, kind, at)
    } catch (error) {
      console.error('[freya.mind] expression memory write failed; continuing', error)
    }
  }

  /** Whether a conversation already has a turn generating. */
  isTurnActive(conversationId: string): boolean {
    return this.activeTurns.has(conversationId)
  }

  /** The running turn for a conversation, or null. */
  activeTurn(conversationId: string): { turnId: string; startedAt: string } | null {
    const active = this.activeTurns.get(conversationId)
    return active ? { ...active } : null
  }

  /** Compatibility helper for cancellation/tests that only need the id. */
  activeTurnId(conversationId: string): string | null {
    return this.activeTurns.get(conversationId)?.turnId ?? null
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
    if (this.activeTurns.has(input.conversationId)) {
      return this.refuse(input, 'a response is already in progress for this conversation')
    }

    const record = await this.store.readConversation(input.conversationId)
    if (record === null) {
      return this.refuse(input, 'no such conversation')
    }

    const turnId = input.turnId || this.newId()
    this.activeTurns.set(input.conversationId, { turnId, startedAt })
    this.experienceByTurn.set(turnId, {
      startedAt,
      referenceUsed: false,
      referenceItemCount: 0,
      requestLength: text.length,
    })
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
            referenceKnowledge: this.recalledFor(text),
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
      const withContext = withTurnContext(carriedMessages, this.sharedContextFor(text, input.conversationId))

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
      const expression = this.expressionForTurn(startedAt)
      const messages = withExpressionBlock(withContext, expression?.block ?? null)

      // Record what context was actually assembled before the provider is asked.
      // This remains true for failure/cancellation outcomes too; a turn does not
      // need to complete successfully for its Experience metadata to be accurate.
      this.experienceByTurn.set(turnId, {
        startedAt,
        referenceUsed: compiled.reference.included,
        referenceItemCount: compiled.reference.itemCount,
        requestLength: text.length,
      })

// --- 5. authorised cognition: one call, or a bounded tool loop ---------
      const cognition = await this.think({
        turnId,
        grantId: grant.grantId,
        messages,
        ownerText: text,
        intents: input.intents ?? {},
        perTurnAllowance: maxOutputTokens,
      })

      // Record cue use only when a provider was actually reached. A Governor
      // denial never dispatches, and a cancellation that arrived before contact
      // never dispatched either — no cue was spent, and recording one would
      // suppress a gesture the owner never saw. The loop reports contact the same
      // way the gateway reports it, never inferred from how far the turn got.
      if (expression !== null && cognition.kind !== 'denied' && cognition.providerContacted) {
        for (const cue of expression.offeredCueIds) {
          this.recordCueUse(cue.cueId, cue.kind, startedAt)
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
        content: cognition.text,
        createdAt: endedAt,
        turnId,
        // What the lookups really returned, kept as typed items beside the prose. The
        // answer is the model's account of the search; this is the search.
        ...mediaField(cognition.steps.map((iteration) => iteration.observation)),
        ...sourcesField(cognition.steps.map((iteration) => iteration.observation), 100),
        ...chartsField(cognition.steps.map((iteration) => iteration.observation)),
        ...canvasField(cognition.steps.map((iteration) => iteration.observation)),
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
      this.activeTurns.delete(input.conversationId)
      this.onTurnStateChange()
      // Cleared after the terminal event so this turn can never leak measurements
      // into a later one.
      this.experienceByTurn.delete(turnId)
      // And so a cancel that arrives after the turn has settled cannot abort a
      // controller that no longer belongs to it.
      this.turnControllers.delete(turnId)
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
   *
   * A tool-loop turn is signalled **twice**, on purpose. `gateway.cancelRequest`
   * reaches a request that is in flight *right now*; the turn's own controller
   * reaches the moments the gateway cannot see — between iterations, or while a
   * tool is running. Both fire, both are idempotent, and neither touches anything
   * outside this turn. The returned count is the gateway's, unchanged, so a caller
   * reporting "stopped" means exactly what it meant before the loop existed.
   */
  cancelTurn(turnId: string, reason = 'the owner stopped this response'): number {
    const aborted = this.gateway.cancelRequest(turnId, reason)
    const controller = this.turnControllers.get(turnId)
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort(new Error(reason))
    }
    return aborted
  }

  /* ------------------------------------------------------------- cognition */

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
  private async think(input: {
    turnId: string
    grantId: string
    messages: readonly ModelMessage[]
    ownerText: string
    intents: TurnIntentHints
    perTurnAllowance: number
  }): Promise<Cognition> {
    const initialToolRequest = initialToolRequestForOwnerText(input.ownerText, input.intents)
    const modelCapability = input.intents.browserUse === true || initialToolRequest?.name === 'browser_read' || routeChatIntent(input.ownerText, { activeEyeSession: false }).kind === 'native_browser_task' ? 'browser' : 'chat'

    if (!this.toolLoopEnabled) {
      if (initialToolRequest !== null) {
        return {
          kind: 'failed',
          reason: initialToolRequest.name === 'web_search'
            ? 'Web search is not available for this turn, so no current sources were retrieved.'
            : "Freya's own browser is not available for this turn, so it was not opened.",
          providerContacted: false,
        }
      }
      const outcome = await this.authority.request({
        kind: 'user_turn',
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
        requestedModel: this.selectedModel(),
        requestedProviderId: this.selectedProviderId(),
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

    const tools = this.tools as MindToolRegistry
    const controller = new AbortController()
    this.turnControllers.set(input.turnId, controller)
    try {
      const outcome = await runToolLoop(
        {
          authority: this.authority,
          tools,
          grantId: input.grantId,
          turnId: input.turnId,
          selectedModel: this.selectedModel,
          selectedProviderId: this.selectedProviderId,
          modelCapability,
          perTurnAllowance: input.perTurnAllowance,
          signal: controller.signal,
          initialToolRequest,
        },
        [...input.messages, tools.instructions()],
      )
      if (outcome.kind === 'denied') return { kind: 'denied', reason: outcome.reason }
      if (outcome.kind === 'cancelled') {
        return { kind: 'cancelled', reason: outcome.reason, providerContacted: outcome.providerContacted }
      }
      if (outcome.kind === 'failed') {
        return { kind: 'failed', reason: outcome.reason, providerContacted: outcome.providerContacted }
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
    cognition: Extract<Cognition, { kind: 'truncated' }>,
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
      content: renderTruncatedAnswer(cognition.text, footer),
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
private async finishTurn(
    input: MindSubmitInput,
    turn: ConversationTurn,
    outcome: MindTurnOutcome,
    detail: {
      reason?: string
      endedAt?: string
      startedAt?: string
      assistantMessageId?: string | null
      providerId?: string | null
      model?: string | null
      /**
       * What the gateway reported, passed straight through. The Mind does not
       * re-derive it: only the gateway knows whether a provider had the request,
       * and a Mind that guessed would report a paid call as free.
       */
      providerContacted?: boolean
      /**
       * The owner's own words for this turn, handed to the relationship lane only.
       *
       * Passed explicitly rather than looked up, so the text cannot outlive the
       * turn in a map and be reported to a *later* one. `finishTurn` never stores
       * it and never puts it in the terminal event.
       */
      ownerText?: string
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

    const providerContacted = detail.providerContacted ?? outcome === 'completed'
    const experience = this.experienceByTurn.get(turn.turnId)

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
  private async recordExperience(experience: TurnExperience): Promise<void> {
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

