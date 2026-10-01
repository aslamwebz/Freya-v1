/**
 * THE HANDS PROTOCOL — the read-only vocabulary across the seam.
 *
 * This file is everything a window may know about what Freya's hands did. It is
 * types, one frozen absent projection, one pure derivation and a handful of exact
 * checks, and it deliberately contains **no command of any kind**. There is no
 * `hands.submit`, no `hands.execute`, no `hands.request`, and no verb whose name
 * is a mutation. That is not an oversight this lane plans to fill in later — a
 * Hands seam that could accept a submission would be a seam that could name an
 * authority, and the standing ruling in this architecture is that a projection is
 * a *report*, never a handle. Everything the Workforce and Context lanes
 * established holds here: Core builds it, a window holds what Core last sent,
 * and nothing a window can do writes a field of it.
 *
 * ## What this file adds to #35's contract
 *
 * Issue #35 shipped the domain: the vocabulary for capabilities, the six contract
 * types, the Action → Observation → Verification lifecycle and the pure state
 * fold. What it could not ship is a *view*, because a view has to answer a
 * question the domain types deliberately do not: **what should a person be told
 * right now, and what is the evidence for that sentence?** This file is that
 * answer, and it is only ever an answer.
 *
 * ## The one distinction this file exists to hold
 *
 * > An action is not evidence that it worked. An observation is not a success.
 * > Only a separately registered verifier can close a step.
 *
 * So the words are separate at every level, and no word here is reachable by
 * guessing another:
 *
 * - `result` says **what happened**. `observations` say **what came back**.
 *   `verification` says **whether the intent was satisfied**. Three fields, three
 *   facts, each present only when Core recorded it.
 * - `phase` is the one word a surface renders, and it is *derived* from those
 *   facts by `handsPhaseOf` — never asserted by a caller.
 * - **`phase: 'verified'` cannot exist without verifier evidence, and the type
 *   system says so.** `HandsActionView` is a discriminated union whose
 *   `'verified'` arm declares `verification: HandsVerificationView` —
 *   non-nullable, and carrying the verifier's own name — while every other arm
 *   declares `verification: null`. There is no way to write an object literal
 *   claiming an action was verified without handing over the evidence that did
 *   it, and no code path in this repository produces one.
 *
 * ## The words are closed, and three absences are load-bearing
 *
 * `health` has two values and `lane` has two, so a window can tell "there are no
 * Hands" from "Hands exist and are doing nothing". The action `phase` has eight,
 * listed in `HANDS_ACTION_PHASES`, and every one is reachable from state #35 can
 * hold. Three absences are the point of the file:
 *
 * - There is **no `completed` phase.** "Completed" is not a claim that anything
 *   worked, so it is never the word shown to a person. An action that settled
 *   with evidence and no verdict is `'observed'`; one that settled with no
 *   evidence is `'settled'`. Neither says "done".
 * - There is **no `success` phase**, for the same reason, and no field anywhere
 *   named `ok`, `success` or `verified` outside the `'verified'` arm.
 * - There is **no `idle` action phase**, because idle is a fact about the *lane*
 *   and belongs to `HandsLaneState`. An action id that names nothing is not an
 *   idle action; it is absent from the projection.
 *
 * `'failed'` is present for the opposite reason. It is a state #35's lifecycle can
 * reach, and a vocabulary with no word for it would force a surface to redraw a
 * failed attempt as something else. `failed` is *attempted and failed*, which is a
 * different fact from `refused` — something was tried — and from `timed_out`,
 * which is a budget fact rather than an attempt fact.
 *
 * ## What is deliberately absent
 *
 * - **No authority, no capability, no scope.** The view deliberately does *not*
 *   say which capability an action used. A window that could see that could read
 *   it as a standing permission, and this lane will not hand one out by omission.
 *   The only capability id that crosses is the one inside a *refusal*, where
 *   naming it is the refusal's whole content.
 * - **No input, no observation `data`, no page content, no file bytes.** `data`
 *   exists for the verifier and stays behind Core. `summary` is the bounded
 *   display handle and crosses, on the same footing as a Context item's `label`.
 * - **No execution.** Nothing here reaches for a browser, a desktop, a file or a
 *   process. This file cannot perform an action even in principle.
 * - **No module state.** The one value Core owns elsewhere — which verifier
 *   reached a verdict — arrives as a callback on `projectHandsStatus`, so the
 *   derivation stays a pure function and a stale name cannot outlive its Core.
 * - **No wiring.** Nothing in this repository passes a `HandsSource` anywhere.
 *   Core has no `handsSource` option and no `hands()` mirror, and filling that in
 *   means editing `core/index.ts`, which this issue does not claim. The port is
 *   declared, exercised by the tests, and left unfilled on purpose.
 */

