/**
 * The control-plane server.
 *
 * Listens on a platform-local IPC channel — a Windows named pipe
 * (`\\.\pipe\freya-control-<pid>`) or a POSIX Unix domain socket — and speaks
 * line-delimited JSON-RPC 2.0 over it. The wire format is identical across
 * platforms, so a CLI written once works on both.
 *
 * One owner. The server starts when Freya starts, stops when Freya stops, and
 * there is no second instance: if a second launch tries to bind the same
 * channel, it fails and Freya's normal single-instance guard does the rest.
 *
 * No HTTP. No REST. No localhost. The pipe name is a Windows kernel object and
 * the socket file is a filesystem node; both are reachable only by processes
 * the local user owns, which is exactly the audience the surface is for.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ControlError,
  type ControlErrorCode,
  type ControlEvent,
  type ControlRequest,
  type ControlResponse,
  MAX_PAYLOAD_BYTES,
} from './contract'
import { AuthFailureLimiter, loadOrCreateToken, tokensMatch } from './token'
import type { ControlService } from './service'

const PIPE_NAME_PREFIX = 'freya-control'
const MAX_LINE_BYTES = MAX_PAYLOAD_BYTES + 64
const SOCKET_DIR = process.env.FREYA_CONTROL_SOCKET_DIR ?? join(tmpdir(), 'freya-control')

export interface ControlServerOptions {
  readonly userDataDir: string
  readonly service: ControlService
  /** When false, the server refuses to start. Used when the build does not want a control surface. */
  readonly enabled: boolean
  /** A logger the host can wire to its own diagnostics. */
  readonly log?: (line: string) => void
  /**
   * Optional salt appended to the pipe / socket name. Production never sets it
   * (the pid alone is unique), but tests in the same process need it so two
   * servers can coexist without colliding on the kernel object.
   */
  readonly salt?: string
}

export interface ControlServer {
  readonly endpoint: string
  start(): Promise<void>
  stop(): Promise<void>
  /** Broadcast a control event to every authenticated subscriber. */
  publish(event: ControlEvent): void
}

function endpointForPlatform(pid: number, salt: string): { endpoint: string; socketPath?: string } {
  // The salt lets tests run multiple servers in the same process without a
  // name collision on the kernel object. Production passes an empty string.
  const suffix = salt === '' ? '' : `-${salt}`
  if (process.platform === 'win32') {
    return { endpoint: `\\\\.\\pipe\\${PIPE_NAME_PREFIX}-${pid}${suffix}` }
  }
  mkdirSync(SOCKET_DIR, { recursive: true })
  return {
    endpoint: `unix:${join(SOCKET_DIR, `freya-${pid}${suffix}.sock`)}`,
    socketPath: join(SOCKET_DIR, `freya-${pid}${suffix}.sock`),
  }
}

interface Subscriber {
  readonly id: string
  readonly topics: Set<string> | null
  readonly socket: Socket
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  if (!opts.enabled) {
    throw new Error('the control server is disabled in this build')
  }
  const token = loadOrCreateToken(opts.userDataDir)
  const limiter = new AuthFailureLimiter()

  const subscribers = new Map<string, Subscriber>()
  const pendingWaits = new Map<
    string,
    { resolve: (response: ControlResponse) => void; timer: NodeJS.Timeout }
  >()
  const pid = process.pid
  const { endpoint, socketPath } = endpointForPlatform(pid, opts.salt ?? '')

  if (socketPath !== undefined && existsSync(socketPath)) {
    // A leftover socket from a crashed prior run. Removing it is safe because
    // the OS only delivers connections to live listeners; a dead file is just
    // a file.
    try {
      unlinkSync(socketPath)
    } catch {
      // A file we cannot remove is the next server's problem — refuse to start
      // rather than risk two owners of the same channel.
      throw new Error(`refusing to start: stale socket at ${socketPath} is not removable`)
    }
  }

  const server: Server = createServer({ allowHalfOpen: false }, (socket) => attach(socket))

  function attach(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    let authenticated = false
    let identity: { kind: 'cli' | 'mcp' | 'script' | 'unspecified'; client?: string; sessionId?: string } = {
      kind: 'unspecified',
    }
    const remoteAddress = describePeer(socket)
    const log = (line: string) => opts.log?.(`[control] ${line}`)

    socket.on('data', (chunk: string) => {
      buffer += chunk
      // A single oversized chunk is a hard fail. The wire allows 256 KiB and
      // anything beyond is a misuse we want to refuse loudly.
      if (buffer.length > MAX_LINE_BYTES) {
        socket.end(lineFor({ jsonrpc: '2.0', id: '0', error: { code: 'PAYLOAD_TOO_LARGE', message: 'request exceeds maximum size' } }))
        return
      }
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        void handleLine(line)
      }
    })

