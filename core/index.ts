import { EventFabric } from './events/fabric'
import type { EventStore } from './events/store'
import { JsonlEventStore } from './events/jsonl-store'
import type { AnyCoreEvent } from './events/envelope'
import { initialCoreState, reduceCoreState, type CoreState } from './state'
import { projectCoreStatus } from './projections/core-status'
import { DefaultGuard, ownerPrincipal, type Guard, type Principal } from './security/guard'
import { CognitionService } from './cognition/service'
import { ModelGateway, type GatewayRecorder } from './model/gateway'
import type { ModelProvider } from './model/provider'
import { FakeModelProvider } from './model/fake-provider'
import { NanoGptProvider, readNanoGptConfig, type NanoGptEnv } from './model/nanogpt-provider'
import type {
  Capability,
  CoreCommandEnvelope,
  CoreCommandResult,
  CoreLifecycle,
  CoreStatus,
  PrincipalId,
} from './protocol/core-protocol'

/**
 * The Freya Core.
 *
 * It starts once per application process, lives outside React, and contains no
 * Electron import and no browser global. Electron owns a Core; Core does not
 * know Electron exists.
 *
 * What Core deliberately does not expose: a provider, a gateway, a grant store
 * that can be written to, or a policy object. A caller gets a command surface
 * and a projection. Anything that could reach a model provider is reachable only
 * through `cognition.request`, which the Governor gates.
 */

export const CORE_VERSION = '0.1.0'

export interface CoreOptions {
  /** Where the durable log lives. */
  dataPath: string
  env?: NanoGptEnv
  now?: () => Date
  newId?: () => string
  /** Test seam: replaces the local provider set. */
  useFakeProviderOnly?: boolean
  /** Test seam: supply providers directly, e.g. to inject a failing one. */
  providers?: ModelProvider[]
}

export interface Core {
  start(): Promise<CoreStatus>
  stop(reason?: string): Promise<void>
  status(): CoreStatus
  handleCommand(envelope: CoreCommandEnvelope): Promise<CoreCommandResult>
  /** Subscribe to projection changes. Returns a disposer. */
  subscribe(listener: (status: CoreStatus) => void): () => void
  /** Direct cognition entry point, for Core's own use and for tests. */
  cognition: CognitionService
  readonly lifecycle: CoreLifecycle
}

class FreyaCore implements Core {
  private currentLifecycle: CoreLifecycle = 'booting'
  private fabric!: EventFabric
  private state: CoreState = initialCoreState()
  private gateway!: ModelGateway
  private service!: CognitionService
  private guard!: Guard
  private owner!: Principal
  private startedAt: string | null = null
  private readonly listeners = new Set<(status: CoreStatus) => void>()
  private disposeState: () => void = () => {}
  private stopped = false

  constructor(private readonly options: CoreOptions) {}

  get lifecycle(): CoreLifecycle {
    return this.currentLifecycle
  }

  get cognition(): CognitionService {
    return this.service
  }

  async start(): Promise<CoreStatus> {
    if (this.lifecycle !== 'booting') return this.status()

    let store: EventStore
    try {
      store = await JsonlEventStore.open(this.options.dataPath)
    } catch (error) {
      // Durability unavailable is a degraded Core, not a Core that silently
      // continues without a log.
      this.currentLifecycle = 'degraded'
      const reason = `event store unavailable: ${describe(error)}`
      this.state = { ...this.state, faults: [...this.state.faults, reason] }
      return this.status()
    }

    this.fabric = await EventFabric.open({ store, now: this.options.now, newId: this.options.newId })
    this.state = await this.fabric.replay(initialCoreState(), reduceCoreState)

    this.guard = this.buildGuard()
    this.owner = ownerPrincipal(this.allCapabilities())

    this.gateway = new ModelGateway({
      providers: this.buildProviders(),
      recorder: this.fabricRecorder(),
      now: this.options.now,
    })

    this.service = new CognitionService(
      { fabric: this.fabric, gateway: this.gateway, now: this.options.now },
      this.state,
    )

    // State follows the log, for both replay and live appends.
    this.disposeState = this.fabric.subscribe((event) => {
      this.state = reduceCoreState(this.state, event)
      this.notify()
    })

    const recoveredSequence = this.fabric.lastSequence
    this.startedAt = (this.options.now ?? (() => new Date()))().toISOString()
    this.currentLifecycle = 'ready'

    await this.fabric.append(
      'core.started',
      {
        version: CORE_VERSION,
        storeKind: this.fabric.describe(),
        recoveredSequence,
      },
      { actor: 'system' },
    )
    await this.fabric.append('core.ready', {}, { actor: 'system' })

    return this.status()
  }

