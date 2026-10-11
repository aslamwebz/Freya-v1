import type { PrincipalId } from './identity'
import type { Capability } from './capabilities'

/* --------------------------------------------------------------- Guard */

export type GuardOutcome = 'allow' | 'deny' | 'approval_required'

export interface GuardDecision {
  outcome: GuardOutcome
  /** The rule that decided it, for the audit trail. */
  reason: string
  capability: Capability
  principal: PrincipalId
}

/* ------------------------------------------------------------ cognition */

export type CognitionOrigin = 'user' | 'goal' | 'workflow' | 'agent' | 'learning' | 'system'

export type CognitionCause =
  | 'user_message'
  | 'user_requested_test'
  | 'explicit_review'
  | 'goal_started'
  | 'run_finished'
  | 'world_changed'
  | 'scheduled_grant'
  | 'learning_consolidation'

export type GovernorOutcome = 'allow' | 'ask' | 'deny'

export interface GovernorDecision {
  outcome: GovernorOutcome
  reason: string
  grantId: string | null
}
