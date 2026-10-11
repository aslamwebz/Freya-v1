import type { PrincipalId } from '../../identity'
export const GUARD_EVENT_TYPES = [
// Guard
  'guard.decision',
] as const
export interface GuardEventPayloads {
'guard.decision': {
    outcome: 'allow' | 'deny' | 'approval_required'
    reason: string
    capability: string
    /** Never the token, never a secret: a claim, not a credential. */
    principal: PrincipalId
  }
}