import type { ActivityRow, AttentionView, CoreView, HomeView, MissionView, ProviderView, Resource, UiAdapter, UiSnapshot, WorkforceView } from './contract'
import { coreMirror } from '../../platform/coreClient'
import { missionMirror } from '../../platform/missionClient'
import { workforceMirror } from '../../platform/workforceClient'
import { attentionMirror } from '../../platform/attentionClient'
import { hostBridge, type ProviderConfigView } from '../../platform/host'

/**
 * The Phase 19.1 live adapter: the UI's first real projection of Phases 0–18.
 *
 * Three rules govern everything in this file, and they exist because the domains on
 * the other side of the bridge were built to withhold things:
 *
 * 1. **Report only what a projection carries.** Every field below is copied out of a
 *    Core projection. Nothing is inferred, smoothed, defaulted into confidence, or
 *    back-filled from the preview fixtures.
 * 2. **Absence is a state, not a gap.** `unavailable` carries the reason Core or the
 *    host gave. Rendering "no attention" when nothing is watching would be telling the
 *    owner they are caught up when in fact nothing is looking.
 * 3. **One mirror per domain, one snapshot.** The mirrors are the renderer's only
 *    window onto Core, and they already own their subscriptions. This adapter
 *    subscribes to them and derives, so the UI holds a projection rather than a
 *    second copy of the truth.
 *
 * It also does *less* than the concept art implied, on purpose. There is no focus
 * percentage, because `FocusState` has no denominator. There are no Mission titles,
 * because Mission content lives in an encrypted store and `coreMissionDetail` is not
 * on the bridge. There are no people and no world, because no such projection exists
 * yet. Each of those omissions is visible in the surface as an absent panel, which is
 * the honest rendering of "not built yet".
 */

const LOADING: Resource<never> = { status: 'loading' }

