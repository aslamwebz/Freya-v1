import { createCore, type Core } from '../core/index'
import type { CoreCommandEnvelope, CoreCommandResult, CoreStatus } from '../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../core/protocol/activity'
import type { ConversationProjection, VoiceProjection } from '../core/protocol/conversation'
import type { BrainProjection } from '../core/brain/brain'
import type { WorkProjection } from '../core/work/projection'
import type { MissionProjection } from '../core/missions/types'
import type { WorkforceProjection, WorkforceSource } from '../core/protocol/workforce'
import type { ContextProjection, ContextProjectionView } from '../core/protocol/context'
import type { NanoGptEnv } from '../core/model/nanogpt-provider'
import { BraveSearchProvider } from '../core/research/providers/brave'
import { ElectronBrowserTargetFactory } from './research/managedTarget'
import { fixtureSearchProvider, fixtureTransport, researchFixturesEnabled } from './research/e2eFixtures'
import { SafeHttpTransport } from '../core/research/transport'
import type { SearchProvider } from '../core/research/types'
import type { ModelProvider } from '../core/model/provider'
import type { BrowserTargetFactory } from '../core/research/browser'

/**
 * The environment the host reads, main-process only.
 *
 * `BRAVE_SEARCH_API_KEY` and `FREYA_ALLOW_WEB_SEARCH` are named here so the shape
 * of what main hands Core is explicit. Neither is returned by any projection, any
 * status or any command: the provider keeps the key in a private field, and Core
 * receives a `SearchProvider` it cannot inspect.
 *
 * `FREYA_ALLOW_WEB_SEARCH` is separate from the credential on purpose. A machine
 * that happens to have a key in its environment must not start calling a paid
 * search API because the key was there. Search is enabled explicitly.
 */
export interface HostEnv extends NanoGptEnv {
  BRAVE_SEARCH_API_KEY?: string
  FREYA_ALLOW_WEB_SEARCH?: string
  /**
   * E2E gates. Main-process only, and both must be present before any research
   * fixture is used.
   *
   * Read from the environment by the host rather than passed by the renderer, so
   * that no window can switch a production build into fixture mode. They replace the
   * transport's DNS and socket seams only — the URL policy, the bounds and the
   * browser target remain the real ones.
   */
  FREYA_E2E?: string
  FREYA_E2E_RESEARCH?: string
}

/**
 * The far side of the Context seam, as the *host* sees it.
 *
 * Core reports context in its own vocabulary — `context()` answers a
 * `ContextProjectionView`, the audit-shaped projection the Context integration
 * inside Core builds — and this host transports the *window's* vocabulary, the
 * `ContextProjection` #24 declared. `ContextChannel` binds *structurally* to a
 * candidate with both halves of the mirror contract, translates what arrives
 * into the window's shape, and forwards it. A candidate that already speaks the
 * window's shape (the seam #24 documented for a Core that grows its own mirror)
 * is forwarded verbatim, because it is already the answer.
 *
 * `ContextChannel` cannot write into a Core, cannot substitute a projection,
 * and has no branch that runs when nothing binds. Electron owns no Context
 * authority here; it owns a forwarding box, a translation and a disposer.
 */
export interface ContextReportingCore {
  context(): ContextProjection | ContextProjectionView
  onContext(
    listener: (projection: ContextProjection | ContextProjectionView) => void,
  ): () => void
}

/** Whether a Core object actually is a context reporter, checked by shape. */
export function isContextReportingCore(candidate: unknown): candidate is ContextReportingCore {
  if (typeof candidate !== 'object' || candidate === null) return false
  const record = candidate as Partial<ContextReportingCore>
  return (
    typeof record.context === 'function' &&
    typeof record.onContext === 'function'
  )
}

