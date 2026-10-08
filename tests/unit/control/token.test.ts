import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthFailureLimiter, loadOrCreateToken, tokensMatch } from '../../../electron/control/token'

describe('control token', () => {
  it('creates a 32-byte hex token on first use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freya-control-'))
    const token = loadOrCreateToken(dir)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const onDisk = readFileSync(join(dir, 'control.token'), 'utf8').trim()
    expect(onDisk).toBe(token)
  })

  it('reuses an existing valid token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freya-control-'))
    const first = loadOrCreateToken(dir)
    const second = loadOrCreateToken(dir)
    expect(first).toBe(second)
  })

  it('regenerates a corrupt token file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freya-control-'))
    writeFileSync(join(dir, 'control.token'), 'not-a-token', 'utf8')
    const fresh = loadOrCreateToken(dir)
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches identical tokens and rejects different ones', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(tokensMatch(a, a)).toBe(true)
    expect(tokensMatch(a, b)).toBe(false)
  })

  it('rejects mismatched lengths in constant time', () => {
    expect(tokensMatch('a'.repeat(64), 'a'.repeat(32))).toBe(false)
    expect(tokensMatch('', 'a'.repeat(64))).toBe(false)
  })
})

describe('AuthFailureLimiter', () => {
  it('opens the gate, then closes after too many failures', () => {
    const limiter = new AuthFailureLimiter(3, 1_000)
    expect(limiter.allow()).toBe(true)
    limiter.noteFailure()
    limiter.noteFailure()
    limiter.noteFailure()
    expect(limiter.allow()).toBe(false)
  })

  it('opens again after the cooldown', () => {
    const now = 1_000
    const limiter = new AuthFailureLimiter(2, 100)
    limiter.noteFailure(now)
    limiter.noteFailure(now)
    expect(limiter.allow(now)).toBe(false)
    // Advance the clock past the cooldown.
    expect(limiter.allow(now + 200)).toBe(true)
  })

  it('a success resets the failure count', () => {
    const limiter = new AuthFailureLimiter(2, 1_000)
    limiter.noteFailure()
    limiter.noteSuccess()
    limiter.noteFailure()
    expect(limiter.allow()).toBe(true)
  })
})
