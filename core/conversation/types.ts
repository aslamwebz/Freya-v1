/**
 * Conversation entities.
 *
 * These are the *bodies* — the things a person actually said and the answers
 * Freya actually gave. They are deliberately a different shape from the durable
 * event vocabulary, because the two have opposite rules:
 *
 *   - the **Event Fabric** is audit. It records that a turn happened, how long
 *     it was, which provider answered. It never holds a word of it.
 *   - the **Conversation Store** is personal data. It holds the words, and it is
 *     encrypted at rest.
 *
 * Keeping them in separate modules is what makes that separation checkable
 * rather than a matter of remembering not to put a field in the wrong object.
 * Nothing in `core/events/` imports from this file.
 */

/**
 * Who said something.
 *
 * A closed union of two. There is no `system` role, and that absence is the
 * design: Freya's identity and instructions are compiled into a provider system
 * message by the Context Compiler and are **not** stored as a fake message the
 * user can see in the transcript. A stored "system" turn would be a thing that
 * looked like conversation but was really configuration, and it would be
 * something the user could not tell apart from something Freya said.
 *
 * Renderer input becomes `user` and nothing else. The mapping is in the
 * Conversation Service, not in a type the renderer can satisfy with a string.
 */
import type { MediaItem } from '../media/types'
import type { ChatMissionProposal } from '../missions/chat-types'
import type { ToolSource, ToolStepRecord, ChartSpec, CanvasSpec } from '../mind/tools'
export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  missionProposal?: ChatMissionProposal
  missionId?: string
  missionDecision?: { proposalMessageId: string; decision: 'approved' | 'rejected' }
  messageId: string
  conversationId: string
  role: MessageRole
  content: string
  createdAt: string
  /** The turn this belongs to. One turn is one user message and its answer. */
  turnId: string
  /**
   * What the lookups behind this answer actually returned, as typed items.
   *
   * Beside the text rather than inside it, and never recovered by re-reading the
   * prose: a card needs an address, and an address guessed out of a sentence is a
   * fabrication. Absent on a turn that looked nothing up, which is most turns.
   */
  media?: readonly MediaItem[]
  /**
   * Web search results behind this answer, as typed sources.
   *
   * Distinguished from `media` because the renderer treats them differently: media
   * becomes cards, sources become citations. Both travel beside the prose for the
   * same reason — the journal keeps the literal model text for audit, but the
   * renderer never re-parses the prose to find structure. The renderer splits this
   * list into "matched" (cited in the answer body) and "related" (the rest of what
   * the search returned) at render time.
   */
  sources?: readonly ToolSource[]
  /**
   * Typed charts the model produced for this answer.
   *
   * The renderer draws them; the journal keeps them as data. A chart that came
   * back from a tool is the only honest way to display a series: a renderer that
   * read numbers out of prose would be drawing from a guess, not a measurement.
   * Absent on a turn that did not call the chart tool.
   */
  charts?: readonly ChartSpec[]
  /**
   * Long-form artifact the model opened beside this answer, if any.
   *
   * The chat says "I made X" in one or two sentences; this carries the body
   * (a document or a program) so the renderer can open a side panel. Absent
   * on a turn that did not call the canvas tool.
   */
  canvas?: CanvasSpec
  /**
   * The loop's own record of the tool steps this turn ran, in order.
   *
   * Beside the prose rather than inside it, so a future reader can verify the
   * transcript's "What Freya did" section against the loop and not against the
   * model. A `browser_tabs` step here means the tool body actually ran for
   * this turn; its absence on a turn that named a browser action in prose is
   * the honest signal that the action was narrated, not performed.
   *
   * Absent on a turn that looked nothing up, which is most turns, and always
   * absent on a user message.
   */
  steps?: readonly ToolStepRecord[]
}

export interface Conversation {
  conversationId: string
  /**
   * Deterministic and local. Derived from the first user message at the moment
   * it is persisted, because a title is cosmetic and a cosmetic label must never
   * cost a model call.
   */
  title: string
  createdAt: string
  updatedAt: string
  /**
   * Null/absent while visible. Closing a chat archives it instead of destroying
   * encrypted history, so recovery and audit never depend on a destructive UI act.
   */
  archivedAt?: string | null
}

/** The list view. Enough to render a picker, nothing that needs decrypting later. */
export interface ConversationSummary {
  conversationId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** The outcome of the most recent turn, or null when there is not one yet. */
  lastTurnOutcome: TurnOutcome | null
}

/**
 * How a turn finished.
 *
 * Six states, and the distinctions between them are the point. Collapsing any
 * two would put a claim in the transcript that Core cannot support.
 *
 * - `completed` — an answer exists and is stored.
 * - `denied` — the Governor refused. Nobody was ever asked.
 * - `cancelled` — somebody stopped it deliberately: the owner pressed stop on
 *   this answer, or STOP ALL landed while it was running.
 * - `failed` — it was attempted and did not work. A provider error, or nowhere
 *   to persist the answer.
 * - `interrupted` — it was running when the process died. The user asked a
 *   question; no answer exists. This is not a failure and not a success, and
 *   the two are not guesses either — recovery records exactly this.
 * - `pending` — written when the turn starts, and only ever seen by a reader
 *   that has not yet run recovery. Any `pending` turn found at start-up becomes
 *   `interrupted`; it is never completed and never retried.
 */