import {
  HANDS_ACTION_STATUSES,
  HANDS_LIMITS,
  HANDS_OBSERVATION_KINDS,
  HANDS_REFUSAL_CODES,
  HANDS_VERIFICATION_STATUSES,
  hasExactKeys,
  observationsForAction,
  verificationsForAction,
  type HandsActionStatus,
  type HandsObservationKind,
  type HandsRefusalCode,
  type HandsState,
  type HandsVerificationStatus,
} from '../hands'

/* ------------------------------------------------------------- read-back */

/**
 * Whether a Hands pull got an answer, in this vocabulary.
 *
 * Two operations because there are two facts: Core answered, or the answer could
 * not be had. A pull is not a command — there is no `hands.status.read` in
 * `CoreCommandName`, and adding one belongs to the lane that owns
 * `core/index.ts` and `core-protocol.ts`, not this one. This outcome therefore
 * describes the read itself, and nothing in this file accepts it back.
 *
 * `refused` is here for the same reason it is on every other subsystem's read:
 * "the read was refused" and "Core understood you" are different facts, and a
 * caller that could not tell them apart would report a refusal as a result.
 */
export type HandsReadOperation = 'status' | 'refused'

export interface HandsReadOutcome {
  readonly operation: HandsReadOperation
  readonly ok: boolean
  /** Why the answer could not be had, in words. Never evidence, never a stack. */
  readonly reason?: string
}

/* ----------------------------------------------------------------- views */

/**
 * What happened when an action was attempted.
 *
 * This is the *result* and nothing else. `status` is the contract's own closed
 * table reported verbatim rather than reinterpreted, and every other value is one
 * Core measured.
 *
 * Two fields of `HandsActionResult` deliberately do not cross:
 *
 * - `reason`, because it is free text written by whatever attempted the action,
 *   while every refusal reason in this file is a fixed string Core owns. A view
 *   that mixed the two would let a window quote execution prose as though Core
 *   had endorsed it. `phase` is the honest summary, and it is closed.
 * - `observationIds`, because the view reports the observations themselves, as
 *   `HandsActionView.observations`. Carrying both would be two answers to one
 *   question, free to disagree.
 */
export interface HandsActionResultView {
  readonly status: HandsActionStatus
  /** When the action was attempted. */
  readonly startedAt: string
  /** When it reached a terminal state, or null while it is still in flight. */
  readonly settledAt: string | null
  /** How long it took, in milliseconds. Null until it settles. */
  readonly durationMs: number | null
}

/**
 * What came back while an action ran.
 *
 * An observation is evidence, never a conclusion — so there is no verdict field
 * here, no `ok`, and no word this view uses that a verifier would use. `kind` is
 * the contract's closed table reported verbatim; `result` is not called `success`
 * for the reason given in `core/hands/types.ts`, and it is not renamed here.
 *
 * `summary` is the bounded sentence a person can read, on the same footing as a
 * Context item's `label`: a display handle Core chose. `data` does not cross at
 * all — it exists for the verifier, and a standing copy of it in every window
 * that caches a projection is exactly how evidence becomes ambient content.
 */
export interface HandsObservationView {
  readonly observationId: string
  readonly kind: HandsObservationKind
  readonly summary: string
  /** When the observation was recorded. */
  readonly recordedAt: string
}

/**
 * Whether the intent was satisfied — the only thing that can close a step.
 *
 * `verifier` is the evidence the `'verified'` arm exists to demand: the name of
 * the thing that reached the verdict. A row carrying `phase: 'verified'` and no
 * `verifier` is not representable, and neither is one whose `status` is anything
 * but `'passed'`.
 *
 * `actionId` is absent because this view is nested inside the action it belongs
 * to: the parent already says which action this is, and a second copy of that id
 * is a second thing that could disagree with the first.
 */
