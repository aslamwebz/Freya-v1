import {
  RESILIENCE_WAKE_KIND_SOURCE,
  RESILIENCE_WAKE_SOURCE_ACTOR,
  isResilienceWakeSource,
  isResilienceWakeKind,
  isResilienceWakeActor,
  type ResilienceWakeSource,
  type ResilienceWake,
  type ResilienceWakeRefusalCode,
} from './types'

/**
 * Wake validation for resilience.
 *
 * A wake is an authorized event that says *look at this now*. It is not a
 * model call, it is not permission, and it is not work.
 */

/**
 * The closed reasons a wake was refused.
 */
export const RESILIENCE_WAKE_REFUSAL_REASONS: Readonly<
  Record<ResilienceWakeRefusalCode, string>
> = Object.freeze({
  'unknown-source': 'That is not a source a wake may arrive on.',
  'unknown-kind': 'That is not a wake kind.',
  'kind-source-mismatch': 'The wake kind does not match its source.',
  'unauthorized-actor': 'The actor is not authorized to raise this wake source.',
  'missing-wake-id': 'The wake has no id.',
  'malformed-timestamp': 'The wake timestamp is malformed.',
  'observed-before-occurred': 'The wake was observed before it occurred.',
  'stop-all-active': 'Freya is stopped.',
  'journal-not-trustworthy': 'The journal cannot be believed.',
  'duplicate-wake': 'This wake has already been processed.',
  'runtime-busy': 'The resilience runtime is busy.',
  'runtime-closed': 'The resilience runtime has been shut down.',
  'polling-prohibited': 'Continuous polling is prohibited.',
})

/**
 * Why a wake was refused.
 */
export function wakeRefusalReason(code: ResilienceWakeRefusalCode): string {
  return RESILIENCE_WAKE_REFUSAL_REASONS[code]
}

/**
 * The wake validation context.
 */
export interface ResilienceWakeContext {
  readonly now: string
  readonly stopAllActive: boolean
  readonly journalTrustworthy: boolean
  readonly processedWakeKeys: readonly string[]
  readonly busy: boolean
  readonly closed: boolean
}

/**
 * The wake validation outcome.
 */
export type ResilienceWakeValidationOutcome =
  | { readonly outcome: 'accepted'; readonly wake: ResilienceWake; readonly wakeKey: string }
  | {
      readonly outcome: 'denied'
      readonly code: ResilienceWakeRefusalCode
      readonly reason: string
    }

/**
 * Compute the dedupe key for a wake.
 */
export function resilienceWakeDedupeKey(wake: {
  readonly source: string
  readonly kind: string
  readonly sourceRef: string | null
}): string {
  return `${wake.source}:${wake.kind}:${wake.sourceRef ?? ''}`
}

/**
 * Validate a wake request.
 */
export function validateResilienceWake(
  request: {
    readonly source: string
    readonly kind: string
    readonly actor: string
    readonly goalRef?: string | null
    readonly sourceRef?: string | null
    readonly occurredAt: string
  },
  wakeId: string,
  context: ResilienceWakeContext,
): ResilienceWakeValidationOutcome {
  const { now, stopAllActive, journalTrustworthy, processedWakeKeys, busy, closed } = context

  if (closed) {
    return { outcome: 'denied', code: 'runtime-closed', reason: wakeRefusalReason('runtime-closed') }
  }
  if (busy) {
    return { outcome: 'denied', code: 'runtime-busy', reason: wakeRefusalReason('runtime-busy') }
  }
  if (!journalTrustworthy) {
    return {
      outcome: 'denied',
      code: 'journal-not-trustworthy',
      reason: wakeRefusalReason('journal-not-trustworthy'),
    }
  }
  if (stopAllActive) {
    return {
      outcome: 'denied',
      code: 'stop-all-active',
      reason: wakeRefusalReason('stop-all-active'),
    }
  }

  if (!isResilienceWakeSource(request.source)) {
    return {
      outcome: 'denied',
      code: 'unknown-source',
      reason: wakeRefusalReason('unknown-source'),
    }
  }
  if (!isResilienceWakeKind(request.kind)) {
    return {
      outcome: 'denied',
      code: 'unknown-kind',
      reason: wakeRefusalReason('unknown-kind'),
    }
  }

  const expectedSource = RESILIENCE_WAKE_KIND_SOURCE[request.kind]
  if (expectedSource !== request.source) {
    return {
      outcome: 'denied',
      code: 'kind-source-mismatch',
      reason: wakeRefusalReason('kind-source-mismatch'),
    }
  }

  if (!isResilienceWakeActor(request.actor)) {
    return {
      outcome: 'denied',
      code: 'unauthorized-actor',
      reason: wakeRefusalReason('unauthorized-actor'),
    }
  }

  const expectedActor = RESILIENCE_WAKE_SOURCE_ACTOR[request.source]
  if (request.actor !== expectedActor) {
    return {
      outcome: 'denied',
      code: 'unauthorized-actor',
      reason: wakeRefusalReason('unauthorized-actor'),
    }
  }

  if (!wakeId || wakeId.length === 0) {
    return {
      outcome: 'denied',
      code: 'missing-wake-id',
      reason: wakeRefusalReason('missing-wake-id'),
    }
  }

  const occurredAt = request.occurredAt
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    return {
      outcome: 'denied',
      code: 'malformed-timestamp',
      reason: wakeRefusalReason('malformed-timestamp'),
    }
  }

  const observedAt = now
  if (Date.parse(observedAt) < Date.parse(occurredAt)) {
    return {
      outcome: 'denied',
      code: 'observed-before-occurred',
      reason: wakeRefusalReason('observed-before-occurred'),
    }
  }

  const wake: ResilienceWake = {
    wakeId,
    source: request.source,
    kind: request.kind,
    goalRef: request.goalRef ?? null,
    sourceRef: request.sourceRef ?? null,
    occurredAt,
    observedAt,
  }

  const wakeKey = resilienceWakeDedupeKey(wake)
  if (processedWakeKeys.includes(wakeKey)) {
    return {
      outcome: 'denied',
      code: 'duplicate-wake',
      reason: wakeRefusalReason('duplicate-wake'),
    }
  }

  return { outcome: 'accepted', wake, wakeKey }
}

/**
 * Order wakes by priority.
 */
export function orderResilienceWakes<T extends { readonly source: ResilienceWakeSource }>(
  wakes: readonly T[],
): readonly T[] {
  const priority: Readonly<Record<ResilienceWakeSource, number>> = Object.freeze({
    'owner-interaction': 0,
    'mission-transition': 1,
    'work-transition': 2,
    'authorized-event': 3,
    'scheduled-heartbeat': 4,
  })
  return [...wakes].sort((a, b) => priority[a.source] - priority[b.source])
}
