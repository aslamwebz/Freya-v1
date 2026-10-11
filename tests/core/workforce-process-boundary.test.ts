// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { WorkforceEngineOptions } from '../../core/workforce/engine'
import { ProcessWorkforce } from '../../core/workforce/process-store'

function fixture() {
  const append = vi.fn(async () => ({ type: 'workforce.event' }))
  const workforce = new ProcessWorkforce({
    principalId: 'owner',
    fabric: { append } as unknown as WorkforceEngineOptions['fabric'],
    core: { missionExists: () => false, requestCognition: async () => { throw new Error('not permitted') } },
  })
  const active = (workforce as unknown as {
    active: Map<string, { method: string; args: unknown[] }>
  }).active
  return { workforce, active, append }
}

describe('process Workforce event admission', () => {
  it('refuses journal mutation using read-only detail and mailbox leases', async () => {
    const { workforce, active, append } = fixture()
    for (const method of ['detail', 'worker.readMailbox']) {
      active.set('lease', { method, args: ['worker-a'] })
      await expect(workforce.handle('workforce.event', {
        id: 'lease', args: ['workforce.worker.created', { workerId: 'forged' }, {}],
      })).rejects.toThrow('not admitted')
    }
    expect(append).not.toHaveBeenCalled()
  })

  it('prevents message and worker creation leases from minting capabilities', async () => {
    const { workforce, active, append } = fixture()
    active.set('lease', { method: 'worker.sendMessage', args: ['worker-a', { to: 'worker-b', text: 'hi' }] })
    await expect(workforce.handle('workforce.event', {
      id: 'lease', args: ['workforce.capability.assigned', { workerId: 'worker-a', capability: 'cognition.request' }, {}],
    })).rejects.toThrow('not admitted')
    active.set('lease', { method: 'createWorker', args: [{ name: 'worker' }] })
    await expect(workforce.handle('workforce.event', {
      id: 'lease', args: ['workforce.assignment.created', { workerId: 'worker-a' }, {}],
    })).rejects.toThrow('not admitted')
    expect(append).not.toHaveBeenCalled()
  })

  it('validates capability ownership and STOP ALL even under matching operation leases', async () => {
    const { workforce, active, append } = fixture()
    active.set('lease', { method: 'assignCapability', args: ['worker-a', 'cognition.request'] })
    await expect(workforce.handle('workforce.event', {
      id: 'lease', args: ['workforce.capability.assigned', { workerId: 'worker-b', capability: 'cognition.request' }, {}],
    })).rejects.toThrow('not admitted')
    expect(append).not.toHaveBeenCalled()

    const stopped = new ProcessWorkforce({
      principalId: 'owner',
      fabric: { append } as unknown as WorkforceEngineOptions['fabric'],
      core: { missionExists: () => false, requestCognition: async () => { throw new Error('not permitted') } },
      stopAll: () => true,
    })
    const leases = (stopped as unknown as { active: Map<string, { method: string; args: unknown[] }> }).active
    leases.set('lease', { method: 'assign', args: [{ workerId: 'worker-a', capabilities: [] }] })
    await expect(stopped.handle('workforce.event', {
      id: 'lease', args: ['workforce.assignment.created', { workerId: 'worker-a' }, {}],
    })).rejects.toThrow('STOP ALL')
    expect(append).not.toHaveBeenCalled()
  })
})