export interface HandsVerificationView {
  readonly verificationId: string
  /** The verifier that reached the verdict, in Core's words. */
  readonly verifier: string
  /** `'requested'` means asked and unanswered. Only `'passed'` can verify. */
  readonly status: HandsVerificationStatus
  /** The verifier's own words on the verdict. Null while still requested. */
  readonly reason: string | null
  /** When the verdict was reached, or null while still requested. */
  readonly verdictAt: string | null
}

/**
 * Why an action never happened.
 *
 * A refusal is terminal and it is not a result: the row it appears on carries no
 * `result`, no `observations` and no `verification`, because nothing was attempted
 * and so there is nothing to have observed or to have verified. `code` is the
 * contract's closed table and `reason` is the fixed sentence that code maps to,
 * so a window renders a phrase Core owns rather than one a caller supplied.
 *
 * `capabilityId` crosses here, and only here. Naming the capability a request
 * named *in order to refuse it* is the refusal's whole content; no other view in
 * this file says which capability anything used.
 */
export interface HandsRefusalView {
  readonly code: HandsRefusalCode
  /** Why, in words a person can act on. Fixed by the code, never supplied. */
  readonly reason: string
  /** The capability that was refused, when one was named. */
  readonly capabilityId: string | null
  /** When the refusal was recorded. */
  readonly refusedAt: string
}

/* ----------------------------------------------------------------- phase */

/**
 * Where one action is, in the eight words a surface may render.
 *
 * Closed, and derived: `handsPhaseOf` is the only thing that assigns one, and it
 * reads state rather than being told. Every value is reachable from state #35 can
 * hold, and each says exactly one thing:
 *
 * - `'running'` — attempted, not settled yet. It may already have observations;
 *   partial evidence does not make an in-flight action anything but running.
 * - `'observed'` — settled, evidence came back, **no verifier has ruled**. This is
 *   the word most likely to be misused, so it is worth being exact: an observation
 *   is not a success, and this is not a near-miss for one.
 * - `'settled'` — settled with no evidence to check and no verdict. The separate
 *   word exists so that `'observed'` can mean *observed* and nothing else.
 * - `'verified'` — a separately registered verifier passed. **The only value that
 *   means the intent was satisfied**, and it cannot be written without the
 *   evidence that produced it.
 * - `'refused'` — Core refused before anything was attempted.
 * - `'failed'` — attempted, and it failed. Different from `'refused'` because
 *   something was tried.
 * - `'cancelled'` — stopped by a caller.
 * - `'timed_out'` — ran past the budget it was given.
 */
export const HANDS_ACTION_PHASES = [
  'running',
  'observed',
  'settled',
  'verified',
  'refused',
  'failed',
  'cancelled',
  'timed_out',
] as const
export type HandsActionPhase = (typeof HANDS_ACTION_PHASES)[number]

/** Every phase, paired with the reason a person is shown for it. */
export const HANDS_ACTION_PHASE_REASONS: Readonly<Record<HandsActionPhase, string>> = Object.freeze({
  running: 'attempted, and still in flight',
  observed: 'evidence came back, and no verifier has ruled on it',
  settled: 'it finished, and nothing observed it',
  verified: 'a separately registered verifier confirmed the intent',
  refused: 'Core refused before anything was attempted',
  failed: 'it was attempted, and it failed',
  cancelled: 'stopped by a caller',
  timed_out: 'it ran past the budget it was given',
})

/* ----------------------------------------------------------- action views */

/** Fields every action view carries, whichever arm it is. */
interface HandsActionViewBase {
  /** The action's stable id, as Core recorded it. Never minted by a window. */
  readonly actionId: string
  /** When the action was first attempted. Null when it was never attempted. */
  readonly startedAt: string | null
  /** When it reached a terminal state, or null while it is still in flight. */
  readonly settledAt: string | null
  /** How long it took, in milliseconds. Null until it settles. */
  readonly durationMs: number | null
  /** What came back, oldest first. Empty when nothing was observed. */
  readonly observations: readonly HandsObservationView[]
}

/**
 * The six arms that carry no verdict and no refusal.
 *
 * `running`, `observed`, `settled`, `failed`, `cancelled` and `timed_out` share
 * one shape on purpose: they are all facts about *what happened*, and none of
 * them is a claim about whether the intent was satisfied.
 *
 * `result` is non-null here, and that is another one of the guarantees rather than
 * an accident of typing: an action id reaches this arm only because a result
 * exists, so the *only* rows in this vocabulary that lack a result are refusals —
 * the one case where something genuinely did not happen. There is no third way to
 * be on screen with nothing behind you.
 */
