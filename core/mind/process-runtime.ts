import { randomUUID } from 'node:crypto'
import { connectRpc, listenRpc, type RpcPeer } from '../../shared/runtime/rpc'
import type { ComponentHealth } from '../../shared/contracts/runtime'
import { MindService, type MindServiceOptions, type MindSubmitInput } from './mind'
import { MindToolRegistry, type MindTool } from './tools'
import type { EventFabric } from '../events/fabric'
import type { ConversationStore } from '../conversation/store'
import { buildConfiguredModelProviders, type CapabilityEnv } from '../model/capability-runtime'
import { FakeModelProvider, SlowFakeModelProvider } from '../model/fake-provider'
import { e2eResearchFixtureProvider } from '../model/research-fixture-provider'
import type { ModelProvider, ModelRequest } from '../model/provider'
import type { CueUsageLedger, InteractionFact, RelationshipItem } from '../personality/types'
import type { ReferenceKnowledge } from './context-compiler'
import type { TurnContextBlock } from './turn-context'

interface TurnPacket {
  input: MindSubmitInput
  context: {
    mode: ConversationStore['mode']; faultReason: string | null
    identity?: MindServiceOptions['identity']; budget?: MindServiceOptions['budget']
    runtimeFacts: string[]; selectedModel: string | null; selectedProviderId: string | null; matrixSpaceIds: string[]
    reference: ReferenceKnowledge | null; sharedContext: TurnContextBlock | null
    ledger: CueUsageLedger | null; facts: InteractionFact[]; relationships: RelationshipItem[]; preferenceTokens: string[]
    tools: Omit<MindTool, 'run'>[]
  }
}

const instanceId = randomUUID(), startedAt = new Date().toISOString()
let peer: RpcPeer | null = null, connecting = false, registered = false
let providers = new Map<string, ModelProvider>()
let providerFailure: string | null = null
const minds = new Map<string, MindService>()
const calls = new Map<string, AbortController>()

async function runTurn(connection: RpcPeer, packet: TurnPacket) {
  const { input, context: c } = packet
  if (minds.has(input.turnId)) throw new Error('turn is already running; it was not replayed')
  const operation = <T>(method: string, ...args: unknown[]) => connection.call<T>(method, { turnId: input.turnId, args })
  const effects: Promise<unknown>[] = []
  const effect = (method: string, ...args: unknown[]) => { effects.push(operation(method, ...args).catch(() => { console.error('[freya] turn enrichment could not be persisted') })) }
  const metadata = new MindToolRegistry({ tools: c.tools.map(tool => ({ ...tool, run: async () => { throw new Error('tool bodies remain behind Core admission') } })),
    guard: { evaluate: () => ({ allowed: false, outcome: 'deny', reason: 'Core admits tool execution' }), holds: () => false },
    principal: { id: 'owner', trusted: true, capabilities: new Set() }, stopped: () => !connection.connected })
  const store: ConversationStore = {
    mode: c.mode, faultReason: c.faultReason,
    readConversation: () => operation('turn.read'), putConversation: value => operation('turn.put', value),
    appendMessage: value => operation('turn.message', value), recordTurnStart: value => operation('turn.start', value),
    recordTurnOutcome: (_id, outcome, detail) => operation('turn.outcome', outcome, detail),
    listConversations: async () => { throw new Error('not admitted on a turn lease') },
    recoverInterruptedTurns: async () => { throw new Error('recovery belongs to Core') }, close: async () => {},
  }
  const mind = new MindService({
    store, fabric: { append: ((type, payload) => operation('turn.event', type, payload)) as EventFabric['append'] },
    authority: { createGrant: value => operation('turn.grant', value), request: ({ signal: _signal, ...intent }) => operation('turn.cognition', intent) },
    gateway: { cancelRequest: () => { effect('turn.cancel'); return 1 } },
    identity: c.identity, budget: c.budget,
    runtimeFacts: () => c.runtimeFacts, selectedModel: () => c.selectedModel, selectedProviderId: () => c.selectedProviderId,
    matrixSpaceIds: () => c.matrixSpaceIds, recall: () => c.reference, turnContext: () => c.sharedContext,
    expressionMemory: c.ledger ? { readLedger: () => c.ledger, recordCueUse: (...args) => effect('turn.cue', ...args) } : undefined,
    interactionFacts: () => c.facts, relationshipItems: () => c.relationships, preferenceTokens: () => c.preferenceTokens,
    onTurnStateChange: () => effect('turn.changed'), onTurnExperience: value => operation('turn.experience', value),
    onOwnerMessage: value => effect('turn.ownerMessage', value),
    tools: c.tools.length ? {
      list: () => metadata.list(), has: name => metadata.has(name), isEmpty: () => metadata.isEmpty(), instructions: names => metadata.instructions(names),
      invoke: ({ signal: _signal, ...request }) => operation('turn.tool', request),
    } : null,
  })
  minds.set(input.turnId, mind)
  try { const result = await mind.runTurn(input); await Promise.all(effects); return result }
  finally { minds.delete(input.turnId) }
}

