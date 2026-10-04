import { FORBIDDEN_THRESHOLD_PAYLOAD_KEYS } from './types'

/**
 * Claim classification for threshold.
 *
 * Authority is minted by the Guard and the Governor, and by Core — never by
 * an event. A payload carrying a forbidden key is not a new field, it is an
 * escalation attempt, and it is refused before it can reach the journal.
 */

/**
 * The no-real-money statement.
 */
export const NO_REAL_MONEY_STATEMENT =
  'The Mature Freya Threshold performs no real-money actions, no real spending and no real financial transactions.'

/**
 * The closed refusal reasons.
 */
export const REFUSAL_REASONS = Object.freeze({
  'journal-not-trustworthy': 'The event journal cannot be believed, so no new work is acted on.',
  'stop-all-active': 'Freya is stopped. Nothing proceeds until the owner clears it.',
  'threshold-disabled': 'The threshold subsystem is switched off.',
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
  'maturity-self-grant-prohibited': 'Maturity self-grant is prohibited.',
  'maturity-authority-widening-prohibited': 'Maturity authority widening is prohibited.',
  'assessment-attempt-ceiling-reached': 'The assessment attempt ceiling has been reached.',
  'evidence-collection-attempt-ceiling-reached': 'The evidence collection attempt ceiling has been reached.',
  'evaluation-attempt-ceiling-reached': 'The evaluation attempt ceiling has been reached.',
  'unknown-dimension': 'Unknown maturity dimension.',
  'unknown-criterion': 'Unknown maturity criterion.',
  'unknown-evidence': 'Unknown evidence.',
  'unknown-assessment': 'Unknown assessment.',
  'unknown-rollback': 'Unknown rollback.',
  'assessment-already-active': 'An assessment is already active.',
  'evidence-already-collected': 'Evidence has already been collected.',
  'concurrent-assessment-limit': 'The concurrent assessment limit has been reached.',
  'deadline-expired': 'The deadline has expired.',
  'interrupted': 'The operation was interrupted.',
})

/**
 * A claim scan result.
 */
export interface ThresholdClaimScan {
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
  'selfGrantMaturity',
  'self-grant-maturity',
  'grantMaturity',
  'grant-maturity',
  'maturityWidensAuthority',
  'maturity-widens-authority',
  'fabricateEvidence',
  'fabricate-evidence',
  'fakeEvidence',
  'fake-evidence',
  'inference',
  'polling',
  'hiddenReasoning',
  'hidden-reasoning',
  'unrestrictedLoop',
  'unrestricted-loop',
  'idleModelCall',
  'idle-model-call',
  'backgroundReasoning',
  'background-reasoning',
  'hiddenDurableState',
  'hidden-durable-state',
  'hiddenState',
  'hidden-state',
])

/**
 * Classify an untrusted claim.
 *
 * Returns whether the claim is prohibited and why. A claim carrying a
 * forbidden key is refused as a claim.
 */
export function classifyThresholdClaim(claim: Record<string, unknown>): ThresholdClaimScan {
  for (const key of Object.keys(claim)) {
    if (FORBIDDEN_THRESHOLD_PAYLOAD_KEYS.has(key) || ADDITIONAL_FORBIDDEN_KEYS.has(key)) {
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
  return Object.keys(payload).filter((key) => FORBIDDEN_THRESHOLD_PAYLOAD_KEYS.has(key))
}

/**
 * The closed refusal subjects.
 */
export const THRESHOLD_REFUSAL_SUBJECTS = [
  'wake',
  'assessment',
  'evidence',
  'evaluation',
  'decision',
  'rollback',
  'continuation',
] as const

export type ThresholdRefusalSubject = (typeof THRESHOLD_REFUSAL_SUBJECTS)[number]

export function isThresholdRefusalSubject(value: unknown): value is ThresholdRefusalSubject {
  return (
    typeof value === 'string' && (THRESHOLD_REFUSAL_SUBJECTS as readonly string[]).includes(value)
  )
}

/**
 * The refusal subject for a given context.
 */
export function refusalSubject(context: string): ThresholdRefusalSubject {
  if (context === 'wake') return 'wake'
  if (context === 'assessment') return 'assessment'
  if (context === 'evidence') return 'evidence'
  if (context === 'evaluation') return 'evaluation'
  if (context === 'decision') return 'decision'
  if (context === 'rollback') return 'rollback'
  return 'continuation'
}
