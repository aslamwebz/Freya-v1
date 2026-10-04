import type {
  ActionConsequenceClass,
  ApprovalKind,
  ApprovalSubjectKind,
  EnterpriseEventType,
  EnterpriseJournalEntry,
  SpendingGateKind,
  VerificationOutcome,
  WebzoneOperationKind,
} from './types'

/**
 * Everything the Autonomous Enterprise slice is allowed to ask the rest of Core for.
 *
 * This file is the whole integration surface, and — as in the Continuous Life Loop —
 * **the omissions are the design**. Read what is *not* here before adding anything:
 *
 *   - There is no cognition port. No `requestCognition`, no provider, no gateway, no
 *     grant. Phase 33 cannot call a model because it has no route to one, which is a
 *     stronger property than "it chooses not to". Anything requiring a thought is
 *     decided by Core through the Governor on the owner's behalf, outside this lane.
 *
 *   - There is no authority port. No capability check, no permission check, no way to
 *     ask "am I allowed to do this". Phase 33 does not decide that; it refuses work
 *     it has no boundary or gate for, and Core's Guard is what actually holds the
 *     capability. Giving this lane a way to *ask* for authority would create a second
 *     answer to a question that already has one.
 *
 *   - There is no spending port and no payment port. Nothing here can move money.
 *     `performWebzoneEffect` is typed to a `WebzoneOperationKind`, and that union has
 *     no member which means paying, ordering or committing — see `WEBZONE_OPERATION_KINDS`
 *     in `./types`.
 *
 *   - There is no self-scheduling port. Nothing here starts, arms or re-arms a timer.
 *     The slice is driven by wakes Core already raises, and `open()` replays the
 *     journal. `./assertions` scans the source for timers for exactly this reason.
 *
 * What is here is: a clock, an id source, the durable journal, the STOP ALL latch, a
 * read of owner approval decisions, and one narrow bounded-effect port that Core
 * fulfils using machinery that already existed.
 */

/** A payload the slice is allowed to write. Closed vocabulary, enforced against the table. */
export type EnterprisePayload = Readonly<Record<string, string | number | boolean | null>>

/**
 * A bounded external effect request.
 *
 * Deliberately shaped so that the *only* things a caller can vary are the target and
 * an opaque payload. There is no amount, no currency, no destination account and no
 * "raw request" field, because an effect request that could carry those is an effect
 * request that could move money — and the type would be the last place standing
 * between a caller and a payment.
 */
export interface EnterpriseEffectRequest {
  readonly operationId: string
  readonly environmentId: string
  readonly kind: WebzoneOperationKind
  /** A URL or path. Checked against the environment's `allowedDomains` before this. */
  readonly target: string
  readonly payload: string
}

/**
 * What actually happened, as a closed outcome.
 *
 * `holds` is false for anything that did not verifiably happen. There is no
 * "probably" and no free-text success, because the caller cannot verify prose and
 * this lane must not either.
 */
export interface EnterpriseEffectOutcome {
  readonly holds: boolean
  /** A closed code. Never prose from the thing that was operated on. */
  readonly code: string
  /**
   * Whether the effect can be undone.
   *
   * Core reports this rather than this lane deciding it, because only Core knows
   * whether it kept a copy. `./rollback` refuses a `destructive` effect that says
   * `false`, which is what makes "deletions are reversible because the content is
   * preserved" true rather than aspirational.
   */
  readonly restorable: boolean
}

export interface EnterpriseApprovalDecision {
  readonly approvalId: string
  /** Whether the owner granted it. Only ever the owner's answer, relayed. */
  readonly granted: boolean
  /**
   * Who actually decided.
   *
   * Closed to `owner` and `core`, and it exists so the runtime can *check* the
   * attribution rather than assume it. An approval is the single thing that lets work
   * the subsystem would otherwise refuse proceed, so "who answered" has to be part of
   * the answer it receives. A response that says `core` is treated as a denial.
   */
  readonly decidedBy: 'owner' | 'core'
  readonly decidedAt: string
}

/**
 * What an owner approval request looks like when Core raises it.
 *
 * `reasoning` is the sentence the owner will read before deciding. It is bounded text
 * from this lane, never model prose: a person is being asked to authorize spending or
 * a binding-sounding action, and a model-generated justification in that position is
 * the persuasion problem this whole phase exists to avoid.
 */
export interface EnterpriseApprovalRequest {
  readonly environmentId: string
  readonly kind: ApprovalKind
  readonly subjectKind: ApprovalSubjectKind
  readonly subjectRef: string
  /** Binds the approval to one exact action body, so it cannot be swapped. */
  readonly subjectDigest: string
  readonly reasoning: string
  /** ISO instant after which the request is void. Absolute, never relative. */
  readonly expiresAt: string
}

