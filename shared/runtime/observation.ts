import type { ComponentHealth, ComponentName } from '../contracts/runtime'
import type { ProcessObservation } from '../contracts/control-center'

/** A health response, never a process-exists guess. No previous success is carried forward. */
export function observeHealth(component: ComponentName, pid: number | null, health: ComponentHealth | null, now = Date.now()): ProcessObservation {
  const base: ProcessObservation = { component, pid, health: null, state: pid === null ? 'stopped' : 'disconnected', source: `${component}: runtime.health`, checkedAt: new Date(now).toISOString(), lastSuccessAt: null, detail: pid === null ? 'Process is stopped' : 'Health response missing' }
  if (!health) return base
  const age = now - Date.parse(health.checkedAt)
  if (health.component !== component || health.pid !== pid || !Number.isFinite(age) || age < -10_000 || age > 10_000) return { ...base, detail: 'Health response is stale, invalid or from a different process' }
  const progressAge = now - Date.parse(health.lastProgressAt ?? '')
  const missingBeat = component === 'core' && (!Number.isFinite(progressAge) || progressAge < -10_000 || progressAge > 40_000)
  return { ...base, health, lastSuccessAt: health.checkedAt, state: missingBeat ? 'degraded' : health.lifecycle === 'ready' ? 'healthy' : health.lifecycle === 'stopping' ? 'starting' : health.lifecycle,
    detail: missingBeat ? 'Core heartbeat is missing or older than 40 seconds' : health.issues.map(issue => issue.message).join('; ') || 'Fresh process health received' }
}
