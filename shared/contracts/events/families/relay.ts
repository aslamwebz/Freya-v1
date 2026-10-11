import type { PrincipalId } from '../../identity'

import type {
  RelayAction,
  RelayConnectorId,
  RelayFailureCode,
  RelayRiskClass,
} from '../vocabulary/relay.ts'

export const RELAY_EVENT_TYPES = [
// Relay (Phase 16) — metadata only, and the family where the target is the
  // most that may be recorded.
  'relay.action.requested',
'relay.approval.requested',
'relay.approval.decided',
'relay.approval.expired',
'relay.action.executed',
'relay.action.failed',
'relay.action.cancelled',
'relay.connector.faulted',
'relay.limits.exceeded',
] as const

export interface RelayEventPayloads {
/* ----------------------------------------------------------------- relay */

  'relay.action.requested': {
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    risk: RelayRiskClass
    idempotencyKey: string
    summary: string
  }

'relay.approval.requested': {
    approvalId: string
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    risk: RelayRiskClass
    summary: string
  }

'relay.approval.decided': {
    approvalId: string
    actionId: string
    decision: 'approved' | 'denied'
    decidedBy: PrincipalId
  }

'relay.approval.expired': {
    approvalId: string
    actionId: string
  }

'relay.action.executed': {
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    outcome: 'read' | 'write'
    resultKind: string
    retries: number
  }

'relay.action.failed': {
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    failureCode: RelayFailureCode
    retries: number
  }

'relay.action.cancelled': {
    actionId: string
    failureCode: RelayFailureCode
  }

'relay.connector.faulted': {
    connector: RelayConnectorId
    reason: string
  }

'relay.limits.exceeded': {
    connector: RelayConnectorId
    action: RelayAction
    limit: string
    observed: number
  }
}