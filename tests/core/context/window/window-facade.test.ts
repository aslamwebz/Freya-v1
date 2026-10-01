// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ContextIntegration } from '../../../../core/context/coreIntegration'
import type { ContextCommandOutcome } from '../../../../core/protocol/context'
import {
  ACTIVE_WINDOW_SUPERSESSION_REASON,
  activeWindowHostReport,
  createActiveWindowFacadeAdmitter,
  type ActiveWindowInfo,
} from '../../../../core/context/sources/window'
import { T0, at } from '../fixture'
import { FakeActiveWindowProvider } from './fakeProvider'

/**
 * THE SEAM BRIDGE — the observation lane meets the merged Core facade.
 *
 * These arms run against the real `ContextIntegration`, not a stand-in,
 * because the point of the bridge is that issue #27's narrow host door
 * answers issue #30's observations exactly as its own boundary tests say a
 * host report should be answered: provenance fixed to `host_report`, origins
 * mandatory, the session scope refused, undeclared scopes refused, and Core
 * keeping its own clock. What the bridge adds is nothing but mapping; what it
 * must never do is insist — every refusal below comes back named.
 */

function integration(): ContextIntegration {
  let next = 0
  const core = new ContextIntegration({
    now: () => T0,
    newId: () => {
      next += 1
      return `x-${String(next)}`
    },
  })
  core.activateScope({ scopeKind: 'conversation', scopeId: 'c1' })
  return core
}

function observed(appName: string, windowTitle: string | null): ActiveWindowInfo {
  const provider = new FakeActiveWindowProvider({ providerId: 'host-observer' })
  return provider.info(appName, windowTitle, T0.toISOString())
}

const declared = { scopeKind: 'conversation', scopeId: 'c1' } as const

function admitted(outcome: ContextCommandOutcome): string {
  expect(outcome.ok, outcome.reason ?? '').toBe(true)
  expect(outcome.operation).toBe('admitted')
  if (typeof outcome.contextId !== 'string') throw new Error('admission named no id')
  return outcome.contextId
}

describe('the report is the own shape of the seam', () => {
  it('maps an observation to a ContextHostReport with no source field to forge', () => {
    const report = activeWindowHostReport(observed('Code Editor', 'notes.md'), declared)
    expect(report).not.toBeNull()
    if (report === null) throw new Error('expected a report')
    expect(Object.keys(report).sort()).toEqual([
      'capturedAt',
      'content',
      'kind',
      'label',
      'originId',
      'scope',
      'ttlMs',
      'uri',
    ])
    expect(report.kind).toBe('active_window')
    expect(report.originId).toBe('host-observer:obs-0001')
    expect(report.uri).toBeNull()
    expect(report.scope).toEqual(declared)
    expect(report).not.toHaveProperty('source')
    expect(report).not.toHaveProperty('channel')
  })

  it('refuses to produce a report when the observation names no origin', () => {
    const liar = observed('Code Editor', 'notes.md')
    const orphaned: ActiveWindowInfo = { ...liar, observationId: '' }
    expect(activeWindowHostReport(orphaned, declared)).toBeNull()
  })
})

describe('the real facade answers the bridge', () => {
  it('admits an observed window through the host lane, metadata intact', () => {
    const core = integration()
    const admit = createActiveWindowFacadeAdmitter({ lane: core, scope: declared })
    const contextId = admitted(admit(observed('Code Editor', 'notes.md')))
    const row = core.read().items.find((item) => item.contextId === contextId)
    expect(row).toBeDefined()
    expect(row?.kind).toBe('active_window')
    expect(row?.source).toBe('host_report')
    expect(row?.originId).toBe('host-observer:obs-0001')
    expect(row?.state).toBe('live')
  })

  it('supersession takes the older window back, at the facade vocabulary', () => {
    const core = integration()
    const admit = createActiveWindowFacadeAdmitter({ lane: core, scope: declared })
    const first = admitted(admit(observed('Code Editor', 'notes.md')))
    const second = admitted(admit(observed('Browser', 'Search')))
    expect(core.read().counts.retained).toBe(2)
    expect(core.read().counts.live).toBe(1)
    const rows = core.read().items
    expect(rows.find((row) => row.contextId === first)?.state).toBe('revoked')
    expect(rows.find((row) => row.contextId === first)?.revokedAt).toBe(T0.toISOString())
    expect(rows.find((row) => row.contextId === second)?.state).toBe('live')
    // revocation reason is free text, so it lives on the store's tombstones —
    // the audit view keeps only that a human-shaped act retired the row.
    void ACTIVE_WINDOW_SUPERSESSION_REASON
  })

  it('the session scope is refused and relayed unchanged: no ambient window feed', () => {
    const core = integration()
    const admit = createActiveWindowFacadeAdmitter({
      lane: core,
      scope: { scopeKind: 'session', scopeId: 'session' },
    })
    const outcome = admit(observed('Code Editor', 'notes.md'))
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('scope_not_requestable')
    expect(core.read().counts.retained).toBe(0)
  })

  it('an undeclared scope is refused, and nothing half-happened', () => {
    const core = integration()
    const admit = createActiveWindowFacadeAdmitter({
      lane: core,
      scope: { scopeKind: 'conversation', scopeId: 'never-declared' },
    })
    const outcome = admit(observed('Code Editor', 'notes.md'))
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('scope_not_declared')
    expect(core.read().counts.retained).toBe(0)
  })

  it('the bridge carries no clock: an observation claimed after the facade instant is refused by the store door', () => {
    // The bridge hands the observation's own capturedAt to the seam; the
    // facade answers with Core's clock, which this fixture froze at T0.
    const provider = new FakeActiveWindowProvider({ providerId: 'host-observer' })
    const future = provider.info('Code Editor', 'notes.md', at(60_000).toISOString())
    const core = integration()
    const admit = createActiveWindowFacadeAdmitter({ lane: core, scope: declared })
    const outcome = admit(future)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/not a valid time|future/i)
    expect(core.read().counts.retained).toBe(0)
  })

  it('an already-expired predecessor is reported settled, never relabelled revoked', () => {
    let clock = T0
    let next = 0
    const core = new ContextIntegration({
      now: () => clock,
      newId: () => `x-${String((next += 1))}`,
    })
    core.activateScope(declared)
    const admit = createActiveWindowFacadeAdmitter({
      lane: core,
      scope: declared,
      ttlMs: 60_000,
    })
    const first = admitted(admit(observed('Code Editor', 'notes.md')))
    clock = at(120_000)
    const second = observed('Browser', 'Search')
    const secondOutcome = admit({ ...second, observedAt: clock.toISOString() })
    expect(secondOutcome.operation).toBe('admitted')
    // the bridge's revoke of the expired row is refused by the facade as
    // already-settled, and the first row keeps its truthful `expired` state
    expect(core.read().items.find((row) => row.contextId === first)?.state).toBe('expired')
  })

  it('a malformed hand-constructed observation is refused before the seam is reached', () => {
    const calls: string[] = []
    const core = integration()
    const counting = {
      admitHostReport(report: Parameters<ContextIntegration['admitHostReport']>[0]) {
        calls.push('admit')
        return core.admitHostReport(report)
      },
      revoke(id: string, reason: string) {
        calls.push('revoke')
        return core.revoke(id, reason)
      },
    }
    const admit = createActiveWindowFacadeAdmitter({ lane: counting, scope: declared })
    const liar: ActiveWindowInfo = { ...observed('Editor', null), observationId: '  ' }
    const outcome = admit(liar)
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('malformed_request')
    expect(calls).toEqual([])
  })
})
