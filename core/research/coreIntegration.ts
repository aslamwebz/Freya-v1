import type { Capability } from '../protocol/core-protocol'
import type { OwnerAuthority } from '../authority'
import type { Guard } from '../security/guard'
import type { Principal } from '../security/guard'
import { ManagedBrowserService, type BrowserTargetFactory } from './browser'
import { ResearchCoordinator, type ResearchEvent } from './coordinator'
import { RESEARCH_LIMITS } from './schemas'
import { Searcher } from './searcher'
import {
  SearchSessionManager,
  type SearchSessionStore,
} from './sessions'
import type { SearchProvider } from './types'

/**
 * Phase 5 inside Core.
 *
 * The Searcher, the managed browser and the research coordinator are provider- and
 * target-agnostic and know nothing about Guard, grants or the Model Gateway. This
 * is the file that binds them to Core's existing authority machinery, and it exists
 * as one focused seam so that the binding can be read in one place.
 *
 * ## Three things happen here and nowhere else
 *
 * 1. **Guard judges every privileged operation before it happens.** Not after, and
 *    not once per research job: before each network request, each browser read and
 *    each model turn. The coordinator calls `authorize` at exactly those points, so
 *    a stop that lands mid-job closes the next operation rather than only the one
 *    in flight.
 *
 * 2. **Every model turn goes through the existing cognition path.** `ResearchModel`
 *    below holds an `OwnerAuthority` and nothing else. It cannot construct a
 *    provider, name one, or reach the gateway directly, so "the research
 *    coordinator called a provider directly" is not a state the code can reach.
 *
 * 3. **The abort signal travels with the request.** The signal handed to
 *    `authorize` is passed onward into the cognition intent, which is what closes
 *    the delayed-authorization race: an abort that lands while a grant is still
 *    being written prevents the provider call that would have followed, rather
 *    than merely cancelling a request that does not exist yet.
 *
 * ## What is deliberately absent
 *
 * No provider is constructed here and no credential is read here. The main process
 * assembles the provider from its environment and injects it; Core has no idea what
 * a Brave key is, and could not forward one even if a model asked it to.
 */

export interface ResearchIntegrationOptions {
  /**
   * The search provider, assembled by the host.
   *
   * Core never reads `BRAVE_SEARCH_API_KEY` or decides that a credential existing
   * means search is on. Enablement is the host's explicit choice, so a machine with
   * a key in its environment still does not call anything until somebody asked.
   */
  searchProvider: SearchProvider
  /** The managed read-only DOM target. Production supplies the Electron one. */
  browserFactory: BrowserTargetFactory
  authority: OwnerAuthority
  guard: Guard
  principal: Principal
  /** Reduces to fixed text; never throws, so an observer cannot fail an operation. */
  onEvent?: (event: ResearchEvent) => void
  /** Bridge to Core's journal and research state. */
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>
  /** Closes research admission synchronously. Called by STOP ALL before any await. */
  closeAdmission: (reason: string) => void
  /** True when the durable stop latch is set. */
  stopped: () => boolean
  limits?: Partial<typeof RESEARCH_LIMITS>
  /** Private search-session persistence. Production supplies the SQLCipher Vault store. */
  sessionStore?: SearchSessionStore
}

/**
 * A research model turn as one bounded, grant-backed cognition.
 *
 * The whole point of this class is that it has no way to reach a provider. It holds
 * an `OwnerAuthority` — which exposes `request`, `createGrant`, `revokeGrant` and
 * `grants`, and no provider, gateway or permit — so the only route from research to
 * a model is the Governor and the Gateway, exactly as for a conversation turn.
 */
class GrantedResearchModel {
  constructor(
    private readonly authority: OwnerAuthority,
    private readonly limits: typeof RESEARCH_LIMITS,
  ) {}

  async complete(
    messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[],
    options: { signal: AbortSignal; researchId: string; requestId: string; maxOutputTokens: number },
  ): Promise<string> {
    // One grant per model turn, created before it and revoked in a `finally`.
    //
    // Per turn rather than per job because the coordinator reports the end of a job
    // by settling its promise, and the grant would then have to be revoked from
    // outside the model adapter — where cancellation is exactly the path most likely
    // to be missed, and the one that would otherwise leave a live allowance behind.
    // Revoking here means no exit can forget it: completion, failure, refusal and
    // cancellation all run the same `finally`.
    const grantId = `research:${options.researchId}:${options.requestId}`
    await this.authority.createGrant({
      grantId,
      expiresAt: new Date(Date.now() + this.limits.durationMs).toISOString(),
      allowedOrigins: ['user'],
      allowedCauses: ['user_message'],
      goalId: null,
      runId: null,
      // Narrowed to the owner. A grant that any principal could spend would be a
      // standing allowance, and a worker that found its id could charge it.
      actor: 'owner',
      backgroundAllowed: false,
      maxCalls: this.limits.modelTurns,
      maxOutputTokens: this.limits.modelTurns * this.limits.maxOutputTokens,
    })

    try {
      const outcome = await this.authority.request({
        kind: 'user_turn',
        prompt: messages.map((message) => message.content).join('\n\n'),
        messages: messages as never,
        maxOutputTokens: Math.min(options.maxOutputTokens, this.limits.maxOutputTokens),
        grantId,
        correlationId: options.researchId,
        cognitionRequestId: options.requestId,
        // The trusted signal, narrowed from the research job. It is never a renderer
        // field: it comes from Core's own AbortController.
        signal: options.signal,
      })
      if (outcome.status === 'denied') throw new Error('the research turn was refused')
      if (outcome.status !== 'allowed') throw new Error('the research turn did not complete')
      return outcome.text
    } finally {
      // Revoked on every exit: completed, failed, refused or cancelled.
      await this.authority.revokeGrant(grantId, 'research turn finished').catch(() => false)
    }
  }
}

