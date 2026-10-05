/**
 * RELAY PROJECTION — the only route from Relay facts to a window.
 *
 * A mirror, in the same sense as every other subsystem's: Core builds it, a
 * window holds what Core last sent, and nothing a window can do writes a field
 * of it. The projection carries connector availability, pending approvals and
 * recent action metadata — and no content. A message body, an event title and
 * an issue's text are not fields here, so they cannot leak through the one
 * object a window is handed.
 */

import type { RelayProjection } from '../protocol/relay'
import {
  RELAY_LIMITS,
  type RelayActionRecord,
  type RelayApprovalRecord,
  type RelayConnectorId,
  type RelayState,
} from './types'
import { pendingApprovals } from './state'

/** The projection schema this lane speaks. */
export const RELAY_SCHEMA_VERSION = 1

export function projectRelay(sequence: number, state: RelayState, statusOf: (connector: RelayConnectorId) => 'ready' | 'unavailable' | 'faulted'): RelayProjection {
  return {
    health: 'ready',
    reason: null,
    schemaVersion: RELAY_SCHEMA_VERSION,
    sequence,
    connectors: (['email', 'calendar', 'github', 'drive', 'telegram', 'external'] as const).map((connector) => ({
      connector,
      status: statusOf(connector),
      label: connectorLabel(connector),
      actions: connectorActions(connector),
      faultReason: state.faulted[connector] ?? null,
    })),
    pendingApprovals: pendingApprovals(state).map(approvalView),
    recentActions: [...state.actions].slice(-RELAY_LIMITS.maxRecentActions).reverse().map(actionView),
    limits: {
      maxActionsPerConnectorPerWindow: RELAY_LIMITS.maxActionsPerConnectorPerWindow,
      maxSendsPerWindow: RELAY_LIMITS.maxSendsPerWindow,
      maxDraftsPerWindow: RELAY_LIMITS.maxDraftsPerWindow,
      maxExternalInvokesPerWindow: RELAY_LIMITS.maxExternalInvokesPerWindow,
      budgetWindowMs: RELAY_LIMITS.budgetWindowMs,
      maxRetries: RELAY_LIMITS.maxRetries,
      maxPendingApprovals: RELAY_LIMITS.maxPendingApprovals,
      approvalTtlMs: RELAY_LIMITS.approvalTtlMs,
    },
  }
}

function connectorLabel(connector: RelayConnectorId): string {
  switch (connector) {
    case 'email':
      return 'Email'
    case 'calendar':
      return 'Calendar'
    case 'github':
      return 'GitHub'
    case 'drive':
      return 'Google Drive'
    case 'telegram':
      return 'Telegram'
    case 'external':
      return 'External connectors'
  }
}

function connectorActions(connector: RelayConnectorId): readonly string[] {
  switch (connector) {
    case 'email':
      return ['email.read', 'email.draft.create', 'email.send']
    case 'calendar':
      return ['calendar.read', 'calendar.create', 'calendar.update', 'calendar.cancel']
    case 'github':
      return ['github.read', 'github.issue.create', 'github.pr.create']
    case 'drive':
      return ['drive.read', 'drive.file.create']
    case 'telegram':
      return ['telegram.read', 'telegram.send']
    case 'external':
      return ['external.invoke']
  }
}

function approvalView(approval: RelayApprovalRecord) {
  return {
    approvalId: approval.approvalId,
    actionId: approval.actionId,
    connector: approval.connector,
    action: approval.action,
    risk: approval.risk,
    summary: approval.summary,
    requestedAt: approval.requestedAt,
  }
}

function actionView(action: RelayActionRecord) {
  return {
    actionId: action.actionId,
    connector: action.connector,
    action: action.action,
    status: action.status,
    risk: action.risk,
    failureCode: action.failureCode,
    retries: action.retries,
    requestedAt: action.requestedAt,
    settledAt: action.settledAt,
  }
}
