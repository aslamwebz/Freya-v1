import { expect, it } from 'vitest'
import { formatHeartbeat, redactRuntimeOutput, requireSelectedProfile } from '../../scripts/launcher-policy.mjs'
import type { ProcessObservation } from '../../shared/contracts/control-center'
it('requires an existing profile or an explicit new-profile request', () => {
  expect(() => requireSelectedProfile(false, false)).toThrow(/missing/)
  expect(() => requireSelectedProfile(false, true)).not.toThrow()
  expect(() => requireSelectedProfile(true, false)).not.toThrow()
})
it('formats a timestamped report for missing observations and redacts secrets', () => {
  const row: ProcessObservation = { component: 'core', state: 'disconnected', pid: 3, health: null, source: 'runtime.health', checkedAt: 'now', lastSuccessAt: null, detail: 'Health response missing' }
  expect(formatHeartbeat([row], 'now')).toContain('now')
  expect(formatHeartbeat([row], 'now')).toContain('heartbeat=missing')
  expect(formatHeartbeat([row], 'now')).not.toContain('OK')
  expect(redactRuntimeOutput('token=abcdef key=abcdef secret=abcdef', ['abcdef'])).not.toContain('abcdef')
})
