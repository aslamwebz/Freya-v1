import type { CognitionCause, CognitionOrigin } from '../../security'

import type { PrincipalId } from '../../identity'
export const COGNITION_EVENT_TYPES = [
// Cognition governance
  'cognition.requested',
'cognition.allowed',
'cognition.denied',
'cognition.authorization_required',
'cognition.grant.created',
'cognition.grant.revoked',
'cognition.grant.reserved',
'cognition.grant.usage_reported',
] as const
export interface CognitionEventPayloads {
'cognition.requested': {
    requestId: string
    origin: CognitionOrigin
    cause: CognitionCause
    /** Metadata only. Prompts belong to future conversation storage. */
    maxOutputTokens: number
    requestedModel: string | null
    parentRunId: string | null
    goalId: string | null
  }

// No provider is named here: authorization happens before one is chosen.
  'cognition.allowed': { requestId: string; grantId: string | null }

'cognition.denied': { requestId: string; reason: string; grantId: string | null }

'cognition.authorization_required': { requestId: string; reason: string }

'cognition.grant.created': {
    grantId: string
    createdBy: PrincipalId
    expiresAt: string
    allowedOrigins: CognitionOrigin[]
    allowedCauses: CognitionCause[]
    goalId: string | null
    runId: string | null
    actor: PrincipalId | null
    backgroundAllowed: boolean
    maxCalls: number
    maxOutputTokens: number
  }

'cognition.grant.revoked': { grantId: string; revokedBy: PrincipalId; reason: string }

/**
   * The allowance taken out of the grant's budget, durably, *before* the provider
   * was called. Authorisation arithmetic, not usage: it moves whether or not the
   * call succeeds and whether or not the provider ever answers.
   *
   * Separate from the report below so that neither can overwrite the other. A
   * single event carrying both meant the report replaced the running total with
   * one call's figures.
   */
  'cognition.grant.reserved': {
    grantId: string
    requestId: string
    /** This call's share of the allowance. The reducer adds it to the total. */
    outputTokenBudgetReserved: number
  }

/**
   * What the provider reported for one call. Nulls mean it reported nothing, or
   * only part of it — which the reducer records as an unknown rather than a zero.
   */
  'cognition.grant.usage_reported': {
    grantId: string
    requestId: string
    inputTokens: number | null
    outputTokens: number | null
  }
}