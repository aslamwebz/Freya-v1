import type { BrowserExecutionContext } from '../../core/browser/runtime'
import { randomUUID } from 'node:crypto'
import type {
  BrowserAuthenticatedPort,
  BrowserJournalPort,
  BrowserProjection,
  BrowserRecoveryReport,
  BrowserRequest,
  BrowserResult,
  DualBrowserRuntime,
  RouteReading,
} from '../../core/browser'
import { createDualBrowserRuntime } from '../../core/browser'
import type { DeviceHandsActionKey } from '../../core/devicehands'
import type { DeviceHandsJournal } from '../devicehands/journal'
import type { BrowserExtensionHost } from '../browserext/host'
import type { FreyaBrowserAdapter } from './publicAdapter'

/**
 * The Phase 51 host activation.
 *
 * ## The one thing this file is careful about
 *
 * **There is exactly one authority, and it is not created here.** The activation is given a
 * {@link Phase51Authority} that the host has already wired to Core's own Device Hands
 * runtime, with Core's STOP ALL latch composed in by `electron/coreHost.ts`. This file never
 * builds a `DeviceHandsRuntime`, never reads a grant file, and never has an
 * `approvalStillValid` of its own.
 *
 * That matters because there are now **two doors** onto the browser surface — the Phase 43
 * extension bridge and this embedded window — and the cheapest way to break this
 * architecture would have been to give each door its own runtime. One runtime means one
 * grant source, one journal, one STOP ALL, one set of ten gates, and a refusal that reads
 * the same whichever browser was asked.
 *
 * ## What it does add
 *
 * Three small things, none of which is authority:
 *
 *   - a **journal port** that writes this phase's own record into the *same* hash-chained
 *     journal the Device Hands runtime already appends to, so there is one durable record
 *     with one integrity chain rather than two files that have to be believed together;
 *   - an **extension port** that answers "is there an authenticated context, and can work be
 *     continued in it" through the Phase 43 host's existing dispatch path;
 *   - the **adapter** that fills the Device Hands browser port from a window Freya owns.
 *
 * ## Activation is explicit and reversible
 *
 * `activate()` needs the owner switch *and* a journal that chains. Neither alone is enough,
 * and `deactivate()` flips this file's own switch off, so the next command is refused before
 * any routing happens.
 */

/** The Phase 35 runtime, as this file consumes it. Never constructed here. */
export interface Phase51Authority {
  /** Core's STOP ALL latch, composed by the host. Read fresh on every command. */
  stopAllActive(): boolean
  /**
   * One Device Hands action.
   *
   * The action key is the Phase 35 `DeviceHandsActionKey`, not a string: this phase routes
   * through the existing vocabulary and has no vocabulary of its own, so a new key cannot
   * be invented here by accident.
   */
  perform(request: {
    readonly actionId: string
    readonly principalId: string
    readonly scope: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Readonly<Record<string, unknown>>
    readonly at: string
    readonly deadlineAt: string
  }): Promise<{
    readonly performed: boolean
    readonly verdict: 'passed' | 'failed' | 'unverified'
    readonly code: string | null
    readonly reason: string
  }>
}

export type DualBrowserActivationState = 'active' | 'disabled'

export interface DualBrowserActivationOptions {
  readonly authority: Phase51Authority
  /** The same hash-chained journal the Device Hands runtime appends to. */
  readonly journal: DeviceHandsJournal<string>
  readonly adapter: FreyaBrowserAdapter
  /** Absent means "no extension", which refuses the authenticated target. */
  readonly extension?: BrowserExtensionHost | null
  readonly allowedHosts?: readonly string[]
  /** Development-only: remove browser budget friction. */
  readonly localUnrestricted?: boolean
  /** Development-only: permit localhost/private hosts and dev ports. */
  readonly allowPrivateHosts?: boolean
  readonly autoEscalate?: boolean
  readonly now?: () => number
  readonly newId?: () => string
  readonly limits?: { readonly maxSessions?: number; readonly handoffTtlMs?: number }
  readonly onLog?: (line: string) => void
}

