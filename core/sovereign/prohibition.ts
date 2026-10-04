import { FORBIDDEN_SOVEREIGNTY_PAYLOAD_KEYS } from './types'

export const NO_REAL_MONEY_STATEMENT =
  'Sovereign Intelligence performs no real-money actions, no real spending and no real financial transactions.'

export const REFUSAL_REASONS = Object.freeze({
  'journal-not-trustworthy': 'The event journal cannot be believed, so no new work is acted on.',
  'stop-all-active': 'Freya is stopped. Nothing proceeds until the owner clears it.',
  'sovereignty-disabled': 'Sovereign Intelligence is switched off.',
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
  'provider-not-approved': 'The provider is not owner-approved.',
  'provider-limit-reached': 'The provider limit has been reached.',
  'plaintext-storage-prohibited': 'Plaintext data storage is prohibited.',
  'integrity-fabrication-prohibited': 'Data integrity fabrication is prohibited.',
  'offline-timeout': 'The offline reasoning session has timed out.',
  'portable-data-limit-reached': 'The portable data limit has been reached.',
  'unknown-operation': 'The operation is not recognized.',
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
])

export interface SovereigntyClaimScan {
  readonly prohibited: boolean
  readonly code: string | null
  readonly reason: string | null
}

export function classifySovereigntyClaim(claim: Record<string, unknown>): SovereigntyClaimScan {
  for (const key of Object.keys(claim)) {
    if (FORBIDDEN_SOVEREIGNTY_PAYLOAD_KEYS.has(key) || ADDITIONAL_FORBIDDEN_KEYS.has(key)) {
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
    (key) => FORBIDDEN_SOVEREIGNTY_PAYLOAD_KEYS.has(key) || ADDITIONAL_FORBIDDEN_KEYS.has(key),
  )
}

export const SOVEREIGNTY_REFUSAL_SUBJECTS = [
  'wake',
  'provider',
  'offline',
  'portable-data',
  'continuation',
] as const

export type SovereigntyRefusalSubject = (typeof SOVEREIGNTY_REFUSAL_SUBJECTS)[number]

export function isSovereigntyRefusalSubject(value: unknown): value is SovereigntyRefusalSubject {
  return (
    typeof value === 'string' && (SOVEREIGNTY_REFUSAL_SUBJECTS as readonly string[]).includes(value)
  )
}

export function refusalSubject(context: string): SovereigntyRefusalSubject {
  if (context === 'wake') return 'wake'
  if (context === 'provider') return 'provider'
  if (context === 'offline') return 'offline'
  if (context === 'portable-data') return 'portable-data'
  return 'continuation'
}
