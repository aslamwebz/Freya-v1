import {
  ABSENT_PERSONALITY_PROJECTION,
  type PersonalityProjection,
  type PersonalityReadOutcome,
} from '../../core/protocol/personality'
import { hostBridge } from './host'

/**
 * The renderer's view of Personality and relationship.
 *
 * A mirror, in the same sense as `workforceMirror` and `contextMirror`: every
 * field arrived from Core over a channel the window cannot write into, and the
 * renderer cannot write one either. There is no renderer-side relationship
 * record, because a local list of habits, preferences or inside jokes is a
 * second source of truth about what Freya knows about a person — and the one a
 * person would trust more than Core's.
 *
 * ## What a window may do
 *
 * Two things, and both are reads: `attach()` starts following Core's pushes and
 * pulls once as a backstop, and `read()` pulls the projection again. Neither
 * submits a command. There is deliberately **no `coreSubmit` call in this
 * file**: Core's vocabulary carries no `personality.*` name the bridge
 * whitelists, and this client does not invent one — so there is no route from a
 * window into the Personality lane that carries a preference, a habit, a joke,
 * a confidence, a provenance or a cue, by construction rather than by
 * checking.
 *
 * There is also no `record`, no `admit`, no `forget` and no `chooseCue`. Not
 * "not implemented yet": absent. Deciding what is true about a relationship is
 * Core's, and a client with those methods would be the first step toward a
 * renderer that could argue with it. A caller that reaches for one gets a
 * missing method rather than a refusal it could learn to phrase differently.
 */

export interface PersonalityMirror {
  readonly projection: PersonalityProjection | null
  subscribe(listener: (projection: PersonalityProjection | null) => void): () => void
  attach(): Promise<() => void>

  /**
   * Pull Core's current projection. Zero parameters, by construction: a read
   * this lane can make cannot carry anything, so it cannot carry a claim.
   */
  read(): Promise<PersonalityReadOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: PersonalityProjection = ABSENT_PERSONALITY_PROJECTION

let shared: PersonalityMirror | null = null
let attachPromise: Promise<PersonalityMirror> | null = null

export function personalityMirror(): PersonalityMirror {
  shared ??= createPersonalityMirror()
  return shared
}

export function ensurePersonalityAttached(): Promise<PersonalityMirror> {
  attachPromise ??= personalityMirror().attach().then(() => personalityMirror())
  return attachPromise
}

export function resetPersonalityMirror(): void {
  shared = null
  attachPromise = null
}

export function createPersonalityMirror(): PersonalityMirror {
  const listeners = new Set<(projection: PersonalityProjection | null) => void>()
  /** Every live bridge subscription this mirror owns, so `reset` can end them all. */
  const subscriptions = new Set<() => void>()
  let current: PersonalityProjection | null = null

  const publish = (projection: PersonalityProjection | null): void => {
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
   * truth over a newer one.
   */
  const read = async (): Promise<PersonalityReadOutcome> => {
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
      projection = await bridge.corePersonality()
    } catch (error) {
      return {
        operation: 'refused',
        ok: false,
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    if (current === null) publish(projection ?? ABSENT)
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
     * Subscribing *first* is deliberate, for the same reason the Workforce and
     * Context clients give: a change that lands between the pull resolving and
     * the subscription registering would otherwise be lost.
     *
     * Each attach owns its own bridge subscription and disposes exactly that
     * one, so two components attached at once — the Personality window and the
     * presence cue in the status bar — cannot unsubscribe each other by
     * unmounting in the wrong order. The shared slot is only cleared when it
     * still holds this attach's own disposer.
     */
    async attach() {
      const bridge = hostBridge()
      if (!bridge) return () => {}
      const own = bridge.onCorePersonality((projection) => publish(projection))
      subscriptions.add(own)
      try {
        publish((await bridge.corePersonality()) ?? ABSENT)
      } catch {
        // A Core that cannot be reached leaves the mirror absent rather than
        // throwing during a window's mount — unless a push already arrived, in
        // which case the push is the newer truth and is kept.
        if (current === null) publish(null)
      }
      return () => {
        subscriptions.delete(own)
        own()
      }
    },

    read,

    reset() {
      for (const dispose of [...subscriptions]) dispose()
      subscriptions.clear()
      publish(null)
    },
  }
}
