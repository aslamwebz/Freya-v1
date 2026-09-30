import type {
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../../core/protocol/activity'
import { hostBridge } from './host'

/**
 * The renderer's view of Core.
 *
 * The renderer holds a *mirror* of the Core projection, never a second copy of
 * the truth. Every field here arrived over IPC from Core, and Core will overwrite
 * it whenever its own state moves. The renderer cannot write to any of it.
 *
 * When the bridge is absent — a browser, a test, a build preview — every method
 * still resolves. It reports a Core that is not present rather than throwing,
 * because the shell has to render in a browser too.
 */

export interface CoreMirror {
  readonly status: CoreStatus | null
  subscribe(listener: (status: CoreStatus | null) => void): () => void
  submit(command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult>
  /**
   * Attach to Core and resolve once the first status has arrived. Returns a
   * disposer. Calling it again replaces the previous subscription, so a
   * remount cannot end up with two live listeners.
   */
  attach(): Promise<() => void>
  /** Idempotent, and independent of `attach()`. */
  attachActivity(): Promise<() => void>

  /**
   * The activity feed, rebuilt by Core from the log and pushed on change.
   *
   * A mirror like `status`: the renderer holds what Core last sent and cannot
   * write to it. There is no renderer-side journal and no renderer-side
   * activity database — dropping this loses nothing, because Core still has it.
   */
  readonly activity: CoreActivityEvent[]
  subscribeActivity(listener: (activity: CoreActivityEvent[]) => void): () => void
}

/** Shown when there is no Core. `null` facts, never optimistic ones. */
const ABSENT: CoreStatus = {
  lifecycle: 'booting',
  eventSequence: 0,
  coreStartedAt: null,
  integrity: {
    integrity: 'ok',
    reason: 'no Core has reported yet',
    line: null,
    eventsRead: 0,
    bytesDiscarded: 0,
  },
  stopAll: { active: false, activatedAt: null, activatedBy: null },
  guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
  governor: { status: 'unknown', grantsActive: 0 },
  providers: [],
  // No Core is reachable, so no provider request is executing in this window's
  // Core. Zero rather than unknown, because the whole point of the field is to
  // say "nothing is being spent right now".
  activeProviderCalls: 0,
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  faults: ['core is not reachable from this window'],
}


/**
 * The one mirror, shared by every panel.
 *
 * There is one Core per process and one bridge, so there is one subscription.
 * Two panels each opening their own bridge subscription would mean every status
 * push was delivered twice and two listeners to clean up on unmount.
 *
 * `coreMirror()` is a pure getter. Attaching is a separate, idempotent step
 * because attaching publishes the current status synchronously — doing that
 * during render would set state during render and loop forever.
 */
let shared: CoreMirror | null = null
let attachPromise: Promise<CoreMirror> | null = null
let activityAttachPromise: Promise<CoreMirror> | null = null

export function coreMirror(): CoreMirror {
  shared ??= createCoreMirror()
  return shared
}

/** Attach to Core once, whichever panel asks first. Safe during an effect. */
export function ensureCoreAttached(): Promise<CoreMirror> {
  attachPromise ??= coreMirror().attach().then(() => coreMirror())
  return attachPromise
}

/** Attach to the activity feed once. Safe during an effect. */
export function ensureActivityAttached(): Promise<CoreMirror> {
  activityAttachPromise ??= coreMirror().attachActivity().then(() => coreMirror())
  return activityAttachPromise
}

/**
 * Forget the shared mirror and its bridge subscription.
 *
 * For tests, and for the one production case where the bridge object is
 * replaced rather than mutated. Without it the singleton would hold a
 * subscription to a bridge that is no longer there, and every later status
 * would silently stop arriving — which is exactly the kind of failure that
 * looks like "Core is idle" rather than "the subscription is dead".
 */
export function resetCoreMirror(): void {
  shared = null
  attachPromise = null
  activityAttachPromise = null
}

export function createCoreMirror(): CoreMirror {
  const listeners = new Set<(status: CoreStatus | null) => void>()
  const activityListeners = new Set<(activity: CoreActivityEvent[]) => void>()
  let current: CoreStatus | null = null
  let currentActivity: CoreActivityEvent[] = []
  let disposeBridge: (() => void) | null = null
  let disposeActivity: (() => void) | null = null

  const publish = (status: CoreStatus | null) => {
    current = status
    for (const listener of [...listeners]) listener(status)
  }

  const publishActivity = (activity: CoreActivityEvent[]) => {
    currentActivity = activity
    for (const listener of [...activityListeners]) listener(activity)
  }

  return {
    get status() {
      return current
    },

    get activity() {
      return currentActivity
    },

    subscribe(listener) {
      listeners.add(listener)
      // Push the current value immediately, so a late subscriber never renders
      // a blank Core panel waiting for a change that already happened.
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    subscribeActivity(listener) {
      activityListeners.add(listener)
      listener(currentActivity)
      return () => {
        activityListeners.delete(listener)
      }
    },

    async submit(command, payload) {
      const host = hostBridge()
      if (!host) {
        return { requestId: 'no-bridge', ok: false, refusal: { reason: 'core bridge unavailable' } }
      }
      const result = await host.coreSubmit(command, payload)
      // The reply carries the authoritative projection. Adopt it rather than
      // patching local state, so the renderer cannot drift from Core.
      if (result.status) publish(result.status)
      return result
    },

    /**
     * Attach to Core. Returns a disposer. Safe to call once per mount; a second
     * call replaces the first, because two live subscriptions would double every
     * status push.
     */
    async attach(): Promise<() => void> {
      // Attaching twice replaces the first subscription rather than adding one.
      disposeBridge?.()
      const host = hostBridge()
      if (!host) {
        publish(ABSENT)
        return () => {}
      }
      const disposer = host.onCoreStatus((status) => publish(status))
      disposeBridge = disposer
      // The host pushes on attach, so this read is a backstop for a push that
      // raced the subscription rather than a poll.
      const initial = await host.coreStatus()
      publish(initial)
      return disposer
    },

    /**
     * Attach to the activity feed.
     *
     * Separate from `attach()` on purpose, and idempotent in its own right: the
     * feed is a stream and the status is a projection, and a caller that only
     * wants one should not be made to hold the other's subscription.
     */
    async attachActivity(): Promise<() => void> {
      disposeActivity?.()
      const host = hostBridge()
      if (!host) {
        publishActivity([])
        return () => {}
      }
      disposeActivity = host.onCoreActivity((activity) => publishActivity(activity))
      // Backstop for a push that raced the subscription, same as for status.
      publishActivity(await host.coreActivity())
      return disposeActivity
    },
  }
}
