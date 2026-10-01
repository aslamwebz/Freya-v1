/**
 * The Core protocol: the vocabulary shared by Core and the renderer.
 *
 * Types only, and no runtime values, so the renderer can depend on the shape
 * of Core without depending on Core's implementation. Everything the renderer
 * is allowed to see is declared here.
 *
 * A renderer that can name a projection field cannot thereby acquire the
 * capability to change one.
 */

import type { ConversationCommandOutcome, VoiceCommandOutcome } from './conversation'

/* ------------------------------------------------------------ identity */

/** A principal asking Core for something. Never carries credentials. */
export type PrincipalId =
  | 'owner'
  | 'system'
  | `agent:${string}`
  | `module:${string}`

/* --------------------------------------------------------- capabilities */

/**
 * The Phase 1 capability vocabulary. Deny by default: a principal holds only
 * what has been explicitly granted, and the vocabulary is closed.
 */
export const CAPABILITIES = [
  'core.status.read',
  'core.command.submit',
  'cognition.status.read',
  'cognition.request',
  'cognition.grant.manage',
  'security.status.read',
  'security.stop',
  'security.resume',
  /**
   * Phase 5 research capabilities.
   *
   * Separate names, because they are separate kinds of privilege. Search asks a
   * third party about the world; `browser.read` fetches an arbitrary public page
   * and therefore executes an attacker's HTML inside a managed sandbox; research
   * starts a multi-stage operation that spends model calls. A capability vocabulary
   * that collapsed them into one `research.use` would make it impossible to widen
   * one without widening all three.
   *
   * None is a grant a model or a page can obtain. They are held by the owner
   * principal only, and each is evaluated by Guard before the privileged work
   * happens rather than after it.
   */
  'search.web',
  'browser.read',
  'research.start',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * Everything the owner holds, in one place.
 *
 * The owner principal is built from this rather than from a list written out at
 * the call site, so a capability added to the vocabulary cannot be quietly left
 * off the one principal that is supposed to have it.
 */
export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES

/**
 * The capabilities a worker may ever hold.
 *
 * Deliberately excludes `cognition.grant.manage` and every `security.*`
 * capability: a worker can ask to think, and that is the end of it.
 *
 * Phase 5 deliberately adds none of `search.web`, `browser.read` or
 * `research.start` here. A worker can already ask for cognition under a grant, and
 * cognition is where a research operation's model turns happen. Giving a worker the
 * ability to reach the network or a browser as well would mean an agent could
 * exfiltrate whatever it was told, which is the opposite of what a bounded worker
 * is for.
 */
export const WORKER_CAPABILITIES: readonly Capability[] = ['cognition.request']

/* --------------------------------------------------------------- Guard */

export type GuardOutcome = 'allow' | 'deny' | 'approval_required'

export interface GuardDecision {
  outcome: GuardOutcome
  /** The rule that decided it, for the audit trail. */
  reason: string
  capability: Capability
  principal: PrincipalId
}

/* ------------------------------------------------------------ cognition */

export type CognitionOrigin = 'user' | 'goal' | 'workflow' | 'agent' | 'learning' | 'system'

export type CognitionCause =
  | 'user_message'
  | 'user_requested_test'
  | 'explicit_review'
  | 'goal_started'
  | 'run_finished'
  | 'world_changed'
  | 'scheduled_grant'
  | 'learning_consolidation'

export type GovernorOutcome = 'allow' | 'ask' | 'deny'

export interface GovernorDecision {
  outcome: GovernorOutcome
  reason: string
  grantId: string | null
}

/* --------------------------------------------------------------- model */

export type ProviderStatusKind = 'disabled' | 'unconfigured' | 'configured' | 'faulted'

export interface ProviderStatus {
  id: string
  kind: 'fake' | 'nanogpt'
  status: ProviderStatusKind
  /** Never a secret: a shape, not a value. */
  model: string | null
  /** Why it is in this state, in words a person can act on. */
  detail: string
  /** True only when a live external call is possible and permitted. */
  liveEnabled: boolean
}

/**
 * Reported provider usage, accumulated over many calls.
 *
 * The two figures are sums of what providers *said*, and the counter is what
 * makes them honest:
 *
 * - `inputTokens` / `outputTokens` are the totals of the calls that reported
 *   usage. They are a **lower bound** whenever `unknownUsageCalls` is above zero,
 *   because the calls that reported nothing are simply not in the sum.
 * - `unknownUsageCalls` counts the calls that reported no usage, or only part of
 *   it. This is the explicit representation of "we do not know", chosen over
 *   treating an unreported call as zero — which would make an unaccounted call
 *   look like a free one — and over making the whole total null, which would
 *   throw away the calls that *were* accounted for.
 *
 * Nothing here is ever estimated. A caller that needs a true total must check
 * `unknownUsageCalls` first; presenting these two numbers as exact is the bug
 * this shape exists to prevent.
 *
 * This is entirely separate from a grant's *authorisation* budget, which is
 * reserved before a call and never depends on what a provider reports.
 */
export interface ModelUsage {
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  /** Calls whose usage was not fully reported. Makes the totals a lower bound. */
  unknownUsageCalls: number
}

/* ---------------------------------------------------------- projection */

export type CoreLifecycle = 'booting' | 'ready' | 'degraded' | 'stopping' | 'stopped'

/**
 * Everything the renderer may know about Core.
 *
 * This is a projection of durable state, not a live handle. A field that is
 * genuinely unknown is `null`, never a placeholder number.
 */
/**
 * Whether the journal can be believed.
 *
 * `torn` is ordinary: a crash interrupted the last write and the surviving
 * prefix is the whole truth. `corrupt` is not: a complete line failed
 * validation, so the journal cannot be replayed into security state — the
 * discarded segment could have contained a STOP ALL. A Core in this state denies
 * cognition regardless of what the replayed prefix says.
 */
export type JournalIntegrity = 'ok' | 'torn' | 'corrupt'

export interface JournalFault {
  integrity: JournalIntegrity
  /** Why, in words a person can act on. Never null. */
  reason: string
  /** Which line the problem was found on, 1-indexed. */
  line: number | null
  /** Complete events that were read and believed. */
  eventsRead: number
  /** Bytes discarded during recovery, including a torn tail. */
  bytesDiscarded: number
}

export interface CoreStatus {
  lifecycle: CoreLifecycle
  /** Last durable event sequence, or 0 when the log is empty. */
  eventSequence: number
  coreStartedAt: string | null
  /**
   * Always present. A healthy journal says so explicitly, because the absence of
   * a warning is not the same thing as a warning that is absent.
   */
  integrity: JournalFault
  /** The latch is derived from durable events, so it survives a restart. */
  stopAll: {
    active: boolean
    activatedAt: string | null
    activatedBy: PrincipalId | null
  }
  guard: {
    /** Deny by default; shown so the posture is visible rather than implied. */
    defaultOutcome: GuardOutcome
    /** Capable of approval, but no approval workflow exists in Phase 1. */
    approvalWorkflow: 'unavailable'
  }
  governor: {
    /**
     * `unknown` is not the same as `deny_all`. A Core that has not finished
     * booting has no answer, and reporting "denying everything" there would
     * claim a stop latch that may well not be set.
     */
    status: 'ready' | 'deny_all' | 'unknown'
    grantsActive: number
  }
  providers: ProviderStatus[]
  /**
   * Provider requests executing **right now**, in this Core process.
   *
   * Read straight from the Model Gateway's active registry, which is the only
   * in-process record of live work. Deliberately not derived from the durable
   * journal: a journal can say a request was started and cannot say whether it
   * is still running, and a Core that died mid-call leaves a start with no
   * finish forever. Inferring "working" from that history is how an idle Freya
   * ends up claiming it is thinking.
   *
   * Zero means nothing is being spent, which is the normal state.
   */
  activeProviderCalls: number
  /** Usage for this Core session. Durable totals are separate. */
  sessionUsage: ModelUsage
  durableUsage: ModelUsage
  /** Non-empty when something is wrong; Core says what, rather than hiding it. */
  faults: string[]
}

/* ----------------------------------------------------------------- RPC */

export type CoreCommandName =
  | 'core.status.read'
  | 'core.command.submit'
  | 'security.status.read'
  | 'security.stopAll'
  | 'security.resume'
  | 'cognition.status.read'
  /**
   * Grant governance. The handler ignores any principal in the payload and
   * records the owner, because identity is assigned by Core and never
   * accepted from a caller.
   */
  | 'cognition.grant.create'
  | 'cognition.grant.revoke'
  /* ------------------------------------------------------ conversation */
  | 'conversation.create'
  | 'conversation.list'
  | 'conversation.read'
  /** The only door from a window into cognition. */
  | 'conversation.turn.submit'
  /** Scoped: stops one response. Does not latch STOP ALL. */
  | 'conversation.turn.cancel'
  /* -------------------------------------------------------------- voice */
  | 'voice.status.read'
  | 'voice.capture.start'
  | 'voice.capture.end'
  | 'voice.capture.cancel'
  /* -------------------------------------------------------------- brain */
  /** Read-only. Reports what the Brain is and what it holds. */
  | 'brain.status.read'
  /**
   * Ask Freya to remember something.
   *
   * The renderer's *request*, not a write. It carries what the person wants
   * remembered and nothing about how trusted it is — the source class is assigned
   * by the pathway that admits it, in Core, because a caller that could name its own
   * source could launder a web page's contents in as an owner assertion.
   */
  | 'brain.memory.write'
  /** Withdraw a memory deliberately. Archived, never deleted. */
  | 'brain.memory.archive'
  /** Recall on demand, so a person can see what Freya would bring to a question. */
  | 'brain.recall'
  /* ----------------------------------------------------------- research */
  /**
   * Phase 5. Five commands, and each payload is one field.
   *
   * `query`, `url` and `researchId` are the entire renderer-controlled input. Not
   * provenance, provider, model, limits, budget, principal or capability — a
   * renderer that could name any of those could either launder a web page's
   * contents in as an owner assertion, or raise its own budgets.
   */
  | 'search.web'
  | 'browser.read'
  | 'research.start'
  | 'research.cancel'
  | 'research.status.read'

export interface CoreCommandEnvelope {
  command: CoreCommandName
  /** Correlates the acknowledgement with the request that caused it. */
  requestId: string
  payload?: unknown
}

export interface CoreCommandResult {
  requestId: string
  ok: boolean
  /** Present when the command was understood; absent on rejection. */
  status?: CoreStatus
  /** Present on a deliberate refusal: Guard, Governor, validation. */
  refusal?: { reason: string }
  /** Present on an unexpected failure. Never carries a stack to the renderer. */
  error?: { message: string }
  /**
   * The durable sequence number of the event this command produced. Present only
   * when the command actually appended something, so a renderer can verify the
   * effect is on disk instead of taking a boolean on trust.
   */
  durableSequence?: number
  /**
   * The conversation view of a conversation command's result.
   *
   * A separate slot rather than a wider `status`, because the two answer different
   * questions and merging them would let a panel read a conversation out of a
   * security projection. Nothing here is writable by the renderer: it is what
   * Core built, and the next push overwrites it.
   */
  conversation?: ConversationCommandOutcome
  /**
   * The voice view of a voice command's result.
   *
   * Its own slot for the same reason the conversation slot exists: a window must
   * never have to dig a transcript or a capture result out of a security
   * projection, and two unrelated streams sharing one field is how that starts.
   */
  voice?: VoiceCommandOutcome
  /**
   * The Brain view of a Brain command's result.
   *
   * Its own slot, for the same reason the conversation and voice slots exist: the
   * Brain is where Freya's long-term knowledge lives, and it must never have to be
   * dug out of a security projection — where it would be copied and cached
   * wherever status is.
   */
  brain?: BrainCommandOutcome
  /**
   * The research view of a research command's result.
   *
   * Its own slot for the same reason the conversation, voice and Brain slots exist:
   * a window must never have to dig a search result or a research answer out of a
   * security projection, where it would travel wherever status is cached or logged.
   */
  research?: ResearchCommandOutcome
}

/**
 * What a research command produced.
 *
 * Bounded in every direction. `limits` is the code-owned ceiling, echoed so a window
 * can show what Freya is actually allowed to spend; it is never an input. Sources
 * carry the URL a person would need in order to check a claim — that is the point of
 * a citation — while the journal, the activity feed and every event carry only ids
 * and counts.
 */
export interface ResearchCommandOutcome {
  operation: 'search' | 'read' | 'research' | 'cancelled' | 'status' | 'refused'
  reason?: string
  operationId?: string
  limits?: {
    iterations: number
    queries: number
    results: number
    pages: number
    evidenceChars: number
    durationMs: number
    modelTurns: number
    maxOutputTokens: number
  }
  results?: readonly {
    title: string
    url: string
    snippet: string
    sourceDomain: string
  }[]
  document?: {
    title: string
    url: string
    sourceDomain: string
    retrievedAt: string
    headings: string[]
    text: string
    links: readonly { title: string; url: string }[]
    truncated: boolean
  }
  result?: {
    id: string
    state: 'completed' | 'partial' | 'failed' | 'cancelled'
    findings: readonly { text: string; sourceIds: string[] }[]
    conflicts: readonly { text: string; sourceIds: string[] }[]
    uncertainties: string[]
    sources: readonly {
      sourceId: string
      url: string
      title: string
      domain: string
      retrievedAt: string
      excerpt: string
    }[]
    failures: readonly { stage: string; code: string }[]
    usage: Record<string, number>
  }
  status?: { operationId: string; stage: string } | null
}

/**
 * What a Brain command produced.
 *
 * `recall` is the interesting one, and its shape is the point: a pack that names
 * every item's source class and confidence, discloses the contradictions it found,
 * and counts what it left out. "Freya recalled this" is only a meaningful thing to
 * show somebody if they can also see where it came from and what was dropped.
 */
export interface BrainCommandOutcome {
  operation:
    | 'status'
    | 'memory-written'
    | 'memory-refused'
    | 'memory-archived'
    | 'recall'
  reason?: string
  memory?: {
    memoryId: string
    kind: string
    subject: string
    status: string
    source: string
    confidence: string
    admittedAt: string
  }
  recall?: {
    query: string
    items: readonly {
      memoryId: string
      subject: string
      content: string
      source: string
      confidence: string
      status: string
      score: number
    }[]
    conflicts: readonly { memoryId: string; conflictsWith: readonly string[]; detail: string }[]
    candidatesConsidered: number
    omittedCount: number
    estimatedTokens: number
    empty: boolean
  }
}
