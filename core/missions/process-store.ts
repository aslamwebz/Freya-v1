import { randomUUID } from 'node:crypto'
import type { RpcPeer } from '../../shared/runtime/rpc'
import type { MissionEngine, MissionEngineOptions } from './engine'
import type { MissionContent } from './types'
import { DEFAULT_MISSION_LIMITS, isLiveMissionStatus } from './types'
import { initialMissionState, reduceMissionState } from './state'
import { missionProjection } from './projection'
import type { MissionPacket, MissionWorkPacket, MissionRuntime } from './process-contract'

type RemoteMethod = Exclude<keyof MissionRuntime, 'open' | 'close' | 'projection' | 'snapshot' | 'limits' | 'record' | 'exists'>
export class ProcessMissions implements MissionRuntime {
  private state = initialMissionState()
  private peer: RpcPeer | null = null
  private dispose: () => void = () => {}
  private readonly active = new Map<string, { method: string; args: unknown[] }>()
  constructor(private readonly options: MissionEngineOptions) {}
  async open() {
    this.state = await this.options.fabric.replay(initialMissionState(), reduceMissionState)
    this.dispose = this.options.fabric.subscribe(event => { this.state = reduceMissionState(this.state, event) })
  }
  private work(extra?: string): MissionWorkPacket {
    const ids = new Set([...this.state.missions.values()].flatMap(mission => mission.childRuns))
    if (extra) ids.add(extra)
    return { revision: this.options.fabric.lastSequence, runs: [...ids].flatMap(id => { const run = this.options.work.run(id); return run ? [run] : [] }),
      steps: [...ids].map(runId => ({ runId, steps: this.options.work.stepsOf(runId) })) }
  }
  async connect(peer: RpcPeer) {
    this.peer = peer; peer.onClose(() => { if (this.peer === peer) this.peer = null })
    const id = randomUUID(); this.active.set(id, { method: 'open', args: [] })
    const packet: MissionPacket = { version: 1, id, events: (await this.options.fabric.readAll()).filter(event => event.type.startsWith('mission.')),
      principalId: this.options.principalId, stopped: this.options.stopAll?.() ?? false, work: this.work(),
      store: { mode: this.options.store.mode, durable: this.options.store.durable, faultReason: this.options.store.faultReason, health: this.options.store.health() } }
    try { await peer.call('mission.configure', packet); this.options.onChange?.() }
    finally { this.active.delete(id) }
  }
  async handle(method: string, raw: unknown): Promise<unknown> {
    const value = raw as { id: string; args: unknown[] }
    const lease = this.active.get(value?.id)
    if (!lease || !Array.isArray(value.args)) throw new Error('no admitted Mission operation')
    const [a, b] = value.args
    const readonly = ['detail', 'privateContent', 'readIntent'].includes(lease.method)
    if (method === 'mission.store.read') return this.options.store.read(a as string)
    if (readonly) throw new Error('the Mission operation is read-only')
    switch (method) {
      case 'mission.store.write': return this.options.store.write(a as MissionContent)
      case 'mission.store.remove': return this.options.store.remove(a as string)
      case 'mission.event': {
        if (typeof a !== 'string' || !a.startsWith('mission.')) throw new Error('Mission event scope mismatch')
        const payload = b as { to?: unknown }
        if (isLiveMissionStatus(payload?.to as never) && this.options.stopAll?.()) {
          throw new Error('STOP ALL prevents Mission activation')
        }
        const event = await this.options.fabric.append(a as never, b as never, { actor: this.options.principalId })
        this.options.onChange?.(); return event
      }
      case 'mission.work.pauseRun': return { result: await this.options.work.pauseRun(a as string, b as string), work: this.work(a as string) }
      case 'mission.work.cancelRun': return { result: await this.options.work.cancelRun(a as string, b as string), work: this.work(a as string) }
      case 'mission.createChild': {
        if (lease.method !== 'attachChildRunWhileCreating') throw new Error('no admitted child Run creation')
        const runId = await (lease.args[1] as () => Promise<string>)()
        return { runId, work: this.work(runId) }
      }
      case 'mission.updateChatContent': {
        if (lease.method !== 'updateChatContent') throw new Error('no admitted chat content update')
        return (lease.args[1] as (content: MissionContent) => MissionContent)(a as MissionContent)
      }
      default: throw new Error('operation unavailable to Missions')
    }
  }
  private async run<K extends RemoteMethod>(method: K, args: Parameters<MissionEngine[K]>): Promise<Awaited<ReturnType<MissionEngine[K]>>> {
    const peer = this.peer
    if (!peer?.connected) throw new Error('Freya Missions are unavailable; the operation was not retried')
    const id = randomUUID(); this.active.set(id, { method, args })
    const packet = [...args]
    if (method === 'updateChatContent' || method === 'attachChildRunWhileCreating') packet[1] = null
    try { return await peer.call<Awaited<ReturnType<MissionEngine[K]>>>('mission.run', { id, method, args: packet, stopped: this.options.stopAll?.() ?? false,
      work: this.work(typeof args[1] === 'string' ? args[1] : undefined) }) }
    finally { this.active.delete(id); if (!['detail', 'privateContent', 'readIntent'].includes(method)) this.options.onChange?.() }
  }
  create(...args: Parameters<MissionEngine['create']>) { return this.run('create', args) }
  update(...args: Parameters<MissionEngine['update']>) { return this.run('update', args) }
  delete(...args: Parameters<MissionEngine['delete']>) { return this.run('delete', args) }
  activate(...args: Parameters<MissionEngine['activate']>) { return this.run('activate', args) }
  markGoalReady(...args: Parameters<MissionEngine['markGoalReady']>) { return this.run('markGoalReady', args) }
  resume(...args: Parameters<MissionEngine['resume']>) { return this.run('resume', args) }
  resumeToReady(...args: Parameters<MissionEngine['resumeToReady']>) { return this.run('resumeToReady', args) }
  pause(...args: Parameters<MissionEngine['pause']>) { return this.run('pause', args) }
  cancel(...args: Parameters<MissionEngine['cancel']>) { return this.run('cancel', args) }
  fail(...args: Parameters<MissionEngine['fail']>) { return this.run('fail', args) }
  autonomyTransition(...args: Parameters<MissionEngine['autonomyTransition']>) { return this.run('autonomyTransition', args) }
  requestCompletion(...args: Parameters<MissionEngine['requestCompletion']>) { return this.run('requestCompletion', args) }
  attachChildRun(...args: Parameters<MissionEngine['attachChildRun']>) { return this.run('attachChildRun', args) }
  attachChildRunWhileCreating(...args: Parameters<MissionEngine['attachChildRunWhileCreating']>) { return this.run('attachChildRunWhileCreating', args) }
  detail(...args: Parameters<MissionEngine['detail']>) { return this.run('detail', args) }
  privateContent(...args: Parameters<MissionEngine['privateContent']>) { return this.run('privateContent', args).catch(() => null) }
  updateChatContent(...args: Parameters<MissionEngine['updateChatContent']>) { return this.run('updateChatContent', args) }
  persistExecutionPlan(...args: Parameters<MissionEngine['persistExecutionPlan']>) { return this.run('persistExecutionPlan', args) }
  writeIntent(...args: Parameters<MissionEngine['writeIntent']>) { return this.run('writeIntent', args) }
  readIntent(...args: Parameters<MissionEngine['readIntent']>) { return this.run('readIntent', args).catch(() => null) }
  commitPlan(...args: Parameters<MissionEngine['commitPlan']>) { return this.run('commitPlan', args) }
  transitionStep(...args: Parameters<MissionEngine['transitionStep']>) { return this.run('transitionStep', args) }
  interruptStep(...args: Parameters<MissionEngine['interruptStep']>) { return this.run('interruptStep', args) }
  recordEvidence(...args: Parameters<MissionEngine['recordEvidence']>) { return this.run('recordEvidence', args) }
  setBlocker(...args: Parameters<MissionEngine['setBlocker']>) { return this.run('setBlocker', args) }
  noteApprovalRequested(...args: Parameters<MissionEngine['noteApprovalRequested']>) { return this.run('noteApprovalRequested', args) }
  noteApprovalOutcome(...args: Parameters<MissionEngine['noteApprovalOutcome']>) { return this.run('noteApprovalOutcome', args) }
  scheduleWake(...args: Parameters<MissionEngine['scheduleWake']>) { return this.run('scheduleWake', args) }
  fireWake(...args: Parameters<MissionEngine['fireWake']>) { return this.run('fireWake', args) }
  recordDecision(...args: Parameters<MissionEngine['recordDecision']>) { return this.run('recordDecision', args) }
  charge(...args: Parameters<MissionEngine['charge']>) { return this.run('charge', args) }
  noteBudgetExceeded(...args: Parameters<MissionEngine['noteBudgetExceeded']>) { return this.run('noteBudgetExceeded', args) }
  setRequestedQuantity(...args: Parameters<MissionEngine['setRequestedQuantity']>) { return this.run('setRequestedQuantity', args) }
  recordCorrection(...args: Parameters<MissionEngine['recordCorrection']>) { return this.run('recordCorrection', args) }
  recordAmbiguity(...args: Parameters<MissionEngine['recordAmbiguity']>) { return this.run('recordAmbiguity', args) }
  projection() { return missionProjection(this.state, this.options.work, { mode: this.options.store.mode, reason: this.peer?.connected ? this.options.store.faultReason : 'Freya Mission engine is disconnected' }, this.options.now?.() ?? new Date()) }
  snapshot() { return this.state }
  limits() { return DEFAULT_MISSION_LIMITS }
  record(id: string) { return this.state.missions.get(id) }
  exists(id: string) { return this.state.missions.has(id) }
  async close() { this.dispose(); if (this.peer?.connected) await this.peer.call('mission.close', null).catch(() => {}); await this.options.store.close() }
}