export interface HandsUnverifiedActionView extends HandsActionViewBase {
  readonly phase: 'running' | 'observed' | 'settled' | 'failed' | 'cancelled' | 'timed_out'
  /** What happened. Always present on this arm. */
  readonly result: HandsActionResultView
  /** Always null: nothing on this arm has been verified. */
  readonly verification: null
  /** Always null: these arms are not refusals. */
  readonly refusal: null
}

/**
 * The refused arm. Carries its refusal and nothing else.
 *
 * A refused action has no result, no observations and no verification, and the
 * types say so — including `observations`, which is the empty tuple. The
 * alternative, a refusal recorded *alongside* a result the way a failed execution
 * might be logged next to a refusal reason, is exactly the merge this
 * architecture exists to prevent; here it is not merely discouraged but
 * unrepresentable.
 */
export interface HandsRefusedActionView extends HandsActionViewBase {
  readonly phase: 'refused'
  /** Always null: a refusal is not an action result. */
  readonly result: null
  /** Always empty: nothing ran, so nothing was observed. */
  readonly observations: readonly []
  /** Always null: there is nothing to verify. */
  readonly verification: null
  readonly refusal: HandsRefusalView
}

/**
 * The verified arm. Carries the verification that established it.
 *
 * `verification` is non-nullable *and* is the verifier's own verdict, so this
 * phase's acceptance criterion is a property of the type rather than of a
 * reviewer's attention. There is no construction of this arm that does not hand
 * over the evidence, and no field on it that says "verified" without naming the
 * verifier beside it.
 *
 * `result` stays non-nullable here too, which is why a state claiming an action
 * was verified while holding no verdict at all produces no row: a `verified` arm
 * is only ever built once both things are in hand.
 */
export interface HandsVerifiedActionView extends HandsActionViewBase {
  readonly phase: 'verified'
  /** What happened. */
  readonly result: HandsActionResultView
  /** The evidence the verifier was given, so the verdict reads in context. */
  readonly observations: readonly HandsObservationView[]
  /** The verdict. Cannot be null on this arm. */
  readonly verification: HandsVerificationView
  /** Always null: an action that was verified was not refused. */
  readonly refusal: null
}

/**
 * One action, as a window may know it.
 *
 * A discriminated union on `phase`, so narrowing on the phase is what hands a
 * caller the evidence — and so the impossible states have no spelling. The key
 * set is identical across all three arms (`actionId`, `phase`, `startedAt`,
 * `settledAt`, `durationMs`, `result`, `observations`, `verification`,
 * `refusal`), which is what lets `hasExactHandsActionViewKeys` be one check rather
 * than three.
 */
export type HandsActionView =
  | HandsUnverifiedActionView
  | HandsRefusedActionView
  | HandsVerifiedActionView

/* ------------------------------------------------------------------ lane */

/**
 * Whether the Hands lane is doing anything, in two words.
 *
 * `'idle'` is the lane live with nothing in flight, and it is a real fact — not a
 * synonym for "no Hands". A window reading `lane: 'idle'` alongside
 * `health: 'ready'` knows the domain exists and nothing is running; a window
 * reading `health: 'unavailable'` knows the domain may not exist at all.
 * Collapsing those is how a surface ends up drawing a calm, empty pair of hands
 * that were never built.
 */
export type HandsLaneState = 'idle' | 'running'

/* ---------------------------------------------------------------- counts */

/**
 * Counts derived from the views, by whoever builds them.
 *
 * `actions` is the sum of every phase count, so a surface can check the two
 * against each other rather than trusting either. Zeroes under
 * `health: 'unavailable'` mean "nobody counted", which is a different fact from
 * "there is nothing", and that is why `health` is read first everywhere these are
 * shown.
 */
export interface HandsStatusCounts {
  readonly actions: number
  readonly running: number
  readonly observed: number
  readonly settled: number
  readonly verified: number
  readonly refused: number
  readonly failed: number
  readonly cancelled: number
  readonly timedOut: number
  readonly observations: number
  readonly verifications: number
}

