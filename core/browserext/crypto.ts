/**
 * The cryptographic surface the bridge needs, injected.
 *
 * Injected rather than imported so the protocol modules stay pure and a test can supply
 * a deterministic implementation. The host supplies one backed by `node:crypto`; the
 * tests supply one they can predict. There is no default here, because a bridge that
 * silently fell back to a weak random would be worse than one that refused to start.
 */
export interface BridgeCrypto {
  /** Exactly `bytes` random bytes. */
  randomBytes(bytes: number): Uint8Array
  /** Lower-case hex SHA-256 of a UTF-8 string. */
  sha256Hex(input: string): string
  /** Constant-time comparison of two lower-case hex digests. */
  timingSafeEqualHex(a: string, b: string): boolean
}

const HEX = '0123456789abcdef'

/** Lower-case hex of a byte array. Pure. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0x0f] ?? '0'
    out += HEX[byte & 0x0f] ?? '0'
  }
  return out
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** URL-safe base64 of a byte array, no padding. Pure. */
export function base64Url(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0
    const b1 = bytes[index + 1]
    const b2 = bytes[index + 2]
    out += B64URL[(b0 >> 2) & 0x3f] ?? 'A'
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? 'A'
    if (b1 !== undefined) out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? 'A'
    if (b2 !== undefined) out += B64URL[b2 & 0x3f] ?? 'A'
  }
  return out
}

/**
 * Constant-time string equality for two same-alphabet strings.
 *
 * Pure, and used as a fallback by a crypto implementation that has no primitive. The
 * comparison length is folded into the accumulator, so two different-length strings are
 * still compared without an early return.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0)
  }
  return diff === 0
}
