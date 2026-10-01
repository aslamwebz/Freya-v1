import {
  ABSENT_CONTEXT_PROJECTION,
  type ContextProjection,
  type ContextReadOutcome,
} from '../../core/protocol/context'
import { hostBridge } from './host'

/**
 * The renderer's view of Context.
 *
 * A mirror, in the same sense as `workforceMirror` and `missionMirror`: every
 * field arrived from Core over a channel the window cannot write into, and the
 * renderer cannot write one either. There is no renderer-side list of things
 * that are "around" the current question, because a local list built from local
 * assumptions is exactly the thing issue #15's provenance rules exist to
 * prevent — and a window that kept one would be a second source of truth about
 * what Freya can see.
 *
 * ## What a window may do
 *
 * Two things, and both are reads: `attach()` starts following Core's pushes and
 * pulls once as a backstop, and `read()` pulls the projection again. Neither
 * submits a command. There is deliberately **no `coreSubmit` call in this
 * file**: the Workforce lane has one payloadless read command, and Context has
 * no command at all yet, because the command vocabulary and its handler live in
 * `core-protocol.ts` and `core/index.ts` — #15's and #16's authority. When a
 * `context.status.read` exists, it will be added there first and this client
 * can mirror it; until then the projection channel is the whole of the surface,
 * and there is no route from a window into the Context lane carrying a
 * provenance, a scope, a TTL, an authority or an item.
 *
 * There is also no `select`, no `revoke`, no `resolve` and no `capture`. Not
 * "not implemented yet": absent. Naming what is around a question, deciding
 * when it stops being valid, and withdrawing it are Context authority, and a
 * client with those methods would be the first step toward a renderer that
 * could argue with Core about what it saw. A caller that reaches for one gets a
 * missing method rather than a refusal it could learn to work around.
 */

export interface ContextMirror {
  readonly projection: ContextProjection | null
  subscribe(listener: (projection: ContextProjection | null) => void): () => void
  attach(): Promise<() => void>

  /**
   * Pull Core's current projection. Zero parameters, by construction: a read
   * this lane can make cannot carry anything, so it cannot carry a claim.
   */
  read(): Promise<ContextReadOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

let shared: ContextMirror | null = null
let attachPromise: Promise<ContextMirror> | null = null

export function contextMirror(): ContextMirror {
  shared ??= createContextMirror()
  return shared
}

export function ensureContextAttached(): Promise<ContextMirror> {
  attachPromise ??= contextMirror().attach().then(() => contextMirror())
  return attachPromise
}

export function resetContextMirror(): void {
  shared = null
  attachPromise = null
}

export function createContextMirror(): ContextMirror {
  const listeners = new Set<(projection: ContextProjection | null) => void>()
  let current: ContextProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: ContextProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Pull the projection and return Core's answer as an outcome.
   *
   * An unreachable Core resolves with a refusal rather than rejecting, so a
   * window reload mid-call produces a sentence on screen and not an unhandled
   * rejection. The call is made with **no arguments** — this is a pull of what
   * Core reports, never a push of what the window believes. The mirror is only
   * overwritten from an empty state: if pushes are already flowing, a pull that
   * resolves later than the newest push would otherwise write an older Core
   * truth over a newer one, and a mirror that silently regressed would be the
   * failure this client exists to prevent.
   */
  const read = async (): Promise<ContextReadOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      return {
        operation: 'refused',
        ok: false,
        reason: 'the Core bridge is not available in this window',
      }
    }
    let projection
    try {
      projection = await bridge.coreContext()
    } catch (error) {
      return {
        operation: 'refused',
        ok: false,
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    if (current === null) publish(projection ?? ABSENT_CONTEXT_PROJECTION)
    return { operation: 'status', ok: true }
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
     * Follow pushes, then pull once as a backstop.
     *
     * Subscribing *first* is deliberate, for the same reason the Workforce
     * client gives: a change that lands between the pull resolving and the
     * subscription registering would otherwise be lost.
     */
    async attach() {
      const bridge = hostBridge()
      if (!bridge) return () => {}
      // Attaching twice replaces the first subscription rather than adding one.
      disposeBridge?.()
      disposeBridge = bridge.onCoreContext((projection) => publish(projection))
      try {
        publish((await bridge.coreContext()) ?? ABSENT_CONTEXT_PROJECTION)
      } catch {
        // A Core that cannot be reached leaves the mirror absent rather than
        // throwing during a window's mount — unless a push already arrived, in
        // which case the push is the newer truth and is kept.
        if (current === null) publish(null)
      }
      return () => {
        disposeBridge?.()
        disposeBridge = null
      }
    },

    read,

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}
