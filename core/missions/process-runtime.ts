import { AsyncLocalStorage } from 'node:async_hooks'
import type { RpcPeer } from '../../shared/runtime/rpc'
import { MissionEngine } from './engine'
import type { MissionPacket, MissionWorkPacket } from './process-contract'
import type { MissionStore } from './store'
import type { AnyCoreEvent } from '../events/envelope'
import type { EventFabric } from '../events/fabric'
import { isTerminalRunStatus } from '../work/types'

export class ProcessMissionRuntime {
  private engine: MissionEngine | null = null
  private readonly leases = new AsyncLocalStorage<string>()
  private work: MissionWorkPacket = { revision: 0, runs: [], steps: [] }
  private stopped = true
  private connection: RpcPeer | null = null
  private operation<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.leases.getStore()
    if (!id || !this.connection?.connected) throw new Error('Mission effect has no connected Core lease')
    return this.connection.call<T>(method, { id, args })
  }
  async configure(connection: RpcPeer, packet: MissionPacket) {
    if (packet.version !== 1) throw new Error('unsupported Mission transport version')
    await this.engine?.close(); this.connection = connection; this.work = packet.work; this.stopped = packet.stopped
    const listeners = new Set<(event: AnyCoreEvent) => void>()
    const fabric = { replay: async <S>(initial: S, reduce: (state: S, event: AnyCoreEvent) => S) => packet.events.reduce(reduce, initial),
      subscribe: (listener: (event: AnyCoreEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      append: async (type: string, payload: unknown) => {
        const event = await this.operation<AnyCoreEvent>('mission.event', type, payload)
        for (const listener of listeners) listener(event)
        return event
      } } as unknown as EventFabric
    const store: MissionStore = { ...packet.store, health: () => packet.store.health, close: async () => {},
      write: content => this.operation('mission.store.write', content), read: id => this.operation('mission.store.read', id), remove: id => this.operation('mission.store.remove', id) }
    const workEffect = async (method: string, id: string, reason: string) => { const effect = await this.operation<{ result: boolean; work: MissionWorkPacket }>(method, id, reason); this.work = effect.work; return effect.result }
    const engine = new MissionEngine({ store, fabric, principalId: packet.principalId, stopAll: () => this.stopped,
      work: { run: id => this.work.runs.find(run => run.runId === id), stepsOf: id => this.work.steps.find(run => run.runId === id)?.steps ?? [], isSettled: isTerminalRunStatus,
        pauseRun: (id, reason) => workEffect('mission.work.pauseRun', id, reason), cancelRun: (id, reason) => workEffect('mission.work.cancelRun', id, reason) } })
    this.engine = engine
    await this.leases.run(packet.id, () => engine.open())
    return true
  }
  async run(value: { id: string; method: string; args: unknown[]; work: MissionWorkPacket; stopped: boolean }) {
    const engine = this.engine
    if (!engine || !Array.isArray(value.args)) throw new Error('Freya Missions are not configured')
    if (value.work.revision >= this.work.revision) { this.work = value.work; this.stopped = value.stopped }
    return this.leases.run(value.id, async () => {
      let result: unknown
      switch (value.method) {
        case 'attachChildRunWhileCreating': result = await engine.attachChildRunWhileCreating(value.args[0] as string, async () => {
          const child = await this.operation<{ runId: string; work: MissionWorkPacket }>('mission.createChild'); this.work = child.work; return child.runId
        }, value.args[2] as string | null); break
        case 'updateChatContent': result = await engine.updateChatContent(value.args[0] as string, content => {
          return this.operation('mission.updateChatContent', content)
        }); break
        case 'create': result = await engine.create(...value.args as Parameters<MissionEngine['create']>); break
        case 'update': result = await engine.update(...value.args as Parameters<MissionEngine['update']>); break
        case 'delete': result = await engine.delete(...value.args as Parameters<MissionEngine['delete']>); break
        case 'activate': result = await engine.activate(...value.args as Parameters<MissionEngine['activate']>); break
        case 'markGoalReady': result = await engine.markGoalReady(...value.args as Parameters<MissionEngine['markGoalReady']>); break
        case 'resume': result = await engine.resume(...value.args as Parameters<MissionEngine['resume']>); break
        case 'resumeToReady': result = await engine.resumeToReady(...value.args as Parameters<MissionEngine['resumeToReady']>); break
        case 'pause': result = await engine.pause(...value.args as Parameters<MissionEngine['pause']>); break
        case 'cancel': result = await engine.cancel(...value.args as Parameters<MissionEngine['cancel']>); break
        case 'fail': result = await engine.fail(...value.args as Parameters<MissionEngine['fail']>); break
        case 'autonomyTransition': result = await engine.autonomyTransition(...value.args as Parameters<MissionEngine['autonomyTransition']>); break
        case 'requestCompletion': result = await engine.requestCompletion(...value.args as Parameters<MissionEngine['requestCompletion']>); break
        case 'attachChildRun': result = await engine.attachChildRun(...value.args as Parameters<MissionEngine['attachChildRun']>); break
        case 'detail': result = await engine.detail(...value.args as Parameters<MissionEngine['detail']>); break
        case 'privateContent': result = await engine.privateContent(...value.args as Parameters<MissionEngine['privateContent']>); break
        case 'persistExecutionPlan': result = await engine.persistExecutionPlan(...value.args as Parameters<MissionEngine['persistExecutionPlan']>); break
        case 'writeIntent': result = await engine.writeIntent(...value.args as Parameters<MissionEngine['writeIntent']>); break
        case 'readIntent': result = await engine.readIntent(...value.args as Parameters<MissionEngine['readIntent']>); break
        case 'commitPlan': result = await engine.commitPlan(...value.args as Parameters<MissionEngine['commitPlan']>); break
        case 'transitionStep': result = await engine.transitionStep(...value.args as Parameters<MissionEngine['transitionStep']>); break
        case 'interruptStep': result = await engine.interruptStep(...value.args as Parameters<MissionEngine['interruptStep']>); break
        case 'recordEvidence': result = await engine.recordEvidence(...value.args as Parameters<MissionEngine['recordEvidence']>); break
        case 'setBlocker': result = await engine.setBlocker(...value.args as Parameters<MissionEngine['setBlocker']>); break
        case 'noteApprovalRequested': result = await engine.noteApprovalRequested(...value.args as Parameters<MissionEngine['noteApprovalRequested']>); break
        case 'noteApprovalOutcome': result = await engine.noteApprovalOutcome(...value.args as Parameters<MissionEngine['noteApprovalOutcome']>); break
        case 'scheduleWake': result = await engine.scheduleWake(...value.args as Parameters<MissionEngine['scheduleWake']>); break
        case 'fireWake': result = await engine.fireWake(...value.args as Parameters<MissionEngine['fireWake']>); break
        case 'recordDecision': result = await engine.recordDecision(...value.args as Parameters<MissionEngine['recordDecision']>); break
        case 'charge': result = await engine.charge(...value.args as Parameters<MissionEngine['charge']>); break
        case 'noteBudgetExceeded': result = await engine.noteBudgetExceeded(...value.args as Parameters<MissionEngine['noteBudgetExceeded']>); break
        case 'setRequestedQuantity': result = await engine.setRequestedQuantity(...value.args as Parameters<MissionEngine['setRequestedQuantity']>); break
        case 'recordCorrection': result = await engine.recordCorrection(...value.args as Parameters<MissionEngine['recordCorrection']>); break
        case 'recordAmbiguity': result = await engine.recordAmbiguity(...value.args as Parameters<MissionEngine['recordAmbiguity']>); break
        default: throw new Error('operation unavailable to Freya Missions')
      }
      process.stdout.write(`[freya] Mission ${value.method} completed; pid=${process.pid}\n`)
      return result
    })
  }
  async close() { const engine = this.engine; this.engine = null; this.connection = null; await engine?.close() }
}
