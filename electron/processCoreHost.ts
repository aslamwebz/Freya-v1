import type { CoreHost, ElectronCoreHost, HostEnv } from './coreHost'
import { NOT_READY, toContextProjection } from './coreHost'
import { connectRpc, type RpcPeer } from '../shared/runtime/rpc'
import type { ComponentHealth } from '../shared/contracts/runtime'
import { ProcessEffects, type DesktopEffects } from './process-effects'

type ProjectionName = 'status' | 'activity' | 'conversation' | 'voice' | 'brain' | 'work' | 'mission' | 'workforce' | 'personality' | 'attention' | 'foundry' | 'office' | 'relay' | 'connectors' | 'skills' | 'forge' | 'life' | 'world' | 'consciousness' | 'lifeLoop' | 'context' | 'goals' | 'toolCatalogue'
type Values = { [K in ProjectionName]: Awaited<ReturnType<ElectronCoreHost[K]>> }

/** The existing desktop contract backed by an independently running Core. */
export class ProcessCoreHost implements CoreHost {
  private peer: RpcPeer | null = null
  private timer: NodeJS.Timeout | null = null
  private connecting: Promise<void> | null = null
  private readonly values: Partial<Values> = {}
  private readonly listeners = new Map<string, Set<(value: never) => void>>()
  private browser: Parameters<ElectronCoreHost['attachDualBrowser']>[0] | null = null
  private tabs: Parameters<ElectronCoreHost['attachBrowserTabs']>[0] | null = null
  private readonly effects: ProcessEffects | null
  private capabilities: ReturnType<ElectronCoreHost['capabilityReadiness']> = {}
  private journal: ReturnType<ElectronCoreHost['deviceHandsJournal']> = null
  private runtimeInstance: string | null = null
  private descriptorHash = ''
  constructor(private readonly endpoint: string, private readonly token: string, effects?: DesktopEffects) { this.effects = effects ? new ProcessEffects(effects) : null }

