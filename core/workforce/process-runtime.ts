import { AsyncLocalStorage } from 'node:async_hooks'
import type { RpcPeer } from '../../shared/runtime/rpc'
import type { EventFabric } from '../events/fabric'
import type { AnyCoreEvent } from '../events/envelope'
import { WorkforceEngine } from './engine'
import type { WorkforceOwnerScope, SubordinateWorkerScope } from './authority'
import type { WorkforcePacket } from './process-contract'

export class ProcessWorkforceRuntime {
  private engine: WorkforceEngine | null = null
  private connection: RpcPeer | null = null
  private readonly leases = new AsyncLocalStorage<{ id: string; missions: string[] }>()
  private stopped = true
  private operation<T>(method: string, ...args: unknown[]): Promise<T> {
    const lease = this.leases.getStore()
    if (!lease || !this.connection?.connected) throw new Error('agent effect has no connected Core lease')
    return this.connection.call<T>(method, { id: lease.id, args })
  }
  async configure(connection: RpcPeer, packet: WorkforcePacket) {
    if (packet.version !== 1) throw new Error('unsupported Workforce transport version')
    await this.close(); this.connection = connection; this.stopped = packet.stopped
    const listeners = new Set<(event: AnyCoreEvent) => void>()
    const fabric = { replay: async <S>(initial: S, reduce: (state: S, event: AnyCoreEvent) => S) => packet.events.reduce(reduce, initial),
      subscribe: (listener: (event: AnyCoreEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      append: async (type: string, payload: unknown, options: unknown) => {
        const event = await this.operation<AnyCoreEvent>('workforce.event', type, payload, options)
        for (const listener of listeners) listener(event)
        return event
      } } as unknown as EventFabric
    const engine = new WorkforceEngine({ fabric, principalId: packet.principalId, limits: packet.limits, stopAll: () => this.stopped,
      core: { missionExists: id => this.leases.getStore()?.missions.includes(id) ?? false, requestCognition: (id, intent) => this.operation('workforce.cognition', id, intent) } })
    this.engine = engine
    await this.leases.run({ id: packet.id, missions: [] }, async () => { await engine.open(); if (packet.stopped) { engine.stopAll('Core STOP ALL is active'); await engine.settled() } })
    process.stdout.write(`[freya] Workforce recovery completed; pid=${process.pid}\n`)
    return engine.projection()
  }
  async run(value: { id: string; method: string; args: unknown[]; missions: string[]; stopped: boolean }) {
    const engine = this.engine
    if (!engine || !Array.isArray(value.args)) throw new Error('Freya agents are not configured')
    this.stopped = value.stopped
    return this.leases.run({ id: value.id, missions: value.missions }, async () => {
      const owner = engine.ownerScope()
      const worker = value.method.startsWith('worker.') ? owner.scopeFor(value.args[0] as string) : null
      const workerArgs = value.args.slice(1)
      let result: unknown
      switch (value.method) {
        case 'createWorker': result = await owner.createWorker(...value.args as Parameters<WorkforceOwnerScope['createWorker']>); break
        case 'retireWorker': result = await owner.retireWorker(...value.args as Parameters<WorkforceOwnerScope['retireWorker']>); break
        case 'suspendWorker': result = await owner.suspendWorker(...value.args as Parameters<WorkforceOwnerScope['suspendWorker']>); break
        case 'resumeWorker': result = await owner.resumeWorker(...value.args as Parameters<WorkforceOwnerScope['resumeWorker']>); break
        case 'createTeam': result = await owner.createTeam(...value.args as Parameters<WorkforceOwnerScope['createTeam']>); break
        case 'disbandTeam': result = await owner.disbandTeam(...value.args as Parameters<WorkforceOwnerScope['disbandTeam']>); break
        case 'joinTeam': result = await owner.joinTeam(...value.args as Parameters<WorkforceOwnerScope['joinTeam']>); break
        case 'leaveTeam': result = await owner.leaveTeam(...value.args as Parameters<WorkforceOwnerScope['leaveTeam']>); break
        case 'assignCapability': result = await owner.assignCapability(...value.args as Parameters<WorkforceOwnerScope['assignCapability']>); break
        case 'assignContext': result = await owner.assignContext(...value.args as Parameters<WorkforceOwnerScope['assignContext']>); break
        case 'assign': result = await owner.assign(...value.args as Parameters<WorkforceOwnerScope['assign']>); break
        case 'cancelAssignment': result = await owner.cancelAssignment(...value.args as Parameters<WorkforceOwnerScope['cancelAssignment']>); break
        case 'worker.readMailbox': result = await worker!.readMailbox(); break
        case 'worker.sendMessage': result = await worker!.sendMessage(...workerArgs as Parameters<SubordinateWorkerScope['sendMessage']>); break
        case 'worker.requestCognition': result = await worker!.requestCognition(...workerArgs as Parameters<SubordinateWorkerScope['requestCognition']>); break
        case 'worker.claimPermission': result = await worker!.claimPermission(...workerArgs as Parameters<SubordinateWorkerScope['claimPermission']>); break
        case 'worker.reportAssignment': result = await worker!.reportAssignment(...workerArgs as Parameters<SubordinateWorkerScope['reportAssignment']>); break
        case 'detail': result = await engine.detail(value.args[0] as string); break
        case 'reconcileExpiredAssignments': result = await engine.reconcileExpiredAssignments(); break
        case 'stopAll': engine.stopAll(value.args[0] as string); await engine.settled(); break
        case 'resume': engine.resume(); break
        default: throw new Error('operation unavailable to Freya agents')
      }
      process.stdout.write(`[freya] Workforce ${value.method} completed; pid=${process.pid}\n`)
      return { result, projection: engine.projection() }
    })
  }
  async close() { const engine = this.engine; this.engine = null; this.connection = null; await engine?.close() }
}
