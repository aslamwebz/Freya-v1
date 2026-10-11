import { RELAY_ACTIONS, RELAY_CONNECTORS, RELAY_FAILURE_CODES, RELAY_RISK_CLASSES, type RelayAction, type RelayConnectorId, type RelayFailureCode, type RelayRiskClass } from '../../shared/contracts/events/vocabulary/relay'
export { RELAY_ACTIONS, RELAY_CONNECTORS, RELAY_FAILURE_CODES, RELAY_RISK_CLASSES } from '../../shared/contracts/events/vocabulary/relay'
export type { RelayAction, RelayConnectorId, RelayFailureCode, RelayRiskClass } from '../../shared/contracts/events/vocabulary/relay'
/**
 * THE RELAY DOMAIN — Phase 16's vocabulary.
 *
 * Relay is the capability-gated transport/control plane for email, calendar,
 * GitHub and generic external connectors. It is not a credential vault and not
 * a model-controlled account bridge: raw credentials and tokens never enter the
 * renderer, the journal, a generic projection, a model prompt or a log line.
 * They live inside an adapter the host constructed in the main process, and
 * the only thing that crosses out of it is a bounded result.
 *
 * ## The rule that governs everything here
 *
 * Every action is separately bounded. Read access never implies write access.
 * Write/send/mutate actions flow through Guard, the Relay budget ledger (the
 * Governor-equivalent for external actions), an explicit owner approval and
 * STOP ALL — in that order, each checked fresh, none skipped.
 *
 * ## What is deliberately absent
 *
 * - **No credential field, anywhere.** No token, no password, no cookie, no
 *   OAuth grant. An adapter is a black box that Core hands a validated request
 *   and receives a bounded result. There is no method that returns a credential
 *   and no payload field one could hide in.
 * - **No model path.** Nothing in this domain imports a gateway, an authority
 *   or a provider. A model may propose an action in conversation; it cannot
 *   execute one, because the only execution door is a Core command that a
 *   renderer reaches through the bridge.
 * - **No free-form target.** Every target is a validated, normalized value
 *   from a closed vocabulary or a bounded opaque id. A caller cannot name an
 *   arbitrary account, repo or calendar.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum, every string a maximum, every payload a byte
 * ceiling. An unbounded "connector" is how a transport plane quietly becomes
 * an exfiltration channel.
 */

import type { Capability } from '../../shared/contracts/capabilities'


export function isRelayConnectorId(value: unknown): value is RelayConnectorId {
  return typeof value === 'string' && (RELAY_CONNECTORS as readonly string[]).includes(value)
}


/**
 * A connector's availability, as the projection reports it.
 *
 * `unavailable` means no adapter is registered — the honest reading, never a
 * placeholder. `ready` means an adapter is registered and the last action did
 * not fault it. `faulted` means an adapter reported a non-transient failure;
 * reads and writes are refused until the host re-registers it.
 */
export const RELAY_CONNECTOR_STATUSES = ['unavailable', 'ready', 'faulted'] as const

export type RelayConnectorStatus = (typeof RELAY_CONNECTOR_STATUSES)[number]


export function isRelayConnectorStatus(value: unknown): value is RelayConnectorStatus {
  return typeof value === 'string' && (RELAY_CONNECTOR_STATUSES as readonly string[]).includes(value)
}


export function isRelayAction(value: unknown): value is RelayAction {
  return typeof value === 'string' && (RELAY_ACTIONS as readonly string[]).includes(value)
}


/**
 * The read actions. These execute directly under Guard + budget + STOP ALL.
 * They never create an approval and never mutate anything.
 */
export const RELAY_READ_ACTIONS = ['email.read', 'calendar.read', 'github.read', 'drive.read', 'telegram.read'] as const

export type RelayReadAction = (typeof RELAY_READ_ACTIONS)[number]


export function isRelayReadAction(value: RelayAction): value is RelayReadAction {
  return (RELAY_READ_ACTIONS as readonly string[]).includes(value)
}


/**
 * The write/send/mutate actions. Every one of these creates a pending approval
 * and executes only after the owner decides.
 */
