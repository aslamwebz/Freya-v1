/**
 * THE RELAY ENGINE — capability-gated execution with replay protection.
 *
 * This is the only code that turns a Relay action into an adapter call, and it
 * is written so the properties Phase 16 claims are structural:
 *
 *   - **Every gate is checked fresh, in order, and none is skippable.** STOP
 *     ALL → Guard → connector availability → budget → idempotency → approval.
 *     A refusal names the closed code that refused.
 *   - **Reads and writes are different paths.** A read executes directly under
 *     Guard + budget. A write creates a pending approval and executes only
 *     after the owner decides — and a draft is never a send, because the two
 *     are different actions on different capabilities.
 *   - **Idempotency is durable.** A write carries a client-generated key; the
 *     fold remembers it, so a replay returns the original outcome instead of
 *     performing the action twice. A replayed send is not a second send.
 *   - **Retries are bounded and explicit.** A transient adapter failure is
 *     retried at most `RELAY_LIMITS.maxRetries` times, the count is recorded,
 *     and a non-transient failure is never retried. There is no loop.
 *   - **The journal holds metadata only.** Every event this engine appends
 *     carries ids, closed labels, counts, instants and targets — never a
 *     message body, an event title, an issue's text or a credential.
 *
 * The engine holds no gateway, no authority object and no provider. It cannot
 * spend a model call, mint a capability or clear STOP ALL, because none of
 * those exists on any type it holds.
 */

import type { EventFabric } from '../events/fabric'
import { validateActionPayload } from './validation'
import {
  RELAY_ACTION_CAPABILITY,
  RELAY_ACTION_CONNECTOR,
  RELAY_ACTION_RISK,
  RELAY_LIMITS,
  isRelayAction,
  isRelayReadAction,
  sanitizeRelayText,
  type RelayAction,
  type RelayActionRecord,
  type RelayCalendarEvent,
  type RelayConnectorId,
  type RelayDriveFile,
  type RelayEmailMessage,
  type RelayFailureCode,
  type RelayGitHubIssue,
  type RelayState,
  type RelayTelegramMessage,
} from './types'
import {
  findApproval,
  findByIdempotencyKey,
  pendingApprovals,
  connectorActionsInWindow,
  draftsInWindow,
  externalInvokesInWindow,
  sendsInWindow,
  telegramSendsInWindow,
} from './state'
import {
  RelayAdapterError,
  RelayTransientError,
  type CalendarAdapter,
  type DriveAdapter,
  type EmailAdapter,
  type ExternalAdapter,
  type GitHubAdapter,
  type RelayAdapterSet,
  type TelegramAdapter,
} from './adapters'

/** What a read returned, in the bounded shape the protocol carries. */
export type RelayReadResult =
  | { readonly kind: 'email.messages'; readonly messages: readonly RelayEmailMessage[]; readonly nextCursor: string | null }
  | { readonly kind: 'calendar.events'; readonly events: readonly RelayCalendarEvent[]; readonly nextCursor: string | null }
  | { readonly kind: 'github.issues'; readonly issues: readonly RelayGitHubIssue[]; readonly nextCursor: string | null }
  | { readonly kind: 'drive.files'; readonly files: readonly RelayDriveFile[]; readonly nextCursor: string | null }
  | { readonly kind: 'telegram.messages'; readonly messages: readonly RelayTelegramMessage[]; readonly nextCursor: string | null }
  | { readonly kind: 'external.result'; readonly data: unknown }

/** What a write produced, after approval. */
export type RelayWriteResult =
  | { readonly kind: 'email.draft.created'; readonly draftId: string }
  | { readonly kind: 'email.sent'; readonly messageId: string }
  | { readonly kind: 'calendar.event.created'; readonly eventId: string }
  | { readonly kind: 'calendar.event.updated'; readonly eventId: string }
  | { readonly kind: 'calendar.event.cancelled'; readonly eventId: string }
  | { readonly kind: 'github.issue.created'; readonly number: number }
  | { readonly kind: 'github.pr.created'; readonly number: number }
  | { readonly kind: 'drive.file.created'; readonly fileId: string }
  | { readonly kind: 'telegram.sent'; readonly messageId: string }
  | { readonly kind: 'external.invoked'; readonly data: unknown }

