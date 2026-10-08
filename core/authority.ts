import type { CognitionCause, CognitionOrigin } from './protocol/core-protocol'
import type { CognitionGrant, CognitionGrantSpec } from './cognition/grants'
import type { CognitionOutcome } from './cognition/service'
import type { ModelMessage } from './model/provider'

/**
 * The authority boundary.
 *
 * This file defines what a caller of Core is *allowed to say*. It is the whole
 * point of the redesign, so the omissions are the interesting part.
 *
 * ## What a caller cannot do
 *
 * A caller cannot name a principal. Every method here runs as the principal
 * baked into the authority object it was handed, chosen by Core. `actor`,
 * `createdBy` and `revokedBy` are not parameters anywhere, because a parameter
 * is a value the caller controls and identity must not be one.
 *
 * A caller cannot name an origin, a cause, or whether it is background. Those
 * are derived from a closed {@link CognitionIntentKind}, so the strongest thing
 * a caller can do is pick a category — and the categories it may pick from
 * depend on who it is. A worker's type does not include `user_turn`, so the
 * grantless path is not reachable from a worker at all, at compile time.
 *
 * A caller cannot obtain a provider, a gateway, a permit, or a grant store it
 * can write to. There is no method that returns any of them.
 *
 * ## What a caller can do
 *
 * Ask for cognition of a stated kind, and — if it is the owner — govern grants
 * within ceilings it chose. A grant is a division of a finite allowance, so
 * creating one is an owner act, not a self-service one.
 */

/**
 * Why cognition is happening, as a closed set.
 *
 * The mapping from kind to origin and cause lives in Core, not here, so that a
 * caller cannot compose an origin and a cause into a combination that means
 * something more powerful than either part.
 */
export type CognitionIntentKind =
  /** A human is present and asked for this answer. Owner only. */
  | 'user_turn'
  /** A step inside an agent's run. Needs a grant. */
  | 'agent_step'
  /** A scheduled task. Needs a grant that permits background work. */
  | 'scheduled_task'

/** Everything a caller may say about a cognition request. */
export interface CognitionIntent {
  /** Trusted Core cancellation only; narrows authority and never crosses IPC. */
  signal?: AbortSignal
  kind: CognitionIntentKind
  /** The text to send. Held in memory only; never written to an audit event. */
  prompt: string
  /** The ceiling the caller is asking for. Never treated as a default. */
  maxOutputTokens: number
  requestedModel?: string | null
  requestedProviderId?: string | null
  /** Trusted Core routing hint; does not grant authority or alter spend limits. */
  modelCapability?: 'chat' | 'browser'
  goalId?: string | null
  correlationId?: string
  cognitionRequestId?: string
  /**
   * Which owner-created grant to be judged against.
   *
   * This selects an *allowance to check*, and nothing more. It cannot widen
   * anything: the Governor still verifies the grant against the request's
   * derived origin, cause, actor and background flag, and still enforces the
   * call and token ceilings. A caller naming a grant it was not given gets a
   * refusal, exactly as omitting this field and letting nomination fall to a
   * different grant would.
   *
   * It exists because nomination by scanning is ambiguous. One conversation turn
   * per grant means the wrong match is a turn that is charged to somebody else's
   * allowance, and "whichever grant was created first" is not a policy.
   */
  grantId?: string
  /**
   * A pre-compiled instruction set from Core's Context Compiler.
   *
   * Content, not authority: the roles are a closed union chosen by trusted Core
   * code, and the Governor is unaffected by it. When present it is canonical and
   * `prompt` becomes the flattened form of the same content.
   */
  messages?: readonly ModelMessage[]
}

/** What Core derives from an intent. Callers never supply these. */
export interface DerivedRequestShape {
  origin: CognitionOrigin
  cause: CognitionCause
  background: boolean
  userInitiated: boolean
}

/**
 * The kind-to-shape mapping, owned by Core.
 *
 * `user_turn` is the only grantless path in the system, and it is defined here
 * as a fact about a human being present rather than as a claim a caller makes.
 */
export const INTENT_SHAPES: Readonly<Record<CognitionIntentKind, DerivedRequestShape>> = {
  user_turn: { origin: 'user', cause: 'user_message', background: false, userInitiated: true },
  agent_step: { origin: 'agent', cause: 'run_finished', background: true, userInitiated: false },
  scheduled_task: { origin: 'system', cause: 'scheduled_grant', background: true, userInitiated: false },
}

/**
 * The owner: the human running Freya.
 *
 * The only surface with grant governance on it. Holding this object is the
 * authority; there is no capability string that can be passed to acquire it.
 */
export interface OwnerAuthority {
  readonly principalId: 'owner'
  request(intent: CognitionIntent): Promise<CognitionOutcome>
  /**
   * Divide a finite allowance. Guard checks `cognition.grant.manage` before
   * this does anything, and the recorded `createdBy` is this principal — never
   * a value from the spec.
   */
  createGrant(spec: CognitionGrantSpec): Promise<unknown>
  revokeGrant(grantId: string, reason: string): Promise<boolean>
  /** Read-only. There is deliberately no way to mutate a grant in place. */
  grants(): readonly CognitionGrant[]
}

/** A worker may not claim a human is waiting. The type says so. */
export type WorkerIntent = Omit<CognitionIntent, 'kind'> & { kind: 'agent_step' | 'scheduled_task' }

/**
 * A future agent or module.
 *
 * Note what is missing: no `createGrant`, no `revokeGrant`, no `user_turn`, no
 * `actor`. A worker can ask for cognition under a grant it was given. It
 * cannot widen its own budget, and it cannot pretend to be the owner.
 */
export interface WorkerAuthority {
  readonly principalId: string
  request(intent: WorkerIntent): Promise<CognitionOutcome>
}
