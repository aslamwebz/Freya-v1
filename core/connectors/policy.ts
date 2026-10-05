/**
 * THE CONNECTOR ACTION POLICY — one closed vocabulary, one authority class,
 * one required scope, one Relay action.
 *
 * This is the join between the connection plane and Relay's action plane. A
 * connector action is a *typed* request a renderer may name; Core translates it
 * to the Relay action that already has a capability, a budget and an approval
 * path. Nothing here executes anything: it is a table.
 *
 * The classification is the point:
 *
 *   - `read` needs the read scope and a readable connection.
 *   - `write` needs the write scope and a readwrite connection, and Relay turns
 *     it into a pending approval.
 *   - `destructive` is separate from `write` on purpose, so a grant that may
 *     create an event is not thereby permitted to cancel one.
 */

import type { RelayAction } from '../relay/types'
import type { ConnectorAuthority, ConnectorKind } from './types'

/**
 * The closed connector-action vocabulary.
 *
 * Deliberately one action per Relay action rather than an explosion of
 * list/search/selected variants: the bounded filter travels in the payload, and
 * the action names the *effect*, not the query shape. A selected-message read
 * is `gmail.read` with an explicit `messageId`, still a read.
 */
export const CONNECTOR_ACTIONS = [
  'gmail.read',
  'gmail.draft.create',
  'gmail.send',
  'drive.read',
  'drive.file.create',
  'calendar.read',
  'calendar.create',
  'calendar.update',
  'calendar.cancel',
  'github.read',
  'github.issue.create',
  'github.pr.create',
  'telegram.read',
  'telegram.send',
] as const
export type ConnectorAction = (typeof CONNECTOR_ACTIONS)[number]

export function isConnectorAction(value: unknown): value is ConnectorAction {
  return typeof value === 'string' && (CONNECTOR_ACTIONS as readonly string[]).includes(value)
}

export interface ConnectorActionPolicy {
  readonly connector: ConnectorKind
  readonly relayAction: RelayAction
  readonly authority: ConnectorAuthority
  /** The scope the grant must carry for this action. */
  readonly scope: string
}

export const CONNECTOR_ACTION_POLICY: Readonly<Record<ConnectorAction, ConnectorActionPolicy>> = Object.freeze({
  'gmail.read': { connector: 'gmail', relayAction: 'email.read', authority: 'read', scope: 'gmail.readonly' },
  'gmail.draft.create': { connector: 'gmail', relayAction: 'email.draft.create', authority: 'write', scope: 'gmail.send' },
  'gmail.send': { connector: 'gmail', relayAction: 'email.send', authority: 'write', scope: 'gmail.send' },

  'drive.read': { connector: 'google-drive', relayAction: 'drive.read', authority: 'read', scope: 'drive.readonly' },
  'drive.file.create': { connector: 'google-drive', relayAction: 'drive.file.create', authority: 'write', scope: 'drive.file' },

  'calendar.read': { connector: 'google-calendar', relayAction: 'calendar.read', authority: 'read', scope: 'calendar.readonly' },
  'calendar.create': { connector: 'google-calendar', relayAction: 'calendar.create', authority: 'write', scope: 'calendar.events' },
  'calendar.update': { connector: 'google-calendar', relayAction: 'calendar.update', authority: 'write', scope: 'calendar.events' },
  'calendar.cancel': { connector: 'google-calendar', relayAction: 'calendar.cancel', authority: 'destructive', scope: 'calendar.events.owned' },

  'github.read': { connector: 'github', relayAction: 'github.read', authority: 'read', scope: 'repo:read' },
  'github.issue.create': { connector: 'github', relayAction: 'github.issue.create', authority: 'write', scope: 'repo:issues.write' },
  'github.pr.create': { connector: 'github', relayAction: 'github.pr.create', authority: 'write', scope: 'repo:pull_requests.write' },

  'telegram.read': { connector: 'telegram', relayAction: 'telegram.read', authority: 'read', scope: 'telegram.chats.read' },
  'telegram.send': { connector: 'telegram', relayAction: 'telegram.send', authority: 'write', scope: 'telegram.messages.send' },
})

export function actionPolicy(action: ConnectorAction): ConnectorActionPolicy {
  return CONNECTOR_ACTION_POLICY[action]
}

/** The actions a connector exposes, in vocabulary order. */
export function actionsForConnector(kind: ConnectorKind): readonly ConnectorAction[] {
  return CONNECTOR_ACTIONS.filter((action) => CONNECTOR_ACTION_POLICY[action].connector === kind)
}

/** Whether an action is a read. Reads execute directly under Relay's gates. */
export function isReadAction(action: ConnectorAction): boolean {
  return CONNECTOR_ACTION_POLICY[action].authority === 'read'
}

/** Whether an action is destructive and therefore separately gated. */
export function isDestructiveAction(action: ConnectorAction): boolean {
  return CONNECTOR_ACTION_POLICY[action].authority === 'destructive'
}