export interface DualBrowserActivationStatus {
  readonly state: DualBrowserActivationState
  readonly publicAvailable: boolean
  readonly sessions: number
  readonly extensionPaired: boolean
  readonly extensionLive: boolean
  readonly journalTrustworthy: boolean
  readonly handoffsUncertain: number
  /** One sentence of facts. Never a claim about an uncertain effect. */
  readonly summary: string
}

export interface DualBrowserActivation {
  /** Replay the record, reconcile, and switch this phase on. Idempotent. */
  activate(): Promise<{ readonly ok: boolean; readonly code: string | null; readonly reason: string }>
  deactivate(reason: string): Promise<{ readonly ok: boolean; readonly reason: string }>
  active(): boolean
  readonly runtime: DualBrowserRuntime
  status(): DualBrowserActivationStatus
  recovery(): BrowserRecoveryReport
  projection(): BrowserProjection
  route(request: BrowserRequest): RouteReading
  execute(request: BrowserRequest, context?: BrowserExecutionContext): Promise<BrowserResult>
  dispose(): Promise<void>
}

/* --------------------------------------------------------------- the journal */

/**
 * This phase's journal port, over the Device Hands journal.
 *
 * Deliberately the same file. Two journals would mean two integrity chains, and a restart
 * that believed one of them could be in a state the other contradicted — which is precisely
 * the "confident fiction about what this machine has done" that
 * `electron/devicehands/journal.ts` exists to prevent.
 *
 * `trustworthy()` is the Device Hands journal's own answer, so an edited line stops the
 * *dual-browser* runtime too, before it routes anything.
 */
function journalPort(journal: DeviceHandsJournal<string>): BrowserJournalPort {
  return {
    append: (type, payload) => journal.append(type, payload),
    replay: () => journal.replay(),
    trustworthy: () => journal.trustworthy(),
  }
}

/* -------------------------------------------------------- the extension port */

/**
 * The authenticated side, through the Phase 43 host.
 *
 * Refuses honestly rather than degrading: with no extension host there is no authenticated
 * context at all, so `status()` reports unpaired and every handoff to Chrome is refused
 * `target-unavailable`.
 *
 * `sharedTabId` is read from the bridge's own live sessions rather than tracked here, so it
 * is a fact about the extension's state and not a copy that could go stale while the owner
 * was changing tabs.
 */
function extensionPort(extension: BrowserExtensionHost | null | undefined): BrowserAuthenticatedPort {
  return {
    status() {
      if (extension === null || extension === undefined) {
        return { paired: false, live: false, sharedTabId: null }
      }
      const hostState = extension.status()
      const live = hostState.connected
      const shared = live
        ? extension.bridge.sessions().find((session) => !session.revoked && session.sharedTabId !== null)
        : undefined
      return { paired: hostState.paired, live, sharedTabId: shared?.sharedTabId ?? null }
    },
    async openHandoff(request) {
      if (extension === null || extension === undefined) {
        return {
          ok: false,
          code: 'target-unavailable',
          reason: 'No Chrome extension is attached to this Freya, so there is nowhere to continue the work.',
          tabId: null,
        }
      }
      const result = await extension.continueInSharedTab({
        url: request.url,
        deadlineAt: Date.parse(request.deadlineAt),
      })
      return { ok: result.ok, code: result.code ?? 'adapter-failed', reason: result.reason, tabId: result.tabId }
    },
  }
}

/* ---------------------------------------------------------------- the object */

/**
 * Build the activation.
 *
 * Nothing is opened, connected or switched on by calling this: the runtime, the adapter and
 * the ports are constructed, and the first effect happens on `activate()`.
 */
