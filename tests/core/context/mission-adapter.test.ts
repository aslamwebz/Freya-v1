// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_MISSION_INACTIVE_REASON,
  MISSION_CONTEXT_TTL_MS,
  MissionContextAdapter,
  isReportableMissionStatus,
  missionContextAdmission,
  missionContextContent,
  type ContextMissionReport,
} from '../../../core/context/mission-adapter'
import type { ContextStore } from '../../../core/context/store'
import { T0, at, sequencedStore, sessionScope } from './fixture'

/**
 * THE MISSION ADAPTER: lifecycle, stale context and cross-Mission isolation.
 *
 * The adapter is the only thing that knows which Mission is current. These
 * tests drive it through the full Mission lifecycle — create, activate, pause,
 * resume, complete — and assert that the context store always reflects the
 * current Mission's bounded metadata, and nothing else.
 *
 * The properties under test:
 *
 *  - **Lifecycle transitions.** A Mission becoming current admits an item;
 *    a Mission changing status re-points; a Mission becoming terminal revokes.
 *  - **Stale context.** The TTL expires deterministically; a revoked item
 *    answers `revoked` rather than resolving.
 *  - **Cross-Mission isolation.** Switching from one Mission to another
 *    revokes the first and admits the second; the two never coexist.
 *  - **No private content.** The admission carries only an id and a status —
 *    no title, no intent, no success criteria, no verification evidence.
 *  - **Determinism.** The same report produces the same admission; the same
 *    sequence of reports produces the same sequence of sync results.
 */

function readyStore(): ContextStore {
  const store = sequencedStore()
  store.setActiveScope(sessionScope())
  return store
}

function report(missionId: string, status: ContextMissionReport['status']): ContextMissionReport {
  return { missionId, status }
}

describe('the admission is bounded metadata', () => {
  it('carries only an id and a status — no private content', () => {
    const admission = missionContextAdmission(report('m-1', 'active'))
    expect(admission.kind).toBe('current_mission')
    expect(admission.source).toBe('core_record')
    expect(admission.originId).toBe('m-1')
    expect(admission.label).toBe('active')
    expect(admission.content).toBe('The current Mission is m-1 and it is active.')
    expect(admission.ttlMs).toBe(MISSION_CONTEXT_TTL_MS)
  })

  it('produces the same admission for the same report', () => {
    expect(missionContextAdmission(report('m-1', 'active'))).toEqual(
      missionContextAdmission(report('m-1', 'active')),
    )
  })

  it('produces a different admission for a different mission', () => {
    expect(missionContextAdmission(report('m-1', 'active')).originId).not.toBe(
      missionContextAdmission(report('m-2', 'active')).originId,
    )
  })

  it('never carries a title, intent or success criteria', () => {
    const admission = missionContextAdmission(report('m-1', 'active'))
    const serialized = JSON.stringify(admission)
    expect(serialized).not.toContain('title')
    expect(serialized).not.toContain('intent')
    expect(serialized).not.toContain('success')
    expect(serialized).not.toContain('verification')
  })

  it('places the item in the session scope', () => {
    const admission = missionContextAdmission(report('m-1', 'active'))
    expect(admission.scope).toEqual({ scopeKind: 'session', scopeId: 'session' })
  })
})

describe('isReportableMissionStatus', () => {
  it('accepts every status in the closed table', () => {
    for (const status of ['draft', 'active', 'paused', 'completed', 'failed', 'cancelled'] as const) {
      expect(isReportableMissionStatus(status)).toBe(true)
    }
  })

  it('refuses an unrecognised status', () => {
    expect(isReportableMissionStatus('archived')).toBe(false)
    expect(isReportableMissionStatus('')).toBe(false)
    expect(isReportableMissionStatus(null)).toBe(false)
    expect(isReportableMissionStatus(42)).toBe(false)
  })
})