/* -------------------------------------------------------- the projection */

/**
 * Everything a window may know about Hands, in one read-only object.
 *
 * A mirror, in the same sense as Workforce's and Context's: Core builds it, a
 * window holds what Core last sent, and nothing a window can do writes a field of
 * it. `sequence` exists so a window can prove which Core state it is looking at.
 *
 * Note what is *not* here, and why each absence is a decision rather than an
 * oversight:
 *
 * - No `verifiedActionIds`. The per-action `phase` is the report, and a second
 *   flat list of ids is a second answer to "what is verified" that could disagree
 *   with the first. `counts.verified` is a count; the phases are the facts.
 * - No `capabilityId`, no `scope`, no `input`, no observation `data`. See the
 *   header: a view that said which capability an action used would be handing out
 *   something a window could mistake for permission.
 * - No clock. `observedAt` is stamped by whoever builds the projection, never
 *   read from inside this file, so the derivation stays deterministic and every
 *   value in it is one Core recorded.
 */
export interface HandsStatusProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  /** Whether anything is in flight right now. */
  readonly lane: HandsLaneState
  readonly actions: readonly HandsActionView[]
  readonly counts: HandsStatusCounts
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  /** When Core built this projection. Stamped by the builder, not read here. */
  readonly observedAt: string
  /**
   * The code-owned ceilings, reported rather than configurable.
   *
   * A window may lower nothing here, because there is nothing here to change.
   * `maxObservationsPerAction` and `maxVerificationsPerAction` are the two worth
   * having in a view: they tell a reader whether an action's evidence list is
   * bounded, and how.
   */
  readonly limits: typeof HANDS_LIMITS
}

/* ------------------------------------------------------------------ seam */

/**
 * The integration seam Core's Hands domain fills.
 *
 * This is the whole of what this lane assumes about the Hands engine: something,
 * at some point, will be able to hand Core a current `HandsStatusProjection` and
 * optionally tell Core when it changes. A source can be *read*, and that is the
 * entire interface — no mutable state, no engine handle, no authority object, and
 * no method that takes an instruction. It mirrors `ContextSource` and
 * `WorkforceSource` so all three domains plug into Core the same way.
 *
 * **`subscribe` is optional** because a source that only ever changes when Core
 * itself changes needs no channel of its own; Core simply reads it again. Note
 * what a listener receives: a projection and nothing else. A source cannot report
 * an action, ask for one, or say a word about authority, because it has no method
 * that accepts either.
 *
 * **Deferred hookup, stated plainly because the seam is not connected:** nothing
 * in this repository passes a `HandsSource` anywhere. Core has no `handsSource`
 * option, no `hands()` mirror and no `onHands()` channel, and adding them means
 * editing `core/index.ts`, which this issue does not claim. The port is declared,
 * exercised by the tests, and left unfilled on purpose — the same honest absence
 * the Context lane shipped rather than guessing at Core's internals.
 */
export interface HandsSource {
  /** The current view. Called by Core; never by a renderer. */
  projection(): HandsStatusProjection
  /** Follow changes. Returns a disposer. Absent means "read again later". */
  subscribe?(listener: (projection: HandsStatusProjection) => void): () => void
}

/* ---------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has not reported one.
 *
 * `unavailable`, never `ready` with an empty list: "no action has been attempted"
 * and "there is no Hands domain" are different facts, and a surface that rendered
 * the second as the first would be showing a person a calm pair of idle hands that
 * do not exist. `lane` reads `'idle'` for the same reason the other absent
 * projections report empty lists — it is the *least* alarming value, which is
 * exactly why it must never be read before `health`.
 */
export const ABSENT_HANDS_STATUS_PROJECTION: HandsStatusProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported Hands yet',
  lane: 'idle',
  actions: Object.freeze([]) as readonly HandsActionView[],
  counts: Object.freeze({
    actions: 0,
    running: 0,
    observed: 0,
    settled: 0,
    verified: 0,
    refused: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    observations: 0,
    verifications: 0,
  }),
  sequence: 0,
  observedAt: '',
  limits: HANDS_LIMITS,
})

/**
 * The sentence Core reports when nothing has plugged the seam.
 *
 * Exported so a future surface quotes the same words instead of paraphrasing them
 * into a claim about a domain this build does not have. It is a *second* absence
 * on purpose: a window that opened before the first push and a Core that has no
 * Hands domain are different situations and must not read identically.
 */