export const RELAY_WRITE_ACTIONS = [
  'email.draft.create',
  'email.send',
  'calendar.create',
  'calendar.update',
  'calendar.cancel',
  'github.issue.create',
  'github.pr.create',
  'drive.file.create',
  'telegram.send',
  'external.invoke',
] as const

export type RelayWriteAction = (typeof RELAY_WRITE_ACTIONS)[number]


export function isRelayWriteAction(value: RelayAction): value is RelayWriteAction {
  return (RELAY_WRITE_ACTIONS as readonly string[]).includes(value)
}


/** Which connector an action belongs to. */
export const RELAY_ACTION_CONNECTOR: Readonly<Record<RelayAction, RelayConnectorId>> = Object.freeze({
  'email.read': 'email',
  'email.draft.create': 'email',
  'email.send': 'email',
  'calendar.read': 'calendar',
  'calendar.create': 'calendar',
  'calendar.update': 'calendar',
  'calendar.cancel': 'calendar',
  'github.read': 'github',
  'github.issue.create': 'github',
  'github.pr.create': 'github',
  'drive.read': 'drive',
  'drive.file.create': 'drive',
  'telegram.read': 'telegram',
  'telegram.send': 'telegram',
  'external.invoke': 'external',
})


export function isRelayRiskClass(value: unknown): value is RelayRiskClass {
  return typeof value === 'string' && (RELAY_RISK_CLASSES as readonly string[]).includes(value)
}


export const RELAY_ACTION_RISK: Readonly<Record<RelayAction, RelayRiskClass>> = Object.freeze({
  'email.read': 'read',
  'email.draft.create': 'routine',
  'email.send': 'consequential',
  'calendar.read': 'read',
  'calendar.create': 'routine',
  'calendar.update': 'routine',
  'calendar.cancel': 'routine',
  'github.read': 'read',
  'github.issue.create': 'routine',
  'github.pr.create': 'routine',
  'drive.read': 'read',
  'drive.file.create': 'routine',
  'telegram.read': 'read',
  'telegram.send': 'consequential',
  'external.invoke': 'consequential',
})


/**
 * The capability each action needs. One action, one capability — the mapping is
 * the whole of "separately bounded": there is no `relay.use` that widens every
 * connector at once.
 */
export const RELAY_ACTION_CAPABILITY: Readonly<Record<RelayAction, Capability>> = Object.freeze({
  'email.read': 'relay.email.read',
  'email.draft.create': 'relay.email.draft',
  'email.send': 'relay.email.send',
  'calendar.read': 'relay.calendar.read',
  'calendar.create': 'relay.calendar.create',
  'calendar.update': 'relay.calendar.update',
  'calendar.cancel': 'relay.calendar.cancel',
  'github.read': 'relay.github.read',
  'github.issue.create': 'relay.github.issue.create',
  'github.pr.create': 'relay.github.pr.create',
  'drive.read': 'relay.drive.read',
  'drive.file.create': 'relay.drive.file.create',
  'telegram.read': 'relay.telegram.read',
  'telegram.send': 'relay.telegram.send',
  'external.invoke': 'relay.external.invoke',
})


/** The capabilities a connector's actions need, for the projection. */
export const RELAY_CONNECTOR_CAPABILITIES: Readonly<Record<RelayConnectorId, readonly Capability[]>> =
  Object.freeze({
    email: ['relay.email.read', 'relay.email.draft', 'relay.email.send'],
    calendar: ['relay.calendar.read', 'relay.calendar.create', 'relay.calendar.update', 'relay.calendar.cancel'],
    github: ['relay.github.read', 'relay.github.issue.create', 'relay.github.pr.create'],
    drive: ['relay.drive.read', 'relay.drive.file.create'],
    telegram: ['relay.telegram.read', 'relay.telegram.send'],
    external: ['relay.external.invoke'],
  })


/* --------------------------------------------------------------- statuses */

