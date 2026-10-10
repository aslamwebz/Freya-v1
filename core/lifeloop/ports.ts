import type {
  DecideOutcome,
  FocusState,
  LifeLoopEventType,
  PendingSchedule,
  WakeActor,
  WakeKind,
  WakeSource,
} from './types'
import type { LifeLoopJournalEntry } from './state'

/**
 * Everything the Continuous Life Loop is allowed to ask the rest of Core for.
 *
 * The whole of this lane's integration surface, in one file, and the omissions are
 * the design. There is no port that returns a gateway, a provider, a permit, a
 * capability, a principal or a grant store. There is no port that creates a wake,
 * names an actor, decides an outcome or moves the loop's state — every one of those
 * is the domain's job, in code that cannot reach a model.
 *
 * Two of these are the only interesting ones, and they are the two that could have
 * been written more loosely:
 *
 *   - {@link LifeLoopPorts.requestCognition} is the *sole* route to a model in
 *     Phase 23. It takes no principal, no capability and no provider, because a
 *     caller that could name any of those would be able to describe a call the
 *     Governor had never authorised. What it returns is a closed outcome, so the
 *     loop cannot branch on a provider's prose.
 *
 *   - {@link LifeLoopPorts.raiseEscalation} deliberately does *not* decide anything.
 *     It asks Attention — which is already Core's authority over the owner's
 *     attention, with its own budgets, cooldowns and focus rule — to consider
 *     something. The loop may conclude `interrupt`; only Attention decides whether
 *     the owner is actually reached. Two authorities over one human's attention is
 *     how a system ends up interrupting somebody twice.
 *
 * Everything else is a read of already-authorized state or a write of loop-owned
 * metadata.
 */

/** A payload the loop is allowed to write. Closed vocabulary, enforced by the fold. */
export type LifeLoopPayload = Readonly<Record<string, string | number | boolean | null>>

/** What the loop asks for when it wants to think about something. */
export interface LifeLoopCognitionRequest {
  /** The wake this thought belongs to. Closed over into the grant and the journal. */
  readonly wakeId: string
  readonly wakeKey: string
  /** The iteration within this wake. Bookkeeping, and bounded by the ceilings. */
  readonly iteration: number
  /**
   * The prompt text.
   *
   * Never journaled, never projected, and never used as a dedupe key — the journal
   * is the least protected file in the system, so the one thing that would make it
   * a transcript of what Freya was thinking is the one thing the loop keeps out.
   */
  readonly prompt: string
  /** What the loop is willing to spend. A ceiling, not a request for more. */
  readonly maxOutputTokens: number
  /** The closed question the answer must be about. Never the prose of an event. */
  readonly question: string
}

/** The closed set of ways a thought can end. No branch exists on anything else. */
export type LifeLoopCognitionOutcome =
  | {
      readonly status: 'decided'
      readonly outcome: DecideOutcome
      /** Provider identity and model, as metadata. Never a credential. */
      readonly providerId: string
      readonly model: string
    }
  | { readonly status: 'refused'; readonly code: string }
  | { readonly status: 'failed'; readonly code: string }

/** What the loop asks for when it wants to check that something actually happened. */
export interface LifeLoopVerificationRequest {
  readonly wakeId: string
  readonly wakeKey: string
  readonly kind: LifeLoopVerificationKind
  readonly reference: string
  readonly goalRef: string | null
}

/**
 * The closed set of checks a verification may perform.
 *
 * Two, and both are reads. A verification here never calls a model and never
 * reaches a connector: "did the thing the wake said actually reach the state the
 * wake said" is a question about Core's own projections, and answering it with
 * inference would make the loop's honesty depend on its provider being honest.
 */
export const LIFE_LOOP_VERIFICATION_KINDS = ['reference-terminal', 'escalation-delivered'] as const

export type LifeLoopVerificationKind = (typeof LIFE_LOOP_VERIFICATION_KINDS)[number]

export interface LifeLoopVerificationOutcome {
  /**
   * True when the wake's claim is settled against Core's own projections.
   *
   * The claim is "the reference has reached a terminal state", and a settled
   * claim is verified regardless of whether the underlying thing succeeded,
   * failed, or was cancelled. The loop's caller reads this as "the wake is
   * resolved, move on" — never as "the mission succeeded".
   */
  readonly holds: boolean
  /**
   * The three states a verification can report.
   *
   * - `settled`: the reference is known to Core and is terminal. `holds` is
   *   `true`. Whether the underlying thing was a success is a separate
   *   question and is *not* what this port answers — the verify port is
   *   about the claim, not the outcome.
   * - `still-open`: the reference is known to Core and is not yet terminal.
   *   `holds` is `false`. The wake is not yet resolved.
   * - `unknown`: the reference is not in Core's mission or work projections
   *   at all. `holds` is `false`. The wake is unverifiable, not just
   *   unsettled, and retrying is futile until the reference is registered.
   *
   * This is a closed vocabulary: the three are exactly what a verification
   * can return, and a new state would be a new port.
   */
  readonly outcome: 'settled' | 'still-open' | 'unknown'
  /**
   * A closed code carrying the source detail. Never prose from the thing
   * being checked. `code` is for diagnostics and journal lines; callers
   * branch on `outcome`, not on `code`.
   */
  readonly code: string
}

