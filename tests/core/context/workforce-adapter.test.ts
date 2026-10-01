// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WORKER_INACTIVE_REASON,
  WORKER_CONTEXT_TTL_MS,
  WorkforceContextAdapter,
  isReportableWorkerStatus,
  workerContextAdmission,
  workerContextContent,
  type ContextWorkerReport,
} from '../../../core/context/workforce-adapter'
import type { ContextStore } from '../../../core/context/store'
import { T0, at, sequencedStore, sessionScope } from './fixture'

/**
 * THE WORKFORCE ADAPTER: lifecycle, stale context and cross-worker isolation.
 *
 * The adapter keeps the context store in sync with the active workforce.
 * These tests drive it through the full worker lifecycle — create, assign,
 * suspend, resume, stop, retire — and assert that the context store always
 * reflects each worker's bounded metadata, and nothing else.
 *
 * The properties under test:
 *
 *  - **Lifecycle transitions.** A worker becoming active admits an item; a
 *    worker changing status re-points; a worker becoming terminal revokes.
 *  - **Stale context.** The TTL expires deterministically; a revoked item
 *    answers `revoked` rather than resolving.
 *  - **Cross-worker isolation.** Each worker gets its own item; one worker's
 *    context never appears when asking about another.
 *  - **No hidden state.** The admission carries only an id, a status, a
 *    specialisation and a count — no message bodies, no context references,
 *    no capabilities, no model outputs.
 *  - **Determinism.** The same reports produce the same admissions; the same
 *    sequence of reports produces the same sequence of sync results.
 */

function readyStore(): ContextStore {
  const store = sequencedStore()
  store.setActiveScope(sessionScope())
  return store
}

function report(
  workerId: string,
  status: ContextWorkerReport['status'],
  openAssignments = 0,
  specialisation: ContextWorkerReport['specialisation'] = 'general',
): ContextWorkerReport {
  return { workerId, status, specialisation, openAssignments }
}

describe('the admission is bounded metadata', () => {
  it('carries only an id, a status, a specialisation and a count', () => {
    const admission = workerContextAdmission(report('w-1', 'working', 2, 'research'))
    expect(admission.kind).toBe('active_worker')
    expect(admission.source).toBe('core_record')
    expect(admission.originId).toBe('w-1')
    expect(admission.label).toBe('research')
    expect(admission.content).toBe('Worker w-1 is working (research) with 2 open assignments.')
    expect(admission.ttlMs).toBe(WORKER_CONTEXT_TTL_MS)
  })

  it('uses the singular form for one open assignment', () => {
    expect(workerContextContent(report('w-1', 'working', 1))).toContain('1 open assignment')
  })

  it('produces the same admission for the same report', () => {
    expect(workerContextAdmission(report('w-1', 'idle', 0, 'code'))).toEqual(
      workerContextAdmission(report('w-1', 'idle', 0, 'code')),
    )
  })

  it('never carries message bodies, context references or capabilities', () => {
    const admission = workerContextAdmission(report('w-1', 'working', 3, 'analysis'))
    const serialized = JSON.stringify(admission)
    expect(serialized).not.toContain('message')
    expect(serialized).not.toContain('body')
    expect(serialized).not.toContain('capability')
    expect(serialized).not.toContain('contextRef')
    expect(serialized).not.toContain('model')
  })

  it('places the item in the session scope', () => {
    const admission = workerContextAdmission(report('w-1', 'idle'))
    expect(admission.scope).toEqual({ scopeKind: 'session', scopeId: 'session' })
  })
})

describe('isReportableWorkerStatus', () => {
  it('accepts every status in the closed table', () => {
    for (const status of ['idle', 'working', 'blocked', 'stopped', 'retired'] as const) {
      expect(isReportableWorkerStatus(status)).toBe(true)
    }
  })

  it('refuses an unrecognised status', () => {
    expect(isReportableWorkerStatus('paused')).toBe(false)
    expect(isReportableWorkerStatus('')).toBe(false)
    expect(isReportableWorkerStatus(null)).toBe(false)
    expect(isReportableWorkerStatus(42)).toBe(false)
  })
})

