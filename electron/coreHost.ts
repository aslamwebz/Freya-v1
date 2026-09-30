import { createCore, type Core } from '../core/index'
import type { CoreCommandEnvelope, CoreCommandResult, CoreStatus } from '../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../core/protocol/activity'
import type { ConversationProjection, VoiceProjection } from '../core/protocol/conversation'
import type { NanoGptEnv } from '../core/model/nanogpt-provider'

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
}

export class ElectronCoreHost implements CoreHost {
  private core: Core | null = null
  private starting: Promise<void> | null = null
  private readonly windows = new Set<(status: CoreStatus) => void>()
  private readonly activityWindows = new Set<(activity: CoreActivityEvent[]) => void>()
  private readonly conversationWindows = new Set<(projection: ConversationProjection) => void>()

  constructor(
    private readonly dataPath: string,
    private readonly env: NanoGptEnv = {},
    private readonly options: CoreHostOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.core) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const core = createCore({
        dataPath: this.dataPath,
        env: this.env,
        // Bytes in, and nowhere else. Core does not persist it, journal it, log it
        // or put it in a projection, so there is nothing for it to leak through.
        ...(this.options.conversationKey
          ? { conversationKey: this.options.conversationKey }
          : {}),
      })
      await core.start()
      this.core = core
      // Any window attached later still gets every subsequent change.
      core.subscribe((status) => this.broadcast(status))
      core.onActivity((activity) => this.broadcastActivity(activity))
      core.onConversation((projection) => this.broadcastConversation(projection))
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
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
    await core?.stop(reason)
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
