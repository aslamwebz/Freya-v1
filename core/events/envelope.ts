import type { CognitionCause, CognitionOrigin, PrincipalId } from '../protocol/core-protocol'

/**
 * The durable Core event envelope.
 *
 * Every event Core records has this shape, permanently. The envelope is what
 * makes replay, correlation and audit possible; the payload is what may change.
 *
 * Two rules hold for the whole of Core:
 *   - an event becomes visible to subscribers only after its append succeeds;
 *   - replay never appends, never publishes, and never causes a side effect.
 */

export const CORE_EVENT_SCHEMA_VERSION = 1

/** Event types. Grouped by the subsystem that owns them. */
export const CORE_EVENT_TYPES = [
  // Lifecycle
  'core.started',
  'core.ready',
  'core.degraded',
  'core.stopping',
  'core.stopped',

  // Commands arriving from the user
  'command.received',

  // Guard
  'guard.decision',
  'security.stop_all.activated',
  'security.stop_all.cleared',

  // Cognition governance
  'cognition.requested',
  'cognition.allowed',
  'cognition.denied',
  'cognition.authorization_required',
  'cognition.grant.created',
  'cognition.grant.revoked',
  'cognition.grant.consumed',

  // Model execution
  'model.request.started',
  'model.request.completed',
  'model.request.failed',
] as const

export type CoreEventType = (typeof CORE_EVENT_TYPES)[number]

export interface CoreEventEnvelope<T extends CoreEventType = CoreEventType> {
  eventId: string
  /** Monotonic per Core lifetime, and after replay, across the whole log. */
  sequence: number
  type: T
  schemaVersion: number
  occurredAt: string

  source: 'core' | 'renderer' | 'system'
  actor: PrincipalId

  /** Ties related events together across subsystems. */
  correlationId: string
  /** The event that caused this one. */
  causationId: string | null

  payload: CoreEventPayloads[T]
}

/** The payload each event type carries. */
export interface CoreEventPayloads {
  'core.started': { version: string; storeKind: string; recoveredSequence: number }
  'core.ready': Record<string, never>
  'core.degraded': { reason: string }
  'core.stopping': { reason: string }
  'core.stopped': { durationMs: number }

  'command.received': {
    /** The user's text. This is the one place user content is durable. */
    text: string
    length: number
  }

  'guard.decision': {
    outcome: 'allow' | 'deny' | 'approval_required'
    reason: string
    capability: string
    /** Never the token, never a secret: a claim, not a credential. */
    principal: PrincipalId
  }

  'security.stop_all.activated': { by: PrincipalId; reason: string }
  'security.stop_all.cleared': { by: PrincipalId }

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
  'cognition.grant.consumed': {
    grantId: string
    requestId: string
    callsUsed: number
    inputTokens: number | null
    outputTokens: number | null
  }

  'model.request.started': {
    requestId: string
    grantId: string | null
    providerId: string
    model: string
    maxOutputTokens: number
  }
  'model.request.completed': {
    requestId: string
    providerId: string
    model: string
    inputTokens: number | null
    outputTokens: number | null
  }
  'model.request.failed': {
    requestId: string
    providerId: string
    reason: string
  }
}

/**
 * Every Core event, as a discriminated union.
 *
 * The mapping matters: it is what lets `Extract<Event, { type: T }>['payload']`
 * resolve to the payload of one specific event type rather than to a union of
 * every payload in the system.
 */
export type AnyCoreEvent = {
  [K in CoreEventType]: CoreEventEnvelope<K>
}[CoreEventType]

/** Events that change durable security or governance state. */
export const SECURITY_EVENT_TYPES: readonly CoreEventType[] = [
  'guard.decision',
  'security.stop_all.activated',
  'security.stop_all.cleared',
  'cognition.grant.created',
  'cognition.grant.revoked',
  'cognition.grant.consumed',
]

export function isSecurityEvent(type: CoreEventType): boolean {
  return SECURITY_EVENT_TYPES.includes(type)
}