/**
 * One projection of Core's Context truth, in the vocabulary a window reads.
 *
 * A Core reporting the window's own `ContextProjection` is already the answer
 * and is returned as it came. A Core reporting `ContextProjectionView` — the
 * shape this repository's Core actually answers — is translated field by field,
 * and the translation is where every "Core does not say" is decided:
 *
 *  - **`label` is always null.** Core's audit row carries the *length* of a
 *    label and never the label, because a file name is private in exactly the
 *    way the content is. The surface falls back to `kind`, which is Core's own
 *    word.
 *  - **`ttlSeconds` is always null.** Core reports the instant an item stops
 *    being valid; it does not report a granted lifetime, and arithmetic on two
 *    instants would be this file inventing one.
 *  - **`references` is always empty.** Core's projection holds no standing
 *    references: `context.reference.read` resolves a term inside Core and is
 *    consumed there, so "no open references" is the truth about the projection
 *    rather than a gap in it.
 *  - **scope and provenance are reported verbatim**, as ids and instants —
 *    metadata, with nothing a sentence could hide in.
 *
 * Health follows the one fact a window cannot check for itself: a Core that has
 * not built its Context integration reports zeroed limits, and one that has can
 * only report positive ones (`contextLimits` clamps into `[1, ceiling]`), so an
 * integration that is not there is `unavailable` in Core's own words rather
 * than `ready` with an empty list.
 */
export function toContextProjection(
  projection: ContextProjection | ContextProjectionView,
): ContextProjection {
  if ('health' in projection) return projection

  const view = projection
  const available = view.limits.maxItems > 0
  return {
    health: available ? 'ready' : 'unavailable',
    reason: available ? null : (view.persistence.reason ?? 'Core has not reported a Context yet'),
    items: view.items.map((row) => ({
      itemId: row.contextId,
      kind: row.kind,
      label: null,
      state: row.state,
      provenance: {
        sourceClass: row.source,
        detail: row.originId,
        admittedAt: row.admittedAt,
      },
      scope: { label: row.scopeKind, detail: row.scopeId },
      expiresAt: row.expiresAt,
      ttlSeconds: null,
    })),
    references: [],
    counts: {
      items: view.counts.retained,
      current: view.counts.live,
      expired: view.counts.expired,
      revoked: view.counts.revoked,
      references: 0,
      unresolvedReferences: 0,
    },
    sequence: view.sequence,
  }
}

/**
 * The host's Context transport: a window set, one optional binding, and no
 * authority.
 *
 * Every method is a read or a subscription. `bind` is called once per Core and
 * only *follows* what that Core reports; `pull` repeats Core's last answer or
 * says there is none. There is deliberately no `emit`, no `submit` and no way
 * for a window — or this class — to introduce a context item, because an
 * Electron-side route for context to get *in* would be Electron holding Context
 * authority, which is exactly what issue #15's lane reserves for Core.
 */
export class ContextChannel {
  private core: ContextReportingCore | null = null
  private disposeCore: () => void = () => {}
  private readonly windows = new Set<(projection: ContextProjection) => void>()

  /**
   * Follow a Core that reports context. Anything else — a Core built without
   * the Context facade — binds to nothing and is not an error.
   */
  bind(candidate: unknown): void {
    if (!isContextReportingCore(candidate)) return
    this.core = candidate
    this.disposeCore = candidate.onContext((projection) =>
      this.broadcast(toContextProjection(projection)),
    )
  }

  /** Core's last reported projection, or null when no Core is reporting. */
  pull(): ContextProjection | null {
    return this.core === null ? null : toContextProjection(this.core.context())
  }

  /**
   * Attach a window. Returns a disposer. A window attaching to a reporting
   * Core is pulled immediately, like every other channel; a window attaching
   * to one that is not is told nothing, which is the honest silence.
   */
  on(send: (projection: ContextProjection) => void): () => void {
    this.windows.add(send)
    const projection = this.pull()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Context push threw', error)
        this.windows.delete(send)
      }
    }
    return () => {
      this.windows.delete(send)
    }
  }

  /** Detach everything and unbind. A stopped host has no Context to mirror. */
  close(): void {
    const dispose = this.disposeCore
    this.disposeCore = () => {}
    this.core = null
    this.windows.clear()
    dispose()
  }

  private broadcast(projection: ContextProjection): void {
    for (const send of [...this.windows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Context push threw', error)
        this.windows.delete(send)
      }
    }
  }
}

/**
 * The Core host.
 *
 * One Core per main process, created before any window exists and destroyed
 * only when the process ends. A renderer reload re-attaches to the same Core
 * instead of starting a second one — reloading is a renderer concern, and a
 * reload must never restart Core, replay its log, or cost a provider call.
 *
 * The renderer never sees the Core object. It sees `submit` and a status
 * subscription, both of which are already narrow.
 */

