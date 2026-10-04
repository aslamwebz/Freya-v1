import { describe, expect, it } from 'vitest'
import { ResilienceRuntime } from '../../../core/resilience/runtime'
import { projectResilienceState } from '../../../core/resilience/projection'
import { RESILIENCE_LIMITS } from '../../../core/resilience/types'
import { narrowResilienceLimits } from '../../../core/resilience/limits'
import {
  T0,
  failureEvent,
  harness,
  wake,
} from './harness'

/**
 * The runtime, end to end and deterministically.
 */

async function opened(h = harness()) {
  const runtime = new ResilienceRuntime({ ports: h.ports })
  await runtime.open()
  return { runtime, h }
}

describe('opening the runtime', () => {
  it('journals a recovery plan on open', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    expect(runtime.describeRecovery()).not.toBeNull()
  })

  it('writes only payloads the Core journal validator accepts', async () => {
    const h = harness()
    await opened(h)
    expect(h.validate()).toEqual([])
  })

  it('is deterministic: same journal = same state', async () => {
    const h1 = harness()
    const h2 = harness()
    const r1 = new ResilienceRuntime({ ports: h1.ports })
    const r2 = new ResilienceRuntime({ ports: h2.ports })
    await r1.open()
    await r2.open()
    expect(r1.folded()).toEqual(r2.folded())
  })
})

describe('failure detection', () => {
  it('detects a failure and transitions to RECOVERING', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.detectFailure(failureEvent())
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('RECOVERING')
    expect(h.types()).toContain('resilience.failure.detected')
  })

  it('refuses a failure detection when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses a failure detection when the journal is not trustworthy', async () => {
    const h = harness({ journalTrustworthy: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('journal-not-trustworthy')
  })
})

describe('recovery', () => {
  it('starts a recovery and transitions to RECOVERING', async () => {
    const { runtime, h } = await opened()
    await runtime.detectFailure(failureEvent())
    const outcome = await runtime.startRecovery('f-1')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('RECOVERING')
    expect(h.types()).toContain('resilience.recovery.started')
  })

  it('completes a recovery and transitions to HEALTHY', async () => {
    const { runtime, h } = await opened()
    await runtime.detectFailure(failureEvent())
    await runtime.startRecovery('f-1')
    const outcome = await runtime.completeRecovery('h-2', 'success', 'Recovery succeeded')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('HEALTHY')
    expect(h.types()).toContain('resilience.recovery.completed')
  })

  it('transitions to DEGRADED on partial recovery', async () => {
    const { runtime } = await opened()
    await runtime.detectFailure(failureEvent())
    await runtime.startRecovery('f-1')
    await runtime.completeRecovery('h-2', 'partial', 'Partial recovery')
    expect(runtime.folded().currentState).toBe('DEGRADED')
  })

  it('transitions to FAILED on recovery failure', async () => {
    const { runtime } = await opened()
    await runtime.detectFailure(failureEvent())
    await runtime.startRecovery('f-1')
    await runtime.completeRecovery('h-2', 'failed', 'Recovery failed')
    expect(runtime.folded().currentState).toBe('FAILED')
  })
})

describe('repair', () => {
  it('refuses a repair without authorization', async () => {
    const { runtime, h } = await opened()
    await runtime.detectFailure(failureEvent())
    const outcome = await runtime.startRepair('f-1', null)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('self-approval-prohibited')
    expect(h.types()).toContain('resilience.repair.unauthorized')
  })

  it('starts a repair with authorization', async () => {
    const { runtime, h } = await opened()
    await runtime.detectFailure(failureEvent())
    const outcome = await runtime.startRepair('f-1', 'owner')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('REPAIRING')
    expect(h.types()).toContain('resilience.repair.started')
  })

  it('completes a repair and transitions to HEALTHY', async () => {
    const { runtime } = await opened()
    await runtime.detectFailure(failureEvent())
    await runtime.startRepair('f-1', 'owner')
    const outcome = await runtime.completeRepair('h-3', 'success', 'Repair succeeded')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('HEALTHY')
  })
})

describe('backup and restore', () => {
  it('creates a backup', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.createBackup('env-1')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('resilience.backup.created')
  })

  it('verifies a backup', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.createBackup('env-1')
    if (!result.ok) throw new Error('backup creation failed')
    const outcome = await runtime.verifyBackup(result.value.backupId)
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('resilience.backup.verified')
  })

  it('starts a restore', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.createBackup('env-1')
    if (!result.ok) throw new Error('backup creation failed')
    await runtime.verifyBackup(result.value.backupId)
    const outcome = await runtime.startRestore(result.value.backupId)
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('resilience.restore.started')
  })

  it('completes a restore', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.createBackup('env-1')
    if (!result.ok) throw new Error('backup creation failed')
    await runtime.verifyBackup(result.value.backupId)
    const restore = await runtime.startRestore(result.value.backupId)
    if (!restore.ok) throw new Error('restore start failed')
    const outcome = await runtime.completeRestore(restore.value.restoreId, 'success', 'Restore completed')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('resilience.restore.completed')
  })
})

