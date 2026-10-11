// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { AttentionEngine } from '../../core/attention/engine'
import { initialAttentionState, reduceAttention } from '../../core/attention/state'
import { EncryptedAttentionScheduleStore } from '../../core/attention/schedule-store'

let directory = ''
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'freya-reminder-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function open(key: Uint8Array, now: () => Date) {
  const store = await EncryptedAttentionScheduleStore.open({ path: join(directory, 'schedules.enc'), key })
  const fabric = await EventFabric.open({ store: await JsonlEventStore.open(join(directory, 'events.jsonl')), now })
  let state = await fabric.replay(initialAttentionState(), reduceAttention)
  fabric.subscribe(event => { state = reduceAttention(state, event) })
  const engine = new AttentionEngine({ fabric, scheduleStore: store, now, getState: () => state, focus: () => 'available', stopAll: () => false })
  await engine.reconcile()
  return { engine, store, fabric, state: () => state }
}

it('retains an encrypted daily reminder across restart, repeats past eight days and cancels durably', async () => {
  const key = randomBytes(32)
  let clock = new Date('2026-10-11T09:00:00Z')
  const first = await open(key, () => clock)
  const result = await first.engine.registerSchedule({ kind: 'reminder', text: 'Brush your teeth', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })
  expect(result.ok).toBe(true)
  expect(await readFile(join(directory, 'schedules.enc'), 'utf8')).not.toContain('Brush your teeth')
  await first.store.close()
  await first.fabric.close()
  const second = await open(key, () => clock)
  for (let day = 0; day < 10; day += 1) {
    clock = new Date(Date.parse('2026-10-11T09:00:00Z') + day * 86_400_000)
    expect(await second.engine.tick(clock)).toBe(1)
    expect(await second.engine.tick(clock)).toBe(0)
  }
  expect(second.state().schedules[0]?.status).toBe('pending')
  expect(second.state().schedules[0]?.repeats).toBe(10)
  const scheduleId = result.ok ? result.scheduleId : ''
  expect(await second.engine.cancelSchedule(scheduleId)).toBe(true)
  expect(await second.store.read(scheduleId)).toBeNull()
  await second.fabric.close(); await second.store.close()
  const third = await open(key, () => clock)
  clock = new Date(clock.getTime() + 86_400_000)
  expect(await third.engine.tick(clock)).toBe(0)
  expect(await readFile(join(directory, 'events.jsonl'), 'utf8')).not.toContain('Brush your teeth')
  await third.fabric.close(); await third.store.close()
})

it('fires once after downtime and skips missed occurrences without drifting the daily time', async () => {
  let clock = new Date('2026-10-11T09:00:00Z')
  const { engine, fabric, store, state } = await open(randomBytes(32), () => clock)
  await engine.registerSchedule({ kind: 'reminder', text: 'Brush', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })
  clock = new Date('2026-10-14T12:00:00Z')
  expect(await engine.tick(clock)).toBe(1)
  expect(state().schedules[0]?.dueAt).toBe('2026-10-15T09:00:00.000Z')
  expect(await engine.tick(clock)).toBe(0)
  await fabric.close(); await store.close()
})

it('serializes concurrent host ticks so a due reminder produces one event', async () => {
  const clock = new Date('2026-10-11T09:00:00Z')
  const { engine, fabric, store, state } = await open(randomBytes(32), () => clock)
  expect((await engine.registerSchedule({ kind: 'reminder', text: 'Brush', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })).ok).toBe(true)
  expect(await Promise.all([engine.tick(clock), engine.tick(clock)])).toEqual([1, 0])
  expect(state().schedules[0]?.repeats).toBe(1)
  await fabric.close(); await store.close()
})

it('rejects a wrong encryption key and open-ended recurrence without durable storage', async () => {
  const clock = new Date('2026-10-11T09:00:00Z')
  const { engine, fabric, store, state } = await open(randomBytes(32), () => clock)
  await engine.registerSchedule({ kind: 'reminder', text: 'Brush', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })
  await expect(EncryptedAttentionScheduleStore.open({ path: join(directory, 'schedules.enc'), key: randomBytes(32) })).rejects.toThrow()
  const ephemeral = new AttentionEngine({ fabric, now: () => clock, getState: state, focus: () => 'available', stopAll: () => false })
  expect(await ephemeral.registerSchedule({ kind: 'reminder', text: 'Brush', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })).toMatchObject({ ok: false })
  await fabric.close(); await store.close()
})

it('keeps an older pending recurring reminder when terminal schedule history fills the metadata bound', async () => {
  const clock = new Date('2026-10-11T09:00:00Z')
  const { engine, fabric, store, state } = await open(randomBytes(32), () => clock)
  const result = await engine.registerSchedule({ kind: 'reminder', text: 'Brush', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })
  for (let i = 0; i < 63; i += 1) {
    const scheduleId = `old-${i}`
    await fabric.append('attention.schedule.registered', { scheduleId, kind: 'reminder', goalRef: null, severityHint: 'none', dueAt: clock.toISOString(), intervalMs: null, maxRepeats: 0, condition: 'always' })
    await fabric.append('attention.schedule.cancelled', { scheduleId, reason: 'owner-cancelled' })
  }
  expect((await engine.registerSchedule({ kind: 'reminder', text: 'New', dueAt: clock.toISOString() })).ok).toBe(true)
  expect(state().schedules.find(row => row.scheduleId === (result.ok ? result.scheduleId : ''))?.status).toBe('pending')
  expect(state().schedules.length).toBeLessThanOrEqual(64)
  await fabric.close(); await store.close()
})

it('preserves pending schedule metadata when private persistence is unavailable and reports the fault', async () => {
  const clock = new Date('2026-10-11T09:00:00Z')
  const { engine, fabric, store, state } = await open(randomBytes(32), () => clock)
  await engine.registerSchedule({ kind: 'reminder', text: 'Brush', dueAt: clock.toISOString(), intervalMs: 86_400_000, maxRepeats: null })
  const unavailable = { durable: false,
    listIds: async () => { throw new Error('Unable to decrypt') },
    read: async () => { throw new Error('Unable to decrypt') },
    write: async () => { throw new Error('Unable to decrypt') },
    remove: async () => { throw new Error('Unable to decrypt') }, close: async () => {},
  }
  const recovered = new AttentionEngine({ fabric, scheduleStore: unavailable, now: () => clock, getState: state, focus: () => 'available', stopAll: () => false })
  await expect(recovered.reconcile()).resolves.toBeUndefined()
  expect(state().schedules[0]?.status).toBe('pending')
  expect(await recovered.tick(clock)).toBe(0)
  expect(state().schedules[0]?.status).toBe('pending')
  expect(recovered.projection().schedulePersistence?.reason).toContain('unavailable')
  await fabric.close(); await store.close()
})