/**
 * An action's lifecycle.
 *
 * `pending_approval` → `approved` → `executing` → `completed` | `failed`.
 * `pending_approval` → `denied` | `cancelled`. Terminal states have no
 * outgoing edges: a completed action is never rewritten, and a retry is a
 * *new* action with a new idempotency key.
 */
export const RELAY_ACTION_STATUSES = [
  'pending_approval',
  'approved',
  'executing',
  'completed',
  'failed',
  'denied',
  'cancelled',
] as const

export type RelayActionStatus = (typeof RELAY_ACTION_STATUSES)[number]


export function isRelayActionStatus(value: unknown): value is RelayActionStatus {
  return typeof value === 'string' && (RELAY_ACTION_STATUSES as readonly string[]).includes(value)
}


export const RELAY_ACTION_TERMINAL_STATUSES = ['completed', 'failed', 'denied', 'cancelled'] as const

export type RelayActionTerminalStatus = (typeof RELAY_ACTION_TERMINAL_STATUSES)[number]


export function isTerminalRelayActionStatus(status: RelayActionStatus): status is RelayActionTerminalStatus {
  return (RELAY_ACTION_TERMINAL_STATUSES as readonly string[]).includes(status)
}


export function isRelayFailureCode(value: unknown): value is RelayFailureCode {
  return typeof value === 'string' && (RELAY_FAILURE_CODES as readonly string[]).includes(value)
}


/* ----------------------------------------------------------------- limits */

/**
 * Code-owned ceilings. A caller may never raise one; the engine clamps down.
 *
 * The budget ledger is Relay's Governor: it is durable (derived from journal
 * events), deny-by-default, and it survives a restart — a send allowance spent
 * before a crash is still spent after it.
 */
export const RELAY_LIMITS = Object.freeze({
  /** Actions accepted per connector in the rolling window, reads included. */
  maxActionsPerConnectorPerWindow: 100,
  /** Sends in the rolling window, across connectors. */
  maxSendsPerWindow: 10,
  /** Drafts in the rolling window. */
  maxDraftsPerWindow: 20,
  /** External invocations in the rolling window. */
  maxExternalInvokesPerWindow: 25,
  /** The rolling window budgets are measured over. */
  budgetWindowMs: 60 * 60 * 1000,
  /** Transient retries per action. Bounded, and never a loop. */
  maxRetries: 2,
  /** Idempotency keys retained. Replay protection is bounded and documented. */
  maxIdempotencyKeys: 1024,
  /** Pending approvals held at once. */
  maxPendingApprovals: 32,
  /** How long an approval may wait for a decision before it expires. */
  approvalTtlMs: 24 * 60 * 60 * 1000,
  /** Characters in one action payload. */
  maxPayloadChars: 64_000,
  /** Recipients on one email. */
  maxRecipients: 50,
  /** Attendees on one calendar event. */
  maxAttendees: 100,
  /** Attachment metadata entries on one email. */
  maxAttachments: 20,
  /** Characters in one attachment's metadata. */
  maxAttachmentMetadataChars: 4_096,
  /** Rows one read may return. */
  maxPaginationLimit: 100,
  /** Characters in an opaque cursor. */
  maxCursorChars: 256,
  /** Characters in an idempotency key. */
  maxIdempotencyKeyChars: 128,
  /** Recent actions the projection retains. */
  maxRecentActions: 50,
  /** Characters in a connector label. */
  maxConnectorLabelChars: 128,
  /** Characters in an external connector name. */
  maxExternalConnectorChars: 64,
  /** Characters in one external operation name. */
  maxExternalOperationChars: 64,
  /** Characters in one external parameter string. */
  maxExternalParamChars: 8_192,
  /** External parameters per invocation. */
  maxExternalParams: 32,
  /** Repos on the GitHub allowlist. */
  maxAllowlistedRepos: 64,
  /** Characters in a repo ref (`owner/repo`). */
  maxRepoRefChars: 256,
  /** Rows one Drive read may return. */
  maxDriveFiles: 100,
  /** Characters in a Drive file name. */
  maxDriveNameChars: 255,
  /** Bytes of Drive file content Relay will carry in one request. */
  maxDriveContentChars: 64_000,
  /** Telegram chats on the allowlist. */
  maxAllowlistedChats: 64,
  /** Characters in a Telegram message. */
  maxTelegramMessageChars: 4_096,
  /** Telegram sends in the rolling window. */
  maxTelegramSendsPerWindow: 20,
})