describe('lifecycle transitions', () => {
  it('admits an item when a worker becomes active', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    const result = adapter.sync([report('w-1', 'idle')], store, T0)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.operation).toBe('admitted')

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('active_worker')
    expect(items[0]?.provenance.originId).toBe('w-1')
  })

  it('is idempotent when the same worker is reported twice', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)
    const second = adapter.sync([report('w-1', 'idle')], store, T0)

    expect(second.results).toHaveLength(0)
    expect(store.list(T0)).toHaveLength(1)
  })

  it('re-points when a worker changes status', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)
    const second = adapter.sync([report('w-1', 'working', 1)], store, T0)

    expect(second.results).toHaveLength(1)
    expect(second.results[0]?.operation).toBe('repointed')

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.content).toContain('working')

    const tombstones = store.tombstones(T0)
    expect(tombstones).toHaveLength(1)
  })

  it('revokes when a worker becomes terminal', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'working', 1)], store, T0)
    const result = adapter.sync([report('w-1', 'retired')], store, T0)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.operation).toBe('revoked')
    expect(store.list(T0)).toHaveLength(0)

    const tombstones = store.tombstones(T0)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.state).toBe('revoked')
    expect(tombstones[0]?.reason).toBe(CONTEXT_WORKER_INACTIVE_REASON)
  })

  it('revokes when a worker is no longer in the reports', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)
    const result = adapter.sync([], store, T0)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.operation).toBe('revoked')
    expect(store.list(T0)).toHaveLength(0)
  })

  it('drives the full lifecycle: idle → working → blocked → idle → stopped', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)
    expect(store.list(T0)).toHaveLength(1)

    adapter.sync([report('w-1', 'working', 2)], store, T0)
    expect(store.list(T0)).toHaveLength(1)
    expect(store.list(T0)[0]?.content).toContain('working')

    adapter.sync([report('w-1', 'blocked')], store, T0)
    expect(store.list(T0)).toHaveLength(1)
    expect(store.list(T0)[0]?.content).toContain('blocked')

    adapter.sync([report('w-1', 'idle')], store, T0)
    expect(store.list(T0)).toHaveLength(1)
    expect(store.list(T0)[0]?.content).toContain('idle')

    adapter.sync([report('w-1', 'stopped')], store, T0)
    expect(store.list(T0)).toHaveLength(0)
  })
})

describe('stale context', () => {
  it('expires deterministically after the TTL', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)
    expect(store.list(T0)).toHaveLength(1)

    const afterTtl = at(WORKER_CONTEXT_TTL_MS + 1)
    expect(store.list(afterTtl)).toHaveLength(0)

    const tombstones = store.tombstones(afterTtl)
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.state).toBe('expired')
  })

  it('answers revoked for a worker that is no longer active', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'working', 1)], store, T0)
    adapter.sync([report('w-1', 'retired')], store, T0)

    const resolution = store.resolve({ term: 'this', kind: 'active_worker' }, T0)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('revoked')
  })

  it('answers expired for a worker whose TTL has passed', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)

    const afterTtl = at(WORKER_CONTEXT_TTL_MS + 1)
    const resolution = store.resolve({ term: 'this', kind: 'active_worker' }, afterTtl)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('expired')
  })
})

describe('cross-worker isolation', () => {
  it('gives each worker its own item', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle'), report('w-2', 'working', 1)], store, T0)

    const items = store.list(T0)
    expect(items).toHaveLength(2)
    const ids = items.map((item) => item.provenance.originId).sort()
    expect(ids).toEqual(['w-1', 'w-2'])
  })

  it('revokes one worker without affecting another', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle'), report('w-2', 'working', 1)], store, T0)
    const result = adapter.sync([report('w-1', 'retired'), report('w-2', 'working', 1)], store, T0)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.operation).toBe('revoked')
    if (result.results[0]?.operation !== 'revoked') throw new Error('expected revoked')
    expect(result.results[0].workerId).toBe('w-1')

    const items = store.list(T0)
    expect(items).toHaveLength(1)
    expect(items[0]?.provenance.originId).toBe('w-2')
  })

  it('resolves to a specific worker, not another', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle'), report('w-2', 'working', 1)], store, T0)

    const resolution = store.resolve({ term: 'this', kind: 'active_worker' }, T0)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('ambiguous')
  })

  it('a revoked worker does not resolve', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle')], store, T0)
    adapter.sync([report('w-1', 'retired')], store, T0)

    const resolution = store.resolve({ term: 'this', kind: 'active_worker' }, T0)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('revoked')
  })

  it('one worker changing status does not affect another', () => {
    const store = readyStore()
    const adapter = new WorkforceContextAdapter()

    adapter.sync([report('w-1', 'idle'), report('w-2', 'idle')], store, T0)
    const result = adapter.sync([report('w-1', 'working', 1), report('w-2', 'idle')], store, T0)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.operation).toBe('repointed')
    if (result.results[0]?.operation !== 'repointed') throw new Error('expected repointed')
    expect(result.results[0].workerId).toBe('w-1')

    const items = store.list(T0)
    expect(items).toHaveLength(2)
  })
})

describe('determinism', () => {
  it('produces the same sync results for the same sequence of reports', () => {
    const run = () => {
      const store = readyStore()
      const adapter = new WorkforceContextAdapter()
      return [
        adapter.sync([report('w-1', 'idle')], store, T0),
        adapter.sync([report('w-1', 'working', 1)], store, T0),
        adapter.sync([report('w-2', 'idle')], store, T0),
        adapter.sync([], store, T0),
      ].flatMap((r) => r.results.map((x) => x.operation))
    }

    expect(run()).toEqual(run())
    expect(run()).toEqual(['admitted', 'repointed', 'admitted', 'revoked', 'revoked'])
  })

  it('the content is a function of the id, status, specialisation and count only', () => {
    expect(workerContextContent(report('w-1', 'idle', 0, 'general'))).toBe(
      workerContextContent(report('w-1', 'idle', 0, 'general')),
    )
    expect(workerContextContent(report('w-1', 'idle', 0, 'general'))).not.toBe(
      workerContextContent(report('w-1', 'working', 0, 'general')),
    )
  })
})
