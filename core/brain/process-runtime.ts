import { AsyncLocalStorage } from 'node:async_hooks'
import type { RpcPeer } from '../../shared/runtime/rpc'
import { Brain } from './brain'
import { applyRecord } from './fold'
import { brainState, type BrainPacket } from './process-packet'
import { BrainStoreError, type BrainRecord, type BrainStore } from './store'
import type { EventFabric } from '../events/fabric'
import type { ReferenceKnowledge } from '../mind/context-compiler'

/** Existing Brain service with a typed, lease-bound Core persistence port. */
export class ProcessMemory {
  private brain: Brain | null = null
  private readonly leases = new AsyncLocalStorage<string>()
  configure(connection: RpcPeer, packet: BrainPacket) {
    const state = brainState(packet)
    let health = packet.health
    const scope = () => { const id = this.leases.getStore(); if (!id) throw new Error('memory write has no Core lease'); return id }
    const store: BrainStore = { mode: packet.mode, faultReason: packet.faultReason, degradedReason: packet.degradedReason,
      state: () => state, health: () => health, close: async () => {},
      write: async record => {
        const result = await connection.call<{ ok: true; record: BrainRecord; health: typeof health } | { ok: false; code: BrainStoreError['code']; reason: string }>('brain.store.write', { id: scope(), record }).catch(error => { connection.close(); throw error })
        if (!result.ok) throw new BrainStoreError(result.code, result.reason)
        applyRecord(state, result.record); health = result.health; return result.record
      } }
    this.brain = new Brain({ store, fabric: { append: ((type, payload) => connection.call('brain.event', { id: scope(), type, payload })) as EventFabric['append'] } as EventFabric })
    return this.brain.projection()
  }
  async run(value: { id: string; method: string; args: unknown[] }) {
    const brain = this.brain
    if (!brain || !Array.isArray(value.args)) throw new Error('Freya memory is not configured')
    return this.leases.run(value.id, async () => {
      let result: unknown
      switch (value.method) {
        case 'writeMemory': result = await brain.writeMemory(...value.args as Parameters<Brain['writeMemory']>); break
        case 'archiveMemory': result = await brain.archiveMemory(...value.args as Parameters<Brain['archiveMemory']>); break
        case 'recordExperience': result = await brain.recordExperience(...value.args as Parameters<Brain['recordExperience']>); break
        case 'recall': result = brain.recall(...value.args as Parameters<Brain['recall']>); break
        default: throw new Error('operation unavailable to Freya memory')
      }
      process.stdout.write(`[freya] memory ${value.method} completed; pid=${process.pid}\n`)
      return { result, projection: brain.projection() }
    })
  }
  reference(query: string): ReferenceKnowledge | null {
    if (!this.brain) throw new Error('Freya memory is not configured')
    const pack = this.brain.recall({ text: query }, { maxEstimatedTokens: 600, maxItems: 8 })
    if (pack.empty) return null
    return { items: pack.memories.map(item => ({ subject: item.subject, content: item.content, sourceLabel: item.source, confidenceLabel: item.confidence })),
      conflicts: pack.conflicts.map(conflict => `${conflict.detail} (${conflict.memoryId} against ${conflict.conflictsWith.join(', ')})`), omittedCount: pack.omittedCount }
  }
  disconnect() { this.brain = null }
}
