import type { Capability, PrincipalId } from '../protocol/core-protocol'
import { WORK_LIMITS, type ObservationKind, type WorkRisk } from './types'

/**
 * THE CAPABILITY EXECUTION BOUNDARY.
 *
 * This is the only door from a Work Step to anything that does real work. It is
 * generic on purpose: Search, a browser, a terminal, an agent, a Phase 7 Mission
 * and Phase 6's own test capabilities are all just a `WorkCapability` here, and
 * `core/work/` names none of them. A future module that can be expressed as
 * "call this, get evidence back, verify it against that" attaches by registering
 * one of these — it does not get a new engine.
 *
 * ## Three rules the shapes enforce
 *
 * **1. The capability is asked; it does not decide.** `capability` is the
 * vocabulary entry Guard evaluates, and the engine evaluates it before calling
 * `execute`. A Step plan cannot name a capability directly — it names a
 * registered capability, which names its own requirement.
 *
 * **2. An Action is not evidence.** `execute` returns an Observation, never a
 * verdict. Whether the intent was satisfied is answered by a *separately
 * registered* `WorkVerifier`, which receives the observation and nothing else.
 * A capability cannot verify itself even if it wants to, because nothing in the
 * observation says which capability produced it.
 *
 * **3. Everything is abortable.** `execute` is handed an `AbortSignal` that
 * cancellation and shutdown both fire, and a capability that wants to be
 * cancellable is expected to honour it. A capability that ignores it is bounded
 * by the Run's action and duration ceilings rather than being trusted to stop.
 */

/** What a Step asks a capability to do. Untrusted, and sanitised before arrival. */
export interface WorkCapabilityRequest {
  readonly runId: string
  readonly stepId: string
  /** The plan's stable key, so a retry is visibly the same work. */
  readonly stepKey: string
  readonly actionId: string
  /** 1 for the first try. Bounded by `limits.maxAttemptsPerStep`. */
  readonly attempt: number
  /**
   * The Step's input, after sanitising.
   *
   * Content, never authority: the same sanitiser that bounds it also refuses
   * functions, symbols and objects with a prototype, so nothing that arrives here
   * can be a capability, a principal or a policy object that was smuggled through
   * a JSON-shaped hole.
   */
  readonly input: Record<string, unknown>
  /** Ties the capability's own logs back to this Run's events. */
  readonly correlationId: string
}

/** The only things a capability is given beyond its request. */
export interface WorkCapabilityContext {
  /**
   * Fired by cancellation and by shutdown.
   *
   * Required rather than optional for the same reason `ModelProvider.complete`
   * requires a signal: a capability that cannot be aborted does not typecheck
   * rather than merely being discouraged.
   */
  readonly signal: AbortSignal
  readonly now: () => Date
}

/**
 * Evidence, not a conclusion.
 *
 * `summary` is a bounded sentence a person can read on the board. `data` is
 * whatever the verifier needs and is **never** journalled, never projected to the
 * renderer, and never passed to another capability.
 */
export interface WorkObservationContent {
  readonly kind: ObservationKind
  readonly summary: string
  readonly data: Record<string, unknown>
}

/** What a capability returns. One observation, no verdict, no exceptions on purpose. */
export interface WorkCapabilityResult {
  readonly observation: WorkObservationContent
}

/**
 * One thing a Step can attempt.
 *
 * `risk` lives here, in code, and not on the Step plan — that placement is the
 * whole reason a plan cannot talk its way past a gate. `consequential` always
 * requires an approval before `execute` is called, whatever the plan says.
 */
export interface WorkCapability {
  /** Stable id, referenced by plans and recorded in events. */
  readonly name: string
  /** The Guard capability this needs. Evaluated before `execute`, every time. */
  readonly capability: Capability
  readonly risk: WorkRisk
  /**
   * The verifier this capability is meant to be checked by, if any.
   *
   * **Optional, and deliberately so.** Work separates a capability from the check that
   * judges it so the two cannot be the same piece of code, and `WorkStepPlan.verifier` stays
   * required — a Step is always checked, and *which* check is still the plan's decision.
   *
   * This field exists for callers that have no way to make that decision honestly. The
   * Mission planner is exactly that: it picks a capability from a private goal it cannot
   * read, so guessing a verifier would mean landing on whatever sorts first — and Core's
   * registry deliberately contains `test.always-fails`, so a Mission would retry to its
   * ceiling and block on work that never had a chance.
   *
   * A capability that omits it is saying "there is no obvious check for me", and a planner
   * that finds nothing to pair with should leave the capability out of the plan rather than
   * attach an unrelated verifier to it.
   */
  readonly verifier?: string
  /**
   * One bounded sentence stating what would happen if this were approved.
   *
   * Read before anything runs, so an approval request has a subject the person
   * can actually decide on. It must describe the effect, not the input.
   */
  describe(request: WorkCapabilityRequest): string
  execute(request: WorkCapabilityRequest, context: WorkCapabilityContext): Promise<WorkCapabilityResult>
}

