import { afterEach, describe, expect, it } from 'vitest'
import type { FreyaHostBridge } from '../../../src/platform/host'
import type { WorkspaceSnapshot } from '../../../src/core/workspace'
import {
  armAppWorkspace,
  currentAppLayout,
  loadAppLayout,
  resetAppWorkspace,
  setAppLayout,
  startupAppLayout,
} from '../../../src/app/state/workspace'

/**
 * App Mode must answer the host's closing-time layout request. The legacy shell
 * did; App Mode never did, so every close waited out the host timeout. This pins
 * the answer and the single-registration rule.
 */

afterEach(() => {
  delete window.freyaHost
  resetAppWorkspace()
})

function installCollectBridge(): { asked: () => boolean; answer: () => WorkspaceSnapshot } {
  let handler: (() => unknown) | null = null
  let calls = 0
  const bridge = {
    onCollect: (h: () => unknown) => { handler = h },
  } as unknown as FreyaHostBridge
  window.freyaHost = bridge
  return {
    asked: () => calls > 0,
    answer: () => {
      calls += 1
      if (!handler) throw new Error('no collect handler was registered')
      return handler() as WorkspaceSnapshot
    },
  }
}

describe('App Mode workspace collect', () => {
  it('registers a collect handler and answers with the current layout', () => {
    const probe = installCollectBridge()
    armAppWorkspace()
    setAppLayout({ nav: 'life', navCollapsed: true, conversationId: 'conv-1' })
    const snapshot = probe.answer()
    expect(snapshot.schema).toBe(1)
    expect(snapshot.surfaces).toEqual([])
    expect(snapshot.nav).toBe('life')
    expect(snapshot.navCollapsed).toBe(true)
    expect(snapshot.conversationId).toBe('conv-1')
    expect(typeof snapshot.savedAt).toBe('number')
  })

  it('arms only once, so a remount cannot answer the host twice', () => {
    let registrations = 0
    const bridge = {
      onCollect: () => { registrations += 1 },
    } as unknown as FreyaHostBridge
    window.freyaHost = bridge
    armAppWorkspace()
    armAppWorkspace()
    expect(registrations).toBe(1)
  })

  it('cold-starts on Home even when the saved workspace was an old chat', () => {
    expect(
      startupAppLayout({
        nav: 'chat',
        navCollapsed: true,
        conversationId: 'conv-old',
      }),
    ).toEqual({
      nav: 'home',
      navCollapsed: true,
      conversationId: 'conv-old',
    })
  })

  it('tracks layout updates', () => {
    installCollectBridge()
    armAppWorkspace()
    setAppLayout({ nav: 'world', navCollapsed: false, conversationId: null })
    expect(currentAppLayout()).toEqual({ nav: 'world', navCollapsed: false, conversationId: null })
  })

  it('preserves legacy surfaces rather than erasing a layout it does not own', async () => {
    let handler: (() => unknown) | null = null
    const stored = {
      schema: 1,
      surfaces: [{
        id: 'chat-1', type: 'chat', title: 'Chat',
        context: {}, layout: { x: 10, y: 10, width: 400, height: 300, minimized: false, pinned: false, z: 1, restoreBounds: null },
      }],
      presence: 'idle', nav: 'home', navCollapsed: false, conversationId: null, savedAt: 1,
    }
    window.freyaHost = {
      loadWorkspace: async () => stored,
      onCollect: (h: () => unknown) => { handler = h },
    } as unknown as FreyaHostBridge
    await loadAppLayout()
    armAppWorkspace()
    setAppLayout({ nav: 'mind', navCollapsed: false, conversationId: null })
    const snapshot = handler!() as WorkspaceSnapshot
    expect(snapshot.nav).toBe('mind')
    expect(snapshot.surfaces).toHaveLength(1)
    expect(snapshot.surfaces[0]?.id).toBe('chat-1')
  })
})