/** What the loop asks for when it has concluded something worth saying. */
export interface LifeLoopEscalation {
  readonly wakeId: string
  readonly wakeKey: string
  readonly kind: WakeKind
  /** What the loop concluded. Attention, not the loop, decides what it becomes. */
  readonly outcome: DecideOutcome
  /** What the loop resolved escalation down to. Focus suppresses and nothing else. */
  readonly escalation: 'none' | 'subtle-cue' | 'speak' | 'interrupt'
  readonly reference: string | null
  readonly goalRef: string | null
}

/**
 * The ports, as Core satisfies them.
 *
 * Every method is a read of already-authorized state or a narrow write, and three
 * of them (`stopAllActive`, `journalTrustworthy`, `focus`) are documented as
 * *callbacks rather than values* on purpose: copying a latch or a focus reading
 * into the loop would let the loop act on a stale one, which is the same class of
 * bug as a STOP ALL checked before an `await`.
 */
export interface LifeLoopPorts {
  /** ISO instant, injected. The loop has no clock of its own and never reads one. */
  now(): string
  /** A fresh id for a wake. Injected so the loop cannot widen its own vocabulary. */
  newId(): string
  /**
   * Append one life-loop event.
   *
   * Durable before it resolves. The loop's state is derived from these and from
   * nothing else, so a refused append must fail loudly rather than be swallowed —
   * there is no in-memory state to fall back on that would not be lost.
   */
  append(type: LifeLoopEventType, payload: LifeLoopPayload): Promise<void>
  /** The whole durable journal, in sequence order. Read once, when the loop opens. */
  replay(): Promise<readonly LifeLoopJournalEntry[]>
  /** The STOP ALL latch, read fresh at every gate. */
  stopAllActive(): boolean
  /** Whether the journal can be believed. False means nothing new is acted on. */
  journalTrustworthy(): boolean
  /** Whether the loop is switched on at all. Off means every wake is denied. */
  enabled(): boolean
  /** Schedules a heartbeat may fire. Read fresh; Attention owns the truth. */
  schedules(): readonly PendingSchedule[]
  /** The deterministic condition probe for one registered schedule. */
  conditionHolds(scheduleId: string): boolean
  /** What the owner is focused on, as Attention already knows it. */
  focus(): FocusState
  /** Whether an owner-created grant could cover one background call right now. */
  grantAvailable(now: string): boolean
  /** Calls still available under that grant. Zero means the loop may not think. */
  budgetRemainingCalls(now: string): number
  /**
   * The only route to a model in Phase 23.
   *
   * What Core puts behind it is the Governor, the Gateway and a grant the owner
   * created — so this call is authorized or refused by machinery that already
   * existed, and a refusal costs nothing because nothing was contacted. The loop
   * does not choose a principal, an origin, a cause or a provider: it picks a
   * category, and Core derives the rest.
   */
  requestCognition(request: LifeLoopCognitionRequest): Promise<LifeLoopCognitionOutcome>
  /** Check that something actually happened. A read, never a second thought. */
  verify(request: LifeLoopVerificationRequest): Promise<LifeLoopVerificationOutcome>
  /**
   * Ask Attention to consider something. It may decline, demote or suppress.
   *
   * Returns what Attention decided, so the loop can record what the owner will
   * actually experience rather than what the loop hoped for. It never returns a
   * decision authority: there is no field here that could set an outcome.
   */
  raiseEscalation(escalation: LifeLoopEscalation): Promise<'escalated' | 'suppressed'>
  /** Whether a goal is still open in Core's own Mission/Work state. */
  goalOpen(goalRef: string): boolean
  /**
   * Whether an escalation requires the owner's explicit consent before it is
   * raised.
   *
   * The one port here that exists for a decision this phase has not yet had to
   * make. It exists because the machinery around it — the `approval` deadline
   * kind, the interruption table's `approval-required` row, the close-out code
   * `awaiting-approval` — was all built in Phase 23 and a mechanism with no
   * producer is not a mechanism, it is dead code that reads as a guarantee.
   *
   * Core's answer today is `false`, and it is written as an explicit answer rather
   * than left absent: Phase 23's bounded actions reach Attention and Core's own
   * projections, neither of which needs consent, so there is nothing to ask about.
   * The moment an action reaches a connector, a worker's allowance or the owner's
   * own record, this becomes the answer that parks the loop — and the parking,
   * the absolute `approval` deadline and the owner-approval wake that lifts it are
   * already wired and tested.
   */
  escalationApprovalRequired(escalation: 'none' | 'subtle-cue' | 'speak' | 'interrupt'): boolean
  /** Something changed that a surface might be showing. */
  onChange(): void
}

/**
 * A wake, as Core raises one.
 *
 * `actor` is here rather than inferred because attribution is Core's job and the
 * loop's is to *check* it: `validateWake` compares the actor Core assigned against
 * the closed `WAKE_SOURCE_ACTOR` table and refuses everything that does not match.
 * A renderer, a model, an agent, a connector, an external webhook and a
 * self-scheduling timer appear nowhere on the right-hand side of that table, so
 * "no renderer may drive the loop" is a table rather than anybody's vigilance.
 */
export interface LifeLoopWakeRequest {
  readonly source: WakeSource
  readonly kind: WakeKind
  readonly actor: WakeActor
  readonly goalRef: string | null
  readonly sourceRef: string | null
  /** ISO instant the thing happened. Supplied by Core, never by the event. */
  readonly occurredAt: string
}