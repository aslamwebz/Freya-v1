import { REFUSAL_REASONS } from './prohibition'
import type { ResilienceRefusalCode } from './types'

/**
 * The authority gate.
 *
 * Every resilience action passes through {@link evaluateResilienceGate}, and
 * the gate is a total function over a fixed list of facts with a **fixed
 * order of precedence**.
 *
 * ## The precedence, and why it is this order
 *
 * | # | Check | Why here |
 * |---|-------|-----------|
 * | 1 | `journal-not-trustworthy` | Nothing new is acted on. |
 * | 2 | `stop-all-active` | The owner's panic button outranks everything. |
 * | 3 | `real-money-prohibited` | No version of a resilience action becomes permissible because a gate allowed it. |
 * | 4 | `resilience-disabled` | A decision, not a fault. |
 * | 5 | `guard-capability` | Capability before everything that could use it. |
 * | 6 | `governor-cognition` | Authorization before the thing being authorized. |
 * | 7 | `budget-remaining` | There must be room left before work begins. |
 * | 8 | `approval-required` | Last, and deliberately. |
 */

/**
 * The Phase 1 capability every resilience action is gated on.
 */
export const RESILIENCE_GUARD_CAPABILITY = 'research.start'

/** The closed checks, in precedence order. */
export const RESILIENCE_GATE_CHECKS = [
  'journal-not-trustworthy',
  'stop-all-active',
  'real-money-prohibited',
  'resilience-disabled',
  'guard-capability',
  'governor-cognition',
  'budget-remaining',
  'approval-required',
] as const

export type ResilienceGateCheck = (typeof RESILIENCE_GATE_CHECKS)[number]

/**
 * The facts the gate reads.
 */
export interface ResilienceAuthorityFacts {
  readonly journalTrustworthy: boolean
  readonly stopAllActive: boolean
  readonly enabled: boolean
  readonly capabilityAllowed: boolean
  readonly cognitionAuthorized: boolean
  readonly budgetRemainingUnits: number
  readonly approvalSatisfied: boolean
  readonly realMoney: boolean
}

/** A gate that refused. */
export interface ResilienceGateDenial {
  readonly outcome: 'deny'
  readonly code: ResilienceRefusalCode
  readonly reason: string
  readonly failedCheck: ResilienceGateCheck
  readonly cleared: readonly ResilienceGateCheck[]
}

export interface ResilienceGateAllowance {
  readonly outcome: 'allow'
  readonly code: 'all-gates-clear'
  readonly reason: string
  readonly cleared: readonly ResilienceGateCheck[]
}

export type ResilienceGateOutcome = ResilienceGateAllowance | ResilienceGateDenial

/** The sentence an allowance carries. */
export const RESILIENCE_GATE_ALLOWED_REASON =
  'Every gate cleared: the journal is believed, Freya is not stopped, the Guard permits it, the Governor authorized it, there is room left and no approval is outstanding.'

/**
 * Why each check refuses, as a closed mapping.
 */
const CHECK_REFUSAL: Readonly<
  Record<ResilienceGateCheck, { readonly code: ResilienceRefusalCode; readonly reason: string }>
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
  'resilience-disabled': {
    code: 'resilience-disabled',
    reason: REFUSAL_REASONS['resilience-disabled'],
  },
  'guard-capability': { code: 'guard-denied', reason: REFUSAL_REASONS['guard-denied'] },
  'governor-cognition': { code: 'governor-denied', reason: REFUSAL_REASONS['governor-denied'] },
  'budget-remaining': { code: 'budget-exhausted', reason: REFUSAL_REASONS['budget-exhausted'] },
  'approval-required': { code: 'approval-required', reason: REFUSAL_REASONS['approval-required'] },
})

/**
 * Run every gate, in precedence order, and stop at the first refusal.
 */
export function evaluateResilienceGate(facts: ResilienceAuthorityFacts): ResilienceGateOutcome {
  const cleared: ResilienceGateCheck[] = []

  for (const check of RESILIENCE_GATE_CHECKS) {
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

  return { outcome: 'allow', code: 'all-gates-clear', reason: RESILIENCE_GATE_ALLOWED_REASON, cleared }
}

/**
 * Whether one check refuses.
 */
function refuses(check: ResilienceGateCheck, facts: ResilienceAuthorityFacts): boolean {
  switch (check) {
    case 'journal-not-trustworthy':
      return facts.journalTrustworthy === false
    case 'stop-all-active':
      return facts.stopAllActive === true
    case 'real-money-prohibited':
      return facts.realMoney === true
    case 'resilience-disabled':
      return facts.enabled === false
    case 'guard-capability':
      return facts.capabilityAllowed === false
    case 'governor-cognition':
      return facts.cognitionAuthorized === false
    case 'budget-remaining':
      return !(
        typeof facts.budgetRemainingUnits === 'number' &&
        Number.isFinite(facts.budgetRemainingUnits) &&
        facts.budgetRemainingUnits >= 1
      )
    case 'approval-required':
      return facts.approvalSatisfied === false
    default: {
      const exhaustive: never = check
      return exhaustive !== exhaustive
    }
  }
}

/**
 * The blocker a gate denial implies for the projection.
 */
export function blockerForRefusal(code: ResilienceRefusalCode): string {
  switch (code) {
    case 'journal-not-trustworthy':
      return 'journal-not-trustworthy'
    case 'stop-all-active':
      return 'stop-all-latched'
    case 'resilience-disabled':
      return 'stop-all-latched'
    case 'guard-denied':
      return 'guard-denied'
    case 'governor-denied':
      return 'governor-denied'
    case 'budget-exhausted':
      return 'budget-exhausted'
    case 'approval-required':
      return 'approval-required'
    case 'real-money-prohibited':
    case 'real-order-prohibited':
      return 'real-money-prohibited'
    default:
      return 'deadline-expired'
  }
}
