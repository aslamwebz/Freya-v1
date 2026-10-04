import { FORBIDDEN_RESILIENCE_PAYLOAD_KEYS } from './types'

/**
 * Claim classification for resilience.
 *
 * Authority is minted by the Guard and the Governor, and by Core — never by
 * an event. A payload carrying a forbidden key is not a new field, it is an
 * escalation attempt, and it is refused before it can reach the journal.
 */

/**
 * The no-real-money statement.
 */
export const NO_REAL_MONEY_STATEMENT =
  'Resilience & Self-Recovery performs no real-money actions, no real spending and no real financial transactions.'

/**
 * The closed refusal reasons.
 */
export const REFUSAL_REASONS = Object.freeze({
  'journal-not-trustworthy': 'The event journal cannot be believed, so no new work is acted on.',
  'stop-all-active': 'Freya is stopped. Nothing proceeds until the owner clears it.',
  'resilience-disabled': 'Resilience is switched off.',
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
})

/**
 * A claim scan result.
 */
export interface ResilienceClaimScan {
  readonly prohibited: boolean
  readonly code: string | null
  readonly reason: string | null
}

/**
 * Additional forbidden patterns beyond the payload keys.
 */
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
])

/**
 * Classify an untrusted claim.
 *
 * Returns whether the claim is prohibited and why. A claim carrying a
 * forbidden key is refused as a claim.
 */
export function classifyResilienceClaim(claim: Record<string, unknown>): ResilienceClaimScan {
  for (const key of Object.keys(claim)) {
    if (FORBIDDEN_RESILIENCE_PAYLOAD_KEYS.has(key) || ADDITIONAL_FORBIDDEN_KEYS.has(key)) {
      return {
        prohibited: true,
        code: 'authority-claim-prohibited',
        reason: `The claim carries "${key}", which is a forbidden authority shape.`,
      }
    }
  }
  return { prohibited: false, code: null, reason: null }
}

/**
 * Find forbidden keys in a payload.
 */
export function forbiddenKeysIn(payload: Record<string, unknown>): readonly string[] {
  return Object.keys(payload).filter((key) => FORBIDDEN_RESILIENCE_PAYLOAD_KEYS.has(key))
}

/**
 * The closed refusal subjects.
 */
export const RESILIENCE_REFUSAL_SUBJECTS = [
  'wake',
  'recovery',
  'repair',
  'backup',
  'restore',
  'degraded-mode',
  'continuation',
] as const

export type ResilienceRefusalSubject = (typeof RESILIENCE_REFUSAL_SUBJECTS)[number]

export function isResilienceRefusalSubject(value: unknown): value is ResilienceRefusalSubject {
  return (
    typeof value === 'string' && (RESILIENCE_REFUSAL_SUBJECTS as readonly string[]).includes(value)
  )
}

/**
 * The refusal subject for a given context.
 */
export function refusalSubject(context: string): ResilienceRefusalSubject {
  if (context === 'wake') return 'wake'
  if (context === 'recovery') return 'recovery'
  if (context === 'repair') return 'repair'
  if (context === 'backup') return 'backup'
  if (context === 'restore') return 'restore'
  if (context === 'degraded-mode') return 'degraded-mode'
  return 'continuation'
}
