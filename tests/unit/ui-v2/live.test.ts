import { afterEach, describe, expect, it } from 'vitest'
import { createLiveAdapter } from '../../../src/ui-v2/state/live'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import { resetMissionMirror } from '../../../src/platform/missionClient'
import { resetWorkforceMirror } from '../../../src/platform/workforceClient'
import { resetAttentionMirror } from '../../../src/platform/attentionClient'

/**
 * Phase 19.1: the live adapter's contract with Core.
 *
 * These tests run with no bridge on purpose — that is the browser case, and it is the
 * case that must not invent anything. A window that cannot reach Core reports loading
 * or unavailable; it never falls back to sample data behind the owner's back.
 */
afterEach(() => {
  resetCoreMirror(); resetMissionMirror(); resetWorkforceMirror(); resetAttentionMirror()
})

describe('live adapter without a Core bridge', () => {
  it('reports unavailable with a reason rather than fabricating a projection', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const snapshot = adapter.getSnapshot()
    // Not `loading`: loading implies a Core is on its way. Nothing is coming, so every
    // resource says so — including the reason, so the surface can put it in words.
    for (const resource of Object.values(snapshot)) {
      expect(resource.status).toBe('unavailable')
      if (resource.status === 'unavailable') expect(resource.reason).toBe('No Freya Core is reachable from this window.')
    }
    disposer()
  })

  it('never labels anything as preview', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    for (const resource of Object.values(adapter.getSnapshot())) {
      expect(resource.status === 'ready' ? resource.source : 'not ready').not.toBe('preview')
    }
    disposer()
  })

  it('keeps a stable snapshot identity while nothing has been reported', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const first = adapter.getSnapshot()
    expect(adapter.getSnapshot()).toBe(first)
    disposer()
  })

  it('exposes an attach method and no command surface', async () => {
    const adapter = createLiveAdapter()
    expect(typeof adapter.attach).toBe('function')
    // Read-only by construction: a window may project Core, never command it.
    for (const key of ['submit', 'submitCommand', 'pause', 'resume'] as const) {
      expect(key in adapter).toBe(false)
    }
  })

  it('returns an unsubscribe disposer from subscribe', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    let calls = 0
    const unsubscribe = adapter.subscribe(() => { calls += 1 })
    unsubscribe()
    expect(typeof unsubscribe).toBe('function')
    disposer()
    expect(calls).toBe(0)
  })
})