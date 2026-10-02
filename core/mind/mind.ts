import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { ConversationTurnEvent } from '../events/envelope'
import type { OwnerAuthority } from '../authority'
import type { CognitionGrantSpec } from '../cognition/grants'
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
 * A turn performs **at most one** provider request. There is no retry, no
 * summarisation call, no critic, no planner, no tool loop and no follow-up. A
 * failure is a failure and is reported as one. This is Phase 3's deliberate bound
 * and it is enforced structurally: the method below contains exactly one call
 * into the cognition service, so "did we accidentally add a second call" is a
 * question about one function rather than about a system.
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
 */
const TURN_GRANT_TTL_MS = 120_000

function foregroundGrantSpec(turnId: string, now: Date, maxOutputTokens: number): CognitionGrantSpec {
  return {
    // Turn-scoped and deterministic, so the grant this turn spends is the grant
    // this turn created. The pattern is a legal event id (`:` is allowed).
    grantId: `turn:${turnId}`,
    expiresAt: new Date(now.getTime() + TURN_GRANT_TTL_MS).toISOString(),
    allowedOrigins: ['user'],
    allowedCauses: ['user_message'],
    backgroundAllowed: false,
    maxCalls: 1,
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
  private readonly recall: ((query: string) => ReferenceKnowledge | null) | null
  private readonly turnContext: TurnContextReader | null
  private readonly onTurnStateChange: () => void
  private readonly onTurnExperience: ((experience: TurnExperience) => Promise<void>) | null
  private readonly expressionMemory: ExpressionMemory | null
  private readonly interactionFacts: () => readonly InteractionFact[]
  private readonly relationshipItems: () => readonly RelationshipItem[]
  private readonly onOwnerMessage: ((message: OwnerMessageEvent) => void) | null

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
    this.recall = options.recall ?? null
    this.turnContext = options.turnContext ?? null
    this.onTurnStateChange = options.onTurnStateChange ?? (() => {})
    this.onTurnExperience = options.onTurnExperience ?? null
    this.expressionMemory = options.expressionMemory ?? null
    this.interactionFacts = options.interactionFacts ?? (() => [])
    this.relationshipItems = options.relationshipItems ?? (() => [])
    this.onOwnerMessage = options.onOwnerMessage ?? null
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
      const grant = foregroundGrantSpec(turnId, this.now(), maxOutputTokens)
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
      const withContext = withTurnContext(compiled.messages, this.sharedContextFor(text, input.conversationId))

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

      // --- 5. exactly one authorised cognition ------------------------------
      const outcome = await this.authority.request({
        kind: 'user_turn',
        prompt: messages.map((m) => m.content).join('\n\n'),
        messages,
        maxOutputTokens,
        grantId: grant.grantId,
        correlationId: turnId,
        cognitionRequestId: turnId,
        // The owner's selection, when there is one. It is a *request*, not a
        // decision: the Governor still authors, the Gateway still refuses any
        // model it cannot serve, and a null here is the ordinary default.
        requestedModel: this.selectedModel(),
        goalId: null,
      })

      // Record cue use only when a provider was actually reached. A Governor
      // denial never dispatches, and a cancellation that arrived before contact
      // never dispatched either — no cue was spent, and recording one would
      // suppress a gesture the owner never saw. `allowed` means the provider
      // answered; `failed` and `cancelled` carry the gateway's own account of
      // whether a provider was contacted.
      const dispatched =
        outcome.status === 'allowed' ||
        ((outcome.status === 'failed' || outcome.status === 'cancelled') && outcome.providerContacted)
      if (expression !== null && dispatched) {
        for (const cue of expression.offeredCueIds) {
          this.recordCueUse(cue.cueId, cue.kind, startedAt)
        }
      }

      if (outcome.status === 'denied') {
        // The Governor refused. Nobody was asked, and the turn says so.
        return await this.finishTurn(input, turn, 'denied', { reason: outcome.reason, ownerText: text })
      }
      if (outcome.status === 'cancelled') {
        return await this.finishTurn(input, turn, 'cancelled', {
          reason: outcome.reason,
          providerContacted: outcome.providerContacted,
          ownerText: text,
        })
      }
      if (outcome.status === 'failed') {
        return await this.finishTurn(input, turn, 'failed', {
          reason: outcome.reason,
          providerContacted: outcome.providerContacted,
          ownerText: text,
        })
      }

      // --- 6. the answer, stored before anyone is told it exists ------------
      const endedAt = this.now().toISOString()
      const assistantMessage: ConversationMessage = {
        messageId: this.newId(),
        conversationId: input.conversationId,
        role: 'assistant',
        content: outcome.text,
        createdAt: endedAt,
        turnId,
      }
      try {
        await this.store.appendMessage(assistantMessage)
      } catch (error) {
        // The answer exists in memory and cannot be kept. Reporting the turn as
        // completed would put text in the transcript that is not durable, which
        // is the one state this ordering exists to prevent.
        return await this.finishTurn(input, turn, 'failed', {
          reason: `the answer could not be stored: ${conversationFault(error)}`,
          providerId: outcome.providerId,
          model: outcome.model,
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
          providerId: outcome.providerId,
          model: outcome.model,
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
   */
  cancelTurn(turnId: string, reason = 'the owner stopped this response'): number {
    return this.gateway.cancelRequest(turnId, reason)
  }

  /* ---------------------------------------------------------------- private */

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
      title: isFirstMessage ? firstMessageTitle : record.conversation.title,
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
 * Place a turn's shared Context block immediately before the owner's question.
 *
 * Position is a truthfulness decision, not a formatting one. The compiler's last
 * message is always the current user message and it stays last, so the material a
 * question refers to never arrives *after* the reference — and the question is
 * still the final thing a provider reads, which is what keeps the person's own
 * words at the end of the packet rather than a file's.
 *
 * A null block returns the compiler's array untouched, so a turn with nothing
 * shared produces exactly the packet it produced before Context existed.
 */
function withTurnContext(
  messages: readonly ModelMessage[],
  block: ModelMessage | null,
): readonly ModelMessage[] {
  if (block === null) return messages
  const last = messages[messages.length - 1]
  if (last === undefined) return [...messages, block]
  return [...messages.slice(0, -1), block, last]
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

