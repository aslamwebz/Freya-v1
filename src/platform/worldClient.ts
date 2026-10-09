import { ABSENT_WORLD_SUMMARY, type WorldSummaryView } from '../../core/protocol/world'
import { hostBridge } from './host'

/**
 * The renderer's view of the world model — the summary, and only the summary.
 *
 * A mirror, in the same sense as every other client here: every field arrived
 * over IPC from Core and the renderer cannot write one.
 *
 * ## Why the summary and not the graph
 *
 * The bridge's world lane is deliberately the narrowest one in `host.ts`: the
 * entity graph, the relation walk, the inspector and the self status are all
 * reached through `coreSubmit` with a read command that Core Guard-evaluates.
 * This client takes the one lane that is a standing subscription, because
 * "what does Freya think she knows, and how sure is she" is exactly the
 * question a control room answers without asking for anything.
 *
 * ## What a window may do with it
 *
 * Pull it once and follow pushes. There is no method here that submits a
 * claim: the two owner-facing world commands exist in Core and are owner-only
 * through Guard, and they are absent from the preload command allowlist — so a
 * window holding this mirror cannot create an entity, a relation, a trust
 * level or a confidence even in principle.
 */

export interface WorldMirror {
  readonly projection: WorldSummaryView | null
  subscribe(listener: (projection: WorldSummaryView | null) => void): () => void
  attach(): Promise<() => void>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, in the protocol's own words. */
const ABSENT: WorldSummaryView = ABSENT_WORLD_SUMMARY

let shared: WorldMirror | null = null
let attachPromise: Promise<WorldMirror> | null = null

export function worldMirror(): WorldMirror {
  shared ??= createWorldMirror()
  return shared
}

/** Attach to the world summary once. Safe during an effect. */
export function ensureWorldAttached(): Promise<WorldMirror> {
  attachPromise ??= worldMirror().attach().then(() => worldMirror())
  return attachPromise
}

export function resetWorldMirror(): void {
  shared = null
  attachPromise = null
}

export function createWorldMirror(): WorldMirror {
  const listeners = new Set<(projection: WorldSummaryView | null) => void>()
  let current: WorldSummaryView | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: WorldSummaryView | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  return {
    get projection() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * Follow pushes, then read once as a backstop — the same order every other
     * client uses, and for the same reason: a summary that lands between the
     * read resolving and the subscription registering would be lost, and the
     * window would show a world model that was one change behind its own Core.
     *
     * A bridge that predates this lane is tolerated rather than fatal: the
     * mirror stays absent, which reads as "no world model is reporting".
     */
    async attach(): Promise<() => void> {
      disposeBridge?.()
      const bridge = hostBridge()
      if (!bridge || typeof bridge.onCoreWorld !== 'function') return () => {}
      disposeBridge = bridge.onCoreWorld((projection) => publish(projection))
      try {
        publish((await bridge.coreWorld()) ?? ABSENT)
      } catch {
        if (current === null) publish(null)
      }
      return () => {
        disposeBridge?.()
        disposeBridge = null
      }
    },

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}
