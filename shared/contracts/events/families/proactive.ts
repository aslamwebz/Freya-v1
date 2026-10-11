export const PROACTIVE_EVENT_TYPES = [
// Proactive Intelligence (Phase 6) — metadata only.
  'proactive.observation.received',
'proactive.observation.dropped',
'proactive.subscription.updated',
'proactive.relevance.evaluated',
'proactive.decision.made',
] as const
export interface ProactiveEventPayloads {
/* ---------------------------------------------------- proactive intelligence */

  'proactive.observation.received': {
    observationId: string
    sourceType: string
    sourceId: string
    trust: string
    dedupeKey: string
    observedAt: string
    goalId: string | null
    milestoneId: string | null
    evidenceRef: string | null
  }

'proactive.observation.dropped': {
    sourceType: string
    sourceId: string
    dedupeKey: string
    reason: string
  }

'proactive.subscription.updated': {
    subscriptionId: string
    sourceId: string
    active: boolean
    expiresAt: string | null
  }

'proactive.relevance.evaluated': {
    observationId: string
    goalId: string | null
    classification: string
    isRelevant: boolean
    confidence: number
    reasoningApplied: boolean
  }

'proactive.decision.made': {
    decisionId: string
    observationId: string
    decision: string
    level: number
    actionRef: string | null
    reason: string
  }
}