describe('degraded mode', () => {
  it('enters degraded mode truthfully', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.enterDegradedMode('moderate', 'Test degradation', ['read-only'])
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('DEGRADED')
    expect(h.types()).toContain('resilience.degraded-mode.entered')
  })

  it('exits degraded mode', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.enterDegradedMode('moderate', 'Test degradation', ['read-only'])
    if (!result.ok) throw new Error('degraded mode entry failed')
    const outcome = await runtime.exitDegradedMode(result.value.recordId)
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('HEALTHY')
    expect(h.types()).toContain('resilience.degraded-mode.exited')
  })
})

describe('STOP ALL', () => {
  it('latches STOP ALL and transitions to FAILED', async () => {
    const { runtime } = await opened()
    await runtime.stop()
    expect(runtime.folded().currentState).toBe('FAILED')
    expect(runtime.folded().stopAllLatched).toBe(true)
  })

  it('lifts STOP ALL only through the owner', async () => {
    const { runtime } = await opened()
    await runtime.stop()
    await runtime.lift()
    expect(runtime.folded().currentState).toBe('HEALTHY')
    expect(runtime.folded().stopAllLatched).toBe(false)
  })

  it('refuses all actions while STOP ALL is latched', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
  })
})

describe('wake validation', () => {
  it('accepts an authorized wake', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('accepted')
    expect(h.types()).toContain('resilience.wake.received')
  })

  it('refuses a wake from an unauthorized actor', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.considerWake(wake({ actor: 'renderer' as never }))
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') {
      expect(outcome.code).toBe('unauthorized-actor')
    }
  })

  it('refuses a wake with a kind-source mismatch', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.considerWake(
      wake({ source: 'owner-interaction', kind: 'system-health' as never }),
    )
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') {
      expect(outcome.code).toBe('kind-source-mismatch')
    }
  })

  it('refuses a duplicate wake', async () => {
    const { runtime } = await opened()
    await runtime.considerWake(wake())
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') {
      expect(outcome.code).toBe('duplicate-wake')
    }
  })
})

describe('self-modification refusal', () => {
  it('refuses self-modification and journals the attempt', async () => {
    const { runtime, h } = await opened()
    await runtime.refuseSelfModification('core/resilience/runtime.ts', 'Attempted self-modification')
    expect(h.types()).toContain('resilience.self-modification.attempted')
    expect(h.types()).toContain('resilience.self-modification.refused')
  })
})

describe('projection', () => {
  it('projects the current state', async () => {
    const { runtime, h } = await opened()
    await runtime.detectFailure(failureEvent())
    const snapshot = runtime.snapshot()
    const projection = projectResilienceState({
      state: runtime.folded(),
      snapshot,
      now: T0,
      sequence: h.entries.length,
    })
    expect(projection.health).toBe('recovering')
    expect(projection.summary.currentState).toBe('RECOVERING')
  })
})

describe('limits', () => {
  it('narrows limits but never widens them', () => {
    const narrowed = narrowResilienceLimits({ maxRecoveryAttempts: 100 })
    expect(narrowed.maxRecoveryAttempts).toBe(RESILIENCE_LIMITS.maxRecoveryAttempts)
  })

  it('honours a narrower limit', () => {
    const narrowed = narrowResilienceLimits({ maxRecoveryAttempts: 1 })
    expect(narrowed.maxRecoveryAttempts).toBe(1)
  })
})

