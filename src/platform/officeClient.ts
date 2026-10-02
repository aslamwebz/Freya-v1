import type { OfficeCommandOutcome } from '../../core/protocol/core-protocol'
import { ABSENT_OFFICE_PROJECTION, type OfficeProjection } from '../../core/office/projection'
import { hostBridge } from './host'

/**
 * The renderer's view of the Office.
 *
 * A mirror, in the same sense as `workClient` and `workforceClient`: every
 * field arrived over IPC from Core and the renderer cannot write one. There is
 * no renderer-side copy of the office, because a local list built from local
 * edits would be a second source of truth about what is happening — and the
 * one a person would trust more than Core.
 *
 * ## What a window may ask for
 *
 * Two things: `read()`, which submits `office.status.read` with no payload,
 * and `requestPresence(workerId)`, which submits `office.presence.request`
 * with a workerId and nothing else. That is the whole of this client's write
 * surface.
 *
 * There is deliberately no `inventStation`, no `inflateCount`, no
 * `fabricateProgress` and no `animate`. Not "not implemented yet": absent. The
 * Office is a pure function of Core state, and a client with those methods
 * would be the first step toward a renderer that could argue with it.
 */

export interface OfficeMirror {
  readonly projection: OfficeProjection | null
  subscribe(listener: (projection: OfficeProjection | null) => void): () => void
  attach(): Promise<() => void>

  /**
   * The one command this lane may submit that writes. It carries a workerId
   * and nothing else — see `OFFICE_NO_PAYLOAD` in the protocol. Answers
   * whether Core accepted the request, in Core's words.
   */
  requestPresence(workerId: string): Promise<OfficeCommandOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: OfficeProjection = ABSENT_OFFICE_PROJECTION

let shared: OfficeMirror | null = null
let attachPromise: Promise<OfficeMirror> | null = null

export function officeMirror(): OfficeMirror {
  shared ??= createOfficeMirror()
  return shared
}

export function ensureOfficeAttached(): Promise<OfficeMirror> {
  attachPromise ??= officeMirror().attach().then(() => officeMirror())
  return attachPromise
}

export function resetOfficeMirror(): void {
  shared = null
  attachPromise = null
}

export function createOfficeMirror(): OfficeMirror {
  const listeners = new Set<(projection: OfficeProjection | null) => void>()
  let current: OfficeProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: OfficeProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Submit the presence request and return Core's own outcome.
   *
   * A Core that cannot be reached resolves with a refusal rather than rejecting,
   * because a window reloading mid-call should produce a sentence on screen and
   * not an unhandled rejection in somebody's console. `ok: false` travels with
   * it, so a refusal can never be mistaken for success by a caller that reads
   * the flag.
   */
  const requestPresence = async (workerId: string): Promise<OfficeCommandOutcome> => {
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
      result = await bridge.coreSubmit('office.presence.request', { workerId })
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
      result.office ?? {
        operation: 'refused',
        ok: false,
        reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no Office result',
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
     * resolving and the subscription registering would otherwise be lost, and
     * a mirror that silently missed the newest office is exactly the failure
     * this client exists to prevent. The read then catches up whatever the
     * subscription raced past, so a window opening on day seven agrees with
     * one that never left.
     */
    async attach() {
      const bridge = hostBridge()
      if (!bridge) {
        publish(ABSENT)
        return () => {}
      }
      // Attaching twice replaces the first subscription rather than adding one:
      // two live subscriptions would double every push.
      disposeBridge?.()
      disposeBridge = bridge.onCoreOffice((projection) => publish(projection))
      try {
        publish((await bridge.coreOffice()) ?? ABSENT)
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

    requestPresence,

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}