export function createDualBrowserActivation(options: DualBrowserActivationOptions): DualBrowserActivation {
  const now = options.now ?? (() => Date.now())
  const adapter = options.adapter
  const authenticated = extensionPort(options.extension)

  const runtime = createDualBrowserRuntime({
    authority: {
      stopAllActive: () => options.authority.stopAllActive(),
      perform: (request) => options.authority.perform(request),
      activeGrant: () => null,
    },
    adapter,
    sessions: adapter,
    authenticated,
    journal: journalPort(options.journal),
    clockMs: now,
    newId: options.newId ?? (() => randomUUID()),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    localUnrestricted: options.localUnrestricted === true,
    allowPrivateHosts: options.allowPrivateHosts === true,
    ...(options.autoEscalate === undefined ? {} : { autoEscalate: options.autoEscalate }),
    ...(options.limits === undefined
      ? {}
      : {
          limits: {
            ...(options.limits.maxSessions === undefined ? {} : { maxSessions: options.limits.maxSessions }),
            ...(options.limits.handoffTtlMs === undefined ? {} : { handoffTtlMs: options.limits.handoffTtlMs }),
          },
        }),
  })

  let state: DualBrowserActivationState = 'disabled'

  /**
   * One sentence of facts, assembled from what is actually bound.
   *
   * No constructor names and no optimism: "public available" is what the adapter answered,
   * "extension paired" is what the bridge answered, and an untrustworthy journal is called
   * untrustworthy rather than folded into a reassuring sentence.
   */
  function summary(): string {
    const parts = [
      `public browser ${adapter.publicAvailable() ? 'available' : 'unavailable'}`,
      `extension ${authenticated.status().paired ? 'paired' : 'unpaired'}`,
      authenticated.status().live ? 'extension live' : 'extension not connected',
      options.journal.trustworthy() ? 'journal trustworthy' : 'journal untrustworthy',
      options.authority.stopAllActive() ? 'STOP ALL latched' : 'stop-all clear',
    ]
    return parts.join(', ')
  }

  return {
    async activate() {
      if (state === 'active') {
        return { ok: true, code: null, reason: 'The dual-browser runtime is already active.' }
      }
      if (!options.journal.trustworthy()) {
        // The same refusal Phase 35 makes, and for the same reason: a record nobody has read
        // is not a record to act on. Refusing to activate is the safe reading.
        return {
          ok: false,
          code: 'journal-untrustworthy',
          reason: 'The browser journal does not chain, so this phase did not open. Nothing was routed.',
        }
      }
      const recovery = await runtime.open()
      state = 'active'
      options.onLog?.(summary())
      return {
        ok: true,
        code: null,
        reason:
          recovery.uncertain.length === 0
            ? `The Freya Browser and the paired Chrome extension are reachable through one Device Hands authority. ${summary()}.`
            : `The Freya Browser is active with ${String(recovery.uncertain.length)} uncertain effect(s) from the last run, none of which were replayed.`,
      }
    },

    async deactivate(reason) {
      if (state !== 'active') {
        return { ok: false, reason: 'The dual-browser runtime is not active.' }
      }
      state = 'disabled'
      return { ok: true, reason: `The dual-browser runtime was deactivated: ${reason}` }
    },

    active() {
      return state === 'active'
    },

    runtime,

    status() {
      const projection = runtime.state()
      const recovery = runtime.recovery()
      const status = authenticated.status()
      return {
        state,
        publicAvailable: adapter.publicAvailable(),
        sessions: projection.sessions.length,
        extensionPaired: status.paired,
        extensionLive: status.live,
        journalTrustworthy: options.journal.trustworthy(),
        handoffsUncertain: recovery.handoffsUncertain.length,
        summary: summary(),
      }
    },

    recovery() {
      return runtime.recovery()
    },

    projection() {
      return runtime.state()
    },

    route(request) {
      return runtime.route(request)
    },

    execute(request, context) {
      if (state !== 'active') {
        return Promise.resolve({
          ok: false,
          command: request.command,
          target: null,
          code: 'subsystem-disabled' as const,
          reason: 'The dual-browser runtime is switched off, so nothing was routed.',
          escalation: null,
        })
      }
      return runtime.execute(request, context)
    },

    async dispose() {
      state = 'disabled'
      await runtime.dispose()
    },
  }
}