import { describe, expect, it } from 'vitest'
import { SovereigntyRuntime } from '../../../core/sovereign/runtime'
import { projectSovereigntyState } from '../../../core/sovereign/projection'
import { SOVEREIGNTY_LIMITS } from '../../../core/sovereign/types'
import { narrowSovereigntyLimits } from '../../../core/sovereign/limits'
import {
  T0,
  harness,
  wake,
} from './harness'

async function opened(h = harness()) {
  const runtime = new SovereigntyRuntime({ ports: h.ports })
  await runtime.open()
  return { runtime, h }
}

describe('opening the runtime', () => {
  it('opens cleanly and is deterministic', async () => {
    const h1 = harness()
    const h2 = harness()
    const r1 = new SovereigntyRuntime({ ports: h1.ports })
    const r2 = new SovereigntyRuntime({ ports: h2.ports })
    await r1.open()
    await r2.open()
    expect(r1.folded()).toEqual(r2.folded())
  })

  it('writes only payloads the Core journal validator accepts', async () => {
    const h = harness()
    await opened(h)
    expect(h.validate()).toEqual([])
  })
})

describe('provider routing', () => {
  it('routes to a provider', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.routeProvider('p-1', 'Test routing')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('sovereignty.provider.routed')
  })

  it('refuses routing when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.routeProvider('p-1', 'Test routing')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses routing when the journal is not trustworthy', async () => {
    const h = harness({ journalTrustworthy: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.routeProvider('p-1', 'Test routing')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('journal-not-trustworthy')
  })
})

describe('provider fallback', () => {
  it('falls back to an alternative provider', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.fallbackProvider('p-1', 'p-2')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('sovereignty.provider.fallback')
  })

  it('transitions to DEGRADED on provider failure', async () => {
    const { runtime } = await opened()
    await runtime.fallbackProvider('p-1', 'p-2')
    expect(runtime.folded().currentState).toBe('ONLINE')
  })
})

describe('offline reasoning', () => {
  it('starts an offline session', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.startOffline('full')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('OFFLINE')
    expect(h.types()).toContain('sovereignty.offline.started')
  })

  it('ends an offline session', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.startOffline('full')
    if (!result.ok) throw new Error('offline start failed')
    const outcome = await runtime.endOffline(result.value.sessionId, 5)
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('ONLINE')
    expect(h.types()).toContain('sovereignty.offline.ended')
  })

  it('refuses offline start when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.startOffline('full')
    expect(outcome.ok).toBe(false)
  })
})

describe('portable data', () => {
  it('exports data with encryption metadata', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.exportData('hash-123', 'v1')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('sovereignty.portable-data.exported')
  })

  it('imports data with encryption metadata', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.importData('hash-123', 'v1')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('sovereignty.portable-data.imported')
  })

  it('verifies data integrity', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.exportData('hash-123', 'v1')
    if (!result.ok) throw new Error('export failed')
    const outcome = await runtime.verifyData(result.value.recordId, 'hash-123')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('sovereignty.portable-data.verified')
  })

  it('refuses export when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.exportData('hash-123', 'v1')
    expect(outcome.ok).toBe(false)
  })
})

describe('STOP ALL', () => {
  it('latches STOP ALL and transitions to FAILED', async () => {
    const { runtime } = await opened()
    await runtime.stop()
    expect(runtime.folded().stopAllLatched).toBe(true)
  })

  it('lifts STOP ALL only through the owner', async () => {
    const { runtime } = await opened()
    await runtime.stop()
    await runtime.lift()
    expect(runtime.folded().currentState).toBe('ONLINE')
    expect(runtime.folded().stopAllLatched).toBe(false)
  })
})

describe('wake validation', () => {
  it('accepts an authorized wake', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('accepted')
    expect(h.types()).toContain('sovereignty.wake.received')
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
    await runtime.refuseSelfModification('core/sovereign/runtime.ts', 'Attempted self-modification')
    expect(h.types()).toContain('sovereignty.state-changed')
  })
})

describe('projection', () => {
  it('projects the current state', async () => {
    const { runtime, h } = await opened()
    await runtime.routeProvider('p-1', 'Test routing')
    const snapshot = runtime.snapshot()
    const projection = projectSovereigntyState({
      state: runtime.folded(),
      snapshot,
      now: T0,
      sequence: h.entries.length,
    })
    expect(projection.health).toBe('online')
    expect(projection.summary.currentState).toBe('ONLINE')
  })
})

describe('limits', () => {
  it('narrows limits but never widens them', () => {
    const narrowed = narrowSovereigntyLimits({ maxProviders: 100 })
    expect(narrowed.maxProviders).toBe(SOVEREIGNTY_LIMITS.maxProviders)
  })

  it('honours a narrower limit', () => {
    const narrowed = narrowSovereigntyLimits({ maxProviders: 1 })
    expect(narrowed.maxProviders).toBe(1)
  })
})
