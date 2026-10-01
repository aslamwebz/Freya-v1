import {
  WORKER_STATUSES,
  isTerminalWorkerStatus,
  type WorkerSpecialisation,
  type WorkerStatus,
} from '../workforce/types'
import type { ContextAdmission } from './types'
import type { ContextStore } from './store'

/**
 * THE ACTIVE-WORKER CONTEXT ADAPTER.
 *
 * Phase 9's coupling to Workforce, built from Core-owned projections. The
 * adapter reads narrow reports — a worker id, its lifecycle status, its
 * specialisation and a safe open-assignment count — and produces bounded
 * context metadata. It never reads a worker's hidden state: no message
 * bodies, no context references, no capabilities, no budget spend, no model
 * outputs.
 *
 * ## What crosses the boundary
 *
 * Four facts: a worker id, a status from the closed `WorkerStatus` table, a
 * specialisation from the closed `WorkerSpecialisation` table, and a count of
 * open assignments. The content is a deterministic sentence derived from
 * those fields, so the same report always produces the same admission.
 *
 * Deliberately absent: message bodies (untrusted content from another agent),
 * context reference ids (which could name private context), capabilities
 * (authority, not context), budget spend (not context), and anything a worker
 * said or produced.
 *
 * ## One item per worker
 *
 * Each active worker gets its own context item, keyed by worker id. When a
 * worker's status changes, the adapter re-points: the old item is revoked
 * and a new one admitted, so the context always reflects the current status.
 * When a worker is no longer active — its status is terminal, or it is no
 * longer in the reports — its item is revoked with a stated reason.
 *
 * ## Deterministic expiry and revocation
 *
 * Every item carries an explicit TTL, so it expires deterministically if the
 * adapter is not called again. Revocation is explicit: a worker that stops or
 * retires has its context taken back with a reason, so a later reference
 * answers `revoked` rather than pretending nothing was there.
 *
 * ## No authority
 *
 * Context never grants authority or capability. A worker's context item says
 * nothing about what the worker may do; Guard does not read this module.
 */

/** What Core may say about an active worker, in Context's own vocabulary. */
export interface ContextWorkerReport {
  readonly workerId: string
  readonly status: WorkerStatus
  readonly specialisation: WorkerSpecialisation
  /** Open assignments — a safe count, never a body or a reference. */
  readonly openAssignments: number
}

/** Why a worker's context was taken back because it is no longer active. */
export const CONTEXT_WORKER_INACTIVE_REASON = 'the worker is no longer active'

/** Why a worker's context was taken back because it changed. */
const CONTEXT_WORKER_CHANGED_REASON = 'the worker changed status'

/** Default TTL for an active-worker context item: 30 minutes. */
export const WORKER_CONTEXT_TTL_MS = 30 * 60_000

/**
 * Whether a status is one Core can put in front of a person as context.
 *
 * `WorkerStatus` is a closed table, and this is the runtime check that the
 * `ContextWorkerReport` type is only a promise about. It is checked rather
 * than assumed because the report is assembled from a Workforce projection
 * fold: a type assertion is not evidence, and an unrecognised status would
 * otherwise be admitted as an item label.
 */
export function isReportableWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === 'string' && (WORKER_STATUSES as readonly string[]).includes(value)
}

/**
 * Whether a status means the worker is no longer active.
 *
 * `retired` is terminal. `stopped` refuses new work — it is not terminal (it
 * can be resumed), but it is not active either, so its context is revoked
 * rather than updated. A stopped worker that is later resumed gets a fresh
 * item.
 */
export function isInactiveWorkerStatus(status: WorkerStatus): boolean {
  return status === 'stopped' || isTerminalWorkerStatus(status)
}

/**
 * The sentence a worker's context resolves to.
 *
 * Bounded by construction — a worker id, a status, a specialisation and a
 * count are all short and all come from closed tables or measured state.
 */
export function workerContextContent(report: ContextWorkerReport): string {
  const assignments =
    report.openAssignments === 1 ? '1 open assignment' : `${report.openAssignments} open assignments`
  return `Worker ${report.workerId} is ${report.status} (${report.specialisation}) with ${assignments}.`
}

