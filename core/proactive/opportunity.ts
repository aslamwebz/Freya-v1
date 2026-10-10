/**
 * FREYA PROACTIVE INTELLIGENCE — Opportunity & Candidate Actions (Phase 6B)
 *
 * Closed vocabulary for event relevance, opportunity classification,
 * and bounded candidate actions.
 */

import type { OpportunityType } from './types'

export {
  OPPORTUNITY_TYPES,
  type OpportunityType,
  PROACTIVE_CANDIDATE_ACTIONS,
  type ProactiveCandidateAction,
} from './types'

export interface OpportunityClassification {
  readonly type: OpportunityType
  readonly confidence: number
  readonly rationale: string
}