export interface EnterprisePorts {
  /** ISO instant, injected. This lane has no clock of its own and never reads one. */
  now(): string
  /** A fresh id. Injected so the slice cannot widen its own id vocabulary. */
  newId(): string
  /**
   * Append one enterprise event.
   *
   * Durable before it resolves. Every derived state here comes from these entries and
   * nothing else, so a refused append must fail loudly — there is no in-memory state
   * to fall back on that would not be lost on the next restart.
   */
  append(type: EnterpriseEventType, payload: EnterprisePayload): Promise<void>
  /** The whole durable journal, in sequence order. Read once, when the slice opens. */
  replay(): Promise<readonly EnterpriseJournalEntry[]>
  /**
   * The STOP ALL latch, read fresh at the gate and again before the effect.
   *
   * A callback rather than a value on purpose: copying the latch into this lane would
   * let it act on a stale reading, which is the same class of bug as a STOP ALL
   * checked before an `await`.
   */
  stopAllActive(): boolean
  /** Whether the journal can be believed. False denies every new action. */
  journalTrustworthy(): boolean
  /** Whether the slice is switched on at all. Off denies every wake. */
  enabled(): boolean
  /**
   * Perform one bounded external effect.
   *
   * Core fulfils this with the existing capability path — the Guard, the browser
   * capability, the relay — so the effect is authorized by machinery that already
   * existed and this lane cannot reach around it. What comes back is a closed outcome,
   * never provider or connector prose.
   */
  performWebzoneEffect(request: EnterpriseEffectRequest): Promise<EnterpriseEffectOutcome>
  /**
   * Put one reversible effect back.
   *
   * Separate from `performWebzoneEffect` on purpose, so that undoing something cannot
   * be expressed as another forward action and quietly re-run the forward gates with
   * different meaning.
   */
  reverseWebzoneEffect(request: EnterpriseEffectRequest): Promise<EnterpriseEffectOutcome>
  /** Ask the owner. Returns the owner's decision; this lane never decides one. */
  requestOwnerApproval(request: EnterpriseApprovalRequest): Promise<EnterpriseApprovalDecision>
  /** Whether an approval the owner granted is still unspent and unrevoked. */
  approvalStillValid(approvalId: string): boolean
  /** Something changed that a surface might be showing. */
  onChange(): void
}

/* --------------------------------------------------------------- gate inputs */

export interface SpendingGateInput {
  readonly gate: SpendingGateKind
  readonly limitMinor: number
  readonly spentMinor: number
  /** What this action would add. Non-negative integer minor units. */
  readonly amountMinor: number
  readonly currency: string
  readonly actionCurrency: string
}

/** The consequence class an operation was assigned, and what it claims about itself. */
export interface ConsequenceInput {
  readonly kind: WebzoneOperationKind
  readonly consequence: ActionConsequenceClass
  readonly restorable: boolean
}

/** What an action asserts about the world, and what was actually observed. */
export interface EvidenceInput {
  /** Whether a claim of success was made at all. */
  readonly claimed: boolean
  /** Where the claim came from. A claim from a model or the environment is not evidence. */
  readonly claimedBy: 'owner' | 'core' | 'external-observation' | 'model' | 'environment' | 'agent'
  /** Whether an observation exists at all. */
  readonly observed: boolean
  /** Whether the observation matched what was intended. */
  readonly matched: boolean
}

export interface VerificationInput {
  readonly actionId: string
  readonly environmentId: string
  readonly outcome: VerificationOutcome
  readonly evidence: EvidenceInput
  readonly deadlineAt: string | null
  readonly stopped: boolean
  readonly at: string
}

export interface RollbackInput {
  readonly actionId: string
  readonly environmentId: string
  readonly consequence: ActionConsequenceClass
  readonly restorable: boolean
  readonly crossedBoundary: boolean
  readonly exceededSpending: boolean
  readonly spentMinor: number
  readonly attempts: number
}

/** One recorded refusal, kept for the owner's audit view. */
export interface EnterpriseRefusalRecord {
  readonly actionId: string
  readonly environmentId: string
  readonly gate: string
  readonly code: string
  readonly reason: string
  readonly at: string
}

/** One recorded effect, kept for the owner's audit view. */
export interface EnterpriseActionRecord {
  readonly actionId: string
  readonly environmentId: string
  readonly kind: string
  readonly state: 'started' | 'completed' | 'failed'
  readonly reasoning: readonly string[]
}