export const NO_HANDS_DOMAIN_REASON =
  'this Core has no Hands domain: no action has been attempted, and none is simulated'

/**
 * The verifier name a verified row carries when Core recorded none.
 *
 * #35's `HandsVerificationResult` does not retain the verifier — it lives on the
 * request, which the state fold does not keep — so `projectHandsStatus` takes a
 * resolver and falls back to this sentence. The fallback is exported, fixed, and
 * asserted by the tests rather than left to a default, because a verified row
 * whose verifier reads as an empty string is the one hole in this file's central
 * claim: `verified` would then be a word with nothing behind it. Saying "Core did
 * not record which verifier this was" is still a true sentence; saying nothing
 * would not be.
 */
export const UNKNOWN_VERIFIER_NAME = 'Core did not record which verifier this was'

/* -------------------------------------------------------------- deriving */

/**
 * Read one action's phase out of state.
 *
 * The only thing in this file that assigns a phase. It *derives* rather than
 * *asserts*, so a caller cannot hand a projection a word Core did not record, and
 * the precedence below is a fixed argument rather than a habit:
 *
 * 1. **A refusal wins outright.** A refusal means nothing was attempted, so a
 *    verdict attached to the same id could not be about the same thing; if state
 *    somehow carries both, the refusal is the fact and the verdict is noise.
 * 2. **Then a passed verification.** This is the only route to `'verified'`, and
 *    it is read from the verification results and never from the action status.
 *    An action that `completed` and an action that `failed` are both reachable
 *    here — the second is legitimate, because "it failed" is sometimes exactly the
 *    intent.
 * 3. **Then the action's own terminal status**, verbatim, so `cancelled`,
 *    `timed_out` and `failed` mean the contract says they mean.
 * 4. **Then the evidence.** Settled with observations is `'observed'`; settled
 *    without is `'settled'`. The split is what keeps `'observed'` honest.
 * 5. **`'running'` last among the action-derived phases**, because a running
 *    action may already have partial observations and is still, unambiguously,
 *    running.
 *
 * Null for an id that names nothing at all. There is no `'idle'` phase to return
 * here: an id with no state behind it is absent, not idle, and pretending
 * otherwise would put a phantom row in the projection.
 */
export function handsPhaseOf(state: HandsState, actionId: string): HandsActionPhase | null {
  if (state.refusals.has(actionId)) return 'refused'
  if (state.verifiedActions.has(actionId)) return 'verified'

  const result = state.actions.get(actionId)
  if (result === undefined) return null

  switch (result.status) {
    case 'running':
      return 'running'
    case 'cancelled':
      return 'cancelled'
    case 'timed_out':
      return 'timed_out'
    case 'failed':
      return 'failed'
    case 'completed':
      return observationsForAction(state, actionId).length > 0 ? 'observed' : 'settled'
  }
}

/**
 * Build the read-only view of Hands state.
 *
 * A pure fold: no clock, no I/O, no randomness, no execution. The same state
 * always produces the same projection, which is what lets the tests assert on it
 * directly instead of through a running Core.
 *
 * Two arguments are the caller's because they are facts about the *build*, not
 * about the domain:
 *
 * - `observedAt` — the instant Core built this. Inventing one here would be a
 *   clock hidden in a function that claims to be pure, so a caller with no clock
 *   of its own passes `''`, which is what the absent projection does too.
 * - `verifierName` — the one piece of Core's Hands engine this file does not
 *   hold: which verifier reached a given verdict. It arrives as a lookup rather
 *   than as module state, so nothing here can outlive the Core that supplied it,
 *   and a projection built without one still carries `UNKNOWN_VERIFIER_NAME`
 *   rather than a silent blank.
 *
 * Both structural guarantees are enforced here rather than asserted in prose: the
 * `'refused'` arm cannot carry a result, and the `'verified'` arm is only
 * constructed when a passing `HandsVerificationResult` was found to put in it.
 *
 * #35's fold is insert-only — `recordActionResult` refuses to rewrite a record and
 * `recordObservation` refuses to touch a terminal one — so the transitions an
 * engine will need (evidence while running, a terminal status afterwards) have no
 * reducer behind them yet. That is the engine phase's business, and it does not
 * affect this function: the derivation only *reads* state, and a state an engine
 * built by any means at all is reported the same way.
 */
