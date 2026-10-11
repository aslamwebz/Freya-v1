import { expect, it } from 'vitest'
import { observeHealth } from '../../shared/runtime/observation'
import type { ComponentHealth } from '../../shared/contracts/runtime'

const at = '2026-10-11T12:00:00.000Z'
const health: ComponentHealth = { component: 'core', pid: 12, instanceId: 'a', lifecycle: 'ready', startedAt: at, checkedAt: at, lastProgressAt: at, dependencies: {}, issues: [] }
it('requires fresh matching process health and Core heartbeat', () => {
  expect(observeHealth('core', 12, health, Date.parse(at)).state).toBe('healthy')
  expect(observeHealth('core', 13, health, Date.parse(at)).state).toBe('disconnected')
  expect(observeHealth('core', 12, { ...health, checkedAt: 'invalid' }, Date.parse(at)).state).toBe('disconnected')
  expect(observeHealth('core', 12, { ...health, lastProgressAt: null }, Date.parse(at)).state).toBe('degraded')
  expect(observeHealth('core', 12, health, Date.parse(at) + 60_000).state).toBe('disconnected')
})
it('reports missing and stopped processes without successful timestamps', () => {
  expect(observeHealth('core', 12, null, Date.parse(at)).lastSuccessAt).toBeNull()
  expect(observeHealth('core', null, null, Date.parse(at)).state).toBe('stopped')
})
