import type { CoreCommandResult } from '../../core/protocol/core-protocol'
import type { SelfStatusView, WorldCommandOutcome } from '../../core/protocol/world'
import { hostBridge } from './host'

/**
 * The renderer's view of the self model — the seven compartments, read once.
 *
 * ## Why this is a read and not a mirror
 *
 * Every other client here holds a push channel. The self model has none: it is
 * *read fresh every time* by design, because five of its seven compartments are
 * the most security-relevant facts in the system — which capabilities Guard
 * just granted, which procedures are promoted, which provider would answer,
 * what a worker claims about itself. A persisted or pushed copy of that would
 * be a second, stale copy of exactly the thing that must never go stale, so
 * `core/world/self.ts` builds it on demand and nothing subscribes to it.
 *
 * So this client submits `self.status.read` — one payloadless owner read that
 * is already in Core's vocabulary and already in the preload allowlist — and
 * holds the answer with the instant it was answered at. A surface says when it
 * read it, which is the only honest way to show a value Core deliberately
 * refuses to stream.
 *
 * ## What a window may do with it
 *
 * Read. There is no write verb here and none on the bridge: nothing on this
 * surface creates an entity, a relation, a trust level or a confidence, and the
 * two owner-facing world commands that could are absent from the preload
 * allowlist entirely. `separation` travels with the answer so the surface can
 * *state* the rules rather than implying them.
 */

/** What a self read produced. A refusal is a result, not an exception. */
export type SelfReadOutcome =
  | { readonly operation: 'self'; readonly ok: true; readonly self: SelfStatusView }
  | { readonly operation: 'unavailable'; readonly ok: false; readonly reason: string }
  | { readonly operation: 'refused'; readonly ok: false; readonly reason: string }

export interface SelfMirror {
  /** The last successful read, or null before one lands. */
  readonly self: SelfStatusView | null
  /** The instant of the last successful read, ISO-8601, or null. */
  readonly readAt: string | null
  /** Why no self model is held, in Core's words. Null when one is. */
  readonly reason: string | null
  subscribe(listener: () => void): () => void
  /** Submit the payloadless read. Answers in Core's own words either way. */
  read(): Promise<SelfReadOutcome>
  /** Forget the last read. For tests. */
  reset(): void
}

const NO_BRIDGE = 'the Core bridge is not available in this window'

let shared: SelfMirror | null = null

export function selfMirror(): SelfMirror {
  shared ??= createSelfMirror()
  return shared
}

export function resetSelfMirror(): void {
  shared = null
}

export function createSelfMirror(): SelfMirror {
  const listeners = new Set<() => void>()
  let current: SelfStatusView | null = null
  let readAt: string | null = null
  let reason: string | null = null

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  /**
   * Submit the one payloadless read and keep the answer.
   *
   * A Core that cannot be reached resolves with a refusal rather than
   * rejecting, because a window reloading mid-call should produce a sentence
   * on screen rather than an unhandled rejection in somebody's console. Only a
   * successful read overwrites a previous one: a refusal that arrives after a
   * good answer would otherwise erase a fact the surface was already showing
   * truthfully.
   */
  const read = async (): Promise<SelfReadOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      if (current === null) {
        reason = NO_BRIDGE
        publish()
      }
      return { operation: 'unavailable', ok: false, reason: NO_BRIDGE }
    }
    let result: CoreCommandResult
    try {
      result = await bridge.coreSubmit('self.status.read')
    } catch (error) {
      const message = `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`
      if (current === null) {
        reason = message
        publish()
      }
      return { operation: 'unavailable', ok: false, reason: message }
    }
    const outcome = result.world as WorldCommandOutcome | undefined
    if (outcome?.operation === 'self' && outcome.ok) {
      current = outcome.self
      readAt = new Date().toISOString()
      reason = null
      publish()
      return { operation: 'self', ok: true, self: outcome.self }
    }
    const message = outcome?.ok === false
      ? outcome.reason
      : result.refusal?.reason ?? result.error?.message ?? 'Core returned no self model'
    if (current === null) {
      reason = message
      publish()
    }
    return { operation: 'refused', ok: false, reason: message }
  }

  return {
    get self() {
      return current
    },
    get readAt() {
      return readAt
    },
    get reason() {
      return current === null ? reason : null
    },
    subscribe(listener) {
      listeners.add(listener)
      listener()
      return () => {
        listeners.delete(listener)
      }
    },
    read,
    reset() {
      current = null
      readAt = null
      reason = null
      publish()
    },
  }
}
