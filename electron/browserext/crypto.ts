import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BridgeCrypto } from '../../core/browserext'

/**
 * The Node implementation of {@link BridgeCrypto}.
 *
 * Kept in `electron/` and out of `core/` so the protocol modules stay pure and the
 * release boundary check never sees a Node import under `core/`.
 */
export const nodeBridgeCrypto: BridgeCrypto = {
  randomBytes(bytes: number): Uint8Array {
    return new Uint8Array(randomBytes(bytes))
  },
  sha256Hex(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex')
  },
  timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) return false
    const left = Buffer.from(a, 'hex')
    const right = Buffer.from(b, 'hex')
    if (left.length !== right.length || left.length === 0) return false
    return timingSafeEqual(left, right)
  },
}
