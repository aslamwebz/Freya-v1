import { MISSION_STATUSES, isTerminalMissionStatus, type MissionStatus } from '../missions/types'
import type { ContextAdmission } from './types'
import type { ContextStore } from './store'

/**
 * THE CURRENT-MISSION CONTEXT ADAPTER.
 *
 * Phase 9's coupling to Missions, built from Core-owned projections. The
 * adapter reads a narrow report — a Mission id and its lifecycle status —
 * and produces bounded context metadata. It never reads a Mission's private
 * content (title, intent, success criteria), which lives in an encrypted
 * store this lane has no business touching.
 *
 * ## What crosses the boundary
 *
 * Exactly two facts: a Mission id and a status from the closed
 * `MissionStatus` table. No title, no intent, no success criteria, no
 * verification evidence, no child-run counts. The content is a deterministic
 * sentence derived from those two fields, so the same report always produces
 * the same admission.
 *
 * ## One item, or "here" stops meaning anything
 *
 * At most one live `current_mission` item exists at any instant. The adapter
 * re-points by revoking the previous item rather than admitting alongside it,
 * because two live items of one kind make every "here" ambiguous, and an
 * ambiguous "here" is a refusal rather than a guess.
 *
 * ## Deterministic expiry and revocation
 *
 * The item carries an explicit TTL, so it expires deterministically if the
 * adapter is not called again (e.g. after a restart). When the Mission is no
 * longer active — its status is terminal, or no Mission is current — the
 * adapter revokes the item with a stated reason, so a later reference answers
 * `revoked` rather than pretending nothing was ever there.
 *
 * ## No authority
 *
 * Context never grants authority or capability. Holding a `current_mission`
 * item says nothing about what may be done with it; Guard does not read this
 * module.
 */

/** What Core may say about the current Mission, in Context's own vocabulary. */
export interface ContextMissionReport {
  readonly missionId: string
  readonly status: MissionStatus
}

/** Why a Mission's context was taken back, in Core's words. */
export const CONTEXT_MISSION_REVOKED_REASON = 'the current Mission changed'

/** Why a Mission's context was taken back because it is no longer active. */
export const CONTEXT_MISSION_INACTIVE_REASON = 'the Mission is no longer active'

/** Default TTL for a current-Mission context item: one hour. */
export const MISSION_CONTEXT_TTL_MS = 60 * 60_000

/**
 * Whether a status is one Core can put in front of a person as context.
 *
 * `MissionStatus` is a closed table, and this is the runtime check that the
 * `ContextMissionReport` type is only a promise about. It is checked rather
 * than assumed because the report is assembled from a Mission projection fold:
 * a type assertion is not evidence, and an unrecognised status would otherwise
 * be admitted as an item label, which is the one part of a Mission somebody
 * might recognise.
 */
export function isReportableMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value)
}

/**
 * The sentence "here" resolves to, when "here" means the current Mission.
 *
 * One clause and two facts. Bounded by construction — a Mission id and a
 * status are both short and both come from a closed table, so this cannot
 * outgrow `maxContentChars` the way free text from a caller can.
 */
export function missionContextContent(report: ContextMissionReport): string {
  return `The current Mission is ${report.missionId} and it is ${report.status}.`
}

/**
 * The admission for a current Mission, built by Core rather than requested.
 *
 * Note what this function does **not** take: a source, a scope or a caller.
 * All three are Core's decision. `scope` is the session scope because a
 * current Mission is ambient, and `source` is fixed by the kind/source table
 * — so nothing that reaches it can assert where it came from, and the type
 * itself has no field in which such an assertion could live.
 */
export function missionContextAdmission(report: ContextMissionReport): ContextAdmission {
  return {
    kind: 'current_mission',
    source: 'core_record',
    scope: { scopeKind: 'session', scopeId: 'session' },
    content: missionContextContent(report),
    label: report.status,
    originId: report.missionId,
    ttlMs: MISSION_CONTEXT_TTL_MS,
  }
}

/** What a sync did, in Core's words. */
export type MissionSyncResult =
  | { readonly operation: 'unchanged' }
  | { readonly operation: 'admitted'; readonly contextId: string }
  | { readonly operation: 'repointed'; readonly contextId: string; readonly revokedId: string }
  | { readonly operation: 'revoked'; readonly contextId: string }

/**
 * The stateful adapter that keeps the context store in sync with the current
 * Mission.
 *
 * The adapter is the only thing that knows which Mission is current. It
 * receives a report on every projection read and applies the diff to the
 * store: admit when a Mission becomes current, re-point when it changes,
 * revoke when it is no longer active.
 *
 * Deterministic: the same sequence of reports against the same store produces
 * the same sequence of sync results. No clock is read; `now` is passed in.
 */
export class MissionContextAdapter {
  private currentContextId: string | null = null
  private currentMissionId: string | null = null
  private currentStatus: MissionStatus | null = null

  /**
   * Sync the store with the current Mission.
   *
   * `report` is null when no Mission is current. A non-null report with a
   * terminal status means the Mission is no longer active — its context is
   * revoked rather than updated, because a completed Mission is not "here"
   * any more.
   */
  sync(report: ContextMissionReport | null, store: ContextStore, now: Date): MissionSyncResult {
    if (report === null || isTerminalMissionStatus(report.status)) {
      return this.revokeCurrent(store, now, CONTEXT_MISSION_INACTIVE_REASON)
    }

    if (this.currentMissionId === report.missionId && this.currentStatus === report.status) {
      return { operation: 'unchanged' }
    }

    const admission = missionContextAdmission(report)
    const result = store.admit(admission, now)
    if (!result.ok) {
      throw new Error(`the current-Mission admission was refused (${result.code}): ${result.reason}`)
    }

    const revokedId = this.currentContextId
    if (revokedId !== null) {
      store.revoke(revokedId, CONTEXT_MISSION_REVOKED_REASON, now)
    }

    this.currentContextId = result.item.contextId
    this.currentMissionId = report.missionId
    this.currentStatus = report.status

    return revokedId === null
      ? { operation: 'admitted', contextId: result.item.contextId }
      : { operation: 'repointed', contextId: result.item.contextId, revokedId }
  }

  private revokeCurrent(store: ContextStore, now: Date, reason: string): MissionSyncResult {
    const contextId = this.currentContextId
    if (contextId === null) return { operation: 'unchanged' }

    store.revoke(contextId, reason, now)
    this.currentContextId = null
    this.currentMissionId = null
    this.currentStatus = null
    return { operation: 'revoked', contextId }
  }
}