  async stop(reason = 'shutdown'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.currentLifecycle = 'stopping'
    this.notify()

    const began = Date.now()
    try {
      if (this.fabric) {
        await this.fabric.append('core.stopping', { reason }, { actor: 'system' })
        await this.fabric.append(
          'core.stopped',
          { durationMs: Date.now() - began },
          { actor: 'system' },
        )
      }
    } finally {
      this.disposeState()
      this.service?.dispose()
      this.currentLifecycle = 'stopped'
      await this.fabric?.close()
      this.notify()
    }
  }

  status(): CoreStatus {
    if (this.fabric === undefined || this.gateway === undefined) {
      // Booting or degraded: the log is not open, so there is nothing to derive.
      // Every fact that would require it stays null rather than being guessed.
      return degradedStatus(this.lifecycle, this.state, this.startedAt)
    }
    return projectCoreStatus({
      state: this.state,
      lifecycle: this.currentLifecycle,
      gateway: this.gateway,
      fabric: this.fabric,
      now: (this.options.now ?? (() => new Date()))(),
      startedAt: this.startedAt,
    })
  }

  subscribe(listener: (status: CoreStatus) => void): () => void {
    this.listeners.add(listener)
    // A subscriber receives the current projection immediately, so a renderer
    // that reconnects never has to wait for the next change to know where it is.
    try {
      listener(this.status())
    } catch (error) {
      console.error('[freya.core] status subscriber threw', error)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  async handleCommand(envelope: CoreCommandEnvelope): Promise<CoreCommandResult> {
    if (this.lifecycle === 'degraded' || this.fabric === undefined) {
      return reject(envelope, 'core is degraded and cannot serve commands')
    }
    // Everything crossing this boundary is untrusted, whatever it claims.
    if (typeof envelope !== 'object' || envelope === null) {
      return reject(envelope, 'malformed command')
    }
    const { command, requestId } = envelope
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return reject(envelope, 'malformed request id')
    }

    try {
      switch (command) {
        case 'core.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'security.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'cognition.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'core.command.submit': {
          const text = readString(envelope.payload, 'text')
          if (text === null) return { requestId, ok: false, refusal: { reason: 'command text is missing' } }
          if (text.length > 4000) return { requestId, ok: false, refusal: { reason: 'command text is too long' } }

          // The renderer is not trusted to be the owner; the bridge asserts an
          // identity and Guard decides what it may do.
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }

          // Durable first. The renderer learns this happened because Core said
          // so, not because the UI assumed it.
          const event = await this.fabric.append(
            'command.received',
            { text, length: text.length },
            { actor: 'owner', correlationId: requestId, source: 'renderer' },
          )
          return {
            requestId,
            ok: true,
            status: this.status(),
            // Proof it is durable, not a UI animation.
            durableSequence: event.sequence,
          }
        }

        case 'security.stopAll': {
          const decision = this.guard.evaluate(this.owner, 'security.stop')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'security.stop', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          if (this.state.stopAll.active) {
            return { requestId, ok: true, status: this.status() }
          }
          const reason = readString(envelope.payload, 'reason') ?? 'requested by owner'
          const event = await this.fabric.append(
            'security.stop_all.activated',
            { by: this.owner.id, reason },
            { actor: this.owner.id, correlationId: requestId },
          )
          return { requestId, ok: true, status: this.status(), durableSequence: event.sequence }
        }

        case 'security.resume': {
          // Clearing the latch needs its own capability, held only by the owner.
          // No model, no agent and no module can present it.
          const decision = this.guard.evaluate(this.owner, 'security.resume')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'security.resume', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          if (!this.state.stopAll.active) {
            return { requestId, ok: true, status: this.status() }
          }
          const event = await this.fabric.append(
            'security.stop_all.cleared',
            { by: this.owner.id },
            { actor: this.owner.id, correlationId: requestId },
          )
          return { requestId, ok: true, status: this.status(), durableSequence: event.sequence }
        }

        default:
          return reject(envelope, `unknown command: ${String(command)}`)
      }
    } catch (error) {
      // An unexpected failure is reported without a stack and without leaking
      // anything about the internals.
      return { requestId, ok: false, error: { message: describe(error) } }
    }
  }

  /* ----------------------------------------------------------- private */

  private allCapabilities(): Capability[] {
    return [
      'core.status.read',
      'core.command.submit',
      'cognition.status.read',
      'cognition.request',
      'cognition.grant.manage',
      'security.status.read',
      'security.stop',
      'security.resume',
    ]
  }

  private buildGuard(): Guard {
    // Deny by default. Nothing is on an approval list, because no approval
    // workflow exists; the concept is present and empty.
    return new DefaultGuard()
  }

  private buildProviders(): ModelProvider[] {
    if (this.options.providers) return [...this.options.providers]
    if (this.options.useFakeProviderOnly) return [new FakeModelProvider()]
    const env = this.options.env ?? {}
    return [new FakeModelProvider(), new NanoGptProvider({ config: readNanoGptConfig(env) })]
  }

  /** Gateway audit events land on the durable fabric, not on a side channel. */
  private fabricRecorder(): GatewayRecorder {
    return {
      started: async (record) => {
        await this.fabric.append(
          'model.request.started',
          record,
          { actor: 'system', correlationId: record.requestId },
        )
      },
      completed: async (record) => {
        await this.fabric.append(
          'model.request.completed',
          record,
          { actor: 'system', correlationId: record.requestId },
        )
      },
      failed: async (record) => {
        await this.fabric.append(
          'model.request.failed',
          record,
          { actor: 'system', correlationId: record.requestId },
        )
      },
    }
  }

  private async recordGuard(
    verdict: { allowed: false; outcome: 'deny' | 'approval_required'; reason: string },
    principal: PrincipalId,
    capability: Capability,
    correlationId: string,
  ): Promise<void> {
    await this.fabric.append(
      'guard.decision',
      {
        outcome: verdict.outcome,
        reason: verdict.reason,
        capability,
        principal,
      },
      { actor: principal, correlationId },
    )
  }

  private notify(): void {
    const status = this.status()
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch (error) {
        console.error('[freya.core] status subscriber threw', error)
      }
    }
  }
}

/** A valid CoreStatus for a Core whose log is not open. */
function degradedStatus(
  lifecycle: CoreLifecycle,
  state: CoreState,
  startedAt: string | null,
): CoreStatus {
  return {
    lifecycle,
    eventSequence: 0,
    coreStartedAt: startedAt,
    stopAll: {
      active: state.stopAll.active,
      activatedAt: state.stopAll.activatedAt,
      activatedBy: state.stopAll.activatedBy,
    },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    governor: { status: 'deny_all', grantsActive: 0 },
    // No log means no providers, and saying so is safer than listing any.
    providers: [],
    sessionUsage: { calls: 0, inputTokens: null, outputTokens: null },
    durableUsage: state.durableUsage,
    faults: [...state.faults],
  }
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function reject(envelope: CoreCommandEnvelope, reason: string): CoreCommandResult {
  const requestId =
    typeof envelope?.requestId === 'string' && envelope.requestId.length > 0
      ? envelope.requestId
      : 'unknown'
  return { requestId, ok: false, refusal: { reason } }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/** Build a Core. One per application process. */
export function createCore(options: CoreOptions): Core {
  return new FreyaCore(options)
}

export type { AnyCoreEvent }