/* ----------------------------------------------------------------- shapes */

/** One recipient. An address Core validated; a name is display metadata. */
export interface RelayRecipient {
  readonly address: string
  readonly name?: string
}


/** Attachment *metadata* only. Content never enters Relay. */
export interface RelayAttachmentMeta {
  readonly filename: string
  readonly contentType: string
  readonly sizeBytes: number
}


/** One email message, as a read returns it. */
export interface RelayEmailMessage {
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


/** A draft: recipients, subject, body and attachment metadata, separated. */
export interface RelayEmailDraft {
  readonly to: readonly RelayRecipient[]
  readonly cc: readonly RelayRecipient[]
  readonly subject: string
  readonly body: string
  readonly attachments: readonly RelayAttachmentMeta[]
}


/** A send is a draft plus the gate. A draft is never a send. */
export interface RelayEmailSend extends RelayEmailDraft {
  readonly idempotencyKey: string
}


/** One calendar event, as a read returns it. */
export interface RelayCalendarEvent {
  readonly eventId: string
  readonly title: string
  readonly startsAt: string
  readonly endsAt: string
  readonly location: string | null
  readonly attendeeCount: number
  readonly organizer: string
}


/**
 * A calendar event input.
 *
 * The attendee list is exactly what the caller supplied — Core validates it
 * and the adapter receives it verbatim. There is no silent invite expansion:
 * no domain-wide lookup, no "and everyone in the building".
 */
export interface RelayCalendarEventInput {
  readonly title: string
  readonly startsAt: string
  readonly endsAt: string
  readonly location: string | null
  readonly attendees: readonly string[]
}


/** A GitHub repo reference: `owner/repo`, validated. */
export interface RelayGitHubRepoRef {
  readonly owner: string
  readonly repo: string
}


/** One GitHub issue, as a read returns it. */
export interface RelayGitHubIssue {
  readonly repo: RelayGitHubRepoRef
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly author: string
  readonly updatedAt: string
}


/** Creating an issue: repo, title, body. No state, no assignee claims. */
export interface RelayGitHubIssueInput {
  readonly repo: RelayGitHubRepoRef
  readonly title: string
  readonly body: string
}


/**
 * Creating a PR: repo, head branch, base branch, title, body.
 *
 * Only a PR ref is created. There is deliberately no force-push, no history
 * rewrite, no branch deletion and no arbitrary command execution anywhere in
 * this vocabulary — the actions do not exist, so they cannot be smuggled.
 */
export interface RelayGitHubPrInput {
  readonly repo: RelayGitHubRepoRef
  readonly head: string
  readonly base: string
  readonly title: string
  readonly body: string
}


/** One Google Drive file, as a read returns it. */
export interface RelayDriveFile {
  readonly fileId: string
  readonly name: string
  readonly mimeType: string
  readonly modifiedAt: string
  readonly sizeBytes: number | null
  readonly parents: readonly string[]
}


/**
 * Creating a Drive file: name, MIME type and bounded content.
 *
 * The content crosses once, in the request, exactly as an email body does. It
 * is held process-locally for the adapter and is never written to the journal
 * or a projection; only the file's id, name and size are ever recorded.
 */
export interface RelayDriveFileInput {
  readonly name: string
  readonly mimeType: string
  readonly content: string
}


/** One Telegram chat, as the allowlist names it. */
export interface RelayTelegramChat {
  readonly chatId: string
  readonly title: string
  readonly kind: 'private' | 'group' | 'channel'
}


/** One Telegram message, as a read returns it. */
export interface RelayTelegramMessage {
  readonly messageId: string
  readonly chatId: string
  readonly from: string
  readonly text: string
  readonly sentAt: string
}


/** Sending a Telegram message. Bounded text, explicit chat. */
export interface RelayTelegramMessageInput {
  readonly chatId: string
  readonly text: string
  readonly idempotencyKey: string
}


/** A generic external invocation. Bounded in every dimension. */
export interface RelayExternalInvoke {
  readonly connector: string
  readonly operation: string
  readonly params: readonly (string | number | boolean)[]
  readonly idempotencyKey: string
}


/** A read query: a bounded filter and a bounded page. */
export interface RelayReadQuery {
  readonly query: string | null
  readonly limit: number
  readonly cursor: string | null
  /**
   * An explicit single-item read, when the action names one.
   *
   * `null` means "list or search"; a value means "this exact item". It is a
   * bounded opaque id, never a URL or a path, and an adapter that does not
   * support it refuses rather than ignoring it.
   */
  readonly messageId?: string | null
}


/* ----------------------------------------------------------- action state */

/**
 * One action record, as the domain holds it.
 *
 * `summary` is a bounded sentence Core wrote from metadata — never content.
 * It is the only human-readable field, and it exists so the projection and the
 * approval screen can say what is being asked without the journal ever holding
 * the thing itself.
 */
export interface RelayActionRecord {
  readonly actionId: string
  readonly connector: RelayConnectorId
  readonly action: RelayAction
  readonly risk: RelayRiskClass
  readonly status: RelayActionStatus
  readonly idempotencyKey: string | null
  readonly summary: string
  readonly failureCode: RelayFailureCode | null
  readonly retries: number
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly settledAt: string | null
}


/** One approval record. Single-use: a decided approval is never re-decided. */
export interface RelayApprovalRecord {
  readonly approvalId: string
  readonly actionId: string
  readonly connector: RelayConnectorId
  readonly action: RelayAction
  readonly risk: RelayRiskClass
  readonly summary: string
  /**
   * `pending` → `approved` | `denied` | `expired`. `expired` is the system's
   * withdrawal of a request that can no longer be honoured — an approval
   * recovered from the journal after a restart, whose content did not
   * survive. Terminal, like the others.
   */
  readonly status: 'pending' | 'approved' | 'denied' | 'expired'
  readonly requestedAt: string
  readonly decidedAt: string | null
}


/** The folded Relay state, derived from `relay.*` events. */
export interface RelayState {
  readonly actions: readonly RelayActionRecord[]
  readonly approvals: readonly RelayApprovalRecord[]
  /** Action instants per connector, for the rolling budget. */
  readonly actionInstants: Readonly<Record<RelayConnectorId, readonly string[]>>
  /** Send instants, for the send-specific cap. */
  readonly sendInstants: readonly string[]
  /** Telegram send instants, for the Telegram-specific cap. */
  readonly telegramSendInstants: readonly string[]
  /** Draft instants, for the draft-specific cap. */
  readonly draftInstants: readonly string[]
  /** External invoke instants, for the external-specific cap. */
  readonly externalInstants: readonly string[]
  /** Connectors the host marked faulted, with the reason. */
  readonly faulted: Readonly<Record<string, string>>
}


export function initialRelayState(): RelayState {
  return {
    actions: [],
    approvals: [],
    actionInstants: { email: [], calendar: [], github: [], drive: [], telegram: [], external: [] },
    sendInstants: [],
    telegramSendInstants: [],
    draftInstants: [],
    externalInstants: [],
    faulted: {},
  }
}


/* -------------------------------------------------------------- utilities */

/** Whether a string is a bounded opaque id. */
export function isRelayId(value: unknown, max = 128): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}


/**
 * Sanitize a display label into bounded, control-character-free data.
 *
 * Not a security boundary on its own — the label is never authority — but it
 * keeps a pathological payload from becoming a multi-megabyte string and
 * keeps terminal control sequences out of anything that might render it.
 */
export function sanitizeRelayText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const isControl =
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    if (isControl) continue
    out += character
  }
  const collapsed = out.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed
}


/** Whether a string parses as an instant. No clock read, no repair. */
export function relayInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}