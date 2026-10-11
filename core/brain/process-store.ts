import { randomUUID } from 'node:crypto'
import type { RpcPeer } from '../../shared/runtime/rpc'
import type { EventFabric } from '../events/fabric'
import type { Brain, BrainProjection } from './brain'
import { brainPacket } from './process-packet'
import type { BrainRecord, BrainStore } from './store'
import { seedBrain } from './seed'

/** Protected storage remains here; every admitted memory algorithm runs in Freya. */
export class ProcessBrain {
  private peer: RpcPeer | null = null
  private cached: BrainProjection | null = null
  private readonly active = new Map<string, string>()
  constructor(private readonly store: BrainStore, private readonly fabric: EventFabric) {}
  async connect(peer: RpcPeer): Promise<void> {
    this.peer = peer
    peer.onClose(() => { if (this.peer === peer) this.peer = null })
    this.cached = await peer.call<BrainProjection>('brain.configure', brainPacket(this.store))
  }
  async handle(method: string, raw: unknown): Promise<unknown> {
    const value = raw as { id: string; record: BrainRecord; type: string; payload: Record<string, unknown> }
    const operation = this.active.get(value?.id)
    if (!operation || operation === 'recall') throw new Error('no admitted memory operation')
    if (method === 'brain.store.write') {
      if (value.record?.kind === 'identity-root' || value.record?.kind === 'self-definition') throw new Error('root identity belongs to protected bootstrap')
      const kinds = operation === 'recordExperience' ? ['experience'] : operation === 'archiveMemory' ? ['memory-record'] : ['memory-candidate', 'memory-record', 'memory-review']
      if (!kinds.includes(value.record?.kind)) throw new Error('memory record is outside the admitted operation')
      try { return { ok: true, record: await this.store.write(value.record), health: this.store.health() } }
      catch (error) { return { ok: false, code: error && typeof error === 'object' && 'code' in error ? error.code : 'write-failed', reason: error instanceof Error ? error.message : 'memory persistence failed' } }
    }
    if (method === 'brain.event') {
      if (!['brain.memory.reviewed', 'brain.memory.admitted', 'brain.memory.archived', 'brain.experience.recorded'].includes(value.type)) throw new Error('memory event is outside the admitted scope')
      return this.fabric.append(value.type as never, value.payload as never, { actor: 'system' })
    }
    throw new Error('operation unavailable to memory')
  }
  private async run<K extends 'writeMemory' | 'archiveMemory' | 'recordExperience' | 'recall'>(method: K, args: Parameters<Brain[K]>): Promise<Awaited<ReturnType<Brain[K]>>> {
    const peer = this.peer
    if (!peer?.connected) throw new Error('Freya memory is unavailable; the operation was not retried')
    const id = randomUUID(); this.active.set(id, method)
    try {
      const result = await peer.call<{ result: Awaited<ReturnType<Brain[K]>>; projection: BrainProjection }>('brain.run', { id, method, args })
      this.cached = result.projection; return result.result
    } finally { this.active.delete(id) }
  }
  writeMemory(...args: Parameters<Brain['writeMemory']>) { return this.run('writeMemory', args) }
  archiveMemory(...args: Parameters<Brain['archiveMemory']>) { return this.run('archiveMemory', args) }
  recordExperience(...args: Parameters<Brain['recordExperience']>) { return this.run('recordExperience', args) }
  recall(...args: Parameters<Brain['recall']>) { return this.run('recall', args) }
  seed(...args: Parameters<Brain['seed']>) { return seedBrain(this.store, ...args) }
  identity() { return this.store.state().identity }
  self() { return this.store.state().self }
  state() { return this.store.state() }
  health() { return { ...this.store.health(), persistence: this.store.mode } }
  projection(): BrainProjection {
    if (this.cached && this.peer?.connected) return { ...this.cached, ...this.store.health() }
    return { ...(this.cached ?? { persistence: this.store.mode, durable: this.store.mode === 'encrypted', identity: null, self: null,
      counts: { entities: 0, relations: 0, observations: 0, memories: 0, admitted: 0, conflicted: 0, rejected: 0, withdrawn: 0, experiences: 0 },
      recentAdmissions: [], conflicts: [], sequence: this.store.state().sequence }), health: 'unavailable', reason: 'Freya memory process is disconnected' }
  }
  async close() { await this.store.close() }
}
