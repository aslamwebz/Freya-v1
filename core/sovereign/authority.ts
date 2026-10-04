import { REFUSAL_REASONS } from './prohibition'
import type { SovereigntyRefusalCode } from './types'

/**
 * The authority gate for sovereignty.
 */

export const SOVEREIGNTY_GUARD_CAPABILITY = 'research.start'

export const SOVEREIGNTY_GATE_CHECKS = [
  'journal-not-trustworthy',
  'stop-all-active',
  'real-money-prohibited',
  'sovereignty-disabled',
  'guard-capability',
  'governor-cognition',
  'budget-remaining',
  'approval-required',
] as const

export type SovereigntyGateCheck = (typeof SOVEREIGNTY_GATE_CHECKS)[number]

export interface SovereigntyAuthorityFacts {
  readonly journalTrustworthy: boolean
  readonly stopAllActive: boolean
  readonly enabled: boolean
  readonly capabilityAllowed: boolean
  readonly cognitionAuthorized: boolean
  readonly budgetRemainingUnits: number
  readonly approvalSatisfied: boolean
  readonly realMoney: boolean
}

export interface SovereigntyGateDenial {
  readonly outcome: 'deny'
  readonly code: SovereigntyRefusalCode
  readonly reason: string
  readonly failedCheck: SovereigntyGateCheck
  readonly cleared: readonly SovereigntyGateCheck[]
}

export interface SovereigntyGateAllowance {
  readonly outcome: 'allow'
  readonly code: 'all-gates-clear'
  readonly reason: string
  readonly cleared: readonly SovereigntyGateCheck[]
}

export type SovereigntyGateOutcome = SovereigntyGateAllowance | SovereigntyGateDenial

export const SOVEREIGNTY_GATE_ALLOWED_REASON =
  'Every gate cleared: the journal is believed, Freya is not stopped, the Guard permits it, the Governor authorized it, there is room left and no approval is outstanding.'

const CHECK_REFUSAL: Readonly<
  Record<SovereigntyGateCheck, { readonly code: SovereigntyRefusalCode; readonly reason: string }>
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
  'sovereignty-disabled': {
    code: 'sovereignty-disabled',
    reason: REFUSAL_REASONS['sovereignty-disabled'],
  },
  'guard-capability': { code: 'guard-denied', reason: REFUSAL_REASONS['guard-denied'] },
  'governor-cognition': { code: 'governor-denied', reason: REFUSAL_REASONS['governor-denied'] },
  'budget-remaining': { code: 'budget-exhausted', reason: REFUSAL_REASONS['budget-exhausted'] },
  'approval-required': { code: 'approval-required', reason: REFUSAL_REASONS['approval-required'] },
})

export function evaluateSovereigntyGate(facts: SovereigntyAuthorityFacts): SovereigntyGateOutcome {
  const cleared: SovereigntyGateCheck[] = []

  for (const check of SOVEREIGNTY_GATE_CHECKS) {
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

  return { outcome: 'allow', code: 'all-gates-clear', reason: SOVEREIGNTY_GATE_ALLOWED_REASON, cleared }
}

function refuses(check: SovereigntyGateCheck, facts: SovereigntyAuthorityFacts): boolean {
  switch (check) {
    case 'journal-not-trustworthy':
      return facts.journalTrustworthy === false
    case 'stop-all-active':
      return facts.stopAllActive === true
    case 'real-money-prohibited':
      return facts.realMoney === true
    case 'sovereignty-disabled':
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

export function blockerForRefusal(code: SovereigntyRefusalCode): string {
  switch (code) {
    case 'journal-not-trustworthy':
      return 'journal-not-trustworthy'
    case 'stop-all-active':
      return 'stop-all-latched'
    case 'sovereignty-disabled':
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
