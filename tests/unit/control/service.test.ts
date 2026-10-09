import { describe, expect, it } from 'vitest'
import { ControlService } from '../../../electron/control/service'
import type { ControlRequest, ControlResponse } from '../../../electron/control/contract'

function result(r: ControlResponse): Record<string, unknown> {
  return 'result' in r ? (r.result as Record<string, unknown>) : {}
}
function error(r: ControlResponse): { code: string; message: string } | undefined {
  return 'error' in r ? r.error : undefined
}

function fakeCore(stopAllActive: boolean) {
  const calls: Array<{ command: string; payload: unknown }> = []
  return {
    calls,
    host: {
      status: () => ({ stopAll: { active: stopAllActive }, providers: [], operational: true, lifecycle: 'ready' as const }),
      conversation: async () => ({
        conversations: [],
        activeConversationId: null,
        messages: [],
        activeTurn: null,
        cognition: { available: true, reason: null },
        stopAll: { active: stopAllActive, activatedAt: null },
        maxMessageCharacters: 8_000,
        faults: [],
        persistence: { mode: 'ephemeral' as const, reason: null },
      }),
      mission: () => ({ missions: [], counts: { total: 0, needsAttention: 0 } as never, persistence: { mode: 'ephemeral' as const, reason: null, durable: false }, limits: {} as never }),
      workforce: () => ({ workers: [], teams: [], counts: { workers: 0, working: 0, idle: 0, waiting: 0, teams: 0 } as never, health: 'unavailable' as const, reason: null }),
      submit: async (envelope: { command: string; payload?: unknown }) => {
        calls.push({ command: envelope.command, payload: envelope.payload })
        return { requestId: 'r1', ok: true }
      },
    } as never,
  }
}

function fakeDeps(stopAllActive: boolean, browser: unknown = null, window: unknown = null) {
  const core = fakeCore(stopAllActive)
  return {
    deps: {
      coreHost: core.host,
      getBrowserService: () => browser,
      getMainWindow: () => window,
      focusWindow: () => true,
      stopAllActive: () => stopAllActive,
      hostPrincipalId: () => 'owner' as const,
      notify: async () => undefined,
    } as never,
    calls: core.calls,
  }
}

/** A minimal Browser Service that records the semantic requests and docks it is handed. */
function fakeBrowser() {
  const requests: unknown[] = []
  const docks: { sessionId: string | null; bounds: unknown }[] = []
  return {
    requests,
    docks,
    service: {
      run: async (request: unknown) => {
        requests.push(request)
        const op = (request as { op: string }).op
        if (op === 'snapshot') {
          return { ok: true, op, data: { snapshot: { tabId: 't1', url: 'https://example.com', title: 'Example', revision: 7, text: '', truncated: false, elements: [], rendered: 'refs', superseded: false } } }
        }
        if (op === 'click') return { ok: true, op, data: { tabId: 't1', clicked: true, revision: 7, name: 'Contact' } }
        if (op === 'scroll') return { ok: true, op, data: { tabId: 't1', top: 4_200, height: 5_000 } }
        return { ok: false, op, code: 'request-malformed', reason: 'unsupported in this fake', data: {} }
      },
      tabs: () => [],
      tab: (tabId: string) => (tabId === 'tab-1' ? { tabId: 'tab-1', sessionId: 'freya-0001' } : null),
      activeTabId: () => 'tab-1',
      dock: (sessionId: string | null, bounds: unknown) => {
        docks.push({ sessionId, bounds })
        return true
      },
    },
  }
}

function fakeWindow() {
  return { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1_000, height: 700 }) }
}

function req(method: string, params: Record<string, unknown> = {}): ControlRequest {
  return { jsonrpc: '2.0', id: 't', method, params }
}

