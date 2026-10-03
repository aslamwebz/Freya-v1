import type {
  GoalAction,
  GoalCheckpointCounts,
  GoalReason,
  GoalStatus,
  GoalVerificationState,
} from '../longhorizon/types'

/**
 * THE LONG-HORIZON GOAL PROTOCOL — what a window may know about goals.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a
 * renderer is typed against, one frozen projection for a Core with no goal
 * domain, and the outcome vocabulary of the reads that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, dates, counts, closed reason codes,
 * verification state, available actions.
 *
 * Does not cross, in any broad read:
 *
 * - **Any goal content.** A goal's title, description and completion criteria
 *   are not fields of any view here. The only link to content is a goal id.
 * - **Any confidence, priority or deadline a window could assert.** They are
 *   reported, never accepted.
 *
 * ## The absences, kept apart
 *
 * `'unavailable'` with `NO_GOAL_DOMAIN_REASON` means *this build has no goal
 * domain and none is simulated*. `null` from the host means *no Core has started
 * yet*. Rendering the first as "Freya has no goals" would tell a person she
 * has no plans when nothing is watching.
 */

/* ------------------------------------------------------------------ views */

/** One goal as a broad read may hold it. No content, no description. */
export interface GoalSummaryView {
  readonly goalId: string
  readonly state: GoalStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly reason: GoalReason | null
  readonly counts: GoalCheckpointCounts
  readonly needsAttention: boolean
  readonly availableActions: readonly GoalAction[]
  readonly verification: {
    readonly state: GoalVerificationState
    readonly verifierId: string
  } | null
}

/** The reason a Core with no goal domain reports. */
export const NO_GOAL_DOMAIN_REASON = 'this build has no goal domain and none is simulated'

/** The reason a Core that has not started yet reports. */
export const GOAL_NO_PAYLOAD = 'no Core has started yet'

/**
 * The frozen projection for a Core with no goal domain.
 *
 * Declared after `NO_GOAL_DOMAIN_REASON` because it reads that constant: a
 * projection whose `reason` was a restatement of the string would be two
 * definitions of one sentence, free to drift apart.
 */
export const ABSENT_GOAL_PROJECTION: GoalProjectionView = Object.freeze({
  persistence: Object.freeze({
    mode: 'unavailable',
    reason: NO_GOAL_DOMAIN_REASON,
    durable: false,
  }),
  goals: Object.freeze([]),
  counts: Object.freeze({
    total: 0,
    draft: 0,
    active: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    needsAttention: 0,
  }),
  goalsRetained: 0,
  goalsTotal: 0,
  goalsHidden: 0,
  sequence: 0,
})

/** The projection a window holds. */
export interface GoalProjectionView {
  readonly persistence: {
    readonly mode: 'encrypted' | 'ephemeral' | 'unavailable'
    readonly reason: string | null
    readonly durable: boolean
  }
  readonly goals: readonly GoalSummaryView[]
  readonly counts: {
    readonly total: number
    readonly draft: number
    readonly active: number
    readonly paused: number
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
    readonly needsAttention: number
  }
  readonly goalsRetained: number
  readonly goalsTotal: number
  readonly goalsHidden: number
  readonly sequence: number
}

/* -------------------------------------------------------------- outcomes */

/** The outcome vocabulary of a goal command. */
export type GoalCommandOperation =
  | 'status'
  | 'created'
  | 'activated'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'settled-failed'
  | 'verification-passed'
  | 'verification-not-established'
  | 'verification-in-progress'
  | 'verification-timeout'
  | 'checkpoint-verified'
  | 'checkpoint-failed'
  | 'refused'

/** What a goal command produced, as a window may see it. */
export interface GoalCommandOutcomeView {
  readonly operation: GoalCommandOperation
  readonly ok: boolean
  readonly reason?: string
  readonly goalId?: string
  readonly state?: GoalStatus
  readonly needsAttention?: boolean
}
