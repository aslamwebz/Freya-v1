import { REFUSAL_REASONS } from './prohibition'
import type { EconomicLimitsLike, EconomicRefusalCode } from './types'

/**
 * The authority gate.
 *
 * Every economic action in Phase 32 passes through {@link evaluateEconomicGate}, and
 * the gate is a total function over a fixed list of facts with a **fixed order of
 * precedence**. The order is the whole content of this module, so it is stated here
 * and then enforced by a table rather than by a chain of `if`s that a later edit could
 * reorder by accident.
 *
 * ## The precedence, and why it is this order
 *
 * | # | Check | Why here |
 * |---|-------|-----------|
 * | 1 | `journal-not-trustworthy` | Nothing new is acted on. Corrupt input outranks everything, because every fact below it is read out of that input. |
 * | 2 | `stop-all-active` | The owner's panic button is a latch, not a request, and it outranks every check below it. |
 * | 3 | `real-money-prohibited` | There is no version of an economic action that becomes permissible because a gate allowed it. |
 * | 4 | `economic-disabled` | A decision, not a fault, and it beats doing work that was asked for. |
 * | 5 | `guard-capability` | Capability before everything that could use it. |
 * | 6 | `governor-cognition` | Authorization before the thing being authorized. |
 * | 7 | `budget-remaining` | There must be room left before work begins, not after. |
 * | 8 | `approval-required` | Last, and deliberately: an approval parks work rather than refusing it, so it is the most expensive thing to reach and the least destructive. |
 *
 * The specification's own ordering puts STOP ALL third, after Guard and the Governor.
 * This module puts it second, and the divergence is intentional, inherited from Phase
 * 23's pre-cognition filter, which also checks the latch before it asks whether a model
 * call is worth it. The argument is short: Guard and the Governor answer questions
 * about *this* request, whereas STOP ALL says *no request is being considered at all*.
 * Evaluating a request against a latch that is already closed is work performed after
 * the owner asked for none, and the ordering that would permit it is the one that makes
 * "stop" mean "stop after the current thing finishes".
 *
 * Nothing here can be skipped, and nothing here can be satisfied by the economic
 * subsystem. Every fact is a callback or a value Core supplies from state it already
 * owns; see `ports.ts` for the shape that makes that checkable at compile time.
 */

/**
 * The Phase 1 capability every economic action is gated on.
 *
 * Named here as a literal rather than imported, so `types.ts` and this module stay free
 * of any dependency on Core's protocol — and it is deliberately an **existing**
 * capability rather than a new one.
 *
 * That is a real design statement, not a convenience. The economic subsystem fetches
 * nothing, calls no model, reaches no browser and executes nothing: it turns
 * observations it has already been handed into records. Those observations arrive from
 * research operations that Guard already governs, so gating on `research.start` is
 * honest — economic intelligence is off unless the owner has enabled research — and
 * adding a capability to Phase 1's vocabulary would have been the opposite: this phase
 * widens nothing.
 */
export const ECONOMIC_GUARD_CAPABILITY = 'research.start'

/** The closed checks, in precedence order. Read down; the first refusal wins. */
export const ECONOMIC_GATE_CHECKS = [
  'journal-not-trustworthy',
  'stop-all-active',
  'real-money-prohibited',
  'economic-disabled',
  'guard-capability',
  'governor-cognition',
  'budget-remaining',
  'approval-required',
] as const

export type EconomicGateCheck = (typeof ECONOMIC_GATE_CHECKS)[number]

/**
 * The facts the gate reads. All of them already-authorized readings from Core.
 *
 * There is no field here that could widen anything: booleans that report what is true,
 * and one number that reports how much room is left. Nothing in this shape is a
 * request, a capability, a grant, a verdict or an outcome.
 */
