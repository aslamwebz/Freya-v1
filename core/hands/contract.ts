/**
 * THE HANDS CONTRACT — the typed shapes for action, observation and verification.
 *
 * This file defines the six core types of the Hands domain. Each is deliberately
 * distinct from the others, because collapsing them produces the failure this
 * architecture exists to prevent:
 *
 * - **ActionRequest** is what was *asked for*. It is a request, not an authority.
 * - **ActionRefusal** is why it was *refused*. It carries a closed code, never a repair.
 * - **ActionResult** is what *happened* when the action was attempted. It is not evidence.
 * - **ObservationRecord** is *what came back*. It is evidence, not a conclusion.
 * - **VerificationRequest** is what was *asked to be checked*. It is a request for a verdict.
 * - **VerificationResult** is *whether the intent was satisfied*. It is the only thing that
 *   can close an action as verified.
 *
 * ## What is deliberately absent
 *
 * - **No authority field.** Nothing here is a permission or a grant. Capability possession
 *   does not imply authority.
 * - **No execution.** Nothing here reaches for a browser, desktop, file or process.
 * - **No model-triggered actions.** No field can be set by a model output.
 */

import type {
  HandsActionStatus,
  HandsObservationKind,
  HandsRefusalCode,
  HandsVerificationStatus,
} from './types'

/* --------------------------------------------------------- capability refs */

/**
 * A capability identifier.
 *
 * A simple string alias. The id is opaque — it names a capability this Core
 * knows, and nothing about the id itself implies authority or permission.
 */
export type HandsCapabilityId = string

/**
 * A scoped capability reference.
 *
 * Names a capability *and* the scope it may be used in. A capability id alone
 * is not enough: the same capability may be authorised in one scope and not in
 * another. The scope is opaque — it is a session id, a conversation id, or a
 * surface id, depending on the caller.
 *
 * **Capability possession does not imply authority.** Holding a `HandsScopedCapabilityRef`
 * says nothing about whether the caller may use it. That decision belongs to
 * Guard, which evaluates the capability before any action is attempted.
 */
export interface HandsScopedCapabilityRef {
  readonly capabilityId: HandsCapabilityId
  /** The scope this capability is referenced within. */
  readonly scope: string
}

/* --------------------------------------------------------- action request */

/**
 * A request to perform an action.
 *
 * This is a *request*: every field is validated against the closed tables and
 * the code-owned limits, and a refusal states its code in words.
 *
 * `capabilityRef` names the capability to use and the scope it may be used in.
 * `input` is untrusted and is sanitised before any capability sees it.
 * `timeoutMs` is the wall-clock budget for this action, clamped to
 * `HANDS_LIMITS.maxActionTimeoutMs`.
 */
export interface HandsActionRequest {
  /** Stable id for this action. */
  readonly actionId: string
  readonly capabilityRef: HandsScopedCapabilityRef
  /**
   * The action to perform, in the capability's own vocabulary.
   *
   * A closed string, not free text: a capability defines what actions it
   * accepts, and a request naming an action the capability does not know is
   * refused rather than passed through.
   */
  readonly action: string
  /**
   * Untrusted input for the action.
   *
   * Content, never authority: the same sanitiser that bounds it also refuses
   * functions, symbols and objects with a prototype, so nothing that arrives here
   * can be a capability, a principal or a policy object that was smuggled through
   * a JSON-shaped hole.
   */
  readonly input: Record<string, unknown>
  /**
   * Wall-clock budget for this action, in milliseconds.
   *
   * Clamped to `[1, HANDS_LIMITS.maxActionTimeoutMs]`. A caller may lower the
   * ceiling and may never raise it.
   */
  readonly timeoutMs?: number | null
  /** Correlates this request with the session that caused it. */
  readonly correlationId?: string
}

/* ---------------------------------------------------------- action refusal */

/**
 * Why an action was refused.
 *
 * A refusal is a *terminal* outcome: it is not a failure that can be retried,
 * and it is not a success that can be verified. It carries a closed code and
 * a human-readable reason, and nothing else.
 *
 * **A refusal is not an action result.** The two are distinct types because
 * "the action was refused" and "the action was attempted and failed" are
 * different facts with different consequences.
 */