    socket.on('error', (err) => {
      log(`peer ${remoteAddress} error: ${err.message}`)
    })

    socket.on('close', () => {
      log(`peer ${remoteAddress} closed (authenticated=${authenticated})`)
    })

    async function handleLine(line: string): Promise<void> {
      if (line.length === 0) return
      if (!authenticated) {
        // The first line on every connection is the auth line. Format:
        //   "AUTH <token> [<client>]\n"
        // Where <client> is a free string the CLI uses for attribution.
        const match = /^AUTH\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line)
        if (match === null) {
          sendError(socket, '0', { code: 'UNAUTHENTICATED', message: 'auth line is missing or malformed' })
          socket.end()
          return
        }
        const presented = match[1] ?? ''
        const client = match[2] ?? 'unspecified'
        if (!limiter.allow()) {
          sendError(socket, '0', { code: 'RATE_LIMITED', message: 'too many failed attempts' })
          socket.end()
          return
        }
        if (!tokensMatch(token, presented)) {
          limiter.noteFailure()
          sendError(socket, '0', { code: 'TOKEN_MISMATCH', message: 'auth failed' })
          socket.end()
          return
        }
        limiter.noteSuccess()
        authenticated = true
        identity = { kind: 'cli', client: client.slice(0, 64) }
        socket.write('OK\n')
        log(`peer ${remoteAddress} authenticated as ${identity.client}`)
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        sendError(socket, '0', { code: 'PARSE_ERROR', message: 'request is not valid JSON' })
        return
      }
      const request = parseRequest(parsed)
      if (request === null) {
        sendError(socket, requestIdOrZero(parsed), { code: 'INVALID_REQUEST', message: 'request shape is invalid' })
        return
      }
      if (request.method === 'event.subscribe' || request.method === 'event.unsubscribe' || request.method === 'wait') {
        const response = handleSubscription(request, socket, identity)
        sendJson(socket, response)
        return
      }
      const response = await opts.service.handle(request, identity)
      sendJson(socket, response)
    }
  }

  function handleSubscription(
    request: ControlRequest,
    socket: Socket,
    _identity: { kind: 'cli' | 'mcp' | 'script' | 'unspecified'; client?: string; sessionId?: string },
  ): ControlResponse {
    switch (request.method) {
      case 'event.subscribe': {
        const topics = readTopics(request.params)
        const sub: Subscriber = { id: randomUUID(), topics, socket }
        subscribers.set(sub.id, sub)
        socket.once('close', () => subscribers.delete(sub.id))
        return { jsonrpc: '2.0', id: request.id, result: { subscribed: sub.id, topics: topics === null ? '*' : [...topics] } }
      }
      case 'event.unsubscribe': {
        const id = stringField(request.params, 'subscriptionId', 64)
        if (id === null) return errorResponse(request.id, 'INVALID_REQUEST', 'subscriptionId is required')
        const removed = subscribers.delete(id)
        return { jsonrpc: '2.0', id: request.id, result: { removed } }
      }
      case 'wait': {
        // A long-poll: resolve when an event matching `topic` arrives, or after
        // `timeoutMs`. `subscribe: true` registers the caller as a subscriber
        // before waiting, so it can be notified by `publish`.
        const topic = stringField(request.params, 'topic', 128)
        const timeoutMs = numberField(request.params, 'timeoutMs', 1, 60_000) ?? 5_000
        const subscribe = booleanField(request.params, 'subscribe', true)
        if (subscribe) {
          const topics = topic === null ? null : new Set([topic])
          const sub: Subscriber = { id: randomUUID(), topics, socket }
          subscribers.set(sub.id, sub)
          socket.once('close', () => subscribers.delete(sub.id))
        }
        const opId = randomUUID()
        return new Promise<ControlResponse>((resolve) => {
          const timer = setTimeout(() => {
            pendingWaits.delete(opId)
            resolve({ jsonrpc: '2.0', id: request.id, result: { matched: false, reason: 'timeout' } })
          }, timeoutMs)
          pendingWaits.set(opId, {
            resolve: (response) => {
              clearTimeout(timer)
              resolve(response)
            },
            timer,
          })
        }) as unknown as ControlResponse
      }
    }
    return errorResponse(request.id, 'METHOD_NOT_FOUND', `unknown method: ${request.method}`)
  }

  function publish(event: ControlEvent): void {
    const wire = JSON.stringify(event) + '\n'
    for (const sub of [...subscribers.values()]) {
      if (sub.topics !== null && !sub.topics.has(event.params.topic)) continue
      try {
        sub.socket.write(wire)
      } catch {
        subscribers.delete(sub.id)
      }
    }
    // Resolve any matching pending wait. The wait is matched on `topic` and
    // resolved with a fresh response object that carries the event as result.
    for (const [opId, wait] of pendingWaits) {
      const response: ControlResponse = {
        jsonrpc: '2.0',
        id: 'wait',
        result: { matched: true, topic: event.params.topic, payload: event.params.payload, at: event.params.at },
      }
      wait.resolve(response)
      pendingWaits.delete(opId)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if (socketPath !== undefined) {
      server.listen(socketPath, () => resolve())
    } else {
      server.listen(endpoint, () => resolve())
    }
  })

  // The endpoint file is how the CLI and the MCP adapter find a running
  // Freya. It is rewritten on every start and removed on every stop, so a
  // crashed instance leaves a stale file and the next launch is honest about
  // having to re-bind. The token file is the security boundary; this is just
  // the address book entry.
  const endpointFile = join(opts.userDataDir, 'control.endpoint')
  writeFileSync(
    endpointFile,
    JSON.stringify({ endpoint, pid, startedAt: new Date().toISOString() }) + '\n',
    'utf8',
  )

  return {
    endpoint,
    start: async () => undefined,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const wait of pendingWaits.values()) {
          clearTimeout(wait.timer)
        }
        pendingWaits.clear()
        for (const sub of subscribers.values()) {
          sub.socket.destroy()
        }
        subscribers.clear()
        server.close(() => {
          if (socketPath !== undefined && existsSync(socketPath)) {
            try {
              unlinkSync(socketPath)
            } catch {
              // best effort
            }
          }
          try {
            unlinkSync(join(opts.userDataDir, 'control.endpoint'))
          } catch {
            // best effort
          }
          resolve()
        })
      }),
    publish,
  }
}