async function connect(): Promise<void> {
  if (connecting || peer?.connected) return
  connecting = true
  try {
    const connection = await connectRpc(required('FREYA_CORE_INTELLIGENCE_ENDPOINT'), required('FREYA_INTELLIGENCE_TOKEN'))
    peer = connection; registered = false
    connection.onClose(() => {
      if (peer !== connection) return
      registered = false; peer = null
      for (const controller of calls.values()) controller.abort()
      for (const [id, mind] of minds) mind.cancelTurn(id, 'Core disconnected; the turn will not be retried')
      console.warn('[freya] Core disconnected; waiting to reconnect')
    })
    connection.handle(async (method, value) => {
      switch (method) {
        case 'provider.configure': {
          const config = value as { env: CapabilityEnv & { FREYA_E2E?: string; FREYA_E2E_RESEARCH?: string }; developer?: 'echo' | 'slow-echo' }
          const fixture = e2eResearchFixtureProvider(config.env)
          const configured = fixture ? [fixture] : buildConfiguredModelProviders(config.env)
          if (!fixture && config.developer) configured.push(config.developer === 'slow-echo' ? new SlowFakeModelProvider() : new FakeModelProvider())
          providers = new Map(configured.map(provider => [provider.id, provider]))
          providerFailure = null
          return configured.map(provider => provider.status())
        }
        case 'provider.complete': {
          const { id, request } = value as { id: string; request: ModelRequest }
          const provider = providers.get(id)
          if (!provider || calls.has(request.requestId)) throw new Error('provider unavailable or request already executing')
          const controller = new AbortController(); calls.set(request.requestId, controller)
          try { const result = await provider.complete(request, { signal: controller.signal }); providerFailure = null; return result }
          catch (error) { if (!controller.signal.aborted) providerFailure = `${id} inference failed; inspect Core diagnostics`; throw error }
          finally { calls.delete(request.requestId) }
        }
        case 'provider.catalogue': {
          const provider = providers.get((value as { id: string }).id)
          return provider?.listModels?.({ signal: AbortSignal.timeout(15_000) }) ?? []
        }
        case 'provider.cancel': calls.get((value as { requestId: string }).requestId)?.abort(); return true
        case 'mind.run': return runTurn(connection, value as TurnPacket)
        case 'mind.cancel': {
          const { turnId, reason } = value as { turnId: string; reason: string }
          return minds.get(turnId)?.cancelTurn(turnId, reason) ?? 0
        }
        default: throw new Error('operation unavailable in Freya')
      }
    })
    const core = await connection.call<{ pid: number }>('freya.register', { instanceId, pid: process.pid })
    registered = true
    process.stdout.write(`[freya] Mind and providers ready; pid=${process.pid}; Core pid=${core.pid}\n`)
  } catch { peer?.close(); peer = null; registered = false; console.warn('[freya] Core is unavailable; waiting to reconnect') }
  finally { connecting = false }
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }

void listenRpc(required('FREYA_INTELLIGENCE_HEALTH_ENDPOINT'), required('FREYA_INTELLIGENCE_TOKEN'), healthPeer => {
  healthPeer.handle(async method => {
    if (method === 'runtime.quit') {
      for (const controller of calls.values()) controller.abort()
      for (const [id, mind] of minds) mind.cancelTurn(id, 'explicit supervisor shutdown')
      setTimeout(() => process.exit(0), 100); return true
    }
    if (method !== 'runtime.health') throw new Error('operation unavailable')
    const issues = []
    let core: ComponentHealth | null = null
    try { core = await peer?.call<ComponentHealth>('runtime.health', null, 3_000) ?? null } catch { /* Report loss of Core readiness. */ }
    if (!registered || !core || core.lifecycle !== 'ready') issues.push({ code: 'core-unavailable', message: 'Core is not connected and ready' })
    if (![...providers.values()].some(provider => provider.status().status === 'configured')) issues.push({ code: 'provider-unavailable', message: 'no model provider is configured and enabled' })
    if (providerFailure) issues.push({ code: 'provider-failed', message: providerFailure })
    return { component: 'freya', instanceId, pid: process.pid, startedAt, lifecycle: issues.length ? 'degraded' : 'ready', checkedAt: new Date().toISOString(),
      lastProgressAt: registered ? new Date().toISOString() : null,
      dependencies: { core: { state: core?.lifecycle === 'ready' ? 'ready' : 'unavailable', checkedAt: new Date().toISOString() } }, issues } satisfies ComponentHealth
  })
}).then(() => { void connect(); setInterval(() => { void connect() }, 1_000) }).catch(error => { console.error('[freya] runtime startup failed', error); process.exitCode = 1 })
