/**
 * THE RELAY PROTOCOL — what a window may know about connectors and actions.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a
 * renderer is typed against, one frozen projection for a Core with no Relay
 * domain, and the outcome vocabulary of the commands that exist. Nothing here
 * is writable by a window in the sense that matters: a window may submit an
 * action request and decide an approval, and it may not name a capability, a
 * credential, a budget, a limit or an authority of its own.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: connector availability (ids and closed statuses), pending approvals
 * as *metadata* (targets and effects, never content), recent action metadata
 * (ids, closed labels, counts, instants), and the bounded result of one
 * explicit read or one approved write.
 *
 * Does not cross: a credential or token of any kind (there is no field one
 * could occupy), message bodies, event titles, issue text, repo content, a
 * raw account handle, a budget figure a window could raise, or any capability
 * name a window could use to widen itself.
 *
 * ## The two absences, kept apart
 *
 * `'unavailable'` with `NO_RELAY_DOMAIN_REASON` means *this build has no Relay
 * domain and none is simulated*. `null` from the host means *no Core has
 * started yet*. Rendering the first as "no connectors" would be telling a
 * person they have no email when nothing is watching for it at all.
 */

import type {
  RelayAction,
  RelayActionStatus,
  RelayConnectorId,
  RelayFailureCode,
  RelayRiskClass,
} from '../relay/types'

/* ----------------------------------------------------------------- views */

/** One connector's availability, as the projection reports it. */
export interface RelayConnectorView {
  readonly connector: RelayConnectorId
  readonly status: 'ready' | 'unavailable' | 'faulted'
  readonly label: string
  /** The actions this connector supports. A closed list, not a claim. */
  readonly actions: readonly string[]
  /** Why it is faulted. Null when it is not. */
  readonly faultReason: string | null
}

/**
 * One pending approval, as metadata.
 *
 * `summary` is a bounded sentence Core wrote from the request's targets —
 * who will be affected and what will happen. It never carries content: no
 * subject, no body, no title. The owner decides on the strength of the
 * target and the action, which is what an approval is for.
 */
export interface RelayApprovalView {
  readonly approvalId: string
  readonly actionId: string
  readonly connector: RelayConnectorId
  readonly action: RelayAction
  readonly risk: RelayRiskClass
  readonly summary: string
  readonly requestedAt: string
}

/**
 * One recent action, as metadata.
 *
 * Every field is an id, a closed label, a count or an instant. There is no
 * field a result could hide in, so a window holding this holds a report about
 * an action rather than the action's material.
 */
export interface RelayActionView {
  readonly actionId: string
  readonly connector: RelayConnectorId
  readonly action: RelayAction
  readonly status: RelayActionStatus
  readonly risk: RelayRiskClass
  readonly failureCode: RelayFailureCode | null
  readonly retries: number
  readonly requestedAt: string
  readonly settledAt: string | null
}

/** The ceilings this projection was built under, so a window can show them. */
export interface RelayLimitsView {
  readonly maxActionsPerConnectorPerWindow: number
  readonly maxSendsPerWindow: number
  readonly maxDraftsPerWindow: number
  readonly maxExternalInvokesPerWindow: number
  readonly budgetWindowMs: number
  readonly maxRetries: number
  readonly maxPendingApprovals: number
  readonly approvalTtlMs: number
}

/**
 * Everything a window may know about Relay, in one read-only object.
 *
 * A mirror: Core builds it, a window holds what Core last sent, and nothing a
 * window can do writes a field of it. `sequence` lets a window prove *which*
 * Core state it is looking at.
 */
export interface RelayProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly schemaVersion: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  readonly connectors: readonly RelayConnectorView[]
  readonly pendingApprovals: readonly RelayApprovalView[]
  readonly recentActions: readonly RelayActionView[]
  readonly limits: RelayLimitsView
}

/* --------------------------------------------------------------- results */

/** What a read returned. Bounded content, crossing only in this result. */
export type RelayReadResult =
  | { readonly kind: 'email.messages'; readonly messages: readonly RelayEmailMessageView[]; readonly nextCursor: string | null }
  | { readonly kind: 'calendar.events'; readonly events: readonly RelayCalendarEventView[]; readonly nextCursor: string | null }
  | { readonly kind: 'github.issues'; readonly issues: readonly RelayGitHubIssueView[]; readonly nextCursor: string | null }
  | { readonly kind: 'external.result'; readonly data: unknown }

