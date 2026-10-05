import type {
  BrowserPortOutcome,
  BrowserPortRequest,
  DeviceHandsActionKey,
  DeviceHandsVerdict,
  GrantFact,
} from '../devicehands'
import { BROWSER_LIMITS, BROWSER_COMMAND_ACTION, type BrowserCommand, type BrowserMode, type BrowserRefusalCode, type BrowserTarget, type BrowserEventType } from './types'
import { assertPublicBrowserUrl, publicBrowserPartition } from './isolation'
import { RefTable, describePage, type PageElement, type PageSnapshot } from './refs'
import { routeBrowserIntent, type AuthenticatedContext, type AuthNeedObservation, type BrowserIntent, type RouteEscalation, type RouteReading, type RoutingContext } from './routing'
import { createHandoffEnvelope, foldHandoffs, settleUnfinished, verifyHandoffEnvelope, type HandoffEnvelope, type HandoffLedgerState } from './handoff'
import { MediaOfferLog, normaliseMediaOffer, type MediaOffer } from './media'
import { browserProjection, foldBrowserState, liveSessionCount, openHandoffCount, pageIdFor, type BrowserProjection, type BrowserRuntimeState } from './state'
import { browserRecoveryReport, type BrowserRecoveryReport } from './recovery'

/**
 * The dual-browser runtime.
 *
 * This is the only file in `core/browser` that touches a port, and it is deliberately
 * small in what it is *allowed* to do with them:
 *
 *   - The **only** route to a page is {@link BrowserAuthorityPort.perform}, which is the
 *     Phase 35 Device Hands runtime called with one of its four existing browser action
 *     keys. There is no second gate chain in this file, no shadow policy, and no code path
 *     that reaches an adapter without a `passed` verdict behind it.
 *   - The **only** things it decides itself are routing, lifecycle, references, media
 *     metadata and handoffs — none of which is authority over anything.
 *   - STOP ALL is read at the top of every command, before routing, so a latched stop
 *     refuses a `session.state` as firmly as it refuses a click.
 *
 * ## The two targets share one authority
 *
 * `page.navigate` here and `page.navigate` in the Phase 43 extension bridge map to the
 * same `browser.navigate` action key, ask for the same grant from the same source, and
 * pass the same ten gates. Choosing a different browser changes *where* the page opens. It
 * does not change *whether* Freya may.
 */

/* -------------------------------------------------------------------- ports */

export type BrowserPayload = Readonly<Record<string, string | number | boolean | null>>

/**
 * What the Phase 35 runtime answers.
 *
 * Deliberately the same three fields `DeviceHandsOutcome` carries. This module does not
 * have a richer answer and must not appear to: the moment it had one, there would be two
 * opinions about whether an action was permitted.
 */
export interface AuthorityVerdict {
  readonly performed: boolean
  readonly verdict: DeviceHandsVerdict
  readonly code: string | null
  readonly reason: string
}

export interface BrowserAuthorityPort {
  /** Core's own STOP ALL latch, composed by the host. Read fresh, every command. */
  stopAllActive(): boolean
  /**
   * One Device Hands action. The grant, the deadline, the policy and the approval are all
   * that runtime's business; this module supplies a key, an input and an id.
   */
  perform(request: {
    readonly actionId: string
    readonly principalId: string
    readonly scope: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Readonly<Record<string, unknown>>
    readonly at: string
    readonly deadlineAt: string
  }): Promise<AuthorityVerdict>
  /** The grant source, consulted for the owner's own reads only. Never for authority. */
  activeGrant(principalId: string, scope: string): GrantFact | null
}

/**
 * What an adapter observed while performing an already-authorised action.
 *
 * `revision` is the one field every command needs: it is the page's own counter, it only
 * goes up, and the runtime retires every element reference below it. An adapter that
 * cannot report a revision reports `holds: false` instead, because "I did the thing but I
 * cannot tell you which page I did it to" is not a result.
 */
export interface BrowserObservation {
  readonly revision: number
  readonly url: string | null
  readonly title?: string
  readonly elements?: unknown
  readonly text?: string
  /** For a click or a keystroke: whether anything about the page actually changed. */
  readonly changed?: boolean
  /** For a keystroke: the value read back out of the field afterwards. */
  readonly fieldValue?: string
}

export interface BrowserActionContext {
  readonly sessionId: string
  readonly target: BrowserTarget
  readonly command: BrowserCommand
  readonly deadlineAt: string
}

/**
 * The browser effect, for whichever target is running.
 *
 * Shaped exactly like the Phase 43 extension adapter's — `begin`, `performBrowser`,
 * `takeObserved`, `abandon` — because it *is* the same seam. The embedded Freya Browser and
 * the paired Chrome extension are two implementations of one port, which is the structural
 * statement that there is one browser authority and two doors.
 */
export interface BrowserAdapterPort {
  begin(sessionId: string, actionId: string, context: BrowserActionContext): void
  performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome>
  /** Read back and discard. Read once, after the verdict, never before. */
  takeObserved(actionId: string): unknown
  abandon(actionId: string): void
}

