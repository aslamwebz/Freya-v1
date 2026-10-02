import {
  ABSENT_WORKFORCE_PROJECTION,
  type WorkforceCommandOutcome,
  type WorkforceProjection,
} from '../../core/protocol/workforce'
import { hostBridge } from './host'

/**
 * The renderer's view of the Workforce.
 *
 * A mirror, in the same sense as `workClient` and `missionClient`: every field
 * arrived over IPC from Core and the renderer cannot write one. There is no
 * renderer-side roster of workers, because a local list built from local edits
 * would be a second source of truth about who exists — and the one a person
 * would trust more than Core.
 *
 * ## What a window may ask for
 *
 * One thing: `read()`, which submits `workforce.status.read` with **no
 * payload**. That is the whole of this client's write surface, and it writes
 * nothing — it asks a question.
 *
 * There is deliberately no `createWorker`, no `assign`, no `setTeam`, no
 * `grantCapability` and no `claim`. Not "not implemented yet": absent. Naming a
 * worker, placing one, assigning it a capability or recording what it claims
 * are Workforce authority, that authority lives in Core (issue #10), and a
 * client with those methods would be the first step toward a renderer that
 * could argue with it. A caller that reaches for one gets a type error rather
 * than a refusal it could learn to work around.
 *
 * Claims in the *projection* are a different thing and the point of the split:
 * a worker's claims arrive as data — `WorkforceClaimView` — so a surface can
 * show them labelled as claims, while nothing in this file can submit one.
 */

export interface WorkforceMirror {
  readonly projection: WorkforceProjection | null
  subscribe(listener: (projection: WorkforceProjection | null) => void): () => void
  attach(): Promise<() => void>

  /**
   * The one command this lane may submit. It carries no payload, by protocol —
   * see `WORKFORCE_NO_PAYLOAD`. Answers whether Core answered, in Core's words.
   */
  read(): Promise<WorkforceCommandOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: WorkforceProjection = ABSENT_WORKFORCE_PROJECTION

let shared: WorkforceMirror | null = null
let attachPromise: Promise<WorkforceMirror> | null = null

export function workforceMirror(): WorkforceMirror {
  shared ??= createWorkforceMirror()
  return shared
}

export function ensureWorkforceAttached(): Promise<WorkforceMirror> {
  attachPromise ??= workforceMirror().attach().then(() => workforceMirror())
  return attachPromise
}

export function resetWorkforceMirror(): void {
  shared = null
  attachPromise = null
}

export function createWorkforceMirror(): WorkforceMirror {
  const listeners = new Set<(projection: WorkforceProjection | null) => void>()
  let current: WorkforceProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: WorkforceProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Submit the Workforce read and return Core's own outcome.
   *
   * A Core that cannot be reached resolves with a refusal rather than rejecting,
   * because a window reloading mid-call should produce a sentence on screen and
   * not an unhandled rejection in somebody's console. The call itself is made
   * with **no payload argument**: the bridge rebuilds every renderer payload
   * from named fields, and this one names none, so there is no route from a
   * compromised window through this client into the Workforce lane.
   */
  const read = async (): Promise<WorkforceCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      return {
        operation: 'refused',
        ok: false,
        reason: 'the Core bridge is not available in this window',
      }
    }
    let result
    try {
      result = await bridge.coreSubmit('workforce.status.read')
    } catch (error) {
      return {
        operation: 'refused',
        ok: false,
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    return (
      result.workforce ?? {
        operation: 'refused',
        ok: false,
        reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no Workforce result',
      }
    )
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
     * Follow pushes, then read once as a backstop.
     *
     * Subscribing *first* is deliberate: a change that lands between the read
     * resolving and the subscription registering would otherwise be lost, and a
     * mirror that silently missed the newest workforce is exactly the failure
     * this client exists to prevent. The read then catches up whatever the
     * subscription raced past, so a window opening on day seven agrees with one
     * that never left.
     */
    async attach() {
      const bridge = hostBridge()
      if (!bridge) return () => {}
      // Attaching twice replaces the first subscription rather than adding one:
      // two live subscriptions would double every push.
      disposeBridge?.()
      disposeBridge = bridge.onCoreWorkforce((projection) => publish(projection))
      try {
        publish((await bridge.coreWorkforce()) ?? ABSENT)
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