export function projectHandsStatus(
  state: HandsState,
  observedAt: string,
  verifierName?: (verificationId: string) => string | null,
): HandsStatusProjection {
  const actionIds = new Set([...state.actions.keys(), ...state.refusals.keys()])
  const actions: HandsActionView[] = []
  for (const actionId of actionIds) {
    const view = handsActionView(state, actionId, verifierName)
    if (view !== null) actions.push(view)
  }

  let running = 0
  let observed = 0
  let settled = 0
  let verified = 0
  let refused = 0
  let failed = 0
  let cancelled = 0
  let timedOut = 0
  let lane: HandsLaneState = 'idle'
  for (const action of actions) {
    if (action.phase === 'running') lane = 'running'
    switch (action.phase) {
      case 'running':
        running += 1
        break
      case 'observed':
        observed += 1
        break
      case 'settled':
        settled += 1
        break
      case 'verified':
        verified += 1
        break
      case 'refused':
        refused += 1
        break
      case 'failed':
        failed += 1
        break
      case 'cancelled':
        cancelled += 1
        break
      case 'timed_out':
        timedOut += 1
        break
    }
  }

  return {
    health: 'ready',
    reason: null,
    lane,
    actions,
    counts: {
      actions: actions.length,
      running,
      observed,
      settled,
      verified,
      refused,
      failed,
      cancelled,
      timedOut,
      observations: state.observations.size,
      verifications: state.verifications.size,
    },
    sequence: state.sequence,
    observedAt,
    limits: HANDS_LIMITS,
  }
}

/**
 * Build one action's view, or null when the id names nothing at all.
 *
 * The arms are constructed separately rather than filled in and cast, because the
 * cast is exactly where the two guarantees would quietly be lost: `refused` gets
 * no `result`, and `verified` gets a `verification` that was looked up rather
 * than assumed.
 */
function handsActionView(
  state: HandsState,
  actionId: string,
  verifierName?: (verificationId: string) => string | null,
): HandsActionView | null {
  const phase = handsPhaseOf(state, actionId)
  if (phase === null) return null

  const result = state.actions.get(actionId)
  const observations = observationsForAction(state, actionId).map((observation) => ({
    observationId: observation.observationId,
    kind: observation.kind,
    summary: observation.summary,
    recordedAt: observation.recordedAt,
  }))
  const base = {
    actionId,
    startedAt: result?.startedAt ?? null,
    settledAt: result?.settledAt ?? null,
    durationMs: result?.durationMs ?? null,
  }

  if (phase === 'refused') {
    const refusal = state.refusals.get(actionId)
    if (refusal === undefined) return null
    return {
      ...base,
      phase: 'refused',
      result: null,
      observations: [],
      verification: null,
      refusal: {
        code: refusal.code,
        reason: refusal.reason,
        capabilityId: refusal.capabilityId,
        refusedAt: refusal.refusedAt,
      },
    }
  }

  const resultView: HandsActionResultView | null =
    result === undefined
      ? null
      : {
          status: result.status,
          startedAt: result.startedAt,
          settledAt: result.settledAt,
          durationMs: result.durationMs,
        }
  if (resultView === null) return null

  if (phase === 'verified') {
    // The passed result is the evidence, so it is looked up rather than trusted.
    // `verifiedActions` is the domain's own derived set, so the two agree; this
    // re-reads the verdict instead of trusting the flag, which is what makes the
    // arm impossible to build empty.
    const verdict = verificationsForAction(state, actionId).find(
      (candidate) => candidate.status === 'passed',
    )
    if (verdict === undefined) return null
    return {
      ...base,
      phase: 'verified',
      result: resultView,
      observations,
      verification: {
        verificationId: verdict.verificationId,
        verifier: verifierName?.(verdict.verificationId) ?? UNKNOWN_VERIFIER_NAME,
        status: verdict.status,
        reason: verdict.reason,
        verdictAt: verdict.verdictAt,
      },
      refusal: null,
    }
  }

  return {
    ...base,
    phase,
    result: resultView,
    observations,
    verification: null,
    refusal: null,
  }
}

/* ----------------------------------------------------------- exact keys */