/** What an approved write produced. */
export type RelayWriteResult =
  | { readonly kind: 'email.draft.created'; readonly draftId: string }
  | { readonly kind: 'email.sent'; readonly messageId: string }
  | { readonly kind: 'calendar.event.created'; readonly eventId: string }
  | { readonly kind: 'calendar.event.updated'; readonly eventId: string }
  | { readonly kind: 'calendar.event.cancelled'; readonly eventId: string }
  | { readonly kind: 'github.issue.created'; readonly number: number }
  | { readonly kind: 'github.pr.created'; readonly number: number }
  | { readonly kind: 'external.invoked'; readonly data: unknown }

/** One email message, as a read returns it. */
export interface RelayEmailMessageView {
  readonly messageId: string
  readonly threadId: string | null
  readonly from: string
  readonly to: readonly string[]
  readonly subject: string
  readonly snippet: string
  readonly receivedAt: string
  readonly hasAttachments: boolean
  readonly attachmentCount: number
}

/** One calendar event, as a read returns it. */
export interface RelayCalendarEventView {
  readonly eventId: string
  readonly title: string
  readonly startsAt: string
  readonly endsAt: string
  readonly location: string | null
  readonly attendeeCount: number
  readonly organizer: string
}

/** One GitHub issue, as a read returns it. */
export interface RelayGitHubIssueView {
  readonly repo: { readonly owner: string; readonly repo: string }
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly author: string
  readonly updatedAt: string
}

/* --------------------------------------------------------------- outcome */

export type RelayOperation =
  | 'status'
  | 'read'
  | 'requested'
  | 'decided'
  | 'executed'
  | 'replayed'
  | 'refused'

/**
 * What a Relay command produced.
 *
 * `refused` is an outcome rather than an exception everywhere: a bad payload, a
 * missing connector, a spent budget and a stopped Core all answer in words,
 * and none is papered over. The `result` slot carries the bounded content of
 * one read or one approved write — and nothing else ever.
 */
export interface RelayCommandOutcome {
  readonly operation: RelayOperation
  readonly ok: boolean
  /** Why the answer could not be had, in words. Never evidence, never a stack. */
  readonly reason?: string
  /** The action's id, once one exists. */
  readonly actionId?: string
  /** The pending approval's id, when a write is awaiting a decision. */
  readonly approvalId?: string
  /** The action's status after the command. */
  readonly status?: RelayActionStatus
  /** The closed failure code, when the command was refused. */
  readonly failureCode?: RelayFailureCode
  /** Present on a read or an approved write. Bounded content lives here. */
  readonly result?: RelayReadResult | RelayWriteResult
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no Relay domain.
 *
 * `unavailable`, never `ready` with empty lists: "there are no connectors" and
 * "nothing is connected" are different facts, and a surface that rendered the
 * second as the first would be telling a person they have no email when Freya
 * is not listening at all.
 */
export const ABSENT_RELAY_PROJECTION: RelayProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a Relay domain yet',
  schemaVersion: 1,
  sequence: 0,
  connectors: Object.freeze([]) as readonly RelayConnectorView[],
  pendingApprovals: Object.freeze([]) as readonly RelayApprovalView[],
  recentActions: Object.freeze([]) as readonly RelayActionView[],
  limits: Object.freeze({
    maxActionsPerConnectorPerWindow: 0,
    maxSendsPerWindow: 0,
    maxDraftsPerWindow: 0,
    maxExternalInvokesPerWindow: 0,
    budgetWindowMs: 0,
    maxRetries: 0,
    maxPendingApprovals: 0,
    approvalTtlMs: 0,
  }),
})

/**
 * The sentence Core reports when nothing has built a Relay domain.
 *
 * Exported so the host, the surface and the tests quote the same words instead
 * of paraphrasing the absence into four slightly different claims.
 */
export const NO_RELAY_DOMAIN_REASON =
  'this Core has no Relay domain: no connector is registered, and none is simulated'

/** The projection schema this lane speaks. */
export const RELAY_SCHEMA_VERSION = 1

/** The sentence a window gets when a payloadless read carried something. */
export const RELAY_NO_PAYLOAD =
  'relay.status.read carries no payload: a window may ask what Core reports and may not supply a connector, an action or a capability'
