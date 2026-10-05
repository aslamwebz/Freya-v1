/**
 * THE CONNECTOR CATALOG — the five providers this build describes.
 *
 * Each definition names the provider, the Relay connector its actions map to,
 * the account kind, and the **explicit minimal scopes** each authority class
 * needs. The scope lists are the whole of "no silent scope upgrade": a grant is
 * checked against them, and an authorization event that names a scope outside
 * the catalog is refused rather than stored.
 *
 * The labels are provider-native where the provider has a real scope identifier
 * (Google, GitHub) and policy labels where it does not (Telegram bot tokens
 * carry no OAuth scopes). In both cases the label is a closed-shape string,
 * never a token and never a URL with a secret in it.
 */

import type { RelayConnectorId } from '../relay/types'
import type { ConnectorAuthority, ConnectorKind } from './types'

export interface ConnectorDefinition {
  readonly kind: ConnectorKind
  readonly label: string
  /** The Relay connector this provider's actions map to. */
  readonly relayConnector: RelayConnectorId
  /** `oauth` providers complete a redirect flow; `token` providers take a key. */
  readonly accountKind: 'oauth' | 'token'
  /** Scopes a read requires. */
  readonly readScopes: readonly string[]
  /** Scopes a routine write requires. */
  readonly writeScopes: readonly string[]
  /** Scopes a destructive action requires, separately gated. */
  readonly destructiveScopes: readonly string[]
}

export const CONNECTOR_CATALOG: Readonly<Record<ConnectorKind, ConnectorDefinition>> = Object.freeze({
  gmail: {
    kind: 'gmail',
    label: 'Gmail',
    relayConnector: 'email',
    accountKind: 'oauth',
    readScopes: ['gmail.readonly'],
    writeScopes: ['gmail.send'],
    destructiveScopes: ['gmail.modify'],
  },
  'google-drive': {
    kind: 'google-drive',
    label: 'Google Drive',
    relayConnector: 'drive',
    accountKind: 'oauth',
    readScopes: ['drive.readonly'],
    writeScopes: ['drive.file'],
    destructiveScopes: [],
  },
  'google-calendar': {
    kind: 'google-calendar',
    label: 'Google Calendar',
    relayConnector: 'calendar',
    accountKind: 'oauth',
    readScopes: ['calendar.readonly'],
    writeScopes: ['calendar.events'],
    destructiveScopes: ['calendar.events.owned'],
  },
  github: {
    kind: 'github',
    label: 'GitHub',
    relayConnector: 'github',
    accountKind: 'token',
    readScopes: ['repo:read'],
    writeScopes: ['repo:issues.write', 'repo:pull_requests.write'],
    destructiveScopes: [],
  },
  telegram: {
    kind: 'telegram',
    label: 'Telegram',
    relayConnector: 'telegram',
    accountKind: 'token',
    readScopes: ['telegram.chats.read'],
    writeScopes: ['telegram.messages.send'],
    destructiveScopes: [],
  },
})

export function connectorDefinition(kind: ConnectorKind): ConnectorDefinition {
  return CONNECTOR_CATALOG[kind]
}

/**
 * Every scope the catalog knows for a connector.
 *
 * Used to refuse an authorization that names a scope the build does not
 * recognize. A grant cannot widen itself by asserting a scope string.
 */
export function knownScopes(kind: ConnectorKind): readonly string[] {
  const definition = CONNECTOR_CATALOG[kind]
  return [...definition.readScopes, ...definition.writeScopes, ...definition.destructiveScopes]
}

/** The scopes a given authority class needs, from the catalog. */
export function scopesForAuthority(kind: ConnectorKind, authority: ConnectorAuthority): readonly string[] {
  const definition = CONNECTOR_CATALOG[kind]
  switch (authority) {
    case 'read':
      return definition.readScopes
    case 'write':
      return definition.writeScopes
    case 'destructive':
      return definition.destructiveScopes
  }
}

/**
 * Whether a grant holds every scope an authority needs.
 *
 * `read` is the floor: a grant that can write can read, because the write
 * scopes are a superset of the read intent in every provider here. This is
 * about *permission to act*, not about silently upgrading: a read action still
 * checks the read scope, and a grant that names only the write scope without
 * the read scope is refused the read rather than granted it.
 */
export function grantCovers(
  granted: readonly string[],
  required: readonly string[],
): boolean {
  if (required.length === 0) return true
  const held = new Set(granted)
  return required.every((scope) => held.has(scope))
}

/** Whether a grant carries any write or destructive scope. */
export function grantIsReadwrite(kind: ConnectorKind, granted: readonly string[]): boolean {
  const definition = CONNECTOR_CATALOG[kind]
  return grantCovers(granted, definition.writeScopes) || grantCovers(granted, definition.destructiveScopes)
}