/** Core's closed labels, mapped to words. The code is the fact; this is only its shape. */
function lifecycleWords(lifecycle: string): string {
  switch (lifecycle) {
    case 'running': return 'running'
    case 'booting': return 'starting'
    case 'stopped': return 'stopped'
    case 'degraded': return 'degraded'
    default: return lifecycle
  }
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The provider status in words a surface can render.
 *
 * `hasKey` is a usable configuration, because the host only reports `true` when it
 * can actually unwrap a stored credential. The three details are the only states
 * that exist: a key plus live enabled is `connected`; a key with live inference
 * switched off is `live-disabled`; no usable key is `not configured`. Nothing here
 * inspects, logs or forwards the key — it is a boolean on the far side.
 */
function providerView(config: ProviderConfigView): ProviderView {
  const connected = config.hasKey
  return {
    connected,
    baseUrl: config.baseUrl,
    model: config.model,
    liveEnabled: config.liveEnabled,
    hasKey: config.hasKey,
    detail: connected ? (config.liveEnabled ? 'connected' : 'live-disabled') : 'not configured',
  }
}

export interface LiveAdapter extends UiAdapter {
  /** Idempotent. Attaches every mirror this projection needs, once. */
  attach(): Promise<() => void>
}

export function createLiveAdapter(): LiveAdapter {
  const core = coreMirror()
  const missions = missionMirror()
  const workforce = workforceMirror()
  const attention = attentionMirror()

  /**
   * Whether this window can ever receive a projection.
   *
   * Captured once, because it cannot change without a reload. With no bridge the Core
   * mirror publishes an `ABSENT` status whose lifecycle is `booting` — which would tell
   * the owner Freya is starting when in fact nothing is there to start, and `loading`
   * would imply an arrival that is never coming. `unavailable` is the only honest
   * answer, and it names the reason so the surface can say so in words.
   */
  const available = liveAvailable()
  const NO_CORE_REASON = 'No Freya Core is reachable from this window.'
  const noCore = <T,>(): Resource<T> => ({ status: 'unavailable', reason: NO_CORE_REASON })
  const absent: UiSnapshot = {
    home: noCore(), core: noCore(), mission: noCore(),
    workforce: noCore(), activity: noCore(), attention: noCore(), provider: noCore(),
  }

  let snapshot: UiSnapshot = available
    ? { home: LOADING, core: LOADING, mission: LOADING, workforce: LOADING, activity: LOADING, attention: LOADING, provider: LOADING }
    : absent
  const listeners = new Set<() => void>()

  /**
   * The provider resource, read once through the bridge rather than polled.
   *
   * The provider is a setting, not a stream: it changes only when the owner saves a
   * new one, and the Settings surface re-reads it through the bridge at that moment.
   * There is no subscription to hold open, so an idle window never asks the main
   * process for a credential status it already has.
   */
  let providerResource: Resource<ProviderView> = available ? LOADING : noCore()

  const refreshProvider = async (): Promise<void> => {
    const bridge = hostBridge()
    if (!bridge) {
      providerResource = noCore()
      derive()
      return
    }
    try {
      providerResource = { status: 'ready', source: 'live', data: providerView(await bridge.providerConfig()) }
    } catch (error) {
      providerResource = {
        status: 'error',
        reason: error instanceof Error ? error.message : 'the provider configuration could not be read',
      }
    }
    derive()
  }

  const coreView = (): Resource<CoreView> => {
    const status = core.status
    if (!status) return LOADING
    return {
      status: 'ready',
      source: 'live',
      data: {
        lifecycle: lifecycleWords(status.lifecycle),
        sequence: status.eventSequence,
        activeRequests: status.activeProviderCalls,
        stopped: status.stopAll.active,
        integrity: status.integrity.integrity,
        faultCount: status.faults.length,
      },
    }
  }

  const missionView = (): Resource<MissionView> => {
    const projection = missions.projection
    if (!projection) return LOADING
    return {
      status: 'ready',
      source: 'live',
      data: {
        rows: projection.missions.map((mission) => ({
          id: mission.missionId,
          status: mission.status,
          runs: mission.counts.total,
          // Core reports runs whose every step verified. Not a completion claim.
          verifiedRuns: mission.counts.verified,
          needsAttention: mission.needsAttention,
        })),
        total: projection.counts.total,
        hidden: projection.missionsHidden,
        durable: projection.persistence.durable,
      },
    }
  }

  const workforceView = (): Resource<WorkforceView> => {
    const projection = workforce.projection
    if (!projection) return LOADING
    // `health: 'unavailable'` means nobody counted, which is not the same as zero
    // workers. Reporting the counts as live data would be the exact lie the
    // protocol's comment warns about, so the projection is passed through whole.
    if (projection.health !== 'ready') {
      return { status: 'unavailable', reason: projection.reason ?? 'the Workforce domain is not reporting' }
    }
    return {
      status: 'ready',
      source: 'live',
      data: {
        rows: projection.workers.map((worker) => ({
          id: worker.workerId, state: worker.state, specialization: worker.specialization,
        })),
        total: projection.counts.workers,
        working: projection.counts.working,
      },
    }
  }

  const activityView = (): Resource<readonly ActivityRow[]> => {
    // An empty feed from a Core that never reported is not "no activity" — it is no
    // evidence at all. Publishing it would tell the owner nothing has happened, which
    // is the one thing this projection cannot establish without a Core behind it.
    if (!core.status) return LOADING
    return {
      status: 'ready',
      source: 'live',
      // `text` here is Core's own one-sentence description, derived by
      // `describeActivity`. It never contains command text, prompt text or a response.
      data: core.activity.map((event) => ({
        id: event.id, text: event.text, at: event.at, sequence: event.sequence, tone: event.tone,
      })),
    }
  }

  const attentionView = (): Resource<AttentionView> => {
    const projection = attention.projection
    if (!projection) return LOADING
    if (projection.health !== 'ready') {
      return { status: 'unavailable', reason: projection.reason ?? 'the Attention domain is not reporting' }
    }
    return {
      status: 'ready',
      source: 'live',
      data: {
        focus: projection.focus,
        ingested: projection.counts.ingested,
        decisions: projection.counts.decisions,
        cued: projection.counts.cued,
        spoke: projection.counts.spoke,
        interrupted: projection.counts.interrupted,
        budgetExceeded: projection.counts.budgetExceeded,
        inboxCount: projection.inbox.length,
      },
    }
  }

  /**
   * Home is assembled only from what the domains actually reported.
   *
   * The composite is the one place a UI is most tempted to stitch several partial
   * truths into a confident sentence, so it is built to fail closed: if Core has not
   * reported, Home is loading; if Core reported but Attention is absent, Home still
   * renders and simply has no attention reading. `people`, `world` and `goals` are
   * omitted rather than filled — no panel is better than an invented one.
   */
  const homeView = (): Resource<HomeView> => {
    const coreResource = coreView()
    const missionResource = missionView()
    if (coreResource.status !== 'ready' && coreResource.status !== 'stale') return coreResource
    if (missionResource.status !== 'ready' && missionResource.status !== 'stale') return missionResource

    const coreData = (coreResource as { readonly data: CoreView }).data
    const missionData = (missionResource as { readonly data: MissionView }).data
    const attentionResource = attentionView()
    const attentionData = attentionResource.status === 'ready' || attentionResource.status === 'stale'
      ? (attentionResource as { readonly data: AttentionView }).data
      : null

    const active = missionData.rows.filter((row) => row.status === 'active').length
    const attentionRows = missionData.rows.filter((row) => row.needsAttention).length

    return {
      status: 'ready',
      source: 'live',
      data: {
        focus: {
          title: `Freya Core is ${coreData.lifecycle}`,
          detail: coreData.stopped
            ? 'Stop-all is active. Nothing is running until it is cleared.'
            : coreData.activeRequests > 0
              ? `${countPhrase(coreData.activeRequests, 'request')} in flight.`
              : coreData.faultCount > 0
                ? `${countPhrase(coreData.faultCount, 'fault')} recorded.`
                : 'Idle and listening.',
          // No denominator exists for a Mission or for attention, so there is no
          // percentage to print. The surface renders this as absent, not as zero.
          progress: null,
        },
        mission: missionData.total === 0
          ? null
          : [
              countPhrase(missionData.total, 'Mission'),
              active > 0 ? `${active} active` : null,
              attentionRows > 0 ? `${attentionRows} needing attention` : null,
              missionData.hidden > 0 ? `${missionData.hidden} not listed` : null,
            ].filter(Boolean).join(' · '),
        attention: {
          // No percentage. Core's `FocusState` is a closed union with no denominator, so
          // a live Home reports the state as words and leaves the figure absent. `null`
          // is the honest value; `0` would read as "Freya is 0% focused", which is a
          // measurement nothing took.
          focused: null,
          caption: attentionData
            ? `Core reports ${attentionData.focus}`
            : 'Attention is not reporting, so nothing is being watched.',
          categories: [],
          profiles: [],
        },
        // Deliberately omitted: goals (no titles cross the bridge), people and world
        // (no projection exists). Each would otherwise render as fiction.
      },
    }
  }

  const derive = (): void => {
    const next: UiSnapshot = !available ? absent : {
      home: homeView(),
      core: coreView(),
      mission: missionView(),
      workforce: workforceView(),
      activity: activityView(),
      attention: attentionView(),
      provider: providerResource,
    }
    // A new object each pass would re-render every subscriber on every Core push, so
    // identity is compared before publishing. `useSyncExternalStore` depends on it.
    if (shallowEqual(next, snapshot)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const disposers: (() => void)[] = []

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async attach() {
      // Replacing rather than stacking: a second attach must not leave a live
      // subscription with nothing holding its disposer.
      for (const dispose of disposers.splice(0)) dispose()
      // Every subscription this adapter opens is retained, the `subscribe` disposers
      // included. A re-attach used to drop those, so the old derive listener stayed
      // registered and each Core push ran derive twice — a slow leak that only showed
      // up over a long session.
      disposers.push(await core.attach(), await core.attachActivity())
      disposers.push(core.subscribe(derive), core.subscribeActivity(derive))
      disposers.push(await missions.attach())
      disposers.push(missions.subscribe(derive))
      disposers.push(await workforce.attach())
      disposers.push(workforce.subscribe(derive))
      disposers.push(await attention.attach())
      disposers.push(attention.subscribe(derive))
      derive()
      // The provider is a read, not a subscription: one backstop read per attach, and
      // the Settings surface re-reads it directly when a save lands.
      if (available) void refreshProvider()
      return () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
    },
  }
}

function shallowEqual(left: UiSnapshot, right: UiSnapshot): boolean {
  const keys = Object.keys(left) as (keyof UiSnapshot)[]
  return keys.every((key) => left[key] === right[key])
}

/**
 * Whether this window can talk to Core at all.
 *
 * A browser, a test and a build preview have no bridge, so `createLiveAdapter` there
 * would render a permanently-loading UI and look broken. `entry` uses this to choose
 * the preview fixtures instead, which is what keeps `npm run dev` useful.
 */
export function liveAvailable(): boolean {
  return hostBridge() !== undefined
}

/**
 * Whether this window is an Electron renderer, regardless of whether a bridge is present.
 *
 * `entry` uses this to choose the adapter, and the distinction matters: a browser has
 * no Core and never will, so it gets the labelled preview fixtures; an Electron
 * `file://` window is a real desktop window, and even when its preload is missing it
 * must use the live adapter so the absence is reported as `unavailable` rather than
 * silently falling back to sample data.
 *
 * The user agent is the signal because it is the one thing a renderer can read that a
 * browser cannot fake without also being Electron. It is a environment check, not a
 * security boundary — the bridge's own authority is unchanged.
 */
export function isElectron(): boolean {
  return typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent)
}