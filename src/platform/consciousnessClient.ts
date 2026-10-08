import {
  ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
  type ConsciousContextProjection,
} from '../../core/protocol/consciousness'
import { hostBridge } from './host'

/**
 * The renderer's view of the unified conscious context.
 *
 * A mirror, in the same sense as every other client here: every field arrived
 * over IPC from Core and the renderer cannot write one. The snapshot is Core's
 * own account of what she currently understands about herself and her
 * situation, derived inside Core from the eleven subsystems that hold the
 * authoritative state — which is why a window reading this never has to
 * assemble a story out of partial truths of its own.
 *
 * ## Why this client exists now
 *
 * The bridge declared `coreConsciousness` / `onCoreConsciousness` and the host
 * bound them, but until the Mind workspace there was no consumer, and a cache
 * with no reader is a cache nobody tests. The Mind is that consumer: it is the
 * one surface whose whole job is to answer "what is Freya currently aware of",
 * and it does so from this projection rather than from a twelfth re-derivation.
 *
 * ## What a window may do with it
 *
 * Exactly two things: pull it once and follow pushes. There is no method here
 * that rebuilds, corrects, refreshes or otherwise influences the snapshot —
 * there is no command in Core's vocabulary that returns a fresher one either,
 * so "no renderer may drive the conscious context" is true of the interface
 * rather than of the code that happens to use it.
 */

export interface ConsciousnessMirror {
  readonly projection: ConsciousContextProjection | null
  subscribe(listener: (projection: ConsciousContextProjection | null) => void): () => void
  attach(): Promise<() => void>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/**
 * Shown before Core has ever reported.
 *
 * The protocol's own frozen absent snapshot, not a locally invented one, so a
 * window that opens early says the same sentence Core would have said.
 */
const ABSENT: ConsciousContextProjection = ABSENT_CONSCIOUS_CONTEXT_PROJECTION

let shared: ConsciousnessMirror | null = null
let attachPromise: Promise<ConsciousnessMirror> | null = null

export function consciousnessMirror(): ConsciousnessMirror {
  shared ??= createConsciousnessMirror()
  return shared
}

/** Attach to the conscious context once. Safe during an effect. */
export function ensureConsciousnessAttached(): Promise<ConsciousnessMirror> {
  attachPromise ??= consciousnessMirror().attach().then(() => consciousnessMirror())
  return attachPromise
}

export function resetConsciousnessMirror(): void {
  shared = null
  attachPromise = null
}

export function createConsciousnessMirror(): ConsciousnessMirror {
  const listeners = new Set<(projection: ConsciousContextProjection | null) => void>()
  let current: ConsciousContextProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: ConsciousContextProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  return {
    get projection() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      // Push the current value immediately, so a late subscriber never renders a
      // blank panel waiting for a change that already happened.
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * Follow pushes, then read once as a backstop.
     *
     * Subscribing *first* is deliberate, for the reason every other client
     * gives: a snapshot that lands between the read resolving and the
     * subscription registering would be lost, and a mirror that silently
     * missed the newest one is exactly the failure this lane exists to prevent.
     *
     * A bridge that predates this lane (or a test double that does not model
     * it) is tolerated rather than crashing a window: the mirror simply stays
     * absent, which is the honest reading of "no conscious context here".
     */
    async attach(): Promise<() => void> {
      disposeBridge?.()
      const bridge = hostBridge()
      if (!bridge || typeof bridge.onCoreConsciousness !== 'function') return () => {}
      disposeBridge = bridge.onCoreConsciousness((projection) => publish(projection))
      try {
        publish((await bridge.coreConsciousness()) ?? ABSENT)
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