describe('lifecycle transitions', () => {
  it('admits an item when a Mission becomes current', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    const result = adapter.sync(report('m-1', 'active'), store, T0)
    expect(result.operation).toBe('admitted')

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('current_mission')
    expect(items[0]?.provenance.originId).toBe('m-1')
  })

  it('is idempotent when the same Mission is reported twice', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    const second = adapter.sync(report('m-1', 'active'), store, T0)

    expect(second.operation).toBe('unchanged')
    expect(store.list(T0)).toHaveLength(1)
  })

  it('re-points when a Mission changes status', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    const first = adapter.sync(report('m-1', 'active'), store, T0)
    expect(first.operation).toBe('admitted')

    const second = adapter.sync(report('m-1', 'paused'), store, T0)
    expect(second.operation).toBe('repointed')
    if (second.operation !== 'repointed') throw new Error('expected repointed')

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.contextId).toBe(second.contextId)
    expect(items[0]?.label).toBe('paused')

    const tombstones = store.tombstones(T0)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.contextId).toBe(second.revokedId)
  })

  it('revokes when a Mission becomes terminal', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    const result = adapter.sync(report('m-1', 'completed'), store, T0)

    expect(result.operation).toBe('revoked')
    expect(store.list(T0)).toHaveLength(0)

    const tombstones = store.tombstones(T0)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.state).toBe('revoked')
    expect(tombstones[0]?.reason).toBe(CONTEXT_MISSION_INACTIVE_REASON)
  })

  it('revokes when no Mission is current', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    const result = adapter.sync(null, store, T0)

    expect(result.operation).toBe('revoked')
    expect(store.list(T0)).toHaveLength(0)
  })

  it('drives the full lifecycle: active → paused → active → completed', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    expect(store.list(T0)).toHaveLength(1)

    adapter.sync(report('m-1', 'paused'), store, T0)
    expect(store.list(T0)).toHaveLength(1)
    expect(store.list(T0)[0]?.label).toBe('paused')

    adapter.sync(report('m-1', 'active'), store, T0)
    expect(store.list(T0)).toHaveLength(1)
    expect(store.list(T0)[0]?.label).toBe('active')

    adapter.sync(report('m-1', 'completed'), store, T0)
    expect(store.list(T0)).toHaveLength(0)
  })
})

describe('stale context', () => {
  it('expires deterministically after the TTL', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    expect(store.list(T0)).toHaveLength(1)

    const afterTtl = at(MISSION_CONTEXT_TTL_MS + 1)
    expect(store.list(afterTtl)).toHaveLength(0)

    const tombstones = store.tombstones(afterTtl)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.state).toBe('expired')
  })

  it('answers revoked for a Mission that is no longer active', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    adapter.sync(report('m-1', 'completed'), store, T0)

    const resolution = store.resolve({ term: 'this', kind: 'current_mission' }, T0)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('revoked')
  })

  it('answers expired for a Mission whose TTL has passed', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)

    const afterTtl = at(MISSION_CONTEXT_TTL_MS + 1)
    const resolution = store.resolve({ term: 'this', kind: 'current_mission' }, afterTtl)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('expired')
  })
})

describe('cross-Mission isolation', () => {
  it('revokes the previous Mission when a new one becomes current', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    const first = adapter.sync(report('m-1', 'active'), store, T0)
    expect(first.operation).toBe('admitted')

    const second = adapter.sync(report('m-2', 'active'), store, T0)
    expect(second.operation).toBe('repointed')
    if (second.operation !== 'repointed') throw new Error('expected repointed')

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.provenance.originId).toBe('m-2')

    const tombstones = store.tombstones(T0)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.contextId).toBe(second.revokedId)
  })

  it('never has two live current-Mission items at once', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    adapter.sync(report('m-2', 'active'), store, T0)
    adapter.sync(report('m-3', 'active'), store, T0)

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.provenance.originId).toBe('m-3')
  })

  it('resolves to the current Mission, not a previous one', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    adapter.sync(report('m-2', 'active'), store, T0)

    const resolution = store.resolve({ term: 'this', kind: 'current_mission' }, T0)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('expected a resolution')
    expect(resolution.item.provenance.originId).toBe('m-2')
  })

  it('a revoked Mission does not resolve', () => {
    const store = readyStore()
    const adapter = new MissionContextAdapter()

    adapter.sync(report('m-1', 'active'), store, T0)
    adapter.sync(report('m-2', 'active'), store, T0)

    const resolution = store.resolve({ term: 'this', kind: 'current_mission' }, T0)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('expected a resolution')
    expect(resolution.item.provenance.originId).toBe('m-2')
  })
})

describe('determinism', () => {
  it('produces the same sync results for the same sequence of reports', () => {
    const run = () => {
      const store = readyStore()
      const adapter = new MissionContextAdapter()
      return [
        adapter.sync(report('m-1', 'active'), store, T0),
        adapter.sync(report('m-1', 'paused'), store, T0),
        adapter.sync(report('m-2', 'active'), store, T0),
        adapter.sync(null, store, T0),
      ].map((r) => r.operation)
    }

    expect(run()).toEqual(run())
    expect(run()).toEqual(['admitted', 'repointed', 'repointed', 'revoked'])
  })

  it('the content is a function of the id and status only', () => {
    expect(missionContextContent(report('m-1', 'active'))).toBe(
      missionContextContent(report('m-1', 'active')),
    )
    expect(missionContextContent(report('m-1', 'active'))).not.toBe(
      missionContextContent(report('m-1', 'paused')),
    )
  })
})
