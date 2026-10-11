import { randomUUID } from 'node:crypto'
import type { CoreCommandEnvelope, CoreCommandResult, CoreStatus } from '../protocol/core-protocol'
import type { ConversationProjection } from '../protocol/conversation'
import type { VoiceTranscriptFragment } from '../voice/types'
import type { CapabilityEnv } from '../model/capability-runtime'
import type { ComponentHealth, ProcessRuntimeOptions } from '../../shared/contracts/runtime'
import type { ProviderStatus } from '../../shared/contracts/model'
import { listenRpc, type RpcPeer } from '../../shared/runtime/rpc'
import { MindConnection } from './mind-connection'
import { ProcessProviders } from '../model/process-provider'
import type { CoreOwnerPort } from './owner-port'
import { ProcessBrain } from '../brain/process-store'
import type { BrainStore } from '../brain/store'
import type { EventFabric } from '../events/fabric'
import { ProcessMissions } from '../missions/process-store'
import type { MissionEngineOptions } from '../missions/engine'
import { ProcessGoals } from '../longhorizon/process-store'
import type { GoalEngineOptions } from '../longhorizon/engine'
import { ProcessWorkforce } from '../workforce/process-store'
import type { WorkforceEngineOptions } from '../workforce/engine'

const projections = ['activity', 'brain', 'work', 'mission', 'workforce', 'personality', 'attention', 'foundry', 'office', 'relay', 'connectors', 'skills', 'forge', 'life', 'world', 'consciousness', 'lifeLoop', 'context', 'goals', 'toolCatalogue', 'voice'] as const
type CoreProcessPort = { [K in typeof projections[number]]: () => unknown } & {
  status(): CoreStatus
  stop(reason?: string): Promise<void>
  handleCommand(envelope: CoreCommandEnvelope): Promise<CoreCommandResult>
  conversation(): Promise<ConversationProjection>
  attentionTick(): Promise<number>
  detectVoiceWake(): Promise<boolean>
  connectorAuthorizationComplete(value: unknown): Promise<unknown>
  connectorEventIngest(value: unknown): Promise<unknown>
  subscribe(listener: (status: CoreStatus) => void): () => void
  onConversation(listener: (projection: ConversationProjection) => void): () => void
  onVoiceTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void
}

/** Core's actual process endpoints and 30-second clock, independent of its clients. */
export class CoreProcess {
  readonly mind = new MindConnection()
  readonly providers: ProcessProviders
  private readonly instanceId = randomUUID()
  private readonly startedAt = new Date().toISOString()
  private heartbeatAt: string | null = null
  private heartbeatError: string | null = null
  private tickRunning = false
  private timer: NodeJS.Timeout | null = null
  private servers: Awaited<ReturnType<typeof listenRpc>>[] = []
  private readonly disposers: (() => void)[] = []
  private readonly owners = new Set<RpcPeer>()
  private brain: ProcessBrain | null = null
  private mission: ProcessMissions | null = null
  private goal: ProcessGoals | null = null
  private workforce: ProcessWorkforce | null = null
  memory(store: BrainStore, fabric: EventFabric): ProcessBrain { this.brain = new ProcessBrain(store, fabric); return this.brain }
  missions(options: MissionEngineOptions): ProcessMissions { this.mission = new ProcessMissions(options); return this.mission }
  goals(options: GoalEngineOptions): ProcessGoals { this.goal = new ProcessGoals(options); return this.goal }
  agents(options: WorkforceEngineOptions): ProcessWorkforce { this.workforce = new ProcessWorkforce(options); return this.workforce }
  constructor(private readonly config: ProcessRuntimeOptions, private readonly env: CapabilityEnv, private readonly developer?: 'echo' | 'slow-echo', private readonly owner?: CoreOwnerPort, private readonly workspaceRoot = process.cwd()) {
    const fixture = env as CapabilityEnv & { FREYA_E2E?: string; FREYA_E2E_RESEARCH?: string }
    this.providers = new ProcessProviders(developer, fixture.FREYA_E2E === '1' && fixture.FREYA_E2E_RESEARCH === 'fixtures')
  }