/**
 * The admission for an active worker, built by Core rather than requested.
 *
 * Note what this function does **not** take: a source, a scope or a caller.
 * All three are Core's decision. `scope` is the session scope because the
 * active workforce is ambient, and `source` is fixed by the kind/source
 * table.
 */
export function workerContextAdmission(report: ContextWorkerReport): ContextAdmission {
  return {
    kind: 'active_worker',
    source: 'core_record',
    scope: { scopeKind: 'session', scopeId: 'session' },
    content: workerContextContent(report),
    label: report.specialisation,
    originId: report.workerId,
    ttlMs: WORKER_CONTEXT_TTL_MS,
  }
}

/** What one worker's sync did, in Core's words. */
export type WorkerSyncResult =
  | { readonly operation: 'unchanged'; readonly workerId: string }
  | { readonly operation: 'admitted'; readonly workerId: string; readonly contextId: string }
  | { readonly operation: 'repointed'; readonly workerId: string; readonly contextId: string; readonly revokedId: string }
  | { readonly operation: 'revoked'; readonly workerId: string; readonly contextId: string }

/** What a whole sync did: one result per worker that changed. */
export interface WorkforceSyncResult {
  readonly results: readonly WorkerSyncResult[]
}

/**
 * The stateful adapter that keeps the context store in sync with the active
 * workforce.
 *
 * The adapter receives the full list of worker reports on every projection
 * read and applies the diff to the store: admit when a worker becomes active,
 * re-point when its status changes, revoke when it is no longer active or no
 * longer in the reports.
 *
 * Deterministic: the same sequence of reports against the same store produces
 * the same sequence of sync results. No clock is read; `now` is passed in.
 */
export class WorkforceContextAdapter {
  private readonly items = new Map<string, string>()

  /**
   * Sync the store with the active workforce.
   *
   * `reports` is the full list of workers Core currently reports. A worker
   * with a terminal status is treated as no longer active — its context is
   * revoked. A worker that was previously tracked but is no longer in the
   * reports is also revoked, because it is no longer active.
   */
  sync(reports: readonly ContextWorkerReport[], store: ContextStore, now: Date): WorkforceSyncResult {
    const results: WorkerSyncResult[] = []
    const seen = new Set<string>()

    for (const report of reports) {
      seen.add(report.workerId)

      if (isInactiveWorkerStatus(report.status)) {
        const revoked = this.revokeWorker(report.workerId, store, now, CONTEXT_WORKER_INACTIVE_REASON)
        if (revoked !== null) results.push(revoked)
        continue
      }

      const currentContextId = this.items.get(report.workerId) ?? null
      if (currentContextId !== null) {
        const current = store.list(now).find((item) => item.contextId === currentContextId)
        if (current !== undefined && current.content === workerContextContent(report)) {
          continue
        }
      }

      const admission = workerContextAdmission(report)
      const result = store.admit(admission, now)
      if (!result.ok) {
        throw new Error(`the active-worker admission was refused (${result.code}): ${result.reason}`)
      }

      const revokedId = this.items.get(report.workerId) ?? null
      if (revokedId !== null) {
        store.revoke(revokedId, CONTEXT_WORKER_CHANGED_REASON, now)
      }

      this.items.set(report.workerId, result.item.contextId)
      results.push(
        revokedId === null
          ? { operation: 'admitted', workerId: report.workerId, contextId: result.item.contextId }
          : { operation: 'repointed', workerId: report.workerId, contextId: result.item.contextId, revokedId },
      )
    }

    for (const workerId of this.items.keys()) {
      if (seen.has(workerId)) continue
      const revoked = this.revokeWorker(workerId, store, now, CONTEXT_WORKER_INACTIVE_REASON)
      if (revoked !== null) results.push(revoked)
    }

    return { results }
  }

  private revokeWorker(
    workerId: string,
    store: ContextStore,
    now: Date,
    reason: string,
  ): WorkerSyncResult | null {
    const contextId = this.items.get(workerId) ?? null
    if (contextId === null) return null

    store.revoke(contextId, reason, now)
    this.items.delete(workerId)
    return { operation: 'revoked', workerId, contextId }
  }
}
