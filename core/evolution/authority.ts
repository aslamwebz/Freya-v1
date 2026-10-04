import { REFUSAL_REASONS } from './prohibition'
import type { EvolutionRefusalCode } from './types'

/**
 * The authority gate for evolution.
 *
 * Every evolution decision flows through this gate. The gate checks, in order:
 * 1. journal trustworthiness
 * 2. STOP ALL
 * 3. real-money prohibition
 * 4. evolution enabled
 * 5. Guard capability
 * 6. Governor cognition
 * 7. budget remaining
 * 8. approval requirement
 *
 * The precedence is deliberate: an untrustworthy journal outranks everything
 * including a valid owner approval, because a log with a hole in it may have
 * lost the stop that would otherwise apply. STOP ALL outranks an approval,
 * because a latch is not a decision. And Guard outranks the domain rules, so
 * an unauthorised caller never learns whether *its particular* improvement
 * would have been allowed.
 */

export const EVOLUTION_GUARD_CAPABILITY = 'evolution.improve'

export const EVOLUTION_GATE_CHECKS = [
  'journal-not-trustworthy',
  'stop-all-active',
  'real-money-prohibited',
  'evolution-disabled',
  'guard-capability',
  'governor-cognition',
  'budget-remaining',
  'approval-required',
] as const

export type EvolutionGateCheck = (typeof EVOLUTION_GATE_CHECKS)[number]

export interface EvolutionAuthorityFacts {
  readonly journalTrustworthy: boolean
  readonly stopAllActive: boolean
  readonly enabled: boolean
  readonly capabilityAllowed: boolean
  readonly cognitionAuthorized: boolean
  readonly budgetRemainingUnits: number
  readonly approvalSatisfied: boolean
  readonly realMoney: boolean
}

export interface EvolutionGateDenial {
  readonly outcome: 'deny'
  readonly code: EvolutionRefusalCode
  readonly reason: string
  readonly failedCheck: EvolutionGateCheck
  readonly cleared: readonly EvolutionGateCheck[]
}

export interface EvolutionGateAllowance {
  readonly outcome: 'allow'
  readonly code: 'all-gates-clear'
  readonly reason: string
  readonly cleared: readonly EvolutionGateCheck[]
}

export type EvolutionGateOutcome = EvolutionGateAllowance | EvolutionGateDenial

export const EVOLUTION_GATE_ALLOWED_REASON =
  'Every gate cleared: the journal is believed, Freya is not stopped, the Guard permits it, the Governor authorized it, there is room left and no approval is outstanding.'

const CHECK_REFUSAL: Readonly<
  Record<EvolutionGateCheck, { readonly code: EvolutionRefusalCode; readonly reason: string }>
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
  'evolution-disabled': {
    code: 'evolution-disabled',
    reason: REFUSAL_REASONS['evolution-disabled'],
  },
  'guard-capability': { code: 'guard-denied', reason: REFUSAL_REASONS['guard-denied'] },
  'governor-cognition': { code: 'governor-denied', reason: REFUSAL_REASONS['governor-denied'] },
  'budget-remaining': { code: 'budget-exhausted', reason: REFUSAL_REASONS['budget-exhausted'] },
  'approval-required': { code: 'approval-required', reason: REFUSAL_REASONS['approval-required'] },
})

export function evaluateEvolutionGate(facts: EvolutionAuthorityFacts): EvolutionGateOutcome {
  const cleared: EvolutionGateCheck[] = []

  for (const check of EVOLUTION_GATE_CHECKS) {
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

  return { outcome: 'allow', code: 'all-gates-clear', reason: EVOLUTION_GATE_ALLOWED_REASON, cleared }
}

function refuses(check: EvolutionGateCheck, facts: EvolutionAuthorityFacts): boolean {
  switch (check) {
    case 'journal-not-trustworthy':
      return facts.journalTrustworthy === false
    case 'stop-all-active':
      return facts.stopAllActive === true
    case 'real-money-prohibited':
      return facts.realMoney === true
    case 'evolution-disabled':
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

export function blockerForRefusal(code: EvolutionRefusalCode): string {
  switch (code) {
    case 'journal-not-trustworthy':
      return 'journal-not-trustworthy'
    case 'stop-all-active':
      return 'stop-all-latched'
    case 'evolution-disabled':
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
