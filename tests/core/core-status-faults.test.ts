// @vitest-environment node
import { expect, it } from 'vitest'
import { ModelGateway } from '../../core/model/gateway'
import { EventFabric } from '../../core/events/fabric'
import { EphemeralEventStore } from '../../core/events/ephemeral-store'
import { initialCoreState } from '../../core/state'
import { projectCoreStatus } from '../../core/projections/core-status'

it('exposes a closed cognition gate alongside unrelated degradation', async () => {
  const gateway = new ModelGateway({ providers: [], recorder: {
    started: async () => {}, completed: async () => {}, failed: async () => {}, cancelled: async () => {},
  } })
  gateway.cancelAll('provider contact halted')
  const store = new EphemeralEventStore()
  const fabric = await EventFabric.open({ store })
  const state = { ...initialCoreState(), faults: ['Brain index damaged'] }
  const status = projectCoreStatus({ state, lifecycle: 'degraded', operational: true,
    gateway, fabric, now: new Date(), startedAt: null,
    integrity: { integrity: 'ok', reason: 'read in full', line: null, eventsRead: 0, bytesDiscarded: 0 },
    persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null },
    diagnosticsPath: null, diagnosticsWriteFailures: 0 })
  expect(status.faults).toContain('Brain index damaged')
  expect(status.faults.join(' ')).toContain('provider contact halted')
  expect(status.governor.status).toBe('deny_all')
  await fabric.close()
})