  async open(core: CoreProcessPort): Promise<void> {
    this.servers.push(await listenRpc(this.config.intelligenceEndpoint, this.config.intelligenceToken, peer => {
      peer.handle(async (method, value) => {
        if (method === 'freya.register') {
          this.mind.connect(peer)
          const statuses = await peer.call<ProviderStatus[]>('provider.configure', { env: this.env, developer: this.developer, workspaceRoot: this.workspaceRoot })
          this.providers.connect(peer, statuses)
          await this.brain?.connect(peer)
          await this.mission?.connect(peer)
          await this.goal?.connect(peer)
          await this.workforce?.connect(peer)
          void this.tick(core)
          return { instanceId: this.instanceId, pid: process.pid }
        }
        if (method === 'runtime.health') return this.health(core)
        if (method.startsWith('turn.')) return this.mind.handle(method, value)
        if (method.startsWith('brain.')) return this.brain?.handle(method, value)
        if (method.startsWith('mission.')) return this.mission?.handle(method, value)
        if (method.startsWith('goal.')) return this.goal?.handle(method, value)
        if (method.startsWith('workforce.')) return this.workforce?.handle(method, value)
        throw new Error('operation unavailable to intelligence process')
      })
    }))
    this.servers.push(await listenRpc(this.config.ownerEndpoint, this.config.ownerToken, peer => {
      this.owners.add(peer); peer.onClose(() => this.owners.delete(peer))
      peer.handle(async (method, value) => {
        switch (method) {
          case 'ui.platform.register': this.owner?.connect(peer, value); return this.owner?.browserJournal('status') ?? null
          case 'ui.capabilities': return this.owner?.capabilities() ?? {}
          case 'ui.preferencesChanged': return this.owner?.refreshPreferences()
          case 'ui.voiceWake': return core.detectVoiceWake()
          case 'ui.connectorAuthorizationComplete': return core.connectorAuthorizationComplete(value)
          case 'ui.connectorEventIngest': return core.connectorEventIngest(value)
          case 'ui.configure': {
            if (!this.owner) throw new Error('Core configuration host is unavailable')
            setTimeout(() => { void this.owner!.configure(value as CapabilityEnv).catch(() => { this.heartbeatError = 'Core configuration failed; inspect Core diagnostics' }) }, 50)
            return true
          }
          case 'ui.deviceHands': return this.owner?.deviceHands(value)
          case 'ui.ownerBrowser': return this.owner?.ownerBrowser(value)
          case 'ui.browserJournal.append': return this.owner?.browserJournal('append', value)
          case 'ui.browserJournal.replay': return this.owner?.browserJournal('replay')
          case 'ui.submit': return core.handleCommand(value as CoreCommandEnvelope)
          case 'ui.snapshot': return this.snapshot(core)
          case 'runtime.health': return this.health(core)
          case 'runtime.shutdown': {
            if ((value as { token?: string })?.token !== this.config.supervisorToken) throw new Error('supervisor authorization required')
            setTimeout(() => { void core.stop('explicit supervisor shutdown').finally(() => process.exit(0)) }, 50)
            return true
          }
          default: throw new Error('operation unavailable to Superapp')
        }
      })
    }))
    const push = (channel: string, value: unknown) => {
      for (const peer of this.owners) if (peer.connected) void peer.call('projection', { channel, value }, 5_000).catch(() => {})
    }
    this.disposers.push(core.subscribe(value => push('status', value)))
    this.disposers.push(core.onConversation(value => push('conversation', value)))
    for (const name of projections) {
      const method = `on${name[0]!.toUpperCase()}${name.slice(1)}`
      const subscribe = (core as unknown as Record<string, ((fn: (value: unknown) => void) => () => void)>)[method]
      if (typeof subscribe === 'function') this.disposers.push(subscribe.call(core, value => push(name, value)))
    }
    this.disposers.push(core.onVoiceTranscript(value => push('voiceTranscript', value)))
    this.timer = setInterval(() => { void this.tick(core) }, 30_000)
    await this.tick(core)
  }
  private async tick(core: CoreProcessPort): Promise<void> {
    this.heartbeatAt = new Date().toISOString()
    if (this.tickRunning || !this.mind.connected) return
    this.tickRunning = true
    try { await core.attentionTick(); this.heartbeatError = null }
    catch { this.heartbeatError = 'the scheduled work tick failed; inspect Core diagnostics' }
    finally { this.tickRunning = false }
  }
  private async snapshot(core: CoreProcessPort): Promise<Record<string, unknown>> {
    const snapshot: Record<string, unknown> = { runtimeInstanceId: this.instanceId, status: core.status(), conversation: await core.conversation() }
    for (const name of projections) snapshot[name] = core[name]()
    return snapshot
  }
  private async health(core: CoreProcessPort): Promise<ComponentHealth> {
    const status = core.status(), conversation = await core.conversation()
    const issues = []
    if (!status.operational) issues.push({ code: 'not-operational', message: `Core is ${status.lifecycle}` })
    if (!status.persistence.durable || status.integrity.integrity !== 'ok') issues.push({ code: 'journal-degraded', message: status.persistence.reason ?? status.integrity.reason ?? 'journal is not durable and verified' })
    if (conversation.persistence.mode !== 'encrypted') issues.push({ code: 'conversation-storage', message: conversation.persistence.reason ?? 'conversation storage is not encrypted' })
    if (this.heartbeatError) issues.push({ code: 'heartbeat-failed', message: this.heartbeatError })
    return { component: 'core', instanceId: this.instanceId, pid: process.pid, startedAt: this.startedAt,
      lifecycle: issues.length ? 'degraded' : 'ready', checkedAt: new Date().toISOString(), lastProgressAt: this.heartbeatAt,
      dependencies: { freya: { state: this.mind.connected ? 'ready' : 'unavailable', checkedAt: new Date().toISOString(), ...(this.mind.connected ? {} : { reason: 'scheduled work retained until Freya reconnects' }) } }, issues }
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const server of this.servers.splice(0)) await server.close()
  }
}
