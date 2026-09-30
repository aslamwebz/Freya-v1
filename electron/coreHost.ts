import { createCore, type Core } from '../core/index'
import type { CoreCommandEnvelope, CoreCommandResult, CoreStatus } from '../core/protocol/core-protocol'
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
  status(): CoreStatus
  stop(reason?: string): Promise<void>
}

export class ElectronCoreHost implements CoreHost {
  private core: Core | null = null
  private starting: Promise<void> | null = null
  private readonly windows = new Set<(status: CoreStatus) => void>()

  constructor(
    private readonly dataPath: string,
    private readonly env: NanoGptEnv = {},
  ) {}

  async start(): Promise<void> {
    if (this.core) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const core = createCore({ dataPath: this.dataPath, env: this.env })
      await core.start()
      this.core = core
      // Any window attached later still gets every subsequent change.
      core.subscribe((status) => this.broadcast(status))
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

  status(): CoreStatus {
    return this.core?.status() ?? NOT_READY
  }

  async stop(reason = 'app shutdown'): Promise<void> {
    const core = this.core
    this.core = null
    this.windows.clear()
    await core?.stop(reason)
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
  stopAll: { active: false, activatedAt: null, activatedBy: null },
  guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
  governor: { status: 'deny_all', grantsActive: 0 },
  providers: [],
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null },
  durableUsage: { calls: 0, inputTokens: null, outputTokens: null },
  faults: [],
}
