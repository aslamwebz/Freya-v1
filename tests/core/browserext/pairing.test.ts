import { describe, expect, it } from 'vitest'
import {
  createPairingOffer,
  generatePairingCode,
  generateToken,
  pairingCodeHash,
  tokenHash,
  verifyPairingCode,
} from '../../../core/browserext'
import { makeCrypto, T0 } from './harness'

const crypto = makeCrypto()

describe('pairing', () => {
  it('generates a short, human-typable code with no ambiguous glyphs', () => {
    const code = generatePairingCode(crypto)
    expect(code).toHaveLength(8)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    expect(code).not.toMatch(/[IO01]/)
  })

  it('accepts the code it showed and refuses any other', () => {
    const { code, offer } = createPairingOffer(crypto, T0)
    expect(verifyPairingCode(crypto, offer, code, T0).ok).toBe(true)
    const wrong = verifyPairingCode(crypto, offer, 'ZZZZZZZZ', T0)
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.code).toBe('pairing-code-invalid')
  })

  it('refuses an expired code rather than extending it', () => {
    const { code, offer } = createPairingOffer(crypto, T0, { ttlMs: 1_000 })
    const result = verifyPairingCode(crypto, offer, code, T0 + 2_000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('pairing-expired')
  })

  it('closes after the attempt ceiling, counting failures', () => {
    let { offer } = createPairingOffer(crypto, T0)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = verifyPairingCode(crypto, offer, 'WRONGCODE', T0)
      expect(result.ok).toBe(false)
      if (!result.ok && result.offer !== null) offer = result.offer
    }
    const closed = verifyPairingCode(crypto, offer, 'WRONGCODE', T0)
    expect(closed.ok).toBe(false)
    if (!closed.ok) expect(closed.code).toBe('pairing-attempts-exceeded')
  })

  it('domain-separates the code hash from the token hash', () => {
    expect(pairingCodeHash(crypto, 'ABCDEFGH')).not.toBe(tokenHash(crypto, 'ABCDEFGH'))
  })

  it('mints a high-entropy token that is never derived from the code', () => {
    const a = generateToken(crypto)
    const b = generateToken(crypto)
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(40)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