describe('ControlService', () => {
  it('refuses unknown methods', async () => {
    const { deps } = fakeDeps(false)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('not.a.method'), { kind: 'cli' })
    expect(error(r)?.code).toBe('METHOD_NOT_FOUND')
  })

  it('allows read methods during STOP ALL', async () => {
    const { deps } = fakeDeps(true)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('freya.status'), { kind: 'cli' })
    expect(error(r)).toBeUndefined()
    expect(result(r).stopAllActive).toBe(true)
  })

  it('refuses action methods during STOP ALL with a structured error', async () => {
    const { deps, calls } = fakeDeps(true)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('conversation.send', { conversationId: 'c1', text: 'hi' }), { kind: 'cli' })
    expect(error(r)?.code).toBe('STOP_ALL_ACTIVE')
    expect(calls).toHaveLength(0)
  })

  it('routes conversation.send through Core with attribution', async () => {
    const { deps, calls } = fakeDeps(false)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('conversation.send', { conversationId: 'c1', text: 'hello' }), { kind: 'cli', client: 'kilo' })
    expect(error(r)).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('conversation.turn.submit')
    const payload = calls[0]?.payload as { conversationId: string; text: string; attribution: { source: string; client: string } }
    expect(payload.conversationId).toBe('c1')
    expect(payload.text).toBe('hello')
    expect(payload.attribution.source).toBe('external')
    expect(payload.attribution.client).toBe('kilo')
  })

  it('requires conversationId and text on conversation.send', async () => {
    const { deps } = fakeDeps(false)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('conversation.send', { conversationId: 'c1' }), { kind: 'cli' })
    expect(error(r)?.code).toBe('INVALID_REQUEST')
  })

  it('reports browser unavailable when no service is mounted', async () => {
    const { deps } = fakeDeps(false)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('browser.open', { url: 'https://example.com' }), { kind: 'cli' })
    // browser.open goes through ControlService.openBrowserTab which returns
    // the BROWSE_DENIED shape inside the result envelope.
    expect(error(r)).toBeUndefined()
    expect(result(r).ok).toBe(false)
    expect(result(r).code).toBe('BROWSE_DENIED')
  })

  it('system.stopStatus reflects the latch', async () => {
    for (const stop of [true, false]) {
      const { deps } = fakeDeps(stop)
      const svc = new ControlService(deps)
      const r = await svc.handle(req('system.stopStatus'), { kind: 'cli' })
      expect(result(r).stopAllActive).toBe(stop)
    }
  })

  it('protocol.version returns the declared version', async () => {
    const { deps } = fakeDeps(false)
    const svc = new ControlService(deps)
    const r = await svc.handle(req('protocol.version'), { kind: 'cli' })
    expect(result(r).protocolVersion).toBe('1')
    const methods = result(r).methods as string[]
    expect(methods).toContain('freya.status')
    expect(methods).toContain('conversation.send')
  })

  it('refuses action methods when input is not the right shape', async () => {
    const { deps } = fakeDeps(false)
    const svc = new ControlService(deps)
    const a = await svc.handle(req('browser.open', {}), { kind: 'cli' })
    expect(error(a)?.code).toBe('INVALID_REQUEST')
    const b = await svc.handle(req('browser.activate', {}), { kind: 'cli' })
    expect(error(b)?.code).toBe('INVALID_REQUEST')
    const c = await svc.handle(req('notification.send', {}), { kind: 'cli' })
    expect(error(c)?.code).toBe('INVALID_REQUEST')
  })

  it('routes snapshot, click and scroll through the browser service', async () => {
    const b = fakeBrowser()
    const { deps } = fakeDeps(false, b.service)
    const svc = new ControlService(deps)

    const snap = await svc.handle(req('browser.snapshot'), { kind: 'cli' })
    expect(error(snap)).toBeUndefined()
    expect((result(snap).data as { snapshot: { revision: number } }).snapshot.revision).toBe(7)

    const click = await svc.handle(req('browser.click', { ref: 'r7', revision: 7 }), { kind: 'cli' })
    expect(error(click)).toBeUndefined()
    expect(result(click).ok).toBe(true)

    const scroll = await svc.handle(req('browser.scroll', { to: 'bottom' }), { kind: 'cli' })
    expect(error(scroll)).toBeUndefined()
    expect(result(scroll).ok).toBe(true)

    expect(b.requests.map((r) => (r as { op: string }).op)).toEqual(['snapshot', 'click', 'scroll'])
  })

  it('reads a numeric-string revision and a pixel scroll target from the CLI', async () => {
    const b = fakeBrowser()
    const { deps } = fakeDeps(false, b.service)
    const svc = new ControlService(deps)
    await svc.handle(req('browser.click', { ref: 'r1', revision: '12' }), { kind: 'cli' })
    await svc.handle(req('browser.scroll', { to: '800' }), { kind: 'cli' })
    expect(b.requests[0]).toMatchObject({ op: 'click', ref: 'r1', revision: 12 })
    expect(b.requests[1]).toMatchObject({ op: 'scroll', to: 800 })
  })

  it('allows snapshot during STOP ALL but refuses click and scroll', async () => {
    const b = fakeBrowser()
    const { deps } = fakeDeps(true, b.service)
    const svc = new ControlService(deps)

    expect(error(await svc.handle(req('browser.snapshot'), { kind: 'cli' }))).toBeUndefined()
    expect(error(await svc.handle(req('browser.click', { ref: 'r1', revision: 1 }), { kind: 'cli' }))?.code).toBe('STOP_ALL_ACTIVE')
    expect(error(await svc.handle(req('browser.scroll', { to: 'bottom' }), { kind: 'cli' }))?.code).toBe('STOP_ALL_ACTIVE')
  })

  it('refuses a click without a ref or revision, and a scroll without a target', async () => {
    const { deps } = fakeDeps(false, fakeBrowser().service)
    const svc = new ControlService(deps)
    expect(error(await svc.handle(req('browser.click', { revision: 3 }), { kind: 'cli' }))?.code).toBe('INVALID_REQUEST')
    expect(error(await svc.handle(req('browser.click', { ref: 'r1' }), { kind: 'cli' }))?.code).toBe('INVALID_REQUEST')
    expect(error(await svc.handle(req('browser.scroll', {}), { kind: 'cli' }))?.code).toBe('INVALID_REQUEST')
  })

  it('advertises the new browser methods in protocol.version', async () => {
    const { deps } = fakeDeps(false)
    const svc = new ControlService(deps)
    const methods = result(await svc.handle(req('protocol.version'), { kind: 'cli' })).methods as string[]
    expect(methods).toContain('browser.snapshot')
    expect(methods).toContain('browser.click')
    expect(methods).toContain('browser.scroll')
    expect(methods).toContain('browser.dock')
    expect(methods).toContain('browser.undock')
  })

  it('docks a tab into the window content area and undocks it', async () => {
    const b = fakeBrowser()
    const { deps } = fakeDeps(false, b.service, fakeWindow())
    const svc = new ControlService(deps)

    const dock = await svc.handle(req('browser.dock', { tabId: 'tab-1' }), { kind: 'cli' })
    expect(error(dock)).toBeUndefined()
    expect(result(dock).ok).toBe(true)
    expect(result(dock).sessionId).toBe('freya-0001')
    expect(b.docks[0]).toEqual({ sessionId: 'freya-0001', bounds: { x: 0, y: 0, width: 1_000, height: 700 } })

    const undock = await svc.handle(req('browser.undock'), { kind: 'cli' })
    expect(result(undock).ok).toBe(true)
    expect(b.docks[1]).toEqual({ sessionId: null, bounds: null })
  })

  it('docks the active tab when no tabId is given', async () => {
    const b = fakeBrowser()
    const { deps } = fakeDeps(false, b.service, fakeWindow())
    const svc = new ControlService(deps)
    const dock = await svc.handle(req('browser.dock'), { kind: 'cli' })
    expect(result(dock).tabId).toBe('tab-1')
    expect(b.docks[0]?.sessionId).toBe('freya-0001')
  })

  it('refuses to dock an unknown tab, and to dock with no sized window', async () => {
    const b = fakeBrowser()
    const withWindow = fakeDeps(false, b.service, fakeWindow())
    const unknown = await new ControlService(withWindow.deps).handle(req('browser.dock', { tabId: 'nope' }), { kind: 'cli' })
    expect(result(unknown).ok).toBe(false)
    expect(result(unknown).code).toBe('tab-unknown')

    const noWindow = fakeDeps(false, b.service, null)
    const unsized = await new ControlService(noWindow.deps).handle(req('browser.dock', { tabId: 'tab-1' }), { kind: 'cli' })
    expect(result(unsized).ok).toBe(false)
    expect(result(unsized).code).toBe('surface-unavailable')
    expect(b.docks).toHaveLength(0)
  })

  it('treats dock as a read, allowed during STOP ALL', async () => {
    const b = fakeBrowser()
    const { deps } = fakeDeps(true, b.service, fakeWindow())
    const svc = new ControlService(deps)
    expect(error(await svc.handle(req('browser.dock', { tabId: 'tab-1' }), { kind: 'cli' }))).toBeUndefined()
    expect(error(await svc.handle(req('browser.undock'), { kind: 'cli' }))).toBeUndefined()
  })
})