/** The exact keys a Hands status projection may carry. */
const HANDS_STATUS_PROJECTION_KEYS: readonly string[] = [
  'health',
  'reason',
  'lane',
  'actions',
  'counts',
  'sequence',
  'observedAt',
  'limits',
]

/** The exact keys any arm of a Hands action view may carry. */
const HANDS_ACTION_VIEW_KEYS: readonly string[] = [
  'actionId',
  'phase',
  'startedAt',
  'settledAt',
  'durationMs',
  'result',
  'observations',
  'verification',
  'refusal',
]

/**
 * Whether a payload carries exactly a Hands status projection's keys.
 *
 * Exact, not permissive: a payload with the right fields *and one more* fails,
 * because the extra field is where a capability, a scope, an owner or an input
 * would arrive. This is the same `hasExactKeys` primitive the contract's own
 * envelope validator uses, reached from the other direction — there it guards
 * what Core admits, here it guards what a host or preload would forward.
 *
 * It checks the key set and nothing else. Deciding whether a payload is also
 * *true* is Core's, and the shape of this check is deliberately incapable of
 * answering that: it can say a projection has its fields, never that a verified
 * row was verified for a real reason.
 */
export function hasExactHandsStatusProjectionKeys(payload: object): boolean {
  return hasExactKeys(payload, HANDS_STATUS_PROJECTION_KEYS)
}

/**
 * Whether a payload carries exactly a Hands action view's keys.
 *
 * One check for all three arms on purpose: the arms share a key set, which is
 * what lets a validator exist at all. If a future arm ever needs a key the others
 * do not have, this check starts failing loudly rather than a caller quietly
 * learning to trust an unchecked shape.
 */
export function hasExactHandsActionViewKeys(payload: object): boolean {
  return hasExactKeys(payload, HANDS_ACTION_VIEW_KEYS)
}

/* ------------------------------------------------------------- the words */

/** Whether a value is one of the eight phases. */
export function isHandsActionPhase(value: unknown): value is HandsActionPhase {
  return typeof value === 'string' && (HANDS_ACTION_PHASES as readonly string[]).includes(value)
}

/** Whether an action status is one Core recorded. */
export function isHandsActionStatus(value: unknown): value is HandsActionStatus {
  return typeof value === 'string' && (HANDS_ACTION_STATUSES as readonly string[]).includes(value)
}

/** Whether an observation kind is one Core recorded. */
export function isHandsObservationKind(value: unknown): value is HandsObservationKind {
  return typeof value === 'string' && (HANDS_OBSERVATION_KINDS as readonly string[]).includes(value)
}

/** Whether a verification status is one Core recorded. */
export function isHandsVerificationStatus(value: unknown): value is HandsVerificationStatus {
  return typeof value === 'string' && (HANDS_VERIFICATION_STATUSES as readonly string[]).includes(value)
}

/** Whether a refusal code is one Core owns. */
export function isHandsRefusalCode(value: unknown): value is HandsRefusalCode {
  return typeof value === 'string' && (HANDS_REFUSAL_CODES as readonly string[]).includes(value)
}

/**
 * Whether a view carries the evidence its phase promises.
 *
 * The check that a boundary would actually run, since the union already makes most
 * of it unrepresentable: a payload arriving from outside is untrusted, and this is
 * how a host asks whether the `verified` arm really did hand over a verdict that
 * passed. It is deliberately narrow — it verifies the *shape of the evidence*, not
 * that the evidence is true, because nothing outside Core can know that.
 */
export function carriesVerifierEvidence(view: HandsActionView): boolean {
  if (view.phase !== 'verified') return false
  const evidence = view.verification
  return evidence.status === 'passed' && evidence.verifier.length > 0
}

/**
 * The exact key sets, exposed for a boundary that has to state them.
 *
 * A host or preload that forwards this projection needs to know the key set in
 * order to check it, and duplicating the list in another file would be the one
 * place it could drift. The values are frozen, and `hasExactKeys` compares against
 * them without copying, so a change here changes every boundary at once.
 */
export const HANDS_STATUS_PROJECTION_KEY_NAMES: readonly string[] = Object.freeze([
  ...HANDS_STATUS_PROJECTION_KEYS,
])

export const HANDS_ACTION_VIEW_KEY_NAMES: readonly string[] = Object.freeze([
  ...HANDS_ACTION_VIEW_KEYS,
])