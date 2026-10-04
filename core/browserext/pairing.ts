import { BROWSER_BRIDGE_LIMITS, type BrowserBridgeRefusalCode } from './types'
import type { BridgeCrypto } from './crypto'
import { timingSafeStringEqual } from './crypto'

/**
 * Pairing: the one moment a person connects an extension to Freya.
 *
 * The model is deliberately small. Freya generates a short, human-typable code, shows
 * it in her own window, and stores only its hash. The person types it into the
 * extension. On a match the host mints a long-lived *token*, hands the plaintext to the
 * extension exactly once, and stores only the token's hash. The host can never read a
 * token back, which means a stolen database is not a stolen browser.
 *
 * Three properties are asserted in `tests/core/browserext/pairing.test.ts` and
 * `tests/red-team/browserext`:
 *
 *   - A code is refused after its TTL, and is **not** extended.
 *   - A code is refused after a bounded number of attempts, so it cannot be brute-forced.
 *   - A token hash is compared in constant time, so a timing oracle is not available.
 */

/** The pairing offer: a hash, an expiry and an attempt counter. Never the code itself. */
export interface PairingOffer {
  /** Lower-case hex SHA-256 of the code. */
  readonly codeHash: string
  readonly expiresAt: number
  readonly attempts: number
  readonly createdAt: number
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

/** A human-typable pairing code from a 32-symbol alphabet, no ambiguous glyphs. */
export function generatePairingCode(crypto: BridgeCrypto): string {
  const bytes = crypto.randomBytes(CODE_LENGTH)
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const byte = bytes[index] ?? 0
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? 'A'
  }
  return code
}

/** The digest of a pairing code. Domain-separated so a token hash can never equal it. */
export function pairingCodeHash(crypto: BridgeCrypto, code: string): string {
  return crypto.sha256Hex(`freya-browser-bridge:pairing-code:${code}`)
}

/** The digest of a bearer token. Stored instead of the token, always. */
export function tokenHash(crypto: BridgeCrypto, token: string): string {
  return crypto.sha256Hex(`freya-browser-bridge:token:${token}`)
}

/** Mint an opaque token. 32 bytes of entropy, URL-safe, never derived from anything. */
export function generateToken(crypto: BridgeCrypto): string {
  return base64UrlToken(crypto.randomBytes(32))
}

/** Local base64url so this module does not depend on the crypto helper's formatting. */
function base64UrlToken(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0
    const b1 = bytes[index + 1]
    const b2 = bytes[index + 2]
    out += alphabet[(b0 >> 2) & 0x3f] ?? 'A'
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? 'A'
    if (b1 !== undefined) out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? 'A'
    if (b2 !== undefined) out += alphabet[b2 & 0x3f] ?? 'A'
  }
  return out
}

export interface PairingOfferOptions {
  readonly ttlMs?: number
}

/**
 * Open a pairing offer. Returns the plaintext code for the owner to read and the offer
 * for the bridge to store. The code exists in memory only for as long as it is shown.
 */
export function createPairingOffer(
  crypto: BridgeCrypto,
  now: number,
  options: PairingOfferOptions = {},
): { readonly code: string; readonly offer: PairingOffer } {
  const ttl = clampTtl(options.ttlMs ?? BROWSER_BRIDGE_LIMITS.pairingCodeTtlMs)
  const code = generatePairingCode(crypto)
  return {
    code,
    offer: Object.freeze({
      codeHash: pairingCodeHash(crypto, code),
      expiresAt: now + ttl,
      attempts: 0,
      createdAt: now,
    }),
  }
}

function clampTtl(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return BROWSER_BRIDGE_LIMITS.pairingCodeTtlMs
  return Math.min(Math.floor(requested), BROWSER_BRIDGE_LIMITS.pairingCodeTtlMs)
}

export type PairingVerification =
  | { readonly ok: true; readonly offer: PairingOffer }
  | { readonly ok: false; readonly code: BrowserBridgeRefusalCode; readonly reason: string; readonly offer: PairingOffer | null }

/**
 * Verify a presented code against an offer.
 *
 * The returned offer always reflects the incremented attempt count, so the caller can
 * persist it even on a refusal. That is what makes the attempt ceiling real rather than
 * a counter that only advances on success.
 */
export function verifyPairingCode(
  crypto: BridgeCrypto,
  offer: PairingOffer,
  presented: unknown,
  now: number,
): PairingVerification {
  if (now > offer.expiresAt) {
    return {
      ok: false,
      code: 'pairing-expired',
      reason: 'That pairing code has expired. A code is refused rather than extended, because an extension of a code is a second chance for somebody else.',
      offer: null,
    }
  }
  if (offer.attempts >= BROWSER_BRIDGE_LIMITS.pairingMaxAttempts) {
    return {
      ok: false,
      code: 'pairing-attempts-exceeded',
      reason: 'Too many pairing attempts against this code, so it is closed. Open a new one in Freya.',
      offer: null,
    }
  }
  const attempted: PairingOffer = Object.freeze({ ...offer, attempts: offer.attempts + 1 })
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 64) {
    return {
      ok: false,
      code: 'pairing-code-invalid',
      reason: 'That is not a pairing code this build issues.',
      offer: attempted,
    }
  }
  const presentedHash = pairingCodeHash(crypto, presented.trim().toUpperCase())
  if (!crypto.timingSafeEqualHex(presentedHash, offer.codeHash)) {
    return {
      ok: false,
      code: 'pairing-code-invalid',
      reason: 'That pairing code does not match the one Freya is showing.',
      offer: attempted,
    }
  }
  return { ok: true, offer: attempted }
}

/** Exposed so a caller can compare two codes without going through an offer. */
export function codesMatch(a: string, b: string): boolean {
  return timingSafeStringEqual(a, b)
}
