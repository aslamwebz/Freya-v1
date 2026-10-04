import { createHash } from 'node:crypto'

/**
 * A minimal RFC 6455 codec, enough for one local, bounded JSON channel.
 *
 * There is no third-party WebSocket dependency here on purpose. The bridge carries a
 * handful of small JSON frames between the host and one paired extension on loopback;
 * a full protocol library would be more surface than the protocol. The codec is split
 * from the server so it can be tested without a socket.
 *
 * What it deliberately does **not** implement: compression (permessage-deflate is
 * never negotiated), binary payloads (opcode 0x2 is closed on), and unbounded frames
 * (a frame larger than the ceiling closes the connection).
 */

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const WS_OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
})

export interface WsFrame {
  readonly opcode: number
  readonly payload: Buffer
}

export interface WsDecodeResult {
  readonly frames: readonly WsFrame[]
  readonly rest: Buffer
  /** Set when a frame violates the codec (bad opcode, oversized, bad length). */
  readonly error: string | null
}

/** The `Sec-WebSocket-Accept` value for a client key. */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(`${secWebSocketKey}${WS_GUID}`).digest('base64')
}

/**
 * Encode one unmasked server frame.
 *
 * Servers never mask, and a server that did would be ignored by a conformant client.
 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

export function encodeText(text: string): Buffer {
  return encodeFrame(WS_OPCODE.text, Buffer.from(text, 'utf8'))
}

export function encodeClose(code = 1000, reason = ''): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  return encodeFrame(WS_OPCODE.close, payload)
}

export function encodePong(payload: Buffer): Buffer {
  return encodeFrame(WS_OPCODE.pong, payload)
}

export function encodePing(payload: Buffer): Buffer {
  return encodeFrame(WS_OPCODE.ping, payload)
}

/**
 * Decode as many complete client frames as `buffer` holds.
 *
 * Client frames must be masked; an unmasked client frame is an error. The returned
 * `rest` is the unconsumed tail, so a caller can concatenate the next chunk and call
 * again. A frame larger than `maxFrameBytes` is an error rather than an allocation.
 */
export function decodeClientFrames(buffer: Buffer, maxFrameBytes: number): WsDecodeResult {
  const frames: WsFrame[] = []
  let offset = 0
  let fragmented: { opcode: number; chunks: Buffer[]; bytes: number } | null = null

  while (true) {
    if (buffer.length - offset < 2) break
    const first = buffer[offset] ?? 0
    const second = buffer[offset + 1] ?? 0
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2

    if (!masked) {
      return { frames, rest: buffer.subarray(offset), error: 'client frames must be masked' }
    }
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      const big = buffer.readBigUInt64BE(cursor)
      if (big > BigInt(maxFrameBytes)) {
        return { frames, rest: Buffer.alloc(0), error: 'frame is larger than the ceiling' }
      }
      length = Number(big)
      cursor += 8
    }
    if (length > maxFrameBytes) {
      return { frames, rest: Buffer.alloc(0), error: 'frame is larger than the ceiling' }
    }
    if (buffer.length - cursor < 4) break
    const maskKey = buffer.subarray(cursor, cursor + 4)
    cursor += 4
    if (buffer.length - cursor < length) break
    const maskedPayload = buffer.subarray(cursor, cursor + length)
    cursor += length
    const payload = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = (maskedPayload[index] ?? 0) ^ (maskKey[index % 4] ?? 0)
    }

    if (opcode === WS_OPCODE.continuation) {
      if (fragmented === null) {
        return { frames, rest: Buffer.alloc(0), error: 'unexpected continuation frame' }
      }
      fragmented.chunks.push(payload)
      fragmented.bytes += payload.length
      if (fragmented.bytes > maxFrameBytes) {
        return { frames, rest: Buffer.alloc(0), error: 'fragmented message is larger than the ceiling' }
      }
      if (fin) {
        frames.push({ opcode: fragmented.opcode, payload: Buffer.concat(fragmented.chunks) })
        fragmented = null
      }
      offset = cursor
      continue
    }

    if (opcode === WS_OPCODE.text || opcode === WS_OPCODE.binary) {
      if (!fin) {
        fragmented = { opcode, chunks: [payload], bytes: payload.length }
      } else {
        frames.push({ opcode, payload })
      }
      offset = cursor
      continue
    }

    if (opcode === WS_OPCODE.ping || opcode === WS_OPCODE.pong || opcode === WS_OPCODE.close) {
      frames.push({ opcode, payload })
      offset = cursor
      continue
    }

    return { frames, rest: Buffer.alloc(0), error: `unsupported opcode ${String(opcode)}` }
  }

  return { frames, rest: buffer.subarray(offset), error: null }
}