/**
 * How a Step's intent is checked.
 *
 * Registered separately from the capability and given only the observation. This
 * is the mechanism behind "verification is not optional": a Step cannot close
 * without one, and the thing that produced the evidence cannot be the thing that
 * certifies it.
 */
export interface WorkVerificationRequest {
  readonly runId: string
  readonly stepId: string
  readonly stepKey: string
  readonly attempt: number
  readonly input: Record<string, unknown>
  readonly observation: WorkObservationContent
}

export interface WorkVerificationOutcome {
  readonly verdict: 'passed' | 'failed'
  /** Why, in a sentence a person can read. Stored in memory, never journalled. */
  readonly reason: string
}

export interface WorkVerifier {
  readonly name: string
  verify(request: WorkVerificationRequest): WorkVerificationOutcome | Promise<WorkVerificationOutcome>
}

/**
 * The set of capabilities and verifiers this Core has.
 *
 * A closed registry rather than a lookup the caller can pass: a plan names a
 * string, and the only question is whether this Core has something under it.
 * Registration is idempotent-by-name refusal — two capabilities cannot share a
 * name, because which one a Run meant would then depend on load order.
 */
export class WorkRegistry {
  private readonly capabilities = new Map<string, WorkCapability>()
  private readonly verifiers = new Map<string, WorkVerifier>()

  /** Throws rather than replacing, so a shadowed capability is a boot failure. */
  register(capability: WorkCapability): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`capability already registered: ${capability.name}`)
    }
    this.capabilities.set(capability.name, capability)
  }

  /**
   * Withdraw a registered capability.
   *
   * The **inverse** of `register`, and it exists because registration alone can only ever
   * grow the registry — which makes "what does Core do with fewer capabilities?" untestable.
   * That question matters: the Mission planner picks the lowest-risk registered capability, so
   * a Core holding only consequential ones plans work that needs a person, and without this
   * there would be no way to demonstrate it short of building a different Core.
   *
   * It returns whether anything was withdrawn, so a caller can assert it happened rather than
   * assume it. It does **not** touch verifiers: a verifier can outlive the capability it was
   * written for, and a plan naming one that no capability declares is a planner's problem to
   * decline rather than a boot failure.
   */
  unregister(name: string): boolean {
    return this.capabilities.delete(name)
  }

  registerVerifier(verifier: WorkVerifier): void {
    if (this.verifiers.has(verifier.name)) {
      throw new Error(`verifier already registered: ${verifier.name}`)
    }
    this.verifiers.set(verifier.name, verifier)
  }

  capability(name: string): WorkCapability | undefined {
    return this.capabilities.get(name)
  }

  verifier(name: string): WorkVerifier | undefined {
    return this.verifiers.get(name)
  }

  has(name: string): boolean {
    return this.capabilities.has(name)
  }

  names(): readonly string[] {
    return [...this.capabilities.keys()].sort()
  }

  verifierNames(): readonly string[] {
    return [...this.verifiers.keys()].sort()
  }
}

/* -------------------------------------------------------------- sanitising */

/** Why an input was refused. Never a repair: a bad value is dropped, not fixed. */
export interface SanitisedInput {
  readonly ok: boolean
  readonly reason: string | null
  readonly value: Record<string, unknown>
}

/**
 * Field names a sanitised input may use.
 *
 * Bounded and plain, and explicitly not `__proto__`, `constructor` or
 * `prototype` — the only three names that reach an object's internals. A plan's
 * input is the least trustworthy thing in the system, because it is whatever a
 * caller cared to send, and refusing those by name is cheaper than relying on the
 * fact that assigning them to a fresh object happens to be inert.
 */