export interface CoreHost {
  /** Start the Core. Safe to await more than once. */
  start(): Promise<void>
  /**
   * Run a command from a renderer.
   *
   * There is deliberately no caller parameter. In Phase 1 the renderer is the
   * owner's UI and the only thing that can reach this host, so the only identity
   * worth passing is the one the host already assumes. Adding a caller argument
   * now would create a field a future module could populate with a forged value,
   * which is worse than having no field at all. When a second kind of caller
   * exists, this host becomes the place that decides which one it is.
   */
  submit(envelope: CoreCommandEnvelope): Promise<CoreCommandResult>
  /**
   * Attach a window. Returns a disposer. The host pushes the current status
   * immediately, so a renderer that has just reloaded knows where it stands
   * without asking.
   */
  attach(send: (status: CoreStatus) => void): () => void
  /**
   * Attach to the activity feed. Returns a disposer.
   *
   * Narrow on purpose: a window gets display-ready rows, not the event fabric.
   * There is no channel here that could carry a payload, so no future event can
   * leak its contents into a window through this door.
   */
  onActivity(send: (activity: CoreActivityEvent[]) => void): () => void
  activity(): CoreActivityEvent[]
  status(): CoreStatus
  /** Attach to the conversation projection. Returns a disposer. */
  onConversation(send: (projection: ConversationProjection) => void): () => void
  conversation(): Promise<ConversationProjection | null>
  voice(): VoiceProjection | null
  /**
   * Attach to the Brain projection. Returns a disposer.
   *
   * Its own channel, not another field on the status. The Brain is where Freya's
   * long-term knowledge lives; shipping it inside a security projection would put
   * it wherever status is cached, logged or forwarded.
   */
  onBrain(send: (projection: BrainProjection) => void): () => void
  brain(): BrainProjection | null
  /**
   * Attach to the Work projection. Returns a disposer.
   *
   * Its own channel for the reason the Brain has one, and here the payload is
   * *live execution state*: which capability is running, which run is waiting on a
   * person. Shipping that inside a security status would put it wherever status is
   * cached, logged or forwarded, and a security projection is exactly the wrong
   * place for something that changes several times a second.
   */
  onWork(send: (projection: WorkProjection) => void): () => void
  work(): WorkProjection | null
  onMission(send: (projection: MissionProjection) => void): () => void
  mission(): MissionProjection | null
  /**
   * Attach to the Workforce projection. Returns a disposer.
   *
   * Its own channel, as every subsystem has, and the same bargain: what a
   * window needs in order to render crosses, and nothing that protects or
   * decides workforce state crosses at all. No source, no authority object, no
   * rule, no worker credential — the host can read a projection and forward it,
   * which is the entire of what it knows how to do with a workforce.
   */
  onWorkforce(send: (projection: WorkforceProjection) => void): () => void
  workforce(): WorkforceProjection | null
  /**
   * Attach to the Context projection, as Core last reported it.
   *
   * Its own channel like every subsystem's, and the note that matters is about
   * what is *not* here: the host has no way to write a context item, no source
   * to hand to Core, and no projection of its own to substitute. A Core that
   * reports no context leaves `context()` answering `null` and this channel a
   * closed door with a disposer; a Core that does report one is followed, and
   * what it says arrives translated into the window's vocabulary. Forwarding
   * what Core says is the entire of what the host knows how to do with context.
   */
  onContext(send: (projection: ContextProjection) => void): () => void
  context(): ContextProjection | null
  stop(reason?: string): Promise<void>
}

