export { observeHealth } from './observation'
import { createConnection, createServer, type Socket } from 'node:net'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'

const MAX_FRAME = 48 * 1024 * 1024
type Handler = (method: string, value: unknown) => Promise<unknown>
type Frame = { id?: string; method?: string; value?: unknown; result?: unknown; error?: string; auth?: string; authenticated?: boolean }

/**
 * How long a call waits before giving up on the *reply*.
 *
 * Three minutes is right for a command that answers in a command. It is not right
 * for one that runs a whole Mind turn: ten provider calls against a reasoning
 * model, each of which can spend a minute thinking, is a turn that legitimately
 * outlives it. A live turn was cut off mid-enquiry by this ceiling, the work was
 * thrown away, and the caller was told Core could not be reached — when Core was
 * answering, just slowly.
 *
 * So the wait is not a single number but one derived from what the caller is
 * actually asking for. {@link TURN_RPC_TIMEOUT_MS} carries a turn; everything
 * else keeps the short ceiling that makes a hung command look hung.
 */
export const TURN_RPC_TIMEOUT_MS = 900_000

/**
 * A call that ran out of time, told apart from a call that never arrived.
 *
 * A timeout is not a disconnection, and every caller in this codebase reports a
 * failure as "Freya Core could not be reached". That phrasing sends whoever reads
 * it — a person or a log search — to look for a dead process while the process is
 * still working on the question. Naming the difference is the whole fix; the
 * class is what lets a caller say so instead of guessing.
 */
export class RpcTimeoutError extends Error {
  readonly method: string
  constructor(method: string, timeoutMs: number) {
    super(`Freya is still working on this (${method} had not answered after ${Math.round(timeoutMs / 1000)}s). The work was not retried.`)
    this.name = 'RpcTimeoutError'
    this.method = method
  }
}

/** Duplex, authenticated local RPC. Calls are never retried or replayed. */
export class RpcPeer {
  private buffer = ''
  private handler: Handler = async () => { throw new Error('operation unavailable') }
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly closes = new Set<() => void>()
  private ready = false
  private ended = false
  private receiving = 0

  constructor(private readonly socket: Socket, authenticate: (frame: Frame) => boolean) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) { this.close(); return }
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        try {
          const frame: Frame = JSON.parse(line)
          if (!frame || typeof frame !== 'object') { this.close(); return }
          if (!this.ready) {
            if (!authenticate(frame)) { this.close(); return }
            this.ready = true
          } else void this.receive(frame)
        } catch { this.close(); return }
      }
    })
    socket.on('error', () => this.disconnect())
    socket.on('close', () => this.disconnect())
  }

  get connected(): boolean { return this.ready && !this.ended }
  handle(handler: Handler): void { this.handler = handler }
  onClose(listener: () => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener) }
  send(frame: Frame): void {
    if (this.ended) throw new Error('runtime disconnected')
    const data = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(data) > MAX_FRAME) throw new Error('runtime payload exceeds limit')
    this.socket.write(data)
  }
  call<T = unknown>(method: string, value: unknown = null, timeoutMs = 180_000): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('runtime disconnected'))
    if (this.pending.size >= 128) return Promise.reject(new Error('too many outstanding runtime requests'))
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcTimeoutError(method, timeoutMs)) }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { this.send({ id, method, value }) } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error)
      }
    })
  }
  close(): void { this.socket.destroy(); this.disconnect() }
  private disconnect(): void {
    if (this.ended) return
    this.ended = true
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('runtime disconnected; operation was not retried')) }
    this.pending.clear()
    for (const listener of this.closes) listener()
    this.closes.clear()
  }
  private async receive(frame: Frame): Promise<void> {
    if (typeof frame.id !== 'string') { this.close(); return }
    if (typeof frame.method === 'string') {
      if (++this.receiving > 128) { this.close(); return }
      try { this.send({ id: frame.id, result: await this.handler(frame.method, frame.value) }) }
      catch (error) {
        if (this.connected) this.send({ id: frame.id, error: error instanceof Error ? error.message : 'runtime operation failed' })
      }
      finally { this.receiving-- }
      return
    }
    const request = this.pending.get(frame.id)
    if (!request) return
    clearTimeout(request.timer); this.pending.delete(frame.id)
    if (typeof frame.error === 'string') request.reject(new Error(frame.error))
    else request.resolve(frame.result)
  }
}

function matches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function listenRpc(endpoint: string, token: string, accept: (peer: RpcPeer) => void) {
  const peers = new Set<RpcPeer>()
  const server = createServer(socket => {
    const timeout = setTimeout(() => socket.destroy(), 3_000)
    const peer = new RpcPeer(socket, frame => {
      clearTimeout(timeout)
      if (!matches(frame.auth, token)) return false
      peer.send({ authenticated: true })
      accept(peer)
      return true
    })
    peers.add(peer)
    peer.onClose(() => { clearTimeout(timeout); peers.delete(peer) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  return { endpoint, async close() {
    for (const peer of peers) peer.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (process.platform !== 'win32') await unlink(endpoint).catch(() => {})
  } }
}

export function connectRpc(endpoint: string, token: string): Promise<RpcPeer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('runtime authentication timed out')) }, 3_000)
    const peer = new RpcPeer(socket, frame => {
      if (frame.authenticated !== true) return false
      clearTimeout(timeout)
      // Resolve after RpcPeer marks the channel authenticated.
      queueMicrotask(() => resolve(peer))
      return true
    })
    peer.onClose(() => { clearTimeout(timeout); reject(new Error('runtime authentication failed or disconnected')) })
    socket.once('connect', () => peer.send({ auth: token }))
  })
}