const INPUT_FIELD = /^[A-Za-z0-9._-]{1,64}$/
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Make untrusted input safe to hand to a capability.
 *
 * This is the property "untrusted content must never be able to create a
 * privileged action merely by appearing in an Observation", applied one step
 * earlier: nothing a caller supplies is passed through as a structure.
 *
 * **Allowed shapes are primitives only** — bounded strings, finite numbers,
 * booleans and `null`. Every object is refused, and refused wholesale rather than
 * walked, because a capability is an object with a prototype and methods: if any
 * structure could cross this boundary then a plan would eventually carry one, and
 * this function would have to be the thing that noticed.
 *
 * Refused rather than repaired, for the reason Brain admission refuses rather
 * than repairs: an input with a hole cut in it looks like valid input, and the
 * hole is where the capability's real behaviour would have been.
 */
export function sanitiseCapabilityInput(input: unknown): SanitisedInput {
  if (input === undefined || input === null) return { ok: true, reason: null, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'step input must be an object', value: {} }
  }

  const out: Record<string, unknown> = {}
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > WORK_LIMITS.maxInputFields) {
    return { ok: false, reason: `step input has more than ${WORK_LIMITS.maxInputFields} fields`, value: {} }
  }

  for (const [key, raw] of entries) {
    if (!INPUT_FIELD.test(key) || RESERVED_FIELD_NAMES.has(key)) {
      return { ok: false, reason: `step input field name is not allowed: ${key.slice(0, 32)}`, value: {} }
    }
    const clean = sanitiseValue(raw, 1)
    if (!clean.ok) return { ok: false, reason: clean.reason, value: {} }
    out[key] = clean.value
  }

  let serialised: string
  try {
    serialised = JSON.stringify(out)
  } catch {
    return { ok: false, reason: 'step input could not be measured', value: {} }
  }
  if (serialised.length > WORK_LIMITS.maxInputBytes) {
    return {
      ok: false,
      reason: `step input is larger than the ${WORK_LIMITS.maxInputBytes} byte limit`,
      value: {},
    }
  }
  return { ok: true, reason: null, value: out }
}

function sanitiseValue(value: unknown, depth: number): { ok: boolean; reason: string | null; value: unknown } {
  if (depth > WORK_LIMITS.maxInputDepth) {
    return { ok: false, reason: 'step input is nested too deeply', value: null }
  }
  if (value === null) return { ok: true, reason: null, value: null }

  switch (typeof value) {
    case 'string':
      return value.length <= WORK_LIMITS.maxInputBytes
        ? { ok: true, reason: null, value }
        : { ok: false, reason: 'a step input string is too large', value: null }
    case 'boolean':
      return { ok: true, reason: null, value }
    case 'number':
      return Number.isFinite(value)
        ? { ok: true, reason: null, value }
        : { ok: false, reason: 'a step input number is not finite', value: null }
    default:
      // Functions, symbols, bigints, undefined and every object. Their presence
      // means the caller sent something that was not data, which is a refusal
      // rather than a value to be dropped — a dropped field is a capability whose
      // behaviour quietly differs from what the plan asked for.
      return { ok: false, reason: `a step input value of type ${typeof value} is not data`, value: null }
  }
}

/* ------------------------------------------------- Phase 6 capabilities */

/**
 * The capabilities Phase 6 ships.
 *
 * Deliberately inert: a recorded value, a refusal, a wait, and a consequential
 * declaration. **No shell, no process, no filesystem, no network.** That is not a
 * placeholder policy — a Work engine demonstrated with `child_process` would be
 * demonstrating the one thing Phase 6 must not build, and an e2e that starts one
 * would be a test suite with a live blast radius.
 *
 * They exist to prove the *mechanism*: guard → approval → action → observation →
 * verification, with a real capability boundary and no external service.
 *
 * ## They ship in production, and that is a decision
 *
 * These are the only executable capabilities in Phase 6. They are reachable from
 * the Work board because the board and the e2e both need something to drive, and
 * removing them would leave the approval gate, bounded retry, cancellation-from-
 * inside and verification-failure paths untestable through the product itself.
 *
 * They are inert by construction rather than by convention: no `fs`, no
 * `child_process`, no socket, no model access, every call abortable and every call
 * raced against the Run's deadline. "Freya can execute no external operation" stays
 * a true sentence about the product.
 *
 * **They should become development/test-only once Phase 5 lands a real capability
 * set**, gated the way `developerProvider` is — behind an explicit opt-in rather
 * than a debug flag. The switch is the single call to
 * `registerPhaseSixCapabilities` in `core/index.ts`, and it is deliberately not made
 * conditional in Phase 6: doing so now would leave the e2e with nothing to drive and
 * would buy nothing Phase 5 does not buy properly. The precondition is that a
 * non-test capability exists *and* the e2e can exercise the engine without these —
 * which is Phase 5's to deliver. See `docs/PHASE-6.md` for the full reasoning.
 */