/** The engine's answer to one action request. */
export type RelayEngineResult =
  | { readonly ok: true; readonly kind: 'read'; readonly result: RelayReadResult }
  | { readonly ok: true; readonly kind: 'pending'; readonly actionId: string; readonly approvalId: string; readonly summary: string }
  | { readonly ok: true; readonly kind: 'replayed'; readonly action: RelayActionRecord }
  | { readonly ok: false; readonly failureCode: RelayFailureCode; readonly reason: string }

/** The engine's answer to one approval decision. */
export type RelayDecisionResult =
  | { readonly ok: true; readonly kind: 'executed'; readonly result: RelayWriteResult }
  | { readonly ok: true; readonly kind: 'denied' }
  | { readonly ok: true; readonly kind: 'replayed'; readonly action: RelayActionRecord }
  | { readonly ok: false; readonly failureCode: RelayFailureCode; readonly reason: string }

export interface RelayEngineOptions {
  fabric: EventFabric
  adapters: RelayAdapterSet
  /**
   * The one place Relay asks Guard anything. The owner principal is baked in
   * here by Core, so the engine holds no principal and cannot build one.
   *
   * The verdict shape is Guard's own: `reason` is present only on a refusal,
   * so an allowed decision cannot carry a fabricated explanation.
   */
  authorizer: {
    evaluate: (capability: RelayActionCapability) => { allowed: true } | { allowed: false; reason: string }
  }
  /** Read fresh at each decision; never copied into state. */
  stopAll: () => boolean
  /** The folded Relay state, owned by Core's reducer. */
  getState: () => RelayState
  /** Repos the GitHub adapter may write to. Code-owned; empty means none. */
  allowlistedRepos?: readonly string[]
  /** Telegram chats reads and sends may target. Code-owned; empty means none. */
  allowlistedChats?: readonly string[]
  now?: () => Date
  newId?: () => string
}

  type RelayActionCapability = (typeof RELAY_ACTION_CAPABILITY)[RelayAction]

  /** What any adapter call returns: a read result or a write result. */
  type RelayAdapterResult = RelayReadResult | RelayWriteResult

  /** A refusal with a closed code, so the journal names what stopped the action. */
function refused(failureCode: RelayFailureCode, reason: string): RelayEngineResult {
  return { ok: false, failureCode, reason }
}

function decisionRefused(failureCode: RelayFailureCode, reason: string): RelayDecisionResult {
  return { ok: false, failureCode, reason }
}

export class RelayEngine {
  private readonly fabric: EventFabric
  private readonly adapters: RelayAdapterSet
  private readonly authorizer: RelayEngineOptions['authorizer']
  private readonly stopAll: () => boolean
  private readonly getState: () => RelayState
  private readonly allowlistedRepos: ReadonlySet<string>
  private readonly allowlistedChats: ReadonlySet<string>
  private readonly now: () => Date
  private readonly newId: () => string
  /**
   * The validated payloads of pending writes, by action id.
   *
   * **Process-local, never journaled.** This is the same bargain attention
   * makes with a schedule's text: the content crosses once, in the request,
   * and is held only in the process that is about to act on it. A pending
   * approval recovered from the journal after a restart has no payload here,
   * so it cannot execute — it is cancelled with a stated reason rather than
   * fired without its content.
   */
  private readonly payloads = new Map<string, Record<string, unknown>>()

