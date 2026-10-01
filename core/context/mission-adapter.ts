import { MISSION_STATUSES, type MissionStatus } from '../missions/types'

/**
 * THE CURRENT-MISSION CONTEXT ADAPTER.
 *
 * This is the whole of Phase 9's coupling to Missions, and it is deliberately
 * this small.
 *
 * ## Why an adapter at all, and why not more of one
 *
 * "Here" should mean the Mission a person is actually working on, so the
 * Context domain needs to know which Mission is current. It does **not** need to
 * know what the Mission says.
 *
 * A Mission's private text — its title, its intent, its success criteria — lives
 * in an encrypted Mission store (`core/missions/encrypted-store.ts`) that this
 * lane has no business reading, and it is absent from `MissionRecord` on
 * purpose: the journal copy of a Mission holds ids, statuses, instants, counts
 * and closed codes, and that absence is what makes a Mission safe to keep in a
 * backup. So the adapter is built from the fields a `MissionSummaryView` already
 * exposes in the open, and there is no path from here to a Mission's words
 * because the words are not on this side of the boundary.
 *
 * That is what "narrow, where safe" means here. A wider adapter — one that read
 * the Mission's title so that "here" could be "here: the offer letter" — would
 * move the most private text Freya holds into an ephemeral, process-lifetime
 * store with no encryption and no durability, which is a downgrade dressed as a
 * feature.
 *
 * ## One item, or "here" stops meaning anything
 *
 * The current Mission is admitted into the **session** scope: it is ambient by
 * nature, and a Mission that resolved only inside the conversation it was
 * created in would stop being "here" the moment the owner opened another
 * surface. That is safe precisely because of what the item carries — an id, a
 * status and a fixed sentence — and unsafe the moment that changes.
 *
 * At most one live `current_mission` item exists at any instant. The adapter
 * re-points by revoking the previous item rather than admitting alongside it,
 * because two live items of one kind make every "here" ambiguous, and an
 * ambiguous "here" is a refusal rather than a guess. See `ContextIntegration`.
 *
 * ## Why the content does not move with the counters
 *
 * The sentence below is a function of the Mission's **id and status only**, not
 * of its run counts. Counts change every time a Run is attached or finishes,
 * and a "here" that re-points on every attachment would fill the audit with
 * revocations of context whose meaning never actually changed — training a reader
 * to ignore the revocation trail, which is the one signal in it worth reading.
 *
 * Stale counts would be worse than none: a prompt compiler reading "2 of 5 runs"
 * that was true four runs ago has been handed a fact it cannot check. So the
 * adapter omits them and says why, rather than including them and labelling them.
 */

import type { ContextCoreRecord } from './coreIntegration'

/**
 * What Core may say about the current Mission, in Context's own vocabulary.
 *
 * Ids, a closed status and a derived sentence. Deliberately **not** a
 * `MissionSummaryView`: that type is the Mission domain's view of a Mission and
 * carries fields — deadlines, verification verdicts, available actions — that
 * have no business being copied into an admission spec that another subsystem
 * will hold. A narrow input type is the enforcement; a comment is not.
 *
 * `status` is typed as `MissionStatus` rather than `string` so a renamed or
 * removed Mission status becomes a compile error here instead of an opaque
 * string reaching an admission.
 */
export interface ContextMissionReport {
  readonly missionId: string
  readonly status: MissionStatus
}

/** Why a Mission's context was taken back, in Core's words. */
export const CONTEXT_MISSION_REVOKED_REASON = 'the current Mission changed'

/**
 * Whether a status is one Core can put in front of a person as context.
 *
 * `MissionStatus` is a closed table, and this is the runtime check that the
 * `ContextMissionReport` type is only a promise about. It is checked rather than
 * assumed because the report is assembled from a Mission projection fold: a type
 * assertion is not evidence, and an unrecognised status would otherwise be admitted
 * as an item label, which is the one part of a Mission somebody might recognise.
 *
 * A guard the type system already provides, deliberately kept — because the caller
 * is Core's own command dispatch and the value underneath it came out of a JSONL
 * fold, which is exactly the place where a closed table stops being decorative.
 */
export function isReportableMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value)
}

/**
 * The sentence "here" resolves to, when "here" means the current Mission.
 *
 * One clause and two facts. Bounded by construction — a Mission id and a status
 * are both short and both come from a closed table, so this cannot outgrow
 * `maxContentChars` the way free text from a caller can.
 */
export function missionContextContent(report: ContextMissionReport): string {
  return `The current Mission is ${report.missionId} and it is ${report.status}.`
}

/**
 * The admission for a current Mission, built by Core rather than requested.
 *
 * Note what this function does **not** take: a source, a channel, a scope or a
 * caller. All four are Core's decision. `scope` is the session scope because a
 * current Mission is ambient, and `source` is fixed by the entry point this spec
 * is only ever handed to — so nothing that reaches it can assert where it came
 * from, and the type itself has no field in which such an assertion could live.
 */
export function missionContextAdmission(report: ContextMissionReport): ContextCoreRecord {
  return {
    kind: 'current_mission',
    scope: { scopeKind: 'session', scopeId: 'session' },
    content: missionContextContent(report),
    // The status, and only the status: a label is rendered, so it must not be
    // the one part of a Mission somebody might recognise by shape.
    label: report.status,
    originId: report.missionId,
  }
}