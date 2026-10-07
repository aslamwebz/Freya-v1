// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { FallbackEventStore } from '../../core/events/fallback-store'
import { EphemeralEventStore } from '../../core/events/ephemeral-store'
import { CORE_EVENT_SCHEMA_VERSION, type AnyCoreEvent } from '../../core/events/envelope'

function event(sequence: number): AnyCoreEvent {
  return { eventId: `e-${sequence}`, sequence, type: 'security.stop_all.activated',
    schemaVersion: CORE_EVENT_SCHEMA_VERSION, occurredAt: new Date().toISOString(), source: 'core',
    actor: 'owner', correlationId: `c-${sequence}`, causationId: null, payload: { by: 'owner', reason: 'stop' } }
}

it('keeps committed security events when a delayed read races an append before fallback', async () => {
  const durable = new EphemeralEventStore()
  const originalRead = durable.readAll.bind(durable)
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const delay = new Promise<void>(resolve => { release = resolve })
  durable.readAll = async () => { const snapshot = await originalRead(); entered(); await delay; return snapshot }
  const failed = vi.fn()
  const store = new FallbackEventStore(durable, failed, vi.fn())
  const read = store.readAll()
  await started
  const append = store.append(event(1))
  // Let an unqueued append finish, without waiting for a queued implementation.
  await new Promise(resolve => setTimeout(resolve, 0))
  release()
  await Promise.all([read, append])
  durable.append = async () => { throw new Error('disk full') }
  await store.append(event(2))
  expect((await store.readAll()).map(e => e.sequence)).toEqual([1, 2])
  expect(failed).toHaveBeenCalledOnce()
  await store.close()
})

it('uses the recovered history when a later read fails', async () => {
  const durable = new EphemeralEventStore()
  await durable.append(event(1))
  const failed = vi.fn()
  const store = new FallbackEventStore(durable, failed, vi.fn())
  await store.readAll()
  durable.readAll = async () => { throw new Error('read failed') }
  expect((await store.readAll()).map(e => e.sequence)).toEqual([1])
  expect(failed).toHaveBeenCalledOnce()
  await store.append(event(2))
  expect(await store.lastSequence()).toBe(2)
  await store.close()
})
