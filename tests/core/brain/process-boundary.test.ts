// @vitest-environment node
import { expect, it } from 'vitest'
import { ProcessBrain } from '../../../core/brain/process-store'
import { MemoryBrainStore } from '../../../core/brain/memory-store'
import { EventFabric } from '../../../core/events/fabric'
import { EphemeralEventStore } from '../../../core/events/ephemeral-store'
import { buildIdentityRoot } from '../../../core/brain/brain'
import type { RpcPeer } from '../../../shared/runtime/rpc'

it('refuses unsolicited memory writes, and never lets an intelligence lease rewrite root identity', async () => {
  const store = new MemoryBrainStore()
  const brain = new ProcessBrain(store, await EventFabric.open({ store: new EphemeralEventStore() }))
  await expect(brain.handle('brain.store.write', { id: 'invented', record: { kind: 'identity-root', identity: buildIdentityRoot() } })).rejects.toThrow('admitted memory operation')
  const peer = {
    connected: true, onClose: () => {},
    call: async (method: string, value: { id: string }) => {
      if (method === 'brain.configure') return null
      await expect(brain.handle('brain.store.write', { id: value.id, record: { kind: 'identity-root', identity: buildIdentityRoot() } })).rejects.toThrow('root identity')
      return { result: { outcome: 'rejected', memory: null, reason: 'test' }, projection: null }
    },
  } as unknown as RpcPeer
  await brain.connect(peer)
  await brain.writeMemory({ kind: 'semantic', subject: 'Fixture', content: 'Fixture', source: 'owner-assertion', sourceRef: null, confidence: 'high', sensitivity: 'personal' })
  expect(store.state().sequence).toBe(0)
})