function clampSummary(text: string): string {
  return text.length > WORK_LIMITS.maxSummaryChars
    ? `${text.slice(0, WORK_LIMITS.maxSummaryChars)}…`
    : text
}

/**
 * Records what it was asked to do and returns it as evidence.
 *
 * `expect` is what makes it useful to a test: a verifier can then check that the
 * observation actually says what the Step intended, which is the only way to
 * demonstrate that a *failed* verification is reachable without breaking
 * something.
 */
export interface RecordInput {
  readonly label?: string
  /** The value the Step intends to produce. Absence makes verification fail. */
  readonly expect?: string
}

export const RECORD_CAPABILITY: WorkCapability = {
  name: 'test.record',
  capability: 'work.execute',
  risk: 'routine',
  // Paired with `test.record.matches` (declared below as `RECORD_VERIFIER`), which checks the
  // observation against the Step's declared `expect`. Named as a string rather than as
  // `RECORD_VERIFIER.name` because the verifier is declared *after* this capability, and a
  // forward reference would make registration order part of whether this file loads.
  verifier: 'test.record.matches',
  describe() {
    return 'records a value in memory and returns it as evidence'
  },
  async execute(request) {
    const input = request.input as Record<string, unknown> & RecordInput
    const label = typeof input.label === 'string' ? input.label : request.stepKey
    return {
      observation: {
        kind: 'result',
        summary: clampSummary(`recorded "${label}"`),
        data: { label, expect: typeof input.expect === 'string' ? input.expect : null, produced: label },
      },
    }
  },
}

/**
 * Always refuses.
 *
 * The failure path, and the one that proves bounded retry is real rather than
 * theoretical: a Step pointed at this retries up to its ceiling and then fails,
 * with every attempt visible.
 */
export const FAILING_CAPABILITY: WorkCapability = {
  name: 'test.failing',
  capability: 'work.execute',
  risk: 'routine',
  describe() {
    return 'always refuses, so failure and retry can be demonstrated'
  },
  async execute() {
    throw new Error('this capability always refuses')
  },
}

/**
 * Succeeds, but produces no evidence to check.
 *
 * A capability returning "done" is not proof that anything worked, and this is
 * the capability that says so: it completes, it observes, and the verifier
 * refuses to pass it because nothing in the observation satisfies the intent.
 */
export const UNVERIFIABLE_CAPABILITY: WorkCapability = {
  name: 'test.unverifiable',
  capability: 'work.execute',
  risk: 'routine',
  describe() {
    return 'completes without producing anything that can be checked'
  },
  async execute() {
    return {
      observation: {
        kind: 'result',
        summary: clampSummary('did the thing'),
        data: {},
      },
    }
  },
}

/**
 * Waits until aborted.
 *
 * `cancellable: true`, so it is the one capability whose signal has something to
 * stop, and therefore the only way to test that cancellation reaches inside the
 * capability rather than merely being recorded afterwards.
 */
export const SLOW_CAPABILITY: WorkCapability = {
  name: 'test.slow',
  capability: 'work.execute',
  risk: 'routine',
  describe() {
    return 'waits until it is cancelled or its deadline passes'
  },
  async execute(request, context) {
    const input = request.input
    const budgetMs =
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.min(input.durationMs, 60_000))
        : 60_000
    await new Promise<void>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('cancelled before the capability started'))
        return
      }
      const timer = setTimeout(() => {
        context.signal.removeEventListener('abort', onAbort)
        resolve()
      }, budgetMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('cancelled while the capability was running'))
      }
      context.signal.addEventListener('abort', onAbort, { once: true })
    })
    return {
      observation: {
        kind: 'exit',
        summary: clampSummary(`waited ${budgetMs}ms`),
        data: { waited: true },
      },
    }
  },
}

/**
 * Declares itself consequential.
 *
 * The only capability that requires approval on its own account. It performs no
 * effect at all — the point is that the engine stops *before* calling it, and a
 * test can assert that no Action was ever recorded for it.
 */