export interface CoreHostOptions {
  /**
   * The conversation master key, from the OS secure storage.
   *
   * Injected rather than constructed here so that the host is testable without
   * Electron's credential store, and so that "no key" is a real, reachable state
   * rather than a branch nobody exercises. Null means Core falls back to an
   * ephemeral conversation store and says so.
   */
  conversationKey?: Uint8Array | null
  /**
   * The Brain's own key, from the keyring.
   *
   * A **separate secret**, not a derivation of the conversation key: compromising
   * conversation history must not yield the Brain, and vice versa. See
   * `electron/keyring.ts` for why the isolation is worth two secrets to protect.
   * Null means the Brain falls back to ephemeral and reports `durable: false`.
   */
  brainKey?: Uint8Array | null
  /**
   * Missions' own key, from the keyring.
   *
   * A **third** independent secret, for the same reason as the other two: what a
   * person asked Freya to accomplish is theirs, and recovering the conversation key
   * must not yield it. See `electron/keyring.ts` for why the isolation is worth a
   * secret per domain. Null means Missions fall back to an ephemeral store and
   * report `durable: false` rather than implying a persistence they do not have.
   */
  missionKey?: Uint8Array | null
  /**
   * The developer echo provider, when one was explicitly asked for.
   *
   * Forwarded verbatim to Core, which is the only place that decides what a
   * provider is. The host does not construct one.
   */
  developerProvider?: 'echo' | 'slow-echo'
  /**
   * Replaces the entire provider set. For tests.
   *
   * Whole-set rather than additive, so a run cannot accidentally reach a real
   * provider. Production passes none of this.
   */
  providers?: ModelProvider[]
  /**
   * Replaces the production research stack wholesale. For tests.
   *
   * Whole-stack rather than per-part, so a test cannot accidentally exercise the
   * real Brave provider or the real Electron target while believing it is offline.
   */
  research?: { searchProvider: SearchProvider; browserFactory: BrowserTargetFactory }
  /**
   * Fills Core's Workforce seam. For assembly and tests; production passes
   * none, and the host does not build one.
   *
   * Forwarded *into* Core and nowhere else. This is not Electron deciding who
   * is on a team or what a worker may do — it cannot, because the type it
   * forwards is something Core can read, not something that takes an
   * instruction. Workforce authority lives in Core (issue #10); the host's job
   * is to hand over a reader and then mirror what comes back.
   */
  workforceSource?: WorkforceSource
}

export class ElectronCoreHost implements CoreHost {
  private core: Core | null = null
  private starting: Promise<void> | null = null
  private readonly windows = new Set<(status: CoreStatus) => void>()
  private readonly activityWindows = new Set<(activity: CoreActivityEvent[]) => void>()
  private readonly conversationWindows = new Set<(projection: ConversationProjection) => void>()
  private readonly brainWindows = new Set<(projection: BrainProjection) => void>()
  private readonly workWindows = new Set<(projection: WorkProjection) => void>()
  private readonly missionWindows = new Set<(projection: MissionProjection) => void>()
  private readonly workforceWindows = new Set<(projection: WorkforceProjection) => void>()
  /**
   * The Context transport box. Binds structurally to a reporting Core, holds a
   * window set, and can write nothing — see `ContextChannel`. Deliberately not
   * a field on Core's construction arguments: Core builds its own Context
   * integration and takes no context source from the host.
   */
  private readonly contextChannel = new ContextChannel()

  constructor(
    private readonly dataPath: string,
    private readonly env: HostEnv = {},
    private readonly options: CoreHostOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.core) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const research = this.options.research ?? this.buildResearchStack()
      const core = createCore({
        dataPath: this.dataPath,
        env: this.env,
        ...(research ? { research } : {}),
        // Bytes in, and nowhere else. Core does not persist it, journal it, log it
        // or put it in a projection, so there is nothing for it to leak through.
        ...(this.options.conversationKey
          ? { conversationKey: this.options.conversationKey }
          : {}),
        ...(this.options.brainKey ? { brainKey: this.options.brainKey } : {}),
        ...(this.options.missionKey ? { missionKey: this.options.missionKey } : {}),
        // The Workforce seam, forwarded whole. Nothing is derived from it here:
        // the host neither reads nor interprets a workforce, it only hands Core
        // the reader it was given and mirrors what Core reports.
        ...(this.options.workforceSource
          ? { workforceSource: this.options.workforceSource }
          : {}),
        ...(this.options.developerProvider
          ? { developerProvider: this.options.developerProvider }
          : {}),
        // The *entire* provider set when one is supplied, forwarded verbatim so a
        // test can never exercise the real provider while believing it is offline.
        ...(this.options.providers ? { providers: this.options.providers } : {}),
      })
      await core.start()
      this.core = core
      // Any window attached later still gets every subsequent change.
      core.subscribe((status) => this.broadcast(status))
      core.onActivity((activity) => this.broadcastActivity(activity))
      core.onConversation((projection) => this.broadcastConversation(projection))
      core.onBrain((projection) => this.broadcastBrain(projection))
      core.onWork((projection) => this.broadcastWork(projection))
      core.onMission((projection) => this.broadcastMission(projection))
      core.onWorkforce((projection) => this.broadcastWorkforce(projection))
      // The Context channel, bound by shape rather than by name: a Core that
      // reports `context()`/`onContext()` is followed and translated into the
      // window's vocabulary, with no edit here and no authority moved into
      // Electron. A Core that reports nothing still binds to nothing.
      this.contextChannel.bind(core)
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * The production research stack: Brave from main's environment, and the real
   * managed Electron DOM target.
   *
   * Both transports are constructed here, in the main process. Core receives two
   * small interfaces and cannot construct a provider, read an environment variable
   * or reach the filesystem, so there is no path from a model or a page to a
   * credential even indirectly.
   */
  private buildResearchStack(): { searchProvider: SearchProvider; browserFactory: BrowserTargetFactory } {
    // The offline fixture path, behind two independent gate variables, replaces the
    // transport's DNS and socket seams only. The URL policy, the byte bounds, the
    // redirect handling and the browser target are all the real ones, so the E2E is
    // testing the production code path and not a parallel implementation of it.
    if (researchFixturesEnabled(this.env as Record<string, string | undefined>)) {
      return {
        searchProvider: fixtureSearchProvider(),
        browserFactory: new ElectronBrowserTargetFactory(fixtureTransport()),
      }
    }

    const transport = new SafeHttpTransport()
    return {
      searchProvider: new BraveSearchProvider({ env: this.env, transport }),
      // Shared deliberately: `SafeHttpTransport` holds no mutable instance state, so
      // a page read and a provider call cannot interfere. Two instances would add an
      // isolation boundary that does not exist and imply a separation the code does
      // not have.
      browserFactory: new ElectronBrowserTargetFactory(transport),
    }
  }

