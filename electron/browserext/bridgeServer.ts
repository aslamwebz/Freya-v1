import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { parseInbound, type BrowserBridge, type BridgeOutbound } from '../../core/browserext'
import { BROWSER_BRIDGE_LIMITS } from '../../core/browserext'
import {
  computeAcceptKey,
  decodeClientFrames,
  encodeClose,
  encodePong,
  encodeText,
  WS_OPCODE,
} from './wsFrames'
import { isExtensionResponse, type ExtensionRequest, type ExtensionResponse } from './protocol'
import type { BrowserTransport } from './browserAdapter'

/**
 * The local bridge server.
 *
 * Bound to `127.0.0.1` only, on a path only a paired extension is told about, and
 * reachable by no page: a page's WebSocket to a loopback port carries an `http(s)`
 * `Origin`, which this server refuses. Only a `chrome-extension://` origin is accepted,
 * and the pure bridge then re-checks that the origin matches the extension id the
 * session authenticated as.
 *
 * The server owns sockets and nothing else. Every decision is made by
 * {@link BrowserBridge}; this file only moves frames.
 */

export interface BridgeServerOptions {
  readonly bridge: BrowserBridge
  /** 0 asks the OS for an ephemeral port. */
  readonly port?: number
  readonly host?: string
  readonly now: () => number
  readonly onLog?: (line: string) => void
}

export interface BridgeServer {
  start(): Promise<{ readonly port: number }>
  stop(): Promise<void>
  readonly transport: BrowserTransport
  isConnected(): boolean
  connectionCount(): number
  /** Send a frame to every connected extension. Used for control-plane notices. */
  broadcast(frame: unknown): void
}

interface Connection {
  readonly id: string
  readonly origin: string
  readonly socket: Socket
  buffer: Buffer
  readonly pending: Map<string, (response: ExtensionResponse) => void>
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const host = options.host ?? '127.0.0.1'
  const connections = new Map<string, Connection>()
  let http: Server | null = null
  let port = 0

  function log(line: string): void {
    options.onLog?.(line)
  }

  function send(connection: Connection, outbound: BridgeOutbound): void {
    try {
      connection.socket.write(encodeText(JSON.stringify(outbound)))
    } catch {
      // A write to a closed socket is not a decision; the close handler cleans up.
    }
  }

  function sendRaw(connection: Connection, frame: unknown): void {
    try {
      connection.socket.write(encodeText(JSON.stringify(frame)))
    } catch {
      // See above.
    }
  }

  function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = request.url ?? ''
    if (!url.startsWith('/freya-browser-bridge')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const origin = String(request.headers.origin ?? '')
    // A page cannot claim a chrome-extension origin. This is the line that stops page
    // content impersonating the extension.
    if (!origin.startsWith('chrome-extension://')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || key.length === 0) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = computeAcceptKey(key)
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    )
    socket.setNoDelay(true)

    const connection: Connection = {
      id: randomUUID(),
      origin,
      socket,
      buffer: Buffer.alloc(0),
      pending: new Map(),
    }
    connections.set(connection.id, connection)
    log(`bridge connection ${connection.id} from ${origin}`)

    const hello = options.bridge.onConnection(connection.id)
    send(connection, hello)

    if (head.length > 0) {
      connection.buffer = Buffer.concat([connection.buffer, head])
      pump(connection)
    }

    socket.on('data', (chunk: Buffer) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk])
      pump(connection)
    })
    socket.on('error', () => closeConnection(connection))
    socket.on('close', () => closeConnection(connection))
  }

  function pump(connection: Connection): void {
    const result = decodeClientFrames(connection.buffer, BROWSER_BRIDGE_LIMITS.maxMessageBytes)
    connection.buffer = Buffer.from(result.rest)
    if (result.error !== null) {
      log(`bridge codec error on ${connection.id}: ${result.error}`)
      connection.socket.write(encodeClose(1009, 'frame error'))
      connection.socket.destroy()
      return
    }
    for (const frame of result.frames) {
      if (frame.opcode === WS_OPCODE.ping) {
        connection.socket.write(encodePong(frame.payload))
        continue
      }
      if (frame.opcode === WS_OPCODE.close) {
        connection.socket.write(encodeClose())
        connection.socket.end()
        return
      }
      if (frame.opcode === WS_OPCODE.pong) continue
      if (frame.opcode !== WS_OPCODE.text) {
        connection.socket.write(encodeClose(1003, 'text only'))
        connection.socket.destroy()
        return
      }
      void handleText(connection, frame.payload.toString('utf8'))
    }
  }

  async function handleText(connection: Connection, text: string): Promise<void> {
    const parsed = parseInbound(text)
    if (!parsed.ok) {
      sendRaw(connection, { kind: 'refused', code: parsed.code, reason: parsed.reason })
      return
    }
    // A response to a host request is routed to the adapter; everything else is a
    // command or handshake for the pure bridge.
    const message: unknown = parsed.message
    if (isExtensionResponse(message)) {
      const resolve = connection.pending.get(message.requestId)
      if (resolve !== undefined) {
        connection.pending.delete(message.requestId)
        resolve(message)
      }
      return
    }
    const outbound = await options.bridge.handle(connection.id, connection.origin, parsed.message)
    send(connection, outbound)
  }

  function closeConnection(connection: Connection): void {
    if (!connections.has(connection.id)) return
    connections.delete(connection.id)
    for (const resolve of connection.pending.values()) {
      resolve({
        kind: 'response',
        requestId: 'closed',
        ok: false,
        code: 'extension-unavailable',
        reason: 'The extension connection ended before the request was answered.',
        result: null,
      })
    }
    connection.pending.clear()
    options.bridge.onDisconnect(connection.id)
    log(`bridge connection ${connection.id} closed`)
  }

  const transport: BrowserTransport = {
    send(connectionId, request: ExtensionRequest) {
      return new Promise<ExtensionResponse>((resolve) => {
        const connection = connections.get(connectionId)
        if (connection === undefined) {
          resolve({
            kind: 'response',
            requestId: request.requestId,
            ok: false,
            code: 'extension-not-connected',
            reason: 'The extension is not connected to the bridge.',
            result: null,
          })
          return
        }
        connection.pending.set(request.requestId, resolve)
        sendRaw(connection, request)
      })
    },
  }

  return {
    transport,

    start() {
      return new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
          if (request.url === '/freya-browser-bridge/status') {
            const body = JSON.stringify({
              protocol: 1,
              pairingOpen: options.bridge.pairingOpen(),
              connected: connections.size > 0,
            })
            response.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(body),
            })
            response.end(body)
            return
          }
          response.writeHead(404)
          response.end()
        })
        server.on('upgrade', handleUpgrade)
        server.on('error', reject)
        server.listen(options.port ?? 0, host, () => {
          http = server
          const address = server.address()
          port = typeof address === 'object' && address !== null ? address.port : 0
          log(`bridge listening on ${host}:${String(port)}`)
          resolve({ port })
        })
      })
    },

    stop() {
      return new Promise((resolve) => {
        for (const connection of [...connections.values()]) {
          connection.socket.destroy()
          closeConnection(connection)
        }
        const server = http
        http = null
        if (server === null) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    },

    isConnected: () => connections.size > 0,
    connectionCount: () => connections.size,
    broadcast(frame) {
      for (const connection of connections.values()) sendRaw(connection, frame)
    },
  }
}
