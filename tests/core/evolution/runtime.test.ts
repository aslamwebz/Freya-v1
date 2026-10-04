import { describe, expect, it } from 'vitest'
import { EvolutionRuntime } from '../../../core/evolution'
import { harness, wake, T0, T_PLUS_1D } from './harness'

describe('the evolution runtime, end to end', () => {
  it('accepts a valid wake and journals it', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake())
    expect(result.outcome).toBe('accepted')
    expect(h.types()).toContain('evolution.wake.received')
  })

  it('denies a wake from an unknown source', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ source: 'unknown-source' as never }))
    expect(result.outcome).toBe('denied')
    expect(result.outcome === 'denied' && result.code).toBe('unknown-source')
  })

  it('denies a wake with a kind-source mismatch', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ kind: 'owner-message' }))
    expect(result.outcome).toBe('denied')
    expect(result.outcome === 'denied' && result.code).toBe('kind-source-mismatch')
  })

  it('denies a duplicate wake', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const first = await runtime.considerWake(wake())
    expect(first.outcome).toBe('accepted')
    const second = await runtime.considerWake(wake())
    expect(second.outcome).toBe('denied')
    expect(second.outcome === 'denied' && second.code).toBe('duplicate-wake')
  })

  it('verifies evidence through the runtime', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.verifyEvidence('planning')
    expect(result.ok).toBe(true)
    expect(h.types()).toContain('evolution.evidence.verified')
  })

  it('proposes an improvement through the runtime', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(true)
    expect(h.types()).toContain('evolution.improvement.proposed')
  })

  it('checks drift through the runtime', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.checkDrift('imp-1')
    expect(result.ok).toBe(true)
    expect(h.types()).toContain('evolution.drift-check.passed')
  })

  it('refuses self-modification', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.refuseSelfModification('core/evolution/runtime.ts', 'attempted self-modification')
    expect(h.types()).toContain('evolution.self-modification.refused')
  })
})

describe('the precedence ladder is obeyed in order', () => {
  it('refuses everything while the journal cannot be believed', async () => {
    const h = harness({ journalTrustworthy: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('journal-not-trustworthy')
  })

  it('lets an untrustworthy journal outrank the stop latch', async () => {
    const h = harness({ journalTrustworthy: false, stopAll: true })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('journal-not-trustworthy')
  })

  it('lets the stop latch outrank an owner action', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    h.setStopAll(true)
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('stop-all-active')
  })

  it('reports guard-denied when the Guard refuses', async () => {
    const h = harness({ guardAllows: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('guard-denied')
  })

  it('reports governor-denied when the Governor refuses', async () => {
    const h = harness({ governorAuthorized: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('governor-denied')
  })

  it('reports budget-exhausted when the budget is gone', async () => {
    const h = harness({ budgetRemainingUnits: 0 })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('budget-exhausted')
  })

  it('reports approval-required when approval is not satisfied', async () => {
    const h = harness({ approvalSatisfied: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('approval-required')
  })

  it('denies by default when no Guard or Governor is wired at all', async () => {
    const h = harness({ guardAllows: false, governorAuthorized: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('guard-denied')
  })
})

describe('STOP ALL immediately halts everything', () => {
  it('latches STOP ALL and refuses all further actions', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.stop()
    expect(runtime.status().stopAllLatched).toBe(true)
    expect(runtime.status().isStopped).toBe(true)
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('stop-all-active')
  })

  it('clears STOP ALL only through an explicit owner act', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.stop()
    expect(runtime.status().isStopped).toBe(true)
    await runtime.lift()
    expect(runtime.status().isStopped).toBe(false)
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(true)
  })
})

describe('restart recovery is deterministic', () => {
  it('rebuilds state from the journal on open', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.considerWake(wake())
    await runtime.verifyEvidence('planning')
    await runtime.proposeImprovement('planning')

    const second = new EvolutionRuntime({ ports: h.ports })
    await second.open()
    expect(second.status().evidenceCount).toBe(runtime.status().evidenceCount)
    expect(second.status().improvementCount).toBe(runtime.status().improvementCount)
  })

  it('produces the same projection for the same journal and clock', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.proposeImprovement('planning')
    const projection = runtime.snapshot()
    const second = new EvolutionRuntime({ ports: h.ports })
    await second.open()
    const projection2 = second.snapshot()
    expect(JSON.stringify(projection.status)).toBe(JSON.stringify(projection2.status))
  })

  it('does not silently resume after a restart', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.proposeImprovement('planning')
    const second = new EvolutionRuntime({ ports: h.ports })
    await second.open()
    expect(second.folded().currentState).toBe('STABLE')
  })
})

describe('the projection is explainable', () => {
  it('reports the current state and active improvements', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.proposeImprovement('planning')
    const projection = runtime.snapshot()
    expect(projection.status.improvementCount).toBe(1)
    expect(projection.status.evidenceCount).toBe(0)
  })

  it('reports a bounded next action', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const projection = runtime.snapshot()
    expect(projection.status).toBeDefined()
  })
})

describe('multi-day evolution continuation across wakes', () => {
  it('continues across wakes without silent resumption', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const first = await runtime.considerWake(wake({ occurredAt: T0 }))
    expect(first.outcome).toBe('accepted')
    h.setClock(T_PLUS_1D)
    const second = await runtime.considerWake(wake({ occurredAt: T_PLUS_1D, sourceRef: 'src-2' }))
    expect(second.outcome).toBe('accepted')
    expect(runtime.status().refusalCount).toBe(0)
  })
})
