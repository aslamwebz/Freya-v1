import { FORBIDDEN_EVOLUTION_PAYLOAD_KEYS } from './types'

export const NO_REAL_MONEY_STATEMENT =
  'Cognitive Evolution performs no real-money actions, no real spending and no real financial transactions.'

export const REFUSAL_REASONS = Object.freeze({
  'journal-not-trustworthy': 'The event journal cannot be believed, so no new work is acted on.',
  'stop-all-active': 'Freya is stopped. Nothing proceeds until the owner clears it.',
  'evolution-disabled': 'Cognitive Evolution is switched off.',
  'guard-denied': 'The Guard did not permit this capability.',
  'governor-denied': 'The Governor did not authorize this cognition.',
  'budget-exhausted': 'There is no budget remaining for this action.',
  'approval-required': 'This action requires owner approval.',
  'real-money-prohibited': 'Real-money actions are prohibited.',
  'real-order-prohibited': 'Real orders are prohibited.',
  'spending-authority-prohibited': 'Spending authority is prohibited.',
  'capability-widening-prohibited': 'Capability widening is prohibited.',
  'grant-creation-prohibited': 'Grant creation is prohibited.',
  'self-approval-prohibited': 'Self-approval is prohibited.',
  'priority-escalation-prohibited': 'Priority escalation is prohibited.',
  'budget-widening-prohibited': 'Budget widening is prohibited.',
  'authority-claim-prohibited': 'Authority claims are prohibited.',
  'polling-prohibited': 'Continuous polling is prohibited.',
  'inference-without-wake-prohibited': 'Inference without a wake is prohibited.',
  'state-fabrication-prohibited': 'State fabrication is prohibited.',
  'silent-resume-prohibited': 'Silent resume is prohibited.',
  'self-modification-prohibited': 'Self-modification is prohibited.',
  'evidence-fabrication-prohibited': 'Evidence fabrication is prohibited.',
  'unauthorized-improvement-prohibited': 'Unauthorized improvements are prohibited.',
  'drift-detected': 'Authority drift was detected and the improvement was refused.',
  'boundary-violation': 'A protected security boundary was violated.',
  'unknown-operation': 'The operation is not recognized.',
  'invalid-evidence': 'The evidence is malformed or incomplete.',
  'insufficient-evidence': 'The evidence is insufficient to support an improvement.',
  'evidence-expired': 'The evidence has expired.',
  'improvement-bound-reached': 'The improvement bound has been reached.',
  'no-such-improvement': 'No such improvement exists.',
  'illegal-transition': 'The improvement cannot transition to that state.',
  'not-owner': 'Only the owner may perform this action.',
  'store-unavailable': 'The evolution store is unavailable.',
  'store-degraded': 'The evolution store is degraded.',
  'invalid-record': 'The stored record is invalid.',
})

const ADDITIONAL_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'fabricateState',
  'fabricate-state',
  'fakeState',
  'fake-state',
  'hideDegradation',
  'hide-degradation',
  'conceal',
  'suppress',
  'fabricateCapability',
  'fabricate-capability',
  'fakeCapability',
  'fake-capability',
  'pretendCapability',
  'selfModify',
  'self-modify',
  'modifyCode',
  'modify-code',
  'widenCapability',
  'widen-capability',
  'addCapability',
  'add-capability',
  'createGrant',
  'create-grant',
  'silentResume',
  'silent-resume',
  'autoResume',
  'auto-resume',
  'realMoney',
  'realOrder',
  'venue',
  'broker',
  'account',
  'wallet',
  'exchange',
  'selfApprove',
  'self-approve',
  'approve',
  'approved',
  'priority',
  'authority',
  'plaintext',
  'unencrypted',
  'fabricateIntegrity',
  'fabricate-integrity',
  'fakeHash',
  'fake-hash',
  'fabricateEvidence',
  'fabricate-evidence',
  'fakeEvidence',
  'fake-evidence',
])

export interface EvolutionClaimScan {
  readonly prohibited: boolean
  readonly code: string | null
  readonly reason: string | null
}

export function classifyEvolutionClaim(claim: Record<string, unknown>): EvolutionClaimScan {
  for (const key of Object.keys(claim)) {
    if (FORBIDDEN_EVOLUTION_PAYLOAD_KEYS.has(key) || ADDITIONAL_FORBIDDEN_KEYS.has(key)) {
      return {
        prohibited: true,
        code: 'authority-claim-prohibited',
        reason: `The claim carries "${key}", which is a forbidden authority shape.`,
      }
    }
  }
  return { prohibited: false, code: null, reason: null }
}

export function forbiddenKeysIn(payload: Record<string, unknown>): readonly string[] {
  return Object.keys(payload).filter(
    (key) => FORBIDDEN_EVOLUTION_PAYLOAD_KEYS.has(key) || ADDITIONAL_FORBIDDEN_KEYS.has(key),
  )
}