  async submit(envelope: CoreCommandEnvelope): Promise<CoreCommandResult> {
    if (!this.core) {
      return {
        requestId: typeof envelope?.requestId === 'string' ? envelope.requestId : 'unknown',
        ok: false,
        error: { message: 'core is not ready' },
      }
    }
    return this.core.handleCommand(envelope)
  }

  attach(send: (status: CoreStatus) => void): () => void {
    this.windows.add(send)
    try {
      send(this.status())
    } catch (error) {
      console.error('[freya.core] window status push threw', error)
    }
    return () => {
      this.windows.delete(send)
    }
  }

  onActivity(send: (activity: CoreActivityEvent[]) => void): () => void {
    this.activityWindows.add(send)
    try {
      send(this.activity())
    } catch (error) {
      console.error('[freya.core] window activity push threw', error)
    }
    return () => {
      this.activityWindows.delete(send)
    }
  }

  /**
   * Attach to the conversation projection.
   *
   * Its own channel, for the same reason status and activity are separate: a long
   * transcript is a much larger payload than a status, and a window that only
   * renders a security panel should not pay to receive one.
   */
  onConversation(send: (projection: ConversationProjection) => void): () => void {
    this.conversationWindows.add(send)
    const core = this.core
    if (core) {
      void core
        .conversation()
        .then((projection) => {
          try {
            send(projection)
          } catch (error) {
            console.error('[freya.core] window conversation push threw', error)
          }
        })
        .catch(() => {})
    }
    return () => {
      this.conversationWindows.delete(send)
    }
  }

  async conversation(): Promise<ConversationProjection | null> {
    if (!this.core) return null
    return this.core.conversation()
  }

  voice(): VoiceProjection | null {
    return this.core?.voice() ?? null
  }

  onBrain(send: (projection: BrainProjection) => void): () => void {
    this.brainWindows.add(send)
    // Pushed immediately, so a window that attaches after startup still sees what
    // Freya already remembers rather than waiting for the next admission.
    const core = this.core
    if (core) {
      try {
        send(core.brain())
      } catch (error) {
        console.error('[freya.core] window Brain push threw', error)
      }
    }
    return () => {
      this.brainWindows.delete(send)
    }
  }

  brain(): BrainProjection | null {
    return this.core?.brain() ?? null
  }

  /**
   * Attach to the Work projection, pushed immediately.
   *
   * A window that reloads re-attaches to the same Core and is told where the work
   * stands without asking — which is the property that makes a renderer reload
   * something that does not interrupt anything.
   */
  onWork(send: (projection: WorkProjection) => void): () => void {
    this.workWindows.add(send)
    try {
      send(this.work() ?? ABSENT_WORK)
    } catch (error) {
      console.error('[freya.core] window Work push threw', error)
    }
    return () => {
      this.workWindows.delete(send)
    }
  }

  work(): WorkProjection | null {
    return this.core?.work() ?? null
  }

  activity(): CoreActivityEvent[] {
    return this.core?.activity() ?? []
  }

  status(): CoreStatus {
    return this.core?.status() ?? NOT_READY
  }