export interface EconomicAuthorityFacts {
  /** Whether the journal can be believed. False means nothing new is acted on. */
  readonly journalTrustworthy: boolean
  /** The STOP ALL latch, read fresh at every gate. */
  readonly stopAllActive: boolean
  /** Whether the subsystem is switched on at all. Off means every action is denied. */
  readonly enabled: boolean
  /** The Guard's verdict on {@link ECONOMIC_GUARD_CAPABILITY}, already decided by Core. */
  readonly capabilityAllowed: boolean
  /** The Governor's answer for this action, already decided by Core. */
  readonly cognitionAuthorized: boolean
  /**
   * Bounded units of economic work still available.
   *
   * **Not money.** Phase 32 has no money, so this cannot be a currency budget and is
   * never converted into one. It is the count of bounded economic steps this process
   * may still take, and its ceiling is a code-owned limit. Naming it "units" rather
   * than "budget" in the wire shape is deliberate: a field called `budget` in an
   * economic subsystem is exactly the sort of thing a later lane would try to fill with
   * a number of pounds.
   */
  readonly budgetRemainingUnits: number
  /** Whether an owner approval this action requires has been given. */
  readonly approvalSatisfied: boolean
  /**
   * Whether the request is asking for real money.
   *
   * Always `false` for anything this subsystem builds. It exists because the fact has
   * to be *read from the request* rather than assumed, so that a hostile request which
   * somehow arrived with a real-money shape is refused by the gate and not merely
   * ignored by the type system.
   */
  readonly realMoney: boolean
}

/** A gate that refused. One code, one sentence, and the checks that had already passed. */
export interface EconomicGateDenial {
  readonly outcome: 'deny'
  readonly code: EconomicRefusalCode
  readonly reason: string
  /** The check that refused. */
  readonly failedCheck: EconomicGateCheck
  /** Every check cleared before it, in order. Written rather than inferred. */
  readonly cleared: readonly EconomicGateCheck[]
}

export interface EconomicGateAllowance {
  readonly outcome: 'allow'
  readonly code: 'all-gates-clear'
  readonly reason: string
  readonly cleared: readonly EconomicGateCheck[]
}

export type EconomicGateOutcome = EconomicGateAllowance | EconomicGateDenial

/** The sentence an allowance carries. Fixed, so four readers quote the same words. */
export const ECONOMIC_GATE_ALLOWED_REASON =
  'Every gate cleared: the journal is believed, Freya is not stopped, the Guard permits it, the Governor authorized it, there is room left and no approval is outstanding.'

/**
 * Why each check refuses, as a closed mapping.
 *
 * A table rather than a switch so that a check added without a sentence fails to
 * compile at the type level instead of producing `undefined` in an owner-visible
 * surface at runtime.
 */
const CHECK_REFUSAL: Readonly<
  Record<EconomicGateCheck, { readonly code: EconomicRefusalCode; readonly reason: string }>
> = Object.freeze({
  'journal-not-trustworthy': {
    code: 'journal-not-trustworthy',
    reason: REFUSAL_REASONS['journal-not-trustworthy'],
  },
  'stop-all-active': { code: 'stop-all-active', reason: REFUSAL_REASONS['stop-all-active'] },
  'real-money-prohibited': {
    code: 'real-money-prohibited',
    reason: REFUSAL_REASONS['real-money-prohibited'],
  },
  'economic-disabled': { code: 'economic-disabled', reason: REFUSAL_REASONS['economic-disabled'] },
  'guard-capability': { code: 'guard-denied', reason: REFUSAL_REASONS['guard-denied'] },
  'governor-cognition': { code: 'governor-denied', reason: REFUSAL_REASONS['governor-denied'] },
  'budget-remaining': { code: 'budget-exhausted', reason: REFUSAL_REASONS['budget-exhausted'] },
  'approval-required': { code: 'approval-required', reason: REFUSAL_REASONS['approval-required'] },
})

/**
 * Run every gate, in precedence order, and stop at the first refusal.
 *
 * Total, pure and side-effect-free: same facts in, same answer out, and the answer
 * names the *first* thing that was wrong. That matters more here than in most places,
 * because the whole point is that an owner reading the journal can see exactly which
 * gate said no and therefore what would have to change for it to say yes.
 *
* Every check is evaluated, in order, and the cleared prefix is returned whether or not
 * the run was allowed — so a denial is auditable as "three gates cleared and then the
 * budget ran out", not merely as "denied".
 */
export function evaluateEconomicGate(facts: EconomicAuthorityFacts): EconomicGateOutcome {
  const cleared: EconomicGateCheck[] = []

  for (const check of ECONOMIC_GATE_CHECKS) {
    // A plain boolean test, deliberately. `refuses` answers "did this check stop it?", and
    // writing that as `!== null` would invert the meaning of every gate at once.
    if (refuses(check, facts)) {
      const entry = CHECK_REFUSAL[check]
      return {
        outcome: 'deny',
        code: entry.code,
        reason: entry.reason,
        failedCheck: check,
        cleared,
      }
    }
    cleared.push(check)
  }

  return { outcome: 'allow', code: 'all-gates-clear', reason: ECONOMIC_GATE_ALLOWED_REASON, cleared }
}