export type TurnOutcome = 'pending' | 'completed' | 'denied' | 'cancelled' | 'failed' | 'interrupted'

/** A terminal outcome, i.e. anything that is not still running or unknown. */
export type TerminalTurnOutcome = Exclude<TurnOutcome, 'pending'>

export interface ConversationTurn {
  turnId: string
  conversationId: string
  userMessageId: string
  /**
   * Null until an answer is stored.
   *
   * The field is the reason an answer can never be shown as complete before it
   * is durable: there is no state in which the transcript has an assistant
   * message and this is still null.
   */
  assistantMessageId: string | null
  outcome: TurnOutcome
  startedAt: string
  endedAt: string | null
  /**
   * The Model Gateway request id for this turn's single call.
   *
   * Held so a scoped "stop this response" can find the request without the Mind
   * reaching for an AbortController, and so cancellation is a lookup rather
   * than a guess.
   */
  requestId: string | null
  providerId: string | null
  model: string | null
  /** Why, in words. Never content. Safe for the journal. */
  reason: string | null
}

/** Everything about one conversation, read on demand. */
export interface ConversationRecord {
  conversation: Conversation
  messages: ConversationMessage[]
  turns: ConversationTurn[]
}

/* ------------------------------------------------------------------ limits */

/**
 * Deterministic content limits.
 *
 * Fixed here rather than negotiated per surface, because a limit that depends on
 * who is asking is a limit somebody can raise. A 500MB paste must fail visibly
 * at the edge, not become one provider request.
 */
export const CONVERSATION_LIMITS = Object.freeze({
  /** One user message. Generous for prose, far below anything that could be an accident. */
  maxMessageCharacters: 8_000,
  /** A title is a few words; anything longer is not a title. */
  maxTitleCharacters: 80,
  /** Conversations returned in one listing. */
  maxConversationsListed: 100,
  /** Messages sent to a renderer in one projection. */
  maxMessagesInProjection: 200,
  /**
   * The output ceiling a conversation turn may ask for.
   *
   * Bounded per turn, and matched by the foreground grant's own ceiling, so the
   * Governor is enforcing the same number the Mind asked for rather than a
   * separate policy that could drift from it.
   *
   * Raised from 1024 on 2026-10-06. The original 1024 was set when the first
   * conversation loop landed (54837a7, 2026-09-30) and was never revisited; it
   * predates any measurement against a real model, and the tool loop is what made
   * it visibly wrong rather than merely tight.
   *
   * Measured output tokens for `qwen/qwen3.8-27b-uncensored` against the live
   * endpoint: a tool call ~35, an answer from supplied evidence ~414, an ordinary
   * answer ~550. A turn that decides to look something up spends all three, which
   * is ~1000 before any margin — so 1024 truncated the *ordinary* case, the one
   * that is supposed to need no tools at all, and the truncation was correctly
   * reported as a failed turn. 3072 covers the three-call shape with room for a
   * longer answer and still bounds the worst case.
   *
   * This number is a *ceiling*, not a forecast. Actual spend is bounded by
   * reported usage against the grant, so a turn that answers briefly costs
   * briefly; what this stops is a turn being unable to finish.
   *
   * It was 3072, which covered the old three-call turn as `1024 + 1024 + 1024`. With
   * ten calls the schedule divides as `3072 + 9 x 512 = 7680`, and the sum is the
   * ceiling rather than a multiple of it, because `outputTokenBudgetReserved` is
   * authorisation arithmetic taken before the call and never released.
   *
   * An ordinary turn still reserves 3072, so the everyday cost of a conversation has
   * not changed: only a turn that genuinely takes nine lookups can reach the rest.
   */
  maxOutputTokensPerTurn: 32_768,

  /**
   * The most one answer may ask for, however it was reached.
   *
   * Separate from the turn ceiling because they answer different questions. The turn
   * ceiling bounds the *worst case* of a turn that spends nine lookups and then answers
   * — 3072 for the answer plus 512 for each of them. A turn that used no tools made one
   * call, and handing that single call the whole 7680 would both exceed what the
   * Governor will authorise in one request and quietly turn a routine conversation into
   * the most expensive kind of turn there is.
   *
   * It is also the first call's share in the loop: `budgetFor(0, maxOutputTokensPerTurn)`
   * works out to exactly this number, so a tool-using turn and a plain one can both
   * write a full-length answer.
   */
  maxOutputTokensPerAnswer: 3_072,
})

/* ---------------------------------------------------------------- helpers */

/**
 * A conversation title, derived locally.
 *
 * The first few words of the first user message, whitespace collapsed. No model
 * call, ever: a title is cosmetic, and cosmetic metadata must not cost credits
 * or create a second thing that can fail.
 */
export function deriveConversationTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return 'New conversation'
  if (collapsed.length <= CONVERSATION_LIMITS.maxTitleCharacters) return collapsed
  const clipped = collapsed.slice(0, CONVERSATION_LIMITS.maxTitleCharacters)
  // Cut on a word boundary so a title does not end mid-word.
  const lastSpace = clipped.lastIndexOf(' ')
  return `${(lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`
}