  async start(): Promise<void> {
    this.timer ??= setInterval(() => { void this.connect().then(() => this.registerEffects()).catch(() => {}) }, 1_000)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try { await this.connect(); return } catch { await new Promise(resolve => setTimeout(resolve, 250)) }
    }
    throw new Error('Core did not accept the desktop connection within 30 seconds')
  }
  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting
    if (this.peer?.connected) return
    this.connecting = (async () => {
      const peer = await connectRpc(this.endpoint, this.token)
      this.peer = peer
      peer.onClose(() => {
        if (this.peer !== peer) return
        this.peer = null
        this.effects?.disconnected(); this.descriptorHash = ''; this.journal = null
        this.push('status', { ...this.status(), operational: false, faults: [...this.status().faults, 'Core is disconnected; commands will not be retried'] })
      })
      peer.handle(async (method, value) => {
        if (method === 'projection') {
          const update = value as { channel: string; value: unknown }
          this.push(update.channel, update.value); return null
        }
        if (method === 'browser.execute') {
          if (!this.browser) throw new Error('Superapp browser is unavailable')
          return this.browser.execute(value as Parameters<NonNullable<typeof this.browser>['execute']>[0])
        }
        if (method === 'browser.tabs') {
          if (!this.tabs) throw new Error('Superapp browser tabs are unavailable')
          return this.tabs.run(value as Parameters<NonNullable<typeof this.tabs>['run']>[0])
        }
        if (this.effects) return this.effects.handle(method, value)
        throw new Error('operation unavailable in Superapp')
      })
      const snapshot = await peer.call<Record<string, unknown>>('ui.snapshot')
      this.runtimeInstance = snapshot.runtimeInstanceId as string
      for (const [name, value] of Object.entries(snapshot)) this.push(name, value)
      this.capabilities = await peer.call('ui.capabilities')
      await this.registerEffects()
      console.log(`[superapp] connected to Core; pid=${process.pid}`)
    })().catch(error => { this.peer?.close(); this.peer = null; throw error }).finally(() => { this.connecting = null })
    return this.connecting
  }
  private async registerEffects(): Promise<void> {
    if (!this.effects || !this.peer?.connected) return
    const descriptors = this.effects.descriptors(), hash = JSON.stringify(descriptors)
    if (hash === this.descriptorHash) return
    const status = await this.peer.call<{ trustworthy: boolean; path: string } | null>('ui.platform.register', descriptors)
    this.descriptorHash = hash
    this.journal = status ? {
      trustworthy: () => this.peer?.connected === true && status.trustworthy,
      path: () => status.path,
      append: (type, payload) => this.request('ui.browserJournal.append', { type, payload }),
      replay: () => this.request('ui.browserJournal.replay'),
    } : null
  }
  private push(name: string, value: unknown): void {
    if (name === 'context' && value) value = toContextProjection(value as Parameters<typeof toContextProjection>[0])
    Object.assign(this.values, { [name]: value })
    for (const listener of this.listeners.get(name) ?? []) {
      try { listener(value as never) } catch { console.error(`[superapp] ${name} projection listener failed`) }
    }
  }
  private follow<K extends ProjectionName>(name: K, listener: (value: NonNullable<Values[K]>) => void): () => void {
    let set = this.listeners.get(name)
    if (!set) { set = new Set(); this.listeners.set(name, set) }
    set.add(listener as (value: never) => void)
    const value = this.values[name]
    if (value != null) listener(value as NonNullable<Values[K]>)
    return () => set!.delete(listener as (value: never) => void)
  }
  private request<T>(method: string, value?: unknown): Promise<T> {
    if (!this.peer?.connected) return Promise.reject(new Error('Core is disconnected; the request was not executed'))
    return this.peer.call<T>(method, value)
  }
  submit(...args: Parameters<CoreHost['submit']>): ReturnType<CoreHost['submit']> { return this.request('ui.submit', args[0]) }
  async stop(_reason?: string): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null; this.peer?.close(); this.peer = null; this.listeners.clear()
  }
  health(): Promise<ComponentHealth> { return this.request('runtime.health') }
  async restartWithEnv(env: HostEnv): Promise<void> {
    const instance = this.runtimeInstance
    await this.request('ui.configure', env)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (this.peer?.connected && this.runtimeInstance !== instance && this.status().operational) return
    }
    throw new Error('Core did not finish applying the saved configuration')
  }
  attentionTick(): Promise<number> { return Promise.reject(new Error('the heartbeat belongs to Core')) }
  capabilityReadiness(): ReturnType<ElectronCoreHost['capabilityReadiness']> { return this.capabilities }
  async refreshPreferences(): Promise<void> { await this.request('ui.preferencesChanged'); this.descriptorHash = ''; await this.registerEffects() }
  detectVoiceWake(): Promise<boolean> { return this.request('ui.voiceWake') }
  connectorAuthorizationComplete(value: unknown): ReturnType<CoreHost['connectorAuthorizationComplete']> { return this.request('ui.connectorAuthorizationComplete', value) }
  connectorEventIngest(value: unknown): ReturnType<CoreHost['connectorEventIngest']> { return this.request('ui.connectorEventIngest', value) }
  attachDualBrowser(port: Parameters<ElectronCoreHost['attachDualBrowser']>[0]): void { this.browser = port }
  attachBrowserTabs(port: Parameters<ElectronCoreHost['attachBrowserTabs']>[0]): void { this.tabs = port }
  deviceHandsJournal(): ReturnType<ElectronCoreHost['deviceHandsJournal']> { return this.journal }
  ownerBrowserGrant(..._args: Parameters<ElectronCoreHost['ownerBrowserGrant']>): ReturnType<ElectronCoreHost['ownerBrowserGrant']> { return null }
  performDeviceHandsAction(value: Parameters<ElectronCoreHost['performDeviceHandsAction']>[0]): ReturnType<ElectronCoreHost['performDeviceHandsAction']> { return this.request('ui.deviceHands', value) }
  performOwnerBrowserAction(value: Parameters<ElectronCoreHost['performOwnerBrowserAction']>[0]): ReturnType<ElectronCoreHost['performOwnerBrowserAction']> { return this.request('ui.ownerBrowser', value) }

  status(): Values['status'] { return this.values.status ?? NOT_READY }
  attach(listener: Parameters<CoreHost['attach']>[0]) { listener(this.status()); return this.follow('status', listener) }
  activity(): Values['activity'] { return this.values.activity ?? [] }
  onActivity(listener: Parameters<CoreHost['onActivity']>[0]) { return this.follow('activity', listener) }
  async conversation(): Promise<Values['conversation']> { return this.values.conversation ?? null }
  onConversation(listener: Parameters<CoreHost['onConversation']>[0]) { return this.follow('conversation', listener) }
  voice(): Values['voice'] { return this.values.voice ?? null }
  onVoice(listener: Parameters<CoreHost['onVoice']>[0]) { return this.follow('voice', listener) }
  onVoiceTranscript(listener: Parameters<CoreHost['onVoiceTranscript']>[0]) {
    const key = 'voiceTranscript'; let set = this.listeners.get(key)
    if (!set) { set = new Set(); this.listeners.set(key, set) }
    set.add(listener as (value: never) => void); return () => set!.delete(listener as (value: never) => void)
  }
  brain(): Values['brain'] { return this.values.brain ?? null }
  onBrain(listener: Parameters<CoreHost['onBrain']>[0]) { return this.follow('brain', listener) }
  work(): Values['work'] { return this.values.work ?? null }
  onWork(listener: Parameters<CoreHost['onWork']>[0]) { return this.follow('work', listener) }
  mission(): Values['mission'] { return this.values.mission ?? null }
  onMission(listener: Parameters<CoreHost['onMission']>[0]) { return this.follow('mission', listener) }
  workforce(): Values['workforce'] { return this.values.workforce ?? null }
  onWorkforce(listener: Parameters<CoreHost['onWorkforce']>[0]) { return this.follow('workforce', listener) }
  personality(): Values['personality'] { return this.values.personality ?? null }
  onPersonality(listener: Parameters<CoreHost['onPersonality']>[0]) { return this.follow('personality', listener) }
  attention(): Values['attention'] { return this.values.attention ?? null }
  onAttention(listener: Parameters<CoreHost['onAttention']>[0]) { return this.follow('attention', listener) }
  foundry(): Values['foundry'] { return this.values.foundry ?? null }
  onFoundry(listener: Parameters<CoreHost['onFoundry']>[0]) { return this.follow('foundry', listener) }
  office(): Values['office'] { return this.values.office ?? null }
  onOffice(listener: Parameters<CoreHost['onOffice']>[0]) { return this.follow('office', listener) }
  relay(): Values['relay'] { return this.values.relay ?? null }
  onRelay(listener: Parameters<CoreHost['onRelay']>[0]) { return this.follow('relay', listener) }
  connectors(): Values['connectors'] { return this.values.connectors ?? null }
  onConnectors(listener: Parameters<CoreHost['onConnectors']>[0]) { return this.follow('connectors', listener) }
  skills(): Values['skills'] { return this.values.skills ?? null }
  onSkills(listener: Parameters<CoreHost['onSkills']>[0]) { return this.follow('skills', listener) }
  forge(): Values['forge'] { return this.values.forge ?? null }
  onForge(listener: Parameters<CoreHost['onForge']>[0]) { return this.follow('forge', listener) }
  life(): Values['life'] { return this.values.life ?? null }
  onLife(listener: Parameters<CoreHost['onLife']>[0]) { return this.follow('life', listener) }
  world(): Values['world'] { return this.values.world ?? null }
  onWorld(listener: Parameters<CoreHost['onWorld']>[0]) { return this.follow('world', listener) }
  consciousness(): Values['consciousness'] { return this.values.consciousness ?? null }
  onConsciousness(listener: Parameters<CoreHost['onConsciousness']>[0]) { return this.follow('consciousness', listener) }
  lifeLoop(): Values['lifeLoop'] { return this.values.lifeLoop ?? null }
  onLifeLoop(listener: Parameters<CoreHost['onLifeLoop']>[0]) { return this.follow('lifeLoop', listener) }
  context(): Values['context'] { return this.values.context ?? null }
  onContext(listener: Parameters<CoreHost['onContext']>[0]) { return this.follow('context', listener) }
  goals(): Values['goals'] { return this.values.goals ?? null }
  toolCatalogue(): Values['toolCatalogue'] { return this.values.toolCatalogue ?? null }
}