/**
 * Whether one check refuses. Pure, and takes no argument a caller could bend.
 *
 * Split out so the table above is the only place the precedence lives, and so the
 * audit in `tests/core/economic/authority.test.ts` can prove the order without reading
 * a loop.
 */
function refuses(check: EconomicGateCheck, facts: EconomicAuthorityFacts): boolean {
  switch (check) {
    case 'journal-not-trustworthy':
      return facts.journalTrustworthy === false
    case 'stop-all-active':
      return facts.stopAllActive === true
    case 'real-money-prohibited':
      return facts.realMoney === true
    case 'economic-disabled':
      return facts.enabled === false
    case 'guard-capability':
      return facts.capabilityAllowed === false
    case 'governor-cognition':
      return facts.cognitionAuthorized === false
    case 'budget-remaining':
      // Must be a finite number *strictly above zero*. Three failures in one expression,
      // and each of them is a real way for a bound to stop existing: `NaN` passes a naive
      // `< 0` test, `0` means "nothing left" and must refuse, and a negative count is
      // nonsense that would otherwise read as "a long way from the ceiling".
      return !(typeof facts.budgetRemainingUnits === 'number' && Number.isFinite(facts.budgetRemainingUnits) && facts.budgetRemainingUnits >= 1)
    case 'approval-required':
      return facts.approvalSatisfied === false
    default: {
      // Unreachable: `check` is narrowed to the closed set above.
      const exhaustive: never = check
      return exhaustive !== exhaustive
    }
  }
}

/**
 * The blocker a gate denial implies for the projection.
 *
 * The projection needs to say *why* an experiment is stuck, and a gate refusal is the
 * most common reason. Mapping here rather than in the projection keeps the one closed
 * vocabulary in one file and means a future gate cannot add a refusal without also
 * deciding what the owner is shown.
 */
export function blockerForRefusal(code: EconomicRefusalCode): string {
  switch (code) {
    case 'journal-not-trustworthy':
      return 'journal-not-trustworthy'
    case 'stop-all-active':
      return 'stop-all-latched'
    case 'economic-disabled':
      return 'stop-all-latched'
    case 'guard-denied':
      return 'guard-denied'
    case 'governor-denied':
      return 'governor-denied'
    case 'budget-exhausted':
      return 'budget-exhausted'
    case 'approval-required':
      return 'approval-required'
    case 'attempt-ceiling-reached':
      return 'attempt-ceiling-reached'
    case 'real-money-prohibited':
    case 'real-order-prohibited':
      return 'real-money-prohibited'
    default:
      return 'deadline-expired'
  }
}

/**
 * The units one economic action costs, by stage.
 *
 * A cost rather than a flat unit so that "the budget ran out" is a useful sentence. It
 * is also the *only* place in Phase 32 where a number of anything is multiplied by
 * something else, which is worth stating plainly: there is no cost model here because
 * there is nothing being purchased.
 */
export const STAGE_UNIT_COST = Object.freeze({
  IDLE: 0,
  RESEARCHING: 1,
  SIMULATING: 2,
  PAPER_TRADING: 1,
  ANALYZING: 1,
  COMPLETE: 0,
  FAILED: 0,
} as const)

/**
 * The total unit allowance for a process.
 *
 * Derived from the ceilings rather than invented, so raising a limit cannot leave the
 * unit budget behind: more scenarios allowed means more units allowed, in proportion.
 * That coupling is deliberate — a limit that could be raised without raising what it
 * costs would be a limit on paper.
 */
export function totalUnitAllowance(limits: EconomicLimitsLike): number {
  return (
    limits.maxExperiments *
    (limits.maxScenariosPerExperiment * STAGE_UNIT_COST.SIMULATING +
      limits.maxEvidencePerExperiment * STAGE_UNIT_COST.RESEARCHING +
      limits.maxPaperOrdersPerExperiment * STAGE_UNIT_COST.PAPER_TRADING +
      limits.maxMetricsPerExperiment * STAGE_UNIT_COST.ANALYZING)
  )
}