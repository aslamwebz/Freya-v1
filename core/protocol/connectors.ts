/**
 * THE CONNECTOR PROTOCOL — what a window may know about connectors.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a
 * renderer is typed against, one frozen projection for a Core with no connector
 * domain, and the outcome vocabulary of the commands that exist. Nothing here
 * is writable by a window: a window may ask for a status, start an
 * authorization, disconnect a connector, and submit a typed connector action.
 * It may not name a scope, a token, an account, a capability, a budget or a
 * limit.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: connector ids and closed states, a display account label the host
 * assigned, scope *names*, read/write/destructive capability flags, a bounded
 * reason, timestamps, and event metadata (ids, kinds, instants, a measured
 * length).
 *
 * Does not cross: an access token, a refresh token, a client secret, an
 * authorization header, a cookie, a code verifier, a raw provider response, or
 * any event payload.
 */

import type { ConnectorFailureCode, ConnectorKind, ConnectorState } from '../connectors/types'

/* ----------------------------------------------------------------- views */

/** One connector's connection state, as the projection reports it. */
export interface ConnectorConnectionView {
  readonly connector: ConnectorKind
  readonly label: string
  readonly state: ConnectorState
  /** A display label the host assigned. Never a credential. */
  readonly accountLabel: string | null
  /** Why it is in this state, in words a person can act on. */
  readonly reason: string | null
  readonly failureCode: ConnectorFailureCode | null
  /** Whether a read may be attempted right now. */
  readonly read: boolean
  /** Whether a write may be requested right now. */
  readonly write: boolean
  /** Whether a destructive action may be requested right now. */
  readonly destructive: boolean
  readonly scopes: readonly string[]
  readonly lastSuccessAt: string | null
  readonly updatedAt: string | null
  /** Whether Relay holds a pending approval for this connector. */
  readonly pendingApproval: boolean
}

/** One received event, as metadata. Never the event's content. */
export interface ConnectorEventView {
  readonly eventId: string
  readonly connector: ConnectorKind
  readonly kind: string
  readonly receivedAt: string
  readonly accepted: boolean
  readonly reason: string | null
}

/** The ceilings this projection was built under, so a window can show them. */
export interface ConnectorLimitsView {
  readonly maxReadResults: number
  readonly maxEventPayloadChars: number
  readonly maxRecentEvents: number
  readonly authRequestTtlMs: number
  readonly maxRetries: number
  readonly requestTimeoutMs: number
}

/**
 * Everything a window may know about connectors, in one read-only object.
 *
 * A mirror: Core builds it, a window holds what Core last sent, and nothing a
 * window can do writes a field of it. `sequence` lets a window prove *which*
 * Core state it is looking at.
 */
export interface ConnectorProjection {
  readonly health: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly connectors: readonly ConnectorConnectionView[]
  readonly recentEvents: readonly ConnectorEventView[]
  readonly limits: ConnectorLimitsView
}

/* --------------------------------------------------------------- outcome */

export type ConnectorOperation =
  | 'status'
  | 'authorization'
  | 'revoked'
  | 'read'
  | 'pending'
  | 'replayed'
  | 'refused'

/**
 * What a connector command produced.
 *
 * `refused` is an outcome rather than an exception everywhere: a bad connector,
 * a missing grant, a scope the connector does not hold, a stopped Core and a
 * missing secure store all answer in words, and none is papered over. The
 * `result` slot carries the bounded content of one read — and nothing else ever.
 */
export interface ConnectorCommandOutcome {
  readonly operation: ConnectorOperation
  readonly ok: boolean
  /** Why the answer could not be had, in words. Never evidence, never a stack. */
  readonly reason?: string
  /** The connector the command concerned, when one was understood. */
  readonly connector?: ConnectorKind
  /** The closed failure code, when the command was refused. */
  readonly failureCode?: ConnectorFailureCode
  /** The authorization request's id, when one was started. */
  readonly requestId?: string
  /** The authorization URL, when one was started. Never a secret. */
  readonly authorizationUrl?: string
  /** The pending approval's id, when a write is awaiting a decision. */
  readonly approvalId?: string
  /** The action's id, once one exists. */
  readonly actionId?: string
  /** The action's status after the command. */
  readonly status?: string
  /** The event's id, when an event was accepted. */
  readonly eventId?: string
  /** Present on a read. Bounded content lives here. */
  readonly result?: unknown
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no connector domain.
 *
 * `unavailable`, never `ready` with empty lists: "there are no connectors" and
 * "nothing is connected" are different facts, and a surface that rendered the
 * second as the first would be telling a person they have no email when Freya
 * is not listening at all.
 */
export const ABSENT_CONNECTOR_PROJECTION: ConnectorProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a connector domain yet',
  schemaVersion: 1,
  sequence: 0,
  connectors: Object.freeze([]) as readonly ConnectorConnectionView[],
  recentEvents: Object.freeze([]) as readonly ConnectorEventView[],
  limits: Object.freeze({
    maxReadResults: 0,
    maxEventPayloadChars: 0,
    maxRecentEvents: 0,
    authRequestTtlMs: 0,
    maxRetries: 0,
    requestTimeoutMs: 0,
  }),
})

/**
 * The sentence Core reports when nothing has built a connector domain.
 *
 * Exported so the host, the surface and the tests quote the same words instead
 * of paraphrasing the absence into four slightly different claims.
 */
export const NO_CONNECTOR_DOMAIN_REASON =
  'this Core has no connector domain: no connector is configured, and none is simulated'

/** The projection schema this lane speaks. */
export const CONNECTOR_SCHEMA_VERSION = 1

/** The sentence a window gets when a payloadless status read carried something. */
export const CONNECTOR_NO_PAYLOAD =
  'connector.status.read carries no payload: a window may ask what Core reports and may not supply a connector, an action or a capability'