/** The window side of a session. Session lifecycle only; never a page operation. */
export interface BrowserSessionPort {
  openSession(sessionId: string, partition: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  /** The Freya Browser is activated and able to open a window. */
  publicAvailable(): boolean
}

/** The extension side. Routing asks for status; handoff asks for an open tab. */
export interface BrowserAuthenticatedPort {
  status(): AuthenticatedContext
  /**
   * Ask the extension to open one URL in the person's browser.
   *
   * This is the only way work crosses into the authenticated context, and it is reached
   * only after a handoff has been offered, verified and explicitly accepted. It is a URL
   * and nothing else — the request type has no field a cookie could arrive in.
   */
  openHandoff(request: {
    readonly handoffId: string
    readonly url: string
    readonly deadlineAt: string
  }): Promise<{ readonly ok: boolean; readonly code: string; readonly reason: string; readonly tabId: number | null }>
}

/** The durable record. The same hash-chained journal Device Hands writes to. */
export interface BrowserJournalPort {
  append(type: BrowserEventType, payload: BrowserPayload): Promise<void>
  replay(): Promise<readonly unknown[]>
  trustworthy(): boolean
}

/* ------------------------------------------------------------------- requests */

export interface BrowserRequest {
  readonly command: BrowserCommand
  readonly target?: 'public' | 'authenticated' | 'auto'
  readonly sessionId?: string
  readonly url?: string
  readonly ref?: string
  readonly text?: string
  readonly handoffId?: string
  readonly reason?: string
  readonly mediaId?: string
  readonly context?: Readonly<Record<string, string>> | null
}

export type BrowserResult =
  | { readonly ok: true; readonly command: BrowserCommand; readonly target: BrowserTarget; readonly data: Readonly<Record<string, unknown>>; readonly escalation: RouteEscalation | null }
  | { readonly ok: false; readonly command: BrowserCommand; readonly target: BrowserTarget | null; readonly code: BrowserRefusalCode; readonly reason: string; readonly escalation: RouteEscalation | null }

export interface DualBrowserRuntimeOptions {
  readonly authority: BrowserAuthorityPort
  readonly adapter: BrowserAdapterPort
  readonly sessions: BrowserSessionPort
  readonly authenticated: BrowserAuthenticatedPort
  readonly journal: BrowserJournalPort
  readonly now?: () => number
  readonly newId?: () => string
  /** Epoch milliseconds. Injected so "five minutes later" means exactly that. */
  readonly clockMs?: () => number
  /** The principal a public-session action is performed under. */
  readonly principalId?: string
  /** The owner's host allowlist for the Freya Browser. */
  readonly allowedHosts?: readonly string[]
  /** Whether the router may *propose* the authenticated target. Off by default. */
  readonly autoEscalate?: boolean
  /**
   * Narrowing only. The host may lower a ceiling; a request may not raise one.
   *
   * Written as a `Record` rather than a `Pick` of the frozen literal so the option is
   * genuinely a number, which is what a host configuration file contains. The runtime
   * still refuses a value above the code-owned ceiling when it uses one.
   */
  readonly limits?: Partial<Record<'maxSessions' | 'handoffTtlMs' | 'maxCommandMs', number>>
}

export interface DualBrowserRuntime {
  /** Replay the record and reconcile. Idempotent. Enables nothing. */
  open(): Promise<BrowserRecoveryReport>
  /** Decide a target without acting on it. For an owner-facing preview of a route. */
  route(request: BrowserRequest): RouteReading
  execute(request: BrowserRequest): Promise<BrowserResult>
  /**
   * Record that a page tried to download something.
   *
   * Called by the host when the browser reports a `will-download`, and it stores
   * **metadata only** — the offer type has no field a byte could arrive in, and the
   * download itself was already cancelled by the window. Returns the offer so the host can
   * show what was refused, or a refusal when the observation is malformed.
   */
  observeMedia(sessionId: string, observation: unknown): Promise<BrowserResult>
  state(): BrowserProjection
  recovery(): BrowserRecoveryReport
  /** Latch STOP ALL through Core and tear every session down. */
  stopAll(reason: string): void
  /** The routes this runtime has decided, for the owner's view. */
  routes(): ReadonlyMap<string, number>
  dispose(): Promise<void>
}

/* -------------------------------------------------------------------- helpers */

function readObservation(value: unknown): BrowserObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const revision = record.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null
  const url = record.url
  if (url !== null && typeof url !== 'string') return null
  return {
    revision,
    url: typeof url === 'string' ? url : null,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(record.elements === undefined ? {} : { elements: record.elements }),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(typeof record.changed === 'boolean' ? { changed: record.changed } : {}),
    ...(typeof record.fieldValue === 'string' ? { fieldValue: record.fieldValue } : {}),
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/* ------------------------------------------------------------------- runtime */

export function createDualBrowserRuntime(options: DualBrowserRuntimeOptions): DualBrowserRuntime {
  const clock = options.clockMs ?? (options.now ?? (() => Date.now()))
  const newId = options.newId ?? (() => `browser-${String(clock()).toLowerCase()}`)
  const principalId = options.principalId ?? 'agent:freya'
  /**
 * The effective ceilings: the code-owned ones, narrowed by the host.
 *
 * Narrowed by `Math.min`, never by assignment, so a configuration file that asks for a
 * *larger* pool than this build is willing to hold gets the code-owned number instead of a
 * wider one. A ceiling that a request can raise is not a ceiling.
 */
  const limits = Object.freeze({
    maxSessions: Math.max(1, Math.min(options.limits?.maxSessions ?? BROWSER_LIMITS.maxSessions, BROWSER_LIMITS.maxSessions)),
    handoffTtlMs: Math.max(1_000, Math.min(options.limits?.handoffTtlMs ?? BROWSER_LIMITS.handoffTtlMs, BROWSER_LIMITS.handoffTtlMs)),
    maxCommandMs: Math.max(1_000, Math.min(options.limits?.maxCommandMs ?? BROWSER_LIMITS.maxCommandMs, BROWSER_LIMITS.maxCommandMs)),
    maxUrlChars: BROWSER_LIMITS.maxUrlChars,
    maxOpenHandoffs: BROWSER_LIMITS.maxOpenHandoffs,
  })
  const allowedHosts = options.allowedHosts ?? []

  let stopped = false
  let enabled = false
  let sequence = 0
  let state: BrowserRuntimeState = foldBrowserState([])
  let ledger: HandoffLedgerState = foldHandoffs([])
  /**
   * Everything this phase has recorded, so `recovery()` can answer about the whole record
   * rather than about the last event.
   *
   * Seeded from the replay at `open()` and appended to alongside every journal write. It is
   * a mirror, not a second record: nothing here is written to disk, and if the journal
   * refuses an append the mirror does not grow either, so a divergence is visible as a
   * *missing* entry rather than as a second source of truth.
   */
  let recorded: readonly unknown[] = []
  let lastObservation: AuthNeedObservation | null = null
  const autoEscalate = options.autoEscalate === true

  /** One ref table and one media log per session, in maps so a close can drop them. */
  const refs = new Map<string, RefTable>()
  const media = new Map<string, MediaOfferLog>()
  const envelopes = new Map<string, HandoffEnvelope>()

  const nowIso = (): string => new Date(clock()).toISOString()

  async function record(type: BrowserEventType, payload: BrowserPayload): Promise<void> {
    try {
      await options.journal.append(type, payload)
      recorded = [...recorded, { type, recordedAt: payload.at ?? null, payload }]
    } catch {
      // A refused append is a loud failure for Device Hands, which derives its facts from
      // the record. This layer does not derive authority from it, so it degrades to an
      // unrecorded event rather than failing an action that already happened — and the
      // next command still reads `trustworthy()`.
    }
  }

  function partitionFor(sessionId: string): { ok: true; partition: string } | { ok: false; reason: string } {
    const reading = publicBrowserPartition(sessionId)
    if (!reading.ok) return { ok: false, reason: reading.reason }
    return { ok: true, partition: reading.partition }
  }

  function sessionContextFor(sessionId: string | null): RoutingContext['session'] {
    if (sessionId === null) return null
    const entry = state.sessions.get(sessionId)
    if (entry === undefined) return null
    return { exists: true, target: entry.target, open: entry.session === 'open' }
  }

  function routingContext(sessionId: string | null): RoutingContext {
    return {
      publicAvailable: options.sessions.publicAvailable(),
      authenticated: options.authenticated.status(),
      session: sessionContextFor(sessionId),
      observed: lastObservation,
      autoEscalate,
    }
  }

  function intentOf(request: BrowserRequest): BrowserIntent {
    return {
      command: request.command,
      target: request.target ?? 'auto',
      sessionId: request.sessionId ?? null,
      url: request.url ?? null,
      ref: request.ref ?? null,
      text: request.text ?? null,
    }
  }

  /**
 * Build a refusal.
 *
 * **Pure.** Recording a refusal is the caller's job — {@link execute} does it once, on the way
 * out — so that every refusal reaches the record before the caller is told about it. A
 * fire-and-forget write inside this function would let a test (and a crash) see a refusal that
 * the journal never heard of.
 */
  function refusal(
    command: BrowserCommand,
    target: BrowserTarget | null,
    code: BrowserRefusalCode,
    reason: string,
  ): BrowserResult {
    return { ok: false, command, target, code, reason, escalation: null }
  }

  /** The gate every command passes before anything is routed. */
  function halted(command: BrowserCommand): BrowserResult | null {
    if (stopped || options.authority.stopAllActive()) {
      return refusal(
        command,
        null,
        'stop-all-latched',
        'STOP ALL is latched, so no page was opened, read, clicked or handed off.',
      )
    }
    if (!enabled) {
      return refusal(command, null, 'subsystem-disabled', 'The dual-browser runtime is switched off, so nothing was routed.')
    }
    return null
  }

  function budget(command: BrowserCommand): BrowserResult | null {
    if (liveSessionCount(state) >= limits.maxSessions) {
      return refusal(command, 'public', 'budget-exceeded', `This runtime already holds ${String(limits.maxSessions)} browser session(s). Close one first.`)
    }
    return null
  }

  /* ------------------------------------------------------ the authority bridge */

  /**
   * The outcome of one gated action.
   *
   * Tagged on `refused` rather than on `ok`, because a {@link BrowserResult} for a
   * successful command is also `ok: true` — and narrowing on a discriminant two unions
   * share is how a refusal gets read as an observation.
   */
  type GateOutcome =
    | { readonly refused: true; readonly result: BrowserResult }
    | { readonly refused: false; readonly observation: BrowserObservation }

  /**
   * Run one Device Hands action, and read the adapter's observation only if it passed.
   *
   * The order is the whole point: `begin` before the action so the adapter knows which
   * command it is serving, `perform` through the gates, `takeObserved` **only** on a
   * `passed` verdict, and `abandon` in `finally` so a refused or failed action cannot leave
   * an observation lying around for a later action id to find.
   */
  async function gated(input: {
    readonly sessionId: string
    readonly target: BrowserTarget
    readonly command: BrowserCommand
    readonly actionKey: DeviceHandsActionKey
    readonly actionInput: Readonly<Record<string, unknown>>
    readonly deadlineMs: number
  }): Promise<GateOutcome> {
    const actionKey = BROWSER_COMMAND_ACTION[input.command]
    /* istanbul ignore next -- the total table makes this unreachable; it is here so that a
       future command mapped to null cannot silently skip the authority. */
    if (actionKey === null) {
      return { refused: true, result: refusal(input.command, input.target, 'authority-refused', 'That command is not an action this build routes through Device Hands.') }
    }

    const actionId = newId()
    const at = nowIso()
    const deadlineAt = new Date(clock() + input.deadlineMs).toISOString()
    options.adapter.begin(input.sessionId, actionId, {
      sessionId: input.sessionId,
      target: input.target,
      command: input.command,
      deadlineAt,
    })
    try {
      const verdict = await options.authority.perform({
        actionId,
        principalId,
        scope: input.sessionId,
        actionKey,
        input: input.actionInput,
        at,
        deadlineAt,
      })
      if (!verdict.performed) {
        // A gate refused. That is Device Hands' answer and this layer has no second opinion.
        return {
          refused: true,
          result: refusal(
            input.command,
            input.target,
            'authority-refused',
            `Device Hands refused this action (${verdict.code ?? verdict.verdict}): ${verdict.reason}`,
          ),
        }
      }
      if (verdict.verdict !== 'passed') {
        // The gate held and the page did not do it. Two different facts, and collapsing them
        // would put "Core would not let me" in the audit for a page that simply did not move.
        return {
          refused: true,
          result: refusal(
            input.command,
            input.target,
            'adapter-failed',
            `Device Hands authorised this action but the browser did not carry it out (${verdict.code ?? verdict.verdict}): ${verdict.reason}`,
          ),
        }
      }
      const observation = readObservation(options.adapter.takeObserved(actionId))
      if (observation === null) {
        // `passed` with nothing to report is a contradiction. Reporting it as a failure
        // is the safe reading: nothing is claimed that was not observed.
        return {
          refused: true,
          result: refusal(
            input.command,
            input.target,
            'adapter-failed',
            'The browser action was authorised but reported nothing about the page, so nothing is claimed about what happened.',
          ),
        }
      }
      return { refused: false, observation }
    } finally {
      options.adapter.abandon(actionId)
    }
  }

  /**
   * Move the session to the revision the page just reported, and record it.
   *
   * The state is folded from the same entry that goes into the record, so what the projection
   * says and what the journal says cannot disagree. Called after **every** action, not only a
   * navigation, because a click or a keystroke can replace the page too — and a projection that
   * only tracked navigation would keep serving a URL the window has already left.
   */
  function adoptRevision(sessionId: string, observation: BrowserObservation): number {
    const table = refs.get(sessionId)
    const entry = state.sessions.get(sessionId)
    if (table === undefined || entry === undefined) return observation.revision
    const previous = table.currentRevision
    table.retire(observation.revision)
    if (observation.revision > previous) {
      const at = nowIso()
      const url = (observation.url ?? '').slice(0, limits.maxUrlChars)
      void record('browser.dual.page.replaced', { sessionId, revision: observation.revision, url, at })
      state = foldBrowserState([{ type: 'browser.dual.page.replaced', payload: { sessionId, revision: observation.revision, url, at } }], state)
    }
    return table.currentRevision
  }

  /* --------------------------------------------------------------- the command */

  async function execute(request: BrowserRequest): Promise<BrowserResult> {
    const command = request.command

    // One way out for every refusal, so every refusal reaches the record before the caller hears
    // about it, and so there is exactly one place that knows a refusal happened.
    const settle = async (result: BrowserResult): Promise<BrowserResult> => {
      if (result.ok) return result
      const at = nowIso()
      const payload: BrowserPayload = { command, target: result.target ?? 'none', code: result.code, at }
      await record('browser.dual.refused', payload)
      state = foldBrowserState([{ type: 'browser.dual.refused', payload }], state)
      return result
    }

    const stop = halted(command)
    if (stop !== null) return await settle(stop)

    const route = routeBrowserIntent(intentOf(request), routingContext(request.sessionId ?? null))
    if (!route.ok) {
      return await settle(refusal(command, null, route.code, route.reason))
    }
    const { target, mode, escalation } = route
    const routedAt = nowIso()
    const routePayload: BrowserPayload = {
      command,
      target,
      mode,
      reason: route.reason.slice(0, 200),
      at: routedAt,
    }
    await record('browser.dual.route.decided', routePayload)
    state = foldBrowserState([{ type: 'browser.dual.route.decided', payload: routePayload }], state)

    return await settle(await dispatch(request, command, target, mode, escalation))
  }

  async function dispatch(
    request: BrowserRequest,
    command: BrowserCommand,
    target: BrowserTarget,
    mode: BrowserMode,
    escalation: RouteEscalation | null,
  ): Promise<BrowserResult> {
    switch (command) {
      case 'session.open':
        return openSession(target, escalation)
      case 'session.close':
        return closeSession(request, target, escalation)
      case 'session.state':
        return { ok: true, command, target, escalation, data: sessionStateFor(request.sessionId ?? null) }
      case 'page.navigate':
        return navigate(request, target, escalation)
      case 'page.read':
        return readPage(request, target, escalation)
      case 'page.describe':
        return describe(request, target, escalation)
      case 'page.click':
        return click(request, target, mode, escalation)
      case 'page.type':
        return type(request, target, mode, escalation)
      case 'media.describe':
        return describeMedia(request, target, escalation)
      case 'handoff.offer':
        return offerHandoff(request, target, escalation)
      case 'handoff.accept':
        return acceptHandoff(request, target, escalation)
      case 'handoff.list':
        return { ok: true, command, target, escalation, data: { handoffs: listHandoffs() } }
      case 'handoff.cancel':
        return cancelHandoff(request, target, escalation)
      /* istanbul ignore next -- exhaustive over the closed command list. */
      default:
        return refusal(command, target, 'request-malformed', 'That command is not routed.')
    }
  }

  /* ------------------------------------------------------------- session.open */

  async function openSession(target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    if (target !== 'public') {
      return refusal('session.open', target, 'target-unavailable', 'A Freya Browser session is opened in the Freya Browser.')
    }
    const over = budget('session.open')
    if (over !== null) return over

    sequence += 1
    const sessionId = `freya-${String(sequence).padStart(4, '0')}`
    const partition = partitionFor(sessionId)
    if (!partition.ok) return refusal('session.open', target, 'request-malformed', partition.reason)

    try {
      await options.sessions.openSession(sessionId, partition.partition)
    } catch (error) {
      return refusal('session.open', target, 'adapter-failed', `The Freya Browser could not be opened: ${error instanceof Error ? error.message : String(error)}`)
    }

    refs.set(sessionId, new RefTable(pageIdFor(sessionId)))
    media.set(sessionId, new MediaOfferLog())
    await record('browser.dual.session.opened', { sessionId, target, at: nowIso() })
    state = foldBrowserState([{ type: 'browser.dual.session.opened', payload: { sessionId, target, at: nowIso() } }], state)

    return {
      ok: true,
      command: 'session.open',
      target,
      escalation,
      data: { sessionId, partition: partition.partition, pageId: pageIdFor(sessionId) },
    }
  }

  /* ------------------------------------------------------------ session.close */

  async function closeSession(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const sessionId = request.sessionId ?? null
    if (sessionId === null) return refusal('session.close', target, 'request-malformed', 'Closing a session needs to name it.')
    const entry = state.sessions.get(sessionId)
    if (entry === undefined) return refusal('session.close', target, 'session-unknown', 'No such browser session.')
    if (entry.session !== 'open') {
      return { ok: true, command: 'session.close', target, escalation, data: { sessionId, alreadyClosed: true } }
    }

    await options.sessions.closeSession(sessionId)
    refs.get(sessionId)?.clear()
    media.get(sessionId)?.clear()
    refs.delete(sessionId)
    media.delete(sessionId)
    lastObservation = null
    const at = nowIso()
    await record('browser.dual.session.closed', { sessionId, target: entry.target, at })
    state = foldBrowserState([{ type: 'browser.dual.session.closed', payload: { sessionId, target: entry.target, at } }], state)
    return { ok: true, command: 'session.close', target, escalation, data: { sessionId, alreadyClosed: false } }
  }

  function sessionStateFor(sessionId: string | null): Readonly<Record<string, unknown>> {
    if (sessionId === null) {
      return { sessionId: null, session: 'closed', page: 'absent', revision: 0, url: null, observed: false }
    }
    const entry = state.sessions.get(sessionId)
    if (entry === undefined) {
      return { sessionId, session: 'closed', page: 'absent', revision: 0, url: null, observed: false }
    }
    return {
      sessionId,
      session: entry.session,
      page: entry.page,
      revision: entry.revision,
      url: entry.url,
      title: entry.title,
      observed: entry.lastObservedAt !== null,
      failureCode: entry.failureCode,
      target: entry.target,
    }
  }

  /* ----------------------------------------------------------- page.navigate */

  async function navigate(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const sessionId = request.sessionId ?? ''
    const address = assertPublicBrowserUrl(request.url, { allowedHosts, allowPrivateHosts: false })
    if (!address.ok) return refusal('page.navigate', target, 'url-refused', address.reason)

    const result = await gated({
      sessionId,
      target,
      command: 'page.navigate',
      actionKey: 'browser.navigate',
      actionInput: { url: address.url },
      deadlineMs: limits.maxCommandMs,
    })
    if (result.refused) return result.result
    const observation = result.observation
    if (observation.url === null) {
      return refusal('page.navigate', target, 'adapter-failed', 'The Freya Browser navigated but did not report where it ended up, so the page is not claimed as loaded.')
    }
    const revision = adoptRevision(sessionId, observation)
    lastObservation = readAuthNeed(observation, address.url)
    return {
      ok: true,
      command: 'page.navigate',
      target,
      escalation,
      data: { url: observation.url, revision, title: observation.title ?? null },
    }
  }

  /* --------------------------------------------------------------- page.read */

  async function readPage(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const sessionId = request.sessionId ?? ''
    const entry = state.sessions.get(sessionId)
    const url = entry?.url ?? null
    if (url === null) {
      return refusal('page.read', target, 'page-stale', 'There is no page loaded, so there is nothing to read. Describe one first by navigating.')
    }
    const result = await gated({
      sessionId,
      target,
      command: 'page.read',
      actionKey: 'browser.read-text',
      actionInput: { url },
      deadlineMs: limits.maxCommandMs,
    })
    if (result.refused) return result.result
    const observation = result.observation
    const revision = adoptRevision(sessionId, observation)
    const text = observation.text ?? ''
    lastObservation = readAuthNeed(observation, url)
    return {
      ok: true,
      command: 'page.read',
      target,
      escalation,
      data: { url, revision, bytes: new TextEncoder().encode(text).length },
    }
  }

  /* ----------------------------------------------------------- page.describe */

  async function describe(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const sessionId = request.sessionId ?? ''
    const table = refs.get(sessionId)
    const entry = state.sessions.get(sessionId)
    if (table === undefined || entry === undefined) return refusal('page.describe', target, 'session-unknown', 'No such Freya Browser session.')
    const url = entry.url
    if (url === null) {
      return refusal('page.describe', target, 'page-stale', 'There is no page loaded, so there is nothing to describe.')
    }

    const result = await gated({
      sessionId,
      target,
      command: 'page.describe',
      actionKey: 'browser.read-text',
      actionInput: { url },
      deadlineMs: limits.maxCommandMs,
    })
    if (result.refused) return result.result
    const observation = result.observation
    const revision = adoptRevision(sessionId, observation)

    const described = describePage(
      { elements: observation.elements, text: observation.text ?? '' },
      {
        pageId: pageIdFor(sessionId),
        revision,
        url: observation.url ?? url,
        title: observation.title,
      },
    )
    if (!described.ok) return refusal('page.describe', target, described.code, described.reason)

    const adopted = table.adopt(described.snapshot)
    const snapshot: PageSnapshot = described.snapshot
    await record('browser.dual.page.described', {
      sessionId,
      revision,
      elements: adopted.length,
      readBytes: snapshot.textBytes,
      at: nowIso(),
    })
    state = foldBrowserState([
      { type: 'browser.dual.page.described', payload: { sessionId, revision, elements: adopted.length, readBytes: snapshot.textBytes, at: nowIso() } },
    ], state)
    lastObservation = readAuthNeed(observation, snapshot.url)

    return {
      ok: true,
      command: 'page.describe',
      target,
      escalation,
      data: {
        pageId: snapshot.pageId,
        revision: snapshot.revision,
        url: snapshot.url,
        title: snapshot.title,
        elements: describeElements(adopted),
        truncated: snapshot.truncated,
      },
    }
  }

  /**
   * What a description hands back.
   *
   * The **selector is included**, and that is a decision worth stating: a caller that holds a
   * reference will get the locator when it acts anyway, so withholding it here only makes the
   * audit trail harder to read. What is *not* included is any element value — a described
   * field reports its label and whether it is protected, never what is typed into it.
   */
  function describeElements(elements: readonly PageElement[]): readonly Record<string, unknown>[] {
    return elements.map((element) => ({
      ref: element.ref,
      kind: element.kind,
      label: element.label,
      selector: element.selector,
      protected: element.protected,
      disabled: element.disabled,
    }))
  }

  /* -------------------------------------------------------------- act: click */

  async function actOn(
    request: BrowserRequest,
    target: BrowserTarget,
    mode: 'read' | 'act',
    command: 'page.click' | 'page.type',
  ): Promise<{ readonly refused: true; readonly result: BrowserResult } | { readonly refused: false; readonly observation: BrowserObservation }> {
    const sessionId = request.sessionId ?? ''
    const table = refs.get(sessionId)
    const entry = state.sessions.get(sessionId)
    if (table === undefined || entry === undefined) return { refused: true, result: refusal(command, target, 'session-unknown', 'No such Freya Browser session.') }
    if (entry.url === null) return { refused: true, result: refusal(command, target, 'page-stale', 'There is no page loaded, so there is nothing to act on.') }

    const resolved = table.resolve(request.ref)
    if (!resolved.ok) {
      if (resolved.code === 'page-stale') {
        await record('browser.dual.ref.stale', {
          sessionId,
          ref: (request.ref ?? '').slice(0, 60),
          refRevision: table.currentRevision,
          currentRevision: table.currentRevision,
          at: nowIso(),
        })
        state = foldBrowserState([{ type: 'browser.dual.ref.stale', payload: { sessionId, at: nowIso() } }], state)
      }
      return { refused: true, result: refusal(command, target, resolved.code, resolved.reason) }
    }

    const element = resolved.element
    const input: Record<string, unknown> = { url: entry.url, selector: element.selector }
    if (command === 'page.type') {
      if (typeof request.text !== 'string' || request.text.length === 0) {
        return { refused: true, result: refusal(command, target, 'request-malformed', 'Typing needs text to type.') }
      }
      input.text = request.text
    }
    if (mode !== 'act') {
      return { refused: true, result: refusal(command, target, 'request-malformed', 'That command does not act on a page.') }
    }

    const result = await gated({ sessionId, target, command, actionKey: command === 'page.click' ? 'browser.click' : 'browser.type-text', actionInput: input, deadlineMs: limits.maxCommandMs })
    if (result.refused) return { refused: true, result: result.result }
    const observation = result.observation

    if (command === 'page.type') {
      const readBack = observation.fieldValue
      if (typeof readBack !== 'string' || readBack !== request.text) {
        return { refused: true, result: refusal(command, target, 'adapter-failed', 'The field did not read back the text that was typed, so nothing is claimed about what the page holds.') }
      }
    }
    if (observation.changed !== true) {
      return { refused: true, result: refusal(command, target, 'adapter-failed', 'Nothing about the page changed, so the action is reported as not done rather than as a success nobody observed.') }
    }
    return { refused: false, observation }
  }

  async function click(request: BrowserRequest, target: BrowserTarget, mode: 'read' | 'act', escalation: RouteEscalation | null): Promise<BrowserResult> {
    const result = await actOn(request, target, mode, 'page.click')
    if (result.refused) return result.result
    const revision = adoptRevision(request.sessionId ?? '', result.observation)
    return { ok: true, command: 'page.click', target, escalation, data: { clicked: true, revision, url: result.observation.url } }
  }

  async function type(request: BrowserRequest, target: BrowserTarget, mode: 'read' | 'act', escalation: RouteEscalation | null): Promise<BrowserResult> {
    const result = await actOn(request, target, mode, 'page.type')
    if (result.refused) return result.result
    const revision = adoptRevision(request.sessionId ?? '', result.observation)
    return { ok: true, command: 'page.type', target, escalation, data: { typed: true, revision, url: result.observation.url } }
  }

  /* -------------------------------------------------------- media.describe */

  async function describeMedia(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const sessionId = request.sessionId ?? ''
    const log = media.get(sessionId)
    if (log === undefined) return refusal('media.describe', target, 'session-unknown', 'No such Freya Browser session.')
    const mediaId = asString(request.mediaId)
    if (mediaId === null) return refusal('media.describe', target, 'request-malformed', 'Describing media needs the id of an observed download.')
    const offer = log.get(mediaId)
    if (offer === null) {
      return refusal('media.describe', target, 'media-not-observed', 'No download was observed for that reference. A page may have offered nothing, or the bound on retained offers has passed it.')
    }
    return { ok: true, command: 'media.describe', target, escalation, data: { ...offer } }
  }

  /** What the last observation says about needing a person. Counts only; no page text. */
  function readAuthNeed(observation: BrowserObservation, requested: string): AuthNeedObservation {
    const elements = Array.isArray(observation.elements) ? observation.elements : []
    let textFields = 0
    let protectedFields = 0
    let signInAffordances = 0
    for (const entry of elements) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (record.kind === 'field') textFields += 1
      if (record.protected === true) protectedFields += 1
      const label = typeof record.label === 'string' ? record.label.toLowerCase() : ''
      if (/sign in|log in|signin|login|log in with|continue with/.test(label)) signInAffordances += 1
    }
    const outcome: AuthNeedObservation = {
      status: null,
      url: requested,
      finalUrl: observation.url,
      textFields,
      protectedFields,
      signInAffordances,
      textBytes: new TextEncoder().encode(observation.text ?? '').length,
    }
    lastObservation = outcome
    return outcome
  }

  /* ---------------------------------------------------------------- handoff */

  async function offerHandoff(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const from = target
    const to: BrowserTarget = from === 'public' ? 'authenticated' : 'public'
    if (openHandoffCount(state) >= limits.maxOpenHandoffs) {
      return refusal('handoff.offer', target, 'budget-exceeded', `This runtime already holds ${String(limits.maxOpenHandoffs)} unsettled handoff(s).`)
    }
    const entry = request.sessionId === undefined ? undefined : state.sessions.get(request.sessionId)
    const url = asString(request.url) ?? entry?.url ?? null
    if (url === null) return refusal('handoff.offer', target, 'url-refused', 'A handoff needs a URL, and there was none in the request or on the page.')

    const handoffId = newId().toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const built = createHandoffEnvelope({
      handoffId,
      from,
      to,
      url,
      reason: request.reason ?? 'carried forward by the owner',
      context: request.context ?? null,
      offeredAt: nowIso(),
      ttlMs: limits.handoffTtlMs,
    })
    if (!built.ok) return refusal('handoff.offer', target, built.code, built.reason)

    envelopes.set(built.envelope.handoffId, built.envelope)
    const at = nowIso()
    await record('browser.dual.handoff.offered', {
      handoffId: built.envelope.handoffId,
      from,
      to,
      reason: built.envelope.reason.slice(0, 200),
      at,
    })
    state = foldBrowserState([{ type: 'browser.dual.handoff.offered', payload: { handoffId: built.envelope.handoffId, from, to, reason: built.envelope.reason.slice(0, 200), at } }], state)
    ledger = foldHandoffs([{ type: 'browser.dual.handoff.offered', payload: { handoffId: built.envelope.handoffId, from, to, url, digest: built.envelope.integrity, at } }], ledger)

    return {
      ok: true,
      command: 'handoff.offer',
      target,
      escalation,
      // The envelope is returned without its integrity digest's inputs re-derived by the
      // caller: the digest is the check, and a caller that could recompute it could also
      // forge it, which is why verification recomputes rather than compares a token.
      data: { handoffId: built.envelope.handoffId, from, to, url: built.envelope.url, expiresAt: built.envelope.expiresAt, context: built.envelope.context },
    }
  }

  async function acceptHandoff(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const handoffId = asString(request.handoffId)
    if (handoffId === null) return refusal('handoff.accept', target, 'handoff-unknown', 'Accepting a handoff needs the id of one that was offered.')
    const envelope = envelopes.get(handoffId)
    if (envelope === undefined) return refusal('handoff.accept', target, 'handoff-unknown', 'No such handoff. An offer does not survive a restart; offer it again.')

    const ledgerRecord = ledger.handoffs.get(handoffId)
    const verified = verifyHandoffEnvelope(envelope, {
      to: target,
      now: clock(),
      state: ledgerRecord?.state ?? 'open',
    })
    if (!verified.ok) return refusal('handoff.accept', target, verified.code, verified.reason)

    const opened = await options.authenticated.openHandoff({
      handoffId,
      url: envelope.url,
      deadlineAt: new Date(clock() + limits.maxCommandMs).toISOString(),
    })
    const at = nowIso()
    if (!opened.ok) {
      await record('browser.dual.handoff.settled', { handoffId, state: 'cancelled', at })
      state = foldBrowserState([{ type: 'browser.dual.handoff.settled', payload: { handoffId, state: 'cancelled', at } }], state)
      ledger = foldHandoffs([{ type: 'browser.dual.handoff.settled', payload: { handoffId, state: 'cancelled', at } }], ledger)
      return refusal('handoff.accept', target, 'adapter-failed', `The extension did not open the page: ${opened.reason}`)
    }

    await record('browser.dual.handoff.consumed', { handoffId, from: envelope.from, to: envelope.to, at })
    state = foldBrowserState([{ type: 'browser.dual.handoff.consumed', payload: { handoffId, from: envelope.from, to: envelope.to, at } }], state)
    ledger = foldHandoffs([{ type: 'browser.dual.handoff.consumed', payload: { handoffId, at } }], ledger)
    envelopes.delete(handoffId)

    return { ok: true, command: 'handoff.accept', target, escalation, data: { handoffId, url: envelope.url, tabId: opened.tabId } }
  }

  function listHandoffs(): readonly Record<string, unknown>[] {
    return [...ledger.handoffs.values()]
      .sort((a, b) => a.handoffId.localeCompare(b.handoffId))
      .map((entry) => ({
        handoffId: entry.handoffId,
        from: entry.from,
        to: entry.to,
        state: entry.state,
        url: entry.url,
        offeredAt: entry.offeredAt,
        settledAt: entry.settledAt,
      }))
  }

  async function cancelHandoff(request: BrowserRequest, target: BrowserTarget, escalation: RouteEscalation | null): Promise<BrowserResult> {
    const handoffId = asString(request.handoffId)
    if (handoffId === null) return refusal('handoff.cancel', target, 'handoff-unknown', 'Cancelling a handoff needs its id.')
    const existing = ledger.handoffs.get(handoffId)
    if (existing === undefined) return refusal('handoff.cancel', target, 'handoff-unknown', 'No such handoff.')
    if (existing.state !== 'open') {
      return refusal('handoff.cancel', target, 'handoff-already-settled', `That handoff is already ${existing.state}, so there is nothing to cancel.`)
    }
    const at = nowIso()
    await record('browser.dual.handoff.settled', { handoffId, state: 'cancelled', at })
    state = foldBrowserState([{ type: 'browser.dual.handoff.settled', payload: { handoffId, state: 'cancelled', at } }], state)
    ledger = foldHandoffs([{ type: 'browser.dual.handoff.settled', payload: { handoffId, state: 'cancelled', at } }], ledger)
    envelopes.delete(handoffId)
    return { ok: true, command: 'handoff.cancel', target, escalation, data: { handoffId, state: 'cancelled' } }
  }

  /* -------------------------------------------------------------- the object */

  return {
    async open() {
      const entries = await options.journal.replay()
      const trustworthy = options.journal.trustworthy()
      recorded = entries
      state = foldBrowserState(entries)
      ledger = settleUnfinished(foldHandoffs(entries))
      // Enabling happens here and nowhere else, and it happens even when the record was
      // empty: an honest recovery report on a first run is "never opened", not a refusal.
      enabled = true
      return browserRecoveryReport({ entries, trustworthy })
    },

    route(request) {
      return routeBrowserIntent(intentOf(request), routingContext(request.sessionId ?? null))
    },

    execute,

    async observeMedia(sessionId, observation) {
      const stop = halted('media.describe')
      if (stop !== null) return stop
      const log = media.get(sessionId)
      if (log === undefined) {
        return refusal('media.describe', 'public', 'session-unknown', 'No such Freya Browser session, so there is nothing its page could have downloaded.')
      }
      const at = nowIso()
      const reading = normaliseMediaOffer(observation, { sessionId, observedAt: at })
      if (!reading.ok) return refusal('media.describe', 'public', reading.code, reading.reason)

      log.record(reading.offer)
void record('browser.dual.media.observed', {
        sessionId,
        mediaId: reading.offer.mediaId,
        mediaType: reading.offer.mediaType ?? 'none',
        bytes: reading.offer.bytes ?? 0,
        at,
      })
      state = foldBrowserState(
        [{ type: 'browser.dual.media.observed', payload: { sessionId, mediaId: reading.offer.mediaId, mediaType: reading.offer.mediaType ?? 'none', bytes: reading.offer.bytes ?? 0, at } }],
        state,
      )
      return {
        ok: true,
        command: 'media.describe',
        target: 'public',
        escalation: null,
        data: { ...reading.offer, written: false, code: 'media-write-refused' },
      }
    },

    state() {
      return browserProjection(state)
    },

    recovery() {
      return browserRecoveryReport({ entries: recorded, trustworthy: options.journal.trustworthy() })
    },

    stopAll(reason) {
      stopped = true
      enabled = false
      for (const sessionId of [...refs.keys()]) {
        void options.sessions.closeSession(sessionId).catch(() => undefined)
      }
      refs.clear()
      media.clear()
      envelopes.clear()
      void reason
    },

    routes() {
      return state.routed
    },

    async dispose() {
      // The switch, not the latch. A disposed runtime is *off*, which is a different fact from
      // a latched STOP ALL, and the two deserve different sentences in the audit.
      enabled = false
      const open = [...state.sessions.values()].filter((entry) => entry.session === 'open')
      await Promise.all(
        open.map(async (entry) => {
          try {
            await options.sessions.closeSession(entry.sessionId)
          } catch {
            // A window that cannot be closed is still recorded as closed below; the next
            // session gets a fresh partition either way.
          }
          const at = nowIso()
          await record('browser.dual.session.closed', { sessionId: entry.sessionId, target: entry.target, at })
          state = foldBrowserState([{ type: 'browser.dual.session.closed', payload: { sessionId: entry.sessionId, target: entry.target, at } }], state)
        }),
      )
      refs.clear()
      media.clear()
      envelopes.clear()
    },
  }
}

/** The observation shape, exported so an adapter in a test can build one honestly. */
export function observationOf(value: Partial<BrowserObservation> & { revision: number }): BrowserObservation {
  return { url: null, ...value }
}

/** Re-exported so a host does not have to reach into two modules for one type. */
export type { BrowserObservation as FreyaBrowserObservation, MediaOffer as FreyaMediaOffer }