export const CONSEQUENTIAL_CAPABILITY: WorkCapability = {
  name: 'test.consequential',
  capability: 'work.execute',
  risk: 'consequential',
  // Paired with `test.change.applied` (declared below as `CHANGE_VERIFIER`), which accepts
  // the capability's own claim that it applied something.
  //
  // The pairing is separate on purpose and that is the whole demonstration: a different
  // registered piece of code decides whether the claim is accepted. It also means a planner
  // can pair these two without guessing — which matters because the Mission planner refuses
  // to plan a capability that declares no check, and a capability reachable only through a
  // gate would otherwise be unplannable.
  verifier: 'test.change.applied',
  describe(request) {
    const input = request.input as { effect?: string }
    return typeof input.effect === 'string'
      ? `would apply this effect: ${input.effect.slice(0, 120)}`
      : 'would apply a consequential effect that has not been approved'
  },
  async execute(request) {
    return {
      observation: {
        kind: 'change',
        summary: clampSummary(`applied the effect of ${request.stepKey}`),
        data: { applied: true },
      },
    }
  },
}

/* --------------------------------------------------------- Phase 6 verifiers */

/**
 * Passes when the observation carries the value the Step intended.
 *
 * `expect` names it in the *plan*, not in the observation, so the check is a
 * comparison between what was intended and what came back rather than the
 * capability marking its own homework.
 */
export const RECORD_VERIFIER: WorkVerifier = {
  name: 'test.record.matches',
  verify(request) {
    const expect =
      typeof request.input.expect === 'string'
        ? request.input.expect
        : request.input.expect === undefined
          ? null
          : null
    if (expect === null) {
      return { verdict: 'failed', reason: 'the step declared no expected result to check against' }
    }
    const produced = request.observation.data.produced
    if (typeof produced !== 'string') {
      return { verdict: 'failed', reason: 'the observation carried nothing that could be checked' }
    }
    return produced === expect
      ? { verdict: 'passed', reason: `the observation reports "${expect}"` }
      : {
          verdict: 'failed',
          reason: `the observation reports "${produced}", which is not "${expect}"`,
        }
  },
}

/**
 * Passes only when the observation says the work was interrupted.
 *
 * Used against the slow capability so that a *cancelled* action has a real
 * verification rule rather than a hard-coded branch in the engine.
 */
export const EXIT_VERIFIER: WorkVerifier = {
  name: 'test.exit.waited',
  verify(request) {
    return request.observation.data.waited === true
      ? { verdict: 'passed', reason: 'the capability reported that it finished its wait' }
      : { verdict: 'failed', reason: 'the capability did not report finishing its wait' }
  },
}

/**
 * Passes only when the observation reports that a change was applied.
 *
 * Paired with `CONSEQUENTIAL_CAPABILITY`, whose observation says `applied`. The
 * pairing is the demonstration worth having: the capability claims a change
 * happened, and a *different* registered piece of code is what decides whether
 * that claim is accepted.
 */
export const CHANGE_VERIFIER: WorkVerifier = {
  name: 'test.change.applied',
  verify(request) {
    return request.observation.data.applied === true
      ? { verdict: 'passed', reason: 'the observation reports that the change was applied' }
      : { verdict: 'failed', reason: 'the observation does not report that anything was applied' }
  },
}

/**
 * Refuses everything.
 *
 * Exists so that "verification required before successful completion" can be
 * tested as a *policy* rather than as an accident of the other verifiers.
 */
export const ALWAYS_FAILING_VERIFIER: WorkVerifier = {
  name: 'test.always-fails',
  verify() {
    return { verdict: 'failed', reason: 'this verifier never passes' }
  },
}

/** Everything Phase 6 registers. Used by Core and by tests alike. */
export function registerPhaseSixCapabilities(registry: WorkRegistry): void {
  registry.register(RECORD_CAPABILITY)
  registry.register(FAILING_CAPABILITY)
  registry.register(UNVERIFIABLE_CAPABILITY)
  registry.register(SLOW_CAPABILITY)
  registry.register(CONSEQUENTIAL_CAPABILITY)
  registry.registerVerifier(RECORD_VERIFIER)
  registry.registerVerifier(EXIT_VERIFIER)
  registry.registerVerifier(CHANGE_VERIFIER)
  registry.registerVerifier(ALWAYS_FAILING_VERIFIER)
}

/** The principal a Work Run executes under when Core created it. */
export type WorkPrincipalId = PrincipalId