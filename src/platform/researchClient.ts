import type { ResearchCommandOutcome } from '../../core/protocol/core-protocol'
import { hostBridge } from './host'

/**
 * The renderer's view of Phase 5 research.
 *
 * A mirror in the same sense `conversationClient` is one: every field arrived over
 * IPC from Core, and the renderer cannot write one. There is no renderer-side cache
 * of results and no optimistic "searching…" row built locally.
 *
 * What the window may send is a question, a query, a URL or an operation id. That is
 * the whole input surface, and it is worth stating why the omissions matter:
 *
 *  - no provider, so a window cannot point research at something else;
 *  - no limits or budget, so a window cannot raise the ceiling that exists to bound
 *    what Freya spends;
 *  - no provenance, so a window cannot label its own input as trusted;
 *  - no capability and no principal, because a window is not an authority.
 */

/** Whether a provider is available, as Core reports it. Null before it has said. */
export type ResearchAvailability = 'ready' | 'unconfigured' | 'disabled' | 'unknown'

export interface ResearchStatus {
  /** True while an operation is running. */
  busy: boolean
  /** The operation id, which is what cancel needs. Null when idle. */
  operationId: string | null
  /** A closed stage name from Core. Never rendered as free text. */
  stage: string | null
  availability: ResearchAvailability
  /** Why research is unavailable, in Core's own words. */
  reason: string | null
}

export interface ResearchMirror {
  readonly status: ResearchStatus
  subscribe(listener: (status: ResearchStatus) => void): () => void
  /** Ask once, on attach, so a window reopening knows what is running. */
  refresh(): Promise<void>

  searchWeb(query: string): Promise<ResearchCommandOutcome>
  readWebPage(url: string): Promise<ResearchCommandOutcome>
  research(question: string): Promise<ResearchCommandOutcome>
  cancel(researchId: string): Promise<ResearchCommandOutcome>
  statusRead(): Promise<ResearchCommandOutcome>

  reset(): void
}

const IDLE: ResearchStatus = {
  busy: false,
  operationId: null,
  stage: null,
  // 'unknown' rather than 'ready': a window that has not asked cannot claim to know
  // whether a provider is configured, and "no results yet" must be distinguishable
  // from "nothing is configured".
  availability: 'unknown',
  reason: null,
}

let shared: ResearchMirror | null = null

export function researchMirror(): ResearchMirror {
  shared ??= createResearchMirror()
  return shared
}

export function resetResearchMirror(): void {
  shared = null
}

export function createResearchMirror(): ResearchMirror {
  const listeners = new Set<(status: ResearchStatus) => void>()
  let current: ResearchStatus = IDLE

  const publish = (next: ResearchStatus): void => {
    current = next
    for (const listener of [...listeners]) listener(next)
  }

  const submit = async (
    command: 'search.web' | 'browser.read' | 'research.start' | 'research.cancel' | 'research.status.read',
    payload?: unknown,
  ): Promise<ResearchCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      return { operation: 'refused', reason: 'the Core bridge is not available in this window' }
    }
    let result
    try {
      result = await bridge.coreSubmit(command, payload)
    } catch (error) {
      // A Core that cannot be reached resolves to a refusal rather than rejecting, so
      // a window reloading mid-call produces a sentence on screen instead of an
      // unhandled rejection in a React effect.
      return {
        operation: 'refused',
        reason: `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
    return (result.research as ResearchCommandOutcome | undefined) ?? {
      operation: 'refused',
      reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no research result',
    }
  }

  return {
    get status() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    async refresh() {
      const outcome = await this.statusRead()
      const status = outcome.status ?? null
      publish({
        busy: status !== null,
        operationId: status?.operationId ?? null,
        stage: status?.stage ?? null,
        availability: current.availability,
        reason: current.reason,
      })
      if (outcome.operation === 'refused' && outcome.reason) {
        publish({ ...current, availability: 'unconfigured', reason: outcome.reason })
      }
    },

    searchWeb: (query) => submit('search.web', { query }),
    readWebPage: (url) => submit('browser.read', { url }),
    research: (question) => submit('research.start', { question }),
    cancel: (researchId) => submit('research.cancel', { researchId }),
    statusRead: () => submit('research.status.read'),

    reset() {
      current = IDLE
      publish(IDLE)
    },
  }
}