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

function fakeDeps(stopAllActive: boolean) {
  const core = fakeCore(stopAllActive)
  return {
    deps: {
      coreHost: core.host,
      getBrowserService: () => null,
      getMainWindow: () => null,
      focusWindow: () => true,
      stopAllActive: () => stopAllActive,
      hostPrincipalId: () => 'owner' as const,
      notify: async () => undefined,
    } as never,
    calls: core.calls,
  }
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
})