export interface HandsActionRefusal {
  readonly actionId: string
  readonly code: HandsRefusalCode
  /** Why, in words a person can act on. */
  readonly reason: string
  /** The capability that was refused, if one was named. */
  readonly capabilityId: HandsCapabilityId | null
  /** When the refusal was recorded. */
  readonly refusedAt: string
}

/* ---------------------------------------------------------- action result */

/**
 * The result of an action that was attempted.
 *
 * This is *not* evidence that the action worked. It is a record of what
 * happened: whether it completed, failed, was cancelled, or timed out. Whether
 * the result satisfies the intent is answered by a separate VerificationResult.
 *
 * **An action result is not a verification result.** The two are distinct types
 * because "the action completed" and "the intent was satisfied" are different
 * facts. A completed action may still fail verification.
 */
export interface HandsActionResult {
  readonly actionId: string
  readonly status: HandsActionStatus
  /** When the action was attempted. */
  readonly startedAt: string
  /** When the action reached a terminal state. */
  readonly settledAt: string | null
  /** How long the action took, in milliseconds. */
  readonly durationMs: number | null
  /** Why the action failed, was cancelled, or timed out. */
  readonly reason: string | null
  /** The observation ids produced by this action, if any. */
  readonly observationIds: readonly string[]
}

/* ------------------------------------------------------ observation record */

/**
 * Evidence about what happened during an action.
 *
 * An Observation is *not* a conclusion. It is a bounded record that something
 * was observed, carrying:
 *
 * - **kind** — what kind of evidence it is (result, exit, change, failure, input);
 * - **summary** — a bounded sentence a person can read;
 * - **data** — whatever the verifier needs, never journalled, never projected.
 *
 * **An observation is not an action result.** The action result says what happened;
 * the observation says what was seen. A capability may produce multiple observations,
 * and none of them is a verdict.
 */
export interface HandsObservationRecord {
  readonly observationId: string
  readonly actionId: string
  readonly kind: HandsObservationKind
  /** A bounded sentence a person can read. Kept in memory; never journalled. */
  readonly summary: string
  /** Evidence for the verifier. Never journalled, never projected. */
  readonly data: Record<string, unknown>
  /** When the observation was recorded. */
  readonly recordedAt: string
}

/* ---------------------------------------------------- verification request */

/**
 * A request to verify that an action's intent was satisfied.
 *
 * This is a *request* for a verdict, not the verdict itself. It carries the
 * action result and the observations, and nothing else. The verifier decides
 * whether the intent was satisfied.
 *
 * **A verification request is not a verification result.** The two are distinct
 * types because "the verifier was asked" and "the verifier passed" are different
 * facts.
 */
export interface HandsVerificationRequest {
  readonly verificationId: string
  readonly actionId: string
  /** The action result being verified. */
  readonly actionResult: HandsActionResult
  /** The observations being verified. */
  readonly observations: readonly HandsObservationRecord[]
  /** The verifier to use. A closed name, not a free string. */
  readonly verifier: string
  /** When the verification was requested. */
  readonly requestedAt: string
}

/* ---------------------------------------------------- verification result */

/**
 * Whether the intent was satisfied.
 *
 * This is the *only* thing that can close an action as verified. It is produced
 * by a verifier, not by the action itself, and not by the observation.
 *
 * **A verification result is not an action result.** The action result says what
 * happened; the verification result says whether it worked. A completed action
 * may still fail verification, and a failed action may still pass verification
 * (if the failure was the intended outcome).
 *
 * **It is impossible to mark an action as verified without a verification result.**
 * The type system enforces this: `HandsActionResult` has no `verified` field,
 * and the only way to represent a verified action is through a `HandsVerificationResult`
 * with `status: 'passed'`.
 */
export interface HandsVerificationResult {
  readonly verificationId: string
  readonly actionId: string
  readonly status: HandsVerificationStatus
  /** Why the verifier passed or failed, in words. Null when still requested. */
  readonly reason: string | null
  /** When the verdict was reached. */
  readonly verdictAt: string | null
}