export class ResearchIntegration {
  readonly searcher: Searcher
  readonly browser: ManagedBrowserService
  readonly coordinator: ResearchCoordinator
  readonly sessions: SearchSessionManager

  constructor(private readonly options: ResearchIntegrationOptions) {
    this.searcher = new Searcher({ provider: options.searchProvider })
    this.browser = new ManagedBrowserService(options.browserFactory)
    this.sessions = new SearchSessionManager({
      searcher: {
        searchWeb: (query, searchOptions) => this.guardedSearchWeb(query, searchOptions),
      },
      ...(options.sessionStore ? { store: options.sessionStore } : {}),
    })
    this.coordinator = new ResearchCoordinator({
      searcher: this.searcher,
      browser: this.browser,
      model: new GrantedResearchModel(options.authority, RESEARCH_LIMITS),
      authorize: (request) => this.authorize(request),
      onEvent: (event) => {
        try {
          options.onEvent?.(event)
        } catch {
          // Observability must never become a resource owner.
        }
      },
      ...(options.limits ? { limits: options.limits } : {}),
    })
  }

  /**
   * Guard, evaluated immediately before one privileged operation.
   *
   * Throwing is the refusal: the coordinator turns it into its own bounded failure
   * code and the network, browser or provider call below never happens. Checking
   * here rather than once per job is what stops a stop that lands halfway through a
   * research job from permitting the rest of it.
   */
  private async authorize(request: {
    operation: 'research' | 'search' | 'read'
    researchId: string
    requestId: string
    signal: AbortSignal
  }): Promise<void> {
    if (request.signal.aborted) throw new Error('research was cancelled')
    if (this.options.stopped()) {
      this.options.closeAdmission('Core is stopped.')
      throw new Error('Core is stopped.')
    }
    const capability = capabilityFor(request.operation)
    const verdict = this.options.guard.evaluate(this.options.principal, capability)
    if (!verdict.allowed) throw new Error(verdict.reason)
    // The signal is threaded into the cognition intent downstream; a stop that lands
    // during the durable write below prevents the provider call that would follow.
  }

  private async guardedSearchWeb(
    query: string,
    options: { signal?: AbortSignal; limit?: number; offset?: number } = {},
  ) {
    if (this.options.stopped()) throw new Error('Core is stopped.')
    const verdict = this.options.guard.evaluate(this.options.principal, 'search.web')
    if (!verdict.allowed) throw new Error(verdict.reason)
    return this.searcher.searchWeb(query, options)
  }

  /** One guarded web search. No model is involved, so this costs nothing. */
  async searchWeb(query: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.guardedSearchWeb(query, signal ? { signal } : {})
  }

  /** One guarded page read. Creates and closes its own session. */
  async readWebPage(url: string, signal?: AbortSignal) {
    if (this.options.stopped()) throw new Error('Core is stopped.')
    const verdict = this.options.guard.evaluate(this.options.principal, 'browser.read')
    if (!verdict.allowed) throw new Error(verdict.reason)
    return this.browser.readWebPage(url, signal ? { signal } : {})
  }

  /** One guarded research job. */
  async research(question: string, signal?: AbortSignal) {
    if (this.options.stopped()) throw new Error('Core is stopped.')
    const verdict = this.options.guard.evaluate(this.options.principal, 'research.start')
    if (!verdict.allowed) throw new Error(verdict.reason)
    return this.coordinator.research(question, signal ? { signal } : {})
  }

  /**
   * Close research admission and cancel everything in flight.
   *
   * Synchronous, and called by STOP ALL in the same turn that closes the gateway.
   * A cancellation that awaited anything first would leave a window where a research
   * operation was already authorised and could still reach the network, which is the
   * window STOP ALL exists to remove.
   */
  closeAdmission(reason: string): void {
    this.coordinator.cancelAll()
    this.sessions.cancelAll()
    void this.browser.closeAll().catch(() => {})
    void reason
  }
}

function capabilityFor(operation: 'research' | 'search' | 'read'): Capability {
  if (operation === 'research') return 'research.start'
  if (operation === 'read') return 'browser.read'
  return 'search.web'
}