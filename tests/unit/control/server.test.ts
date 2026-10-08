import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { startControlServer, type ControlServer } from '../../../electron/control/server'
import { ControlService } from '../../../electron/control/service'
import { PROTOCOL_VERSION } from '../../../electron/control/contract'

interface WireResponse {
  jsonrpc: '2.0'
  id: string
  result?: unknown
  error?: { code: string; message: string; detail?: string }
}

function fakeDeps(stopAllActive: boolean) {
  return {
    deps: {
      coreHost: {
        status: () => ({ stopAll: { active: stopAllActive }, providers: [], operational: true, lifecycle: 'ready' as const }),
        conversation: async () => null,
        mission: () => null,
        workforce: () => null,
        submit: async () => ({ requestId: 'r', ok: true }),
      } as never,
      getBrowserService: () => null,
      getMainWindow: () => null,
      focusWindow: () => true,
      stopAllActive: () => stopAllActive,
      hostPrincipalId: () => 'owner' as const,
      notify: async () => undefined,
    } as never,
  }
}

class TestClient {
  readonly socket: Socket
  private buffer = ''
  private readonly waiters: Array<(line: string) => void> = []
  private firstDataResolve: ((line: string) => void) | null = null
  private authenticated = false

  constructor(endpoint: string) {
    const socketPath = endpoint.startsWith('unix:') ? endpoint.slice(5) : endpoint
    this.socket = connect(socketPath)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => this.onData(chunk))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (this.firstDataResolve !== null) {
        const resolve = this.firstDataResolve
        this.firstDataResolve = null
        resolve(line)
        continue
      }
      const next = this.waiters.shift()
      if (next !== undefined) next(line)
    }
  }

  /** Wait for the next line of data from the server. */
  nextLine(): Promise<string> {
    return new Promise((resolve) => {
      if (this.firstDataResolve === null && this.waiters.length === 0 && this.buffer.length > 0) {
        const first = this.buffer
        this.buffer = ''
        resolve(first)
        return
      }
      if (this.waiters.length === 0 && this.firstDataResolve === null) {
        this.firstDataResolve = resolve
        return
      }
      this.waiters.push(resolve)
    })
  }

  async authenticate(token: string): Promise<void> {
    this.socket.write(`AUTH ${token} test\n`)
    const greeting = await this.nextLine()
    if (greeting !== 'OK') {
      throw new Error(`auth failed: ${greeting}`)
    }
    this.authenticated = true
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<WireResponse> {
    if (!this.authenticated) throw new Error('not authenticated')
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }) + '\n')
    const line = await this.nextLine()
    return JSON.parse(line) as WireResponse
  }

  close(): void {
    this.socket.destroy()
  }
}

describe('control server (integration)', () => {
  let userDataDir: string
  let server: ControlServer | null = null

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'freya-control-server-'))
  })

  afterEach(async () => {
    if (server !== null) {
      await server.stop()
      server = null
    }
    rmSync(userDataDir, { recursive: true, force: true })
  })

  async function startServer(stopAllActive: boolean, salt: string): Promise<{ server: ControlServer; token: string }> {
    const { deps } = fakeDeps(stopAllActive)
    const started = await startControlServer({
      userDataDir,
      service: new ControlService(deps),
      enabled: true,
      log: () => undefined,
      salt,
    })
    server = started
    const tokenPath = join(userDataDir, 'control.token')
    const value = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : ''
    return { server: started, token: value }
  }

  it('rejects a connection with no auth line', async () => {
    const { server: s } = await startServer(false, randomUUID())
    const client = new TestClient(s.endpoint)
    client.socket.write('NOTAUTH\n')
    const line = await client.nextLine()
    const parsed = JSON.parse(line) as { error: { code: string } }
    expect(parsed.error.code).toBe('UNAUTHENTICATED')
    client.close()
  })

  it('rejects a wrong token', async () => {
    const { server: s } = await startServer(false, randomUUID())
    const client = new TestClient(s.endpoint)
    client.socket.write(`AUTH ${'f'.repeat(64)} cli\n`)
    const line = await client.nextLine()
    const parsed = JSON.parse(line) as { error: { code: string } }
    expect(parsed.error.code).toBe('TOKEN_MISMATCH')
    client.close()
  })

  it('accepts a correct token, serves protocol.version, writes the endpoint file', async () => {
    const { server: s, token: t } = await startServer(false, randomUUID())
    expect(s.endpoint).toMatch(/^(\\\\.\\pipe\\|unix:)/)
    const endpointFile = join(userDataDir, 'control.endpoint')
    expect(existsSync(endpointFile)).toBe(true)
    const parsed = JSON.parse(readFileSync(endpointFile, 'utf8')) as { endpoint: string; pid: number }
    expect(parsed.endpoint).toBe(s.endpoint)
    expect(typeof parsed.pid).toBe('number')

    const client = new TestClient(s.endpoint)
    await client.authenticate(t)
    const r = await client.request('protocol.version')
    expect(r.error).toBeUndefined()
    expect((r.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION)
    client.close()
  })

  it('returns STOP_ALL_ACTIVE on an action call when STOP ALL is latched', async () => {
    const { server: s, token: t } = await startServer(true, randomUUID())
    const client = new TestClient(s.endpoint)
    await client.authenticate(t)
    const r = await client.request('conversation.send', { conversationId: 'c1', text: 'hi' })
    expect(r.error?.code).toBe('STOP_ALL_ACTIVE')
    client.close()
  })

  it('rejects oversized payloads', async () => {
    const { server: s, token: t } = await startServer(false, randomUUID())
    const client = new TestClient(s.endpoint)
    await client.authenticate(t)
    // 300 KiB > 256 KiB cap
    const big = 'a'.repeat(300 * 1024)
    client.socket.write(big)
    const line = await client.nextLine()
    const parsed = JSON.parse(line) as { error: { code: string } }
    expect(parsed.error.code).toBe('PAYLOAD_TOO_LARGE')
    client.close()
  })

  it('returns UNKNOWN method for unknown RPC methods after auth', async () => {
    const { server: s, token: t } = await startServer(false, randomUUID())
    const client = new TestClient(s.endpoint)
    await client.authenticate(t)
    const r = await client.request('not.a.real.method')
    expect(r.error?.code).toBe('METHOD_NOT_FOUND')
    client.close()
  })
})