  constructor(options: RelayEngineOptions) {
    this.fabric = options.fabric
    this.adapters = options.adapters
    this.authorizer = options.authorizer
    this.stopAll = options.stopAll
    this.getState = options.getState
    this.allowlistedRepos = new Set(options.allowlistedRepos ?? [])
    this.allowlistedChats = new Set(options.allowlistedChats ?? [])
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Reconcile pending approvals recovered from the journal.
   *
   * A pending approval whose payload was in a previous process's memory
   * cannot be executed — firing it would either lose the content or invent
   * one. It is cancelled with a stated reason, which is the truthful outcome
   * and the same honesty Work applies to an interrupted run.
   */
  async reconcile(): Promise<void> {
    for (const approval of pendingApprovals(this.getState())) {
      if (this.payloads.has(approval.actionId)) continue
      await this.fabric.append(
        'relay.approval.expired',
        { approvalId: approval.approvalId, actionId: approval.actionId },
        { actor: 'system', correlationId: approval.approvalId },
      )
      await this.fabric.append(
        'relay.action.cancelled',
        { actionId: approval.actionId, failureCode: 'approval_expired' },
        { actor: 'system', correlationId: approval.actionId },
      )
    }
  }

  /**
   * The connectors that are registered, with the actions each supports.
   *
   * Truthful by construction: a connector with no adapter is `unavailable`,
   * and the projection reports exactly this. A renderer cannot forge
   * availability, because it never sees the registry — only this projection.
   */
  connectorStatus(connector: RelayConnectorId): 'ready' | 'unavailable' | 'faulted' {
    if (connector === 'external') {
      const registered = this.adapters.external ?? {}
      return Object.keys(registered).length > 0 ? 'ready' : 'unavailable'
    }
    const adapter = this.adapters[connector]
    if (adapter === undefined) return 'unavailable'
    if (this.getState().faulted[connector] !== undefined) return 'faulted'
    return 'ready'
  }

  /**
   * Execute one action request.
   *
   * Reads execute directly. Writes create a pending approval and return
   * without touching the adapter — the action runs only from `decide`, after
   * the owner has said yes.
   */
  async execute(input: { action: unknown; payload: unknown }): Promise<RelayEngineResult> {
    if (!isRelayAction(input.action)) {
      return refused('unknown_action', 'that is not a Relay action')
    }
    const action = input.action
    const connector = RELAY_ACTION_CONNECTOR[action]

    // STOP ALL first, synchronously, before anything else. A stopped Core
    // does not reach a connector, read or write.
    if (this.stopAll()) {
      return refused('stop_all', 'Freya is stopped. Every Relay action is refused.')
    }

    const capability = RELAY_ACTION_CAPABILITY[action]
    const decision = this.authorizer.evaluate(capability)
    if (!decision.allowed) {
      return refused('capability_denied', decision.reason)
    }

    const status = this.connectorStatus(connector)
    if (status === 'unavailable') {
      return refused('connector_unavailable', `the ${connector} connector is not configured in this build`)
    }
    if (status === 'faulted') {
      return refused('connector_faulted', `the ${connector} connector is faulted: ${this.getState().faulted[connector]}`)
    }

    const validated = validateActionPayload(action, input.payload)
    if (!validated.ok) {
      return refused('validation_failed', validated.reason)
    }
    const payload = validated.value

    // The budget ledger: Relay's Governor. Durable, deny-by-default, and
    // checked before the action is even recorded.
    const budget = this.checkBudget(action, connector)
    if (budget !== null) {
      return refused('budget_exceeded', budget)
    }

    if (isRelayReadAction(action)) {
      return await this.executeRead(action, payload)
    }
    return await this.requestWrite(action, connector, payload)
  }

  /**
   * Decide a pending approval.
   *
   * Single-use: a pending approval can be decided once, and a decided one is
   * never re-decided — the stale-approval-reuse attack finds the record
   * already terminal and is refused.
   */
  async decide(approvalId: string, decision: 'approved' | 'denied'): Promise<RelayDecisionResult> {
    if (this.stopAll()) {
      return decisionRefused('stop_all', 'Freya is stopped. Every Relay decision is refused.')
    }
    const gate = this.authorizer.evaluate('relay.approval.decide' as RelayActionCapability)
    if (!gate.allowed) {
      return decisionRefused('capability_denied', gate.reason)
    }
    const state = this.getState()
    const approval = findApproval(state, approvalId)
    if (approval === undefined || approval.status !== 'pending') {
      return decisionRefused('approval_unknown', 'no pending approval with that id')
    }
    const requestedMs = Date.parse(approval.requestedAt)
    if (!Number.isFinite(requestedMs) || this.now().getTime() - requestedMs > RELAY_LIMITS.approvalTtlMs) {
      return decisionRefused('approval_expired', 'the approval request has expired')
    }

    const action = state.actions.find((record) => record.actionId === approval.actionId)
    if (action === undefined) {
      return decisionRefused('approval_unknown', 'the approval’s action is no longer held')
    }

    // The payload is process-local. A pending approval recovered from the
    // journal after a restart has none — it was cancelled by `reconcile`,
    // and reaching this line means the record is inconsistent, so the
    // honest answer is a refusal rather than an execution with no content.
    const payload = this.payloads.get(action.actionId)
    if (payload === undefined) {
      return decisionRefused('approval_expired', 'the approval’s content is no longer available')
    }

    await this.fabric.append(
      'relay.approval.decided',
      { approvalId: approval.approvalId, actionId: action.actionId, decision, decidedBy: 'owner' },
      { actor: 'owner', correlationId: approval.approvalId },
    )

    if (decision === 'denied') {
      this.payloads.delete(action.actionId)
      await this.fabric.append(
        'relay.action.cancelled',
        { actionId: action.actionId, failureCode: 'approval_denied' },
        { actor: 'owner', correlationId: action.actionId },
      )
      return { ok: true, kind: 'denied' }
    }

    return await this.executeApproved(action, payload)
  }

  /* -------------------------------------------------------------- reads */

  private async executeRead(action: RelayAction, payload: Record<string, unknown>): Promise<RelayEngineResult> {
    const actionId = this.newId()

    try {
      const result = await this.callAdapter(action, payload)
      const readResult = result as unknown as RelayReadResult
      await this.fabric.append(
        'relay.action.executed',
        {
          actionId,
          connector: RELAY_ACTION_CONNECTOR[action],
          action,
          outcome: 'read',
          resultKind: readResult.kind,
          retries: 0,
        },
        { actor: 'owner', correlationId: actionId },
      )
      return { ok: true, kind: 'read', result: readResult }
    } catch (error) {
      const code = error instanceof RelayTransientError ? 'transient_error' : 'adapter_error'
      await this.fabric.append(
        'relay.action.failed',
        {
          actionId,
          connector: RELAY_ACTION_CONNECTOR[action],
          action,
          failureCode: code,
          retries: 0,
        },
        { actor: 'owner', correlationId: actionId },
      )
      return refused(code, safeReason(error))
    }
  }

  /* -------------------------------------------------------------- writes */

  /**
   * Record a write request as a pending approval.
   *
   * The adapter is not called. The action exists as a journal record and a
   * pending approval, and nothing happens until the owner decides.
   */
  private async requestWrite(
    action: RelayAction,
    connector: RelayConnectorId,
    payload: Record<string, unknown>,
  ): Promise<RelayEngineResult> {
    const state = this.getState()
    const idempotencyKey = payload.idempotencyKey as string

    // Replay protection, checked before anything is recorded: a key the fold
    // already holds is answered with the original outcome, never a second
    // execution. A replayed send is not a send.
    const existing = findByIdempotencyKey(state, idempotencyKey)
    if (existing !== undefined) {
      return { ok: true, kind: 'replayed', action: existing }
    }

    if (pendingApprovals(state).length >= RELAY_LIMITS.maxPendingApprovals) {
      return refused('budget_exceeded', `at most ${RELAY_LIMITS.maxPendingApprovals} approvals may be pending at once`)
    }

    const actionId = this.newId()
    const approvalId = this.newId()
    const summary = writeSummary(action, payload)

    // Held in process memory only. The journal records the request's metadata;
    // the content crosses once, in the request, and is never written down.
    this.payloads.set(actionId, payload)

    await this.fabric.append(
      'relay.action.requested',
      {
        actionId,
        connector,
        action,
        risk: RELAY_ACTION_RISK[action],
        idempotencyKey,
        summary,
      },
      { actor: 'owner', correlationId: actionId },
    )
    await this.fabric.append(
      'relay.approval.requested',
      {
        approvalId,
        actionId,
        connector,
        action,
        risk: RELAY_ACTION_RISK[action],
        summary,
      },
      { actor: 'owner', correlationId: approvalId },
    )
    return { ok: true, kind: 'pending', actionId, approvalId, summary }
  }

  /**
   * Execute an approved write, with the bounded retry policy.
   *
   * A transient failure is retried at most `RELAY_LIMITS.maxRetries` times and
   * the count is recorded. A non-transient failure is never retried. Either
   * way the action settles once: there is no loop, and a retry is never a
   * silent second attempt.
   */
  private async executeApproved(action: RelayActionRecord, payload: Record<string, unknown>): Promise<RelayDecisionResult> {
    this.payloads.delete(action.actionId)
    let retries = 0
    for (;;) {
      try {
        const result = await this.callAdapter(action.action, payload)
        const writeResult = result as unknown as RelayWriteResult
        await this.fabric.append(
          'relay.action.executed',
          {
            actionId: action.actionId,
            connector: action.connector,
            action: action.action,
            outcome: 'write',
            resultKind: writeResult.kind,
            retries,
          },
          { actor: 'owner', correlationId: action.actionId },
        )
        return { ok: true, kind: 'executed', result: writeResult }
      } catch (error) {
        if (error instanceof RelayTransientError && retries < RELAY_LIMITS.maxRetries) {
          retries += 1
          continue
        }
        const code = error instanceof RelayTransientError ? 'transient_error' : 'adapter_error'
        await this.fabric.append(
          'relay.action.failed',
          {
            actionId: action.actionId,
            connector: action.connector,
            action: action.action,
            failureCode: code,
            retries,
          },
          { actor: 'owner', correlationId: action.actionId },
        )
        return decisionRefused(code, safeReason(error))
      }
    }
  }

  /* -------------------------------------------------------------- shared */

  /**
   * The budget check, shared by reads and writes.
   *
   * Per-connector action cap, plus the send/draft/external caps that apply to
   * this action. Every figure is derived from the journal, so a restart
   * cannot reset a budget — the same honesty the attention fold applies to
   * its own windows.
   */
  private checkBudget(action: RelayAction, connector: RelayConnectorId): string | null {
    const state = this.getState()
    const now = this.now().getTime()
    if (connectorActionsInWindow(state, connector, now) >= RELAY_LIMITS.maxActionsPerConnectorPerWindow) {
      return `the ${connector} connector has reached its ${RELAY_LIMITS.budgetWindowMs / 60_000}-minute action ceiling`
    }
    if (action === 'email.send' && sendsInWindow(state, now) >= RELAY_LIMITS.maxSendsPerWindow) {
      return `at most ${RELAY_LIMITS.maxSendsPerWindow} emails may be sent per ${RELAY_LIMITS.budgetWindowMs / 60_000} minutes`
    }
    if (action === 'email.draft.create' && draftsInWindow(state, now) >= RELAY_LIMITS.maxDraftsPerWindow) {
      return `at most ${RELAY_LIMITS.maxDraftsPerWindow} drafts may be created per ${RELAY_LIMITS.budgetWindowMs / 60_000} minutes`
    }
    if (action === 'telegram.send' && telegramSendsInWindow(state, now) >= RELAY_LIMITS.maxTelegramSendsPerWindow) {
      return `at most ${RELAY_LIMITS.maxTelegramSendsPerWindow} Telegram messages may be sent per ${RELAY_LIMITS.budgetWindowMs / 60_000} minutes`
    }
    if (action === 'external.invoke' && externalInvokesInWindow(state, now) >= RELAY_LIMITS.maxExternalInvokesPerWindow) {
      return `at most ${RELAY_LIMITS.maxExternalInvokesPerWindow} external invocations are allowed per ${RELAY_LIMITS.budgetWindowMs / 60_000} minutes`
    }
    return null
  }

  /**
   * Call the adapter for one validated action.
   *
   * The only place an adapter is reached. The payload is the validated,
   * normalized value from `validation.ts` — never the raw request.
   */
  private async callAdapter(action: RelayAction, payload: Record<string, unknown>): Promise<RelayAdapterResult> {
    switch (action) {
      case 'email.read': {
        const adapter = this.requireEmail()
        const messages = await adapter.listMessages({
          query: (payload.query as string | null) ?? null,
          limit: payload.limit as number,
          cursor: (payload.cursor as string | null) ?? null,
          messageId: (payload.messageId as string | null) ?? null,
        })
        return { kind: 'email.messages', messages, nextCursor: null }
      }
      case 'email.draft.create': {
        const adapter = this.requireEmail()
        const result = await adapter.createDraft({
          to: (payload.to as string[]).map((address) => ({ address })),
          cc: (payload.cc as string[]).map((address) => ({ address })),
          subject: payload.subject as string,
          body: payload.body as string,
          attachments: (payload.attachments as { filename: string; contentType: string; sizeBytes: number }[]) ?? [],
        })
        return { kind: 'email.draft.created', draftId: result.draftId }
      }
      case 'email.send': {
        const adapter = this.requireEmail()
        const result = await adapter.send({
          to: (payload.to as string[]).map((address) => ({ address })),
          cc: (payload.cc as string[]).map((address) => ({ address })),
          subject: payload.subject as string,
          body: payload.body as string,
          attachments: (payload.attachments as { filename: string; contentType: string; sizeBytes: number }[]) ?? [],
          idempotencyKey: payload.idempotencyKey as string,
        })
        return { kind: 'email.sent', messageId: result.messageId }
      }
      case 'calendar.read': {
        const adapter = this.requireCalendar()
        const events = await adapter.listEvents({
          query: (payload.query as string | null) ?? null,
          limit: payload.limit as number,
          cursor: (payload.cursor as string | null) ?? null,
        })
        return { kind: 'calendar.events', events, nextCursor: null }
      }
      case 'calendar.create': {
        const adapter = this.requireCalendar()
        const result = await adapter.createEvent({
          title: payload.title as string,
          startsAt: payload.startsAt as string,
          endsAt: payload.endsAt as string,
          location: (payload.location as string | null) ?? null,
          attendees: (payload.attendees as string[]) ?? [],
        })
        return { kind: 'calendar.event.created', eventId: result.eventId }
      }
      case 'calendar.update': {
        const adapter = this.requireCalendar()
        const result = await adapter.updateEvent({
          eventId: payload.eventId as string,
          title: (payload.title as string | null) ?? null,
          startsAt: (payload.startsAt as string | null) ?? null,
          endsAt: (payload.endsAt as string | null) ?? null,
          location: payload.location as string | null | undefined,
          attendees: payload.attendees as string[] | undefined,
        })
        return { kind: 'calendar.event.updated', eventId: result.eventId }
      }
      case 'calendar.cancel': {
        const adapter = this.requireCalendar()
        const result = await adapter.cancelEvent(payload.eventId as string)
        return { kind: 'calendar.event.cancelled', eventId: result.eventId }
      }
      case 'github.read': {
        const adapter = this.requireGitHub()
        const issues = await adapter.listIssues(payload.repo as { owner: string; repo: string }, {
          query: null,
          limit: payload.limit as number,
          cursor: (payload.cursor as string | null) ?? null,
        })
        return { kind: 'github.issues', issues, nextCursor: null }
      }
      case 'github.issue.create': {
        const adapter = this.requireGitHub()
        this.requireAllowlisted(payload.repo as { owner: string; repo: string })
        const result = await adapter.createIssue({
          repo: payload.repo as { owner: string; repo: string },
          title: payload.title as string,
          body: payload.body as string,
        })
        return { kind: 'github.issue.created', number: result.number }
      }
      case 'github.pr.create': {
        const adapter = this.requireGitHub()
        this.requireAllowlisted(payload.repo as { owner: string; repo: string })
        const result = await adapter.createPr({
          repo: payload.repo as { owner: string; repo: string },
          head: payload.head as string,
          base: payload.base as string,
          title: payload.title as string,
          body: payload.body as string,
        })
        return { kind: 'github.pr.created', number: result.number }
      }
      case 'drive.read': {
        const adapter = this.requireDrive()
        const files = await adapter.listFiles({
          query: (payload.query as string | null) ?? null,
          limit: payload.limit as number,
          cursor: (payload.cursor as string | null) ?? null,
          messageId: (payload.messageId as string | null) ?? null,
        })
        return { kind: 'drive.files', files, nextCursor: null }
      }
      case 'drive.file.create': {
        const adapter = this.requireDrive()
        const result = await adapter.createFile({
          name: payload.name as string,
          mimeType: payload.mimeType as string,
          content: payload.content as string,
        })
        return { kind: 'drive.file.created', fileId: result.fileId }
      }
      case 'telegram.read': {
        const adapter = this.requireTelegram()
        const chatId = payload.chatId as string
        this.requireAllowlistedChat(chatId)
        const messages = await adapter.listMessages(chatId, {
          query: (payload.query as string | null) ?? null,
          limit: payload.limit as number,
          cursor: (payload.cursor as string | null) ?? null,
        })
        return { kind: 'telegram.messages', messages, nextCursor: null }
      }
      case 'telegram.send': {
        const adapter = this.requireTelegram()
        const chatId = payload.chatId as string
        this.requireAllowlistedChat(chatId)
        const result = await adapter.sendMessage({
          chatId,
          text: payload.text as string,
          idempotencyKey: payload.idempotencyKey as string,
        })
        return { kind: 'telegram.sent', messageId: result.messageId }
      }
      case 'external.invoke': {
        const connector = payload.connector as string
        const adapter = this.requireExternal(connector)
        const result = await adapter.invoke({
          connector,
          operation: payload.operation as string,
          params: (payload.params as (string | number | boolean)[]) ?? [],
          idempotencyKey: payload.idempotencyKey as string,
        })
        return { kind: 'external.result', data: result.data }
      }
    }
  }

  private requireEmail(): EmailAdapter {
    const adapter = this.adapters.email
    if (adapter === undefined) throw new RelayAdapterError('the email connector is not configured')
    return adapter
  }

  private requireCalendar(): CalendarAdapter {
    const adapter = this.adapters.calendar
    if (adapter === undefined) throw new RelayAdapterError('the calendar connector is not configured')
    return adapter
  }

  private requireGitHub(): GitHubAdapter {
    const adapter = this.adapters.github
    if (adapter === undefined) throw new RelayAdapterError('the GitHub connector is not configured')
    return adapter
  }

  private requireDrive(): DriveAdapter {
    const adapter = this.adapters.drive
    if (adapter === undefined) throw new RelayAdapterError('the Drive connector is not configured')
    return adapter
  }

  private requireTelegram(): TelegramAdapter {
    const adapter = this.adapters.telegram
    if (adapter === undefined) throw new RelayAdapterError('the Telegram connector is not configured')
    return adapter
  }

  private requireExternal(connector: string): ExternalAdapter {
    const adapter = this.adapters.external?.[connector]
    if (adapter === undefined) {
      throw new RelayAdapterError(`the external connector "${connector}" is not registered`)
    }
    return adapter
  }

  /**
   * The GitHub repo allowlist.
   *
   * Code-owned and host-supplied. An empty list means no repo may be written
   * to — deny by default. Registering a GitHub adapter does not put any repo
   * on the list; the host must name them explicitly.
   */
  private requireAllowlisted(repo: { owner: string; repo: string }): void {
    if (this.allowlistedRepos.size === 0) {
      throw new RelayAdapterError('no GitHub repository is allowlisted in this build')
    }
    const ref = `${repo.owner}/${repo.repo}`
    if (!this.allowlistedRepos.has(ref)) {
      throw new RelayAdapterError(`the repository ${ref} is not allowlisted`)
    }
  }

  /**
   * The Telegram chat allowlist.
   *
   * Code-owned and host-supplied. An empty list means no chat may be read from
   * or written to — deny by default. Registering a Telegram adapter does not
   * put any chat on the list; the host must name them explicitly, which is what
   * makes "no silent chat enumeration" structural rather than a promise.
   */
  private requireAllowlistedChat(chatId: string): void {
    if (this.allowlistedChats.size === 0) {
      throw new RelayAdapterError('no Telegram chat is allowlisted in this build')
    }
    if (!this.allowlistedChats.has(chatId)) {
      throw new RelayAdapterError(`the chat ${chatId} is not allowlisted`)
    }
  }
}

/** A bounded, closed reason for a journal line. Never an adapter's raw text. */
function safeReason(error: unknown): string {
  if (error instanceof RelayTransientError) return 'the connector reported a transient failure'
  if (error instanceof RelayAdapterError) return 'the connector refused the request'
  return 'the connector failed'
}

/**
 * The approval summary: targets and metadata, never content.
 *
 * This sentence is written into the journal and the projection, so it carries
 * who will be affected and what will happen — never what was said.
 */
function writeSummary(action: RelayAction, payload: Record<string, unknown>): string {
  const to = (payload.to as string[]) ?? []
  const cc = (payload.cc as string[]) ?? []
  switch (action) {
    case 'email.send':
      return `Send email to ${formatRecipients(to, cc)}`
    case 'email.draft.create':
      return `Save a draft to ${formatRecipients(to, cc)}`
    case 'calendar.create':
      return `Create calendar event at ${payload.startsAt} with ${(payload.attendees as string[])?.length ?? 0} attendee(s)`
    case 'calendar.update':
      return `Update calendar event ${payload.eventId}`
    case 'calendar.cancel':
      return `Cancel calendar event ${payload.eventId}`
    case 'github.issue.create':
      return `Create an issue in ${(payload.repo as { owner: string; repo: string }).owner}/${(payload.repo as { owner: string; repo: string }).repo}`
    case 'github.pr.create':
      return `Create a pull request in ${(payload.repo as { owner: string; repo: string }).owner}/${(payload.repo as { owner: string; repo: string }).repo} (${payload.head} → ${payload.base})`
    case 'drive.file.create':
      return `Create a Drive file named ${sanitizeRelayText(payload.name, 80)}`
    case 'telegram.send':
      return `Send a Telegram message to chat ${payload.chatId}`
    case 'external.invoke':
      return `Invoke ${payload.connector}.${payload.operation}`
    default:
      return 'Perform a Relay action'
  }
}

function formatRecipients(to: readonly string[], cc: readonly string[]): string {
  const all = [...to, ...cc]
  if (all.length === 0) return 'no recipients'
  if (all.length <= 3) return all.join(', ')
  return `${all.slice(0, 3).join(', ')} and ${all.length - 3} more`
}
