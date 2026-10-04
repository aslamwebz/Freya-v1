import type { RuntimeProjection, RuntimeStatus } from './types'

/**
 * The diagnostics answers, derived from the projection.
 *
 * The projection already carries everything; this is the same facts arranged as
 * the questions a person or an App Mode surface actually asks. It is a pure
 * function of the projection and holds no state, so it cannot drift from it.
 */
export interface RuntimeAnswers {
  readonly lifecycle: RuntimeProjection['lifecycle']
  readonly implemented: readonly string[]
  readonly registered: readonly string[]
  readonly available: readonly string[]
  readonly active: readonly string[]
  readonly degraded: readonly { readonly id: string; readonly reason: string }[]
  readonly blocked: readonly {
    readonly id: string
    readonly reason: string
    readonly missing: readonly string[]
  }[]
  readonly disabled: readonly string[]
  readonly lastStopReason: string | null
  readonly lastReconciledAt: string | null
  readonly recoveredDomains: readonly string[]
}

export function runtimeAnswers(projection: RuntimeProjection): RuntimeAnswers {
  const idsWith = (status: RuntimeStatus): readonly string[] =>
    projection.domains.filter((domain) => domain.status === status).map((domain) => domain.id)

  return {
    lifecycle: projection.lifecycle,
    implemented: idsWith('implemented'),
    registered: idsWith('registered'),
    available: idsWith('available'),
    active: projection.domains
      .filter((domain) => domain.status === 'active' || domain.status === 'degraded')
      .map((domain) => domain.id),
    degraded: projection.domains
      .filter((domain) => domain.status === 'degraded')
      .map((domain) => ({ id: domain.id, reason: domain.reason })),
    blocked: projection.blocked.map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      missing: entry.missing,
    })),
    disabled: idsWith('disabled'),
    lastStopReason: projection.lastStopReason,
    lastReconciledAt: projection.lastReconciledAt,
    recoveredDomains: projection.recoveredDomains,
  }
}

/**
 * A one-line summary, for a diagnostics header.
 *
 * Deliberately counts only. It never names a blocked domain, so it cannot become
 * the thing a surface renders instead of the detail.
 */
export function runtimeSummary(projection: RuntimeProjection): string {
  const { counts } = projection
  return [
    `lifecycle ${projection.lifecycle}`,
    `${counts.active} active`,
    `${counts.degraded} degraded`,
    `${counts.available} available`,
    `${counts.blocked} blocked`,
  ].join(', ')
}