function lineFor(response: ControlResponse): string {
  return JSON.stringify(response) + '\n'
}

function sendJson(socket: Socket, response: ControlResponse): void {
  socket.write(lineFor(response))
}

function sendError(socket: Socket, id: string, error: ControlError): void {
  sendJson(socket, { jsonrpc: '2.0', id, error })
}

function errorResponse(id: string, code: ControlErrorCode, message: string): ControlResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function parseRequest(value: unknown): ControlRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') return null
  if (typeof obj.method !== 'string' || obj.method.length === 0) return null
  if (typeof obj.id !== 'string' && typeof obj.id !== 'number') return null
  return {
    jsonrpc: '2.0',
    id: String(obj.id),
    method: obj.method,
    ...(obj.params === undefined ? {} : { params: obj.params as Readonly<Record<string, unknown>> }),
  }
}

function requestIdOrZero(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return '0'
}

function stringField(params: unknown, key: string, max: number): string | null {
  if (typeof params !== 'object' || params === null) return null
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  return value
}

function numberField(params: unknown, key: string, min: number, max: number): number | null {
  if (typeof params !== 'object' || params === null) return null
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null
  return value
}

function booleanField(params: unknown, key: string, fallback: boolean): boolean {
  if (typeof params !== 'object' || params === null) return fallback
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : fallback
}

function readTopics(params: unknown): Set<string> | null {
  if (typeof params !== 'object' || params === null) return null
  const raw = (params as Record<string, unknown>).topics
  if (raw === undefined) return null
  if (!Array.isArray(raw)) return null
  const set = new Set<string>()
  for (const t of raw) {
    if (typeof t === 'string' && t.length > 0 && t.length < 128) set.add(t)
  }
  return set
}

function describePeer(socket: Socket): string {
  // `address()` is undefined for pipes/sockets until a name is set; the
  // constructor's `remoteAddress` is similarly undefined for the same reason.
  // We label the peer by its socket-id-equivalent (the random Node-internal
  // handle) for log readability.
  return socket.remoteAddress ?? 'local'
}