  async stop(reason = 'app shutdown'): Promise<void> {
    const core = this.core
    this.core = null
    this.windows.clear()
    this.activityWindows.clear()
    this.conversationWindows.clear()
    this.brainWindows.clear()
    this.workWindows.clear()
    this.workforceWindows.clear()
    this.contextChannel.close()
    await core?.stop(reason)
  }

  onMission(send: (projection: MissionProjection) => void): () => void {
    this.missionWindows.add(send)
    const projection = this.mission()
    if (projection !== null) send(projection)
    return () => {
      this.missionWindows.delete(send)
    }
  }

  mission(): MissionProjection | null {
    return this.core?.mission() ?? null
  }

  private broadcastMission(projection: MissionProjection): void {
    for (const send of [...this.missionWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Mission push threw', error)
        this.missionWindows.delete(send)
      }
    }
  }

  /**
   * Attach to the Workforce projection, pushed immediately.
   *
   * A window that reloads re-attaches to the same Core and is told what the
   * workforce is without asking — including, today, the honest sentence that no
   * Workforce domain exists. Null before the Core has started, so a host with
   * nothing to report says nothing rather than manufacturing an empty one.
   */
  onWorkforce(send: (projection: WorkforceProjection) => void): () => void {
    this.workforceWindows.add(send)
    const projection = this.workforce()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Workforce push threw', error)
      }
    }
    return () => {
      this.workforceWindows.delete(send)
    }
  }

  workforce(): WorkforceProjection | null {
    return this.core?.workforce() ?? null
  }

  /**
   * Attach to the Context projection, as the channel saw it last.
   *
   * Null until a Core starts reporting, then Core's own facts in the window's
   * vocabulary — a window attaching late is pushed the current one, like every
   * other channel here. Nothing in this host decides what a projection means.
   */
  onContext(send: (projection: ContextProjection) => void): () => void {
    return this.contextChannel.on(send)
  }

  context(): ContextProjection | null {
    return this.contextChannel.pull()
  }

  private broadcastWorkforce(projection: WorkforceProjection): void {
    for (const send of [...this.workforceWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Workforce push threw', error)
        this.workforceWindows.delete(send)
      }
    }
  }

  private broadcastWork(projection: WorkProjection): void {
    for (const send of [...this.workWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Work push threw', error)
        this.workWindows.delete(send)
      }
    }
  }

  private broadcastBrain(projection: BrainProjection): void {
    for (const send of [...this.brainWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Brain push threw', error)
        this.brainWindows.delete(send)
      }
    }
  }

  private broadcastConversation(projection: ConversationProjection): void {
    for (const send of [...this.conversationWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window conversation push threw', error)
        this.conversationWindows.delete(send)
      }
    }
  }

  private broadcastActivity(activity: CoreActivityEvent[]): void {
    for (const send of [...this.activityWindows]) {
      try {
        send(activity)
      } catch (error) {
        console.error('[freya.core] window activity push threw', error)
        this.activityWindows.delete(send)
      }
    }
  }

  private broadcast(status: CoreStatus): void {
    for (const send of [...this.windows]) {
      try {
        send(status)
      } catch (error) {
        console.error('[freya.core] window status push threw', error)
        this.windows.delete(send)
      }
    }
  }
}

/**
 * A valid Work projection for a host whose Core has not started.
 *
 * Stated as unavailable rather than as an empty board: "Freya is not up yet" and
 * "there is no work" look identical otherwise, and they are very different things.
 */
const ABSENT_WORK: WorkProjection = {
  health: 'unavailable',
  reason: 'no Core has reported yet',
  detailAvailable: false,
  runs: [],
  tasks: [],
  approvals: [],
  counts: {
    runs: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    awaitingApproval: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pendingApprovals: 0,
    tasks: 0,
    liveCapabilities: 0,
  },
  runsRetained: 0,
  runsTotal: 0,
  runsHidden: 0,
  capabilities: [],
  verifiers: [],
  limits: { maxSteps: 0, maxActions: 0, maxDurationMs: 0, maxAttemptsPerStep: 0 },
  sequence: 0,
}

/** A valid status for a host whose Core has not started. Nothing is guessed. */
const NOT_READY: CoreStatus = {
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
  // No Core, so no gateway, so nothing executing. Zero is the honest reading of
  // a host that has not started, not a guess at what a provider might be doing.
  activeProviderCalls: 0,
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  faults: [],
}
