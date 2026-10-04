import { describe, expect, it } from 'vitest'
import { createSessionRegistry } from '../../../core/browserext'
import { makeCrypto, T0 } from './harness'

const crypto = makeCrypto()

function registry() {
  return createSessionRegistry(crypto)
}

function create(reg: ReturnType<typeof registry>, capabilities: readonly string[] = ['page.metadata']) {
  return reg.create({
    connectionId: 'conn-1',
    extensionId: 'ext-1',
    tokenHash: 'hash-1',
    capabilities: capabilities as never,
    now: T0,
  })
}

function authorize(reg: ReturnType<typeof registry>, sessionId: string, overrides: Partial<{
  seq: number
  nonce: string
  idempotencyKey: string
  connectionId: string
  now: number
  command: string
}> = {}) {
  return reg.authorize({
    sessionId,
    connectionId: overrides.connectionId ?? 'conn-1',
    seq: overrides.seq ?? 1,
    nonce: overrides.nonce ?? 'n-1',
    idempotencyKey: overrides.idempotencyKey ?? 'i-1',
    command: (overrides.command ?? 'session.status') as never,
    now: overrides.now ?? T0,
  })
}

describe('session registry', () => {
  it('authorises a first command and advances the sequence', () => {
    const reg = registry()
    const session = create(reg)
    const first = authorize(reg, session.sessionId)
    expect(first.ok).toBe(true)
    const second = authorize(reg, session.sessionId, { seq: 2, nonce: 'n-2', idempotencyKey: 'i-2' })
    expect(second.ok).toBe(true)
  })

  it('refuses a replayed nonce', () => {
    const reg = registry()
    const session = create(reg)
    authorize(reg, session.sessionId)
    const replay = authorize(reg, session.sessionId, { seq: 2, nonce: 'n-1', idempotencyKey: 'i-2' })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.refusal.code).toBe('nonce-replayed')
  })

  it('refuses an out-of-order sequence', () => {
    const reg = registry()
    const session = create(reg)
    authorize(reg, session.sessionId, { seq: 5 })
    const old = authorize(reg, session.sessionId, { seq: 5, nonce: 'n-9', idempotencyKey: 'i-9' })
    expect(old.ok).toBe(false)
    if (!old.ok) expect(old.refusal.code).toBe('sequence-out-of-order')
  })

  it('treats a repeated idempotency key for the same command as a replay', () => {
    const reg = registry()
    const session = create(reg)
    authorize(reg, session.sessionId, { idempotencyKey: 'same' })
    reg.rememberResult(session.sessionId, 'same', 'session.status', { done: true })
    const replay = authorize(reg, session.sessionId, { seq: 2, nonce: 'n-2', idempotencyKey: 'same' })
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.replayed).toBe(true)
  })

  it('refuses one idempotency key naming a different command', () => {
    const reg = registry()
    const session = create(reg)
    authorize(reg, session.sessionId, { idempotencyKey: 'same', command: 'session.status' })
    reg.rememberResult(session.sessionId, 'same', 'session.status', { done: true })
    const conflict = authorize(reg, session.sessionId, { seq: 2, nonce: 'n-2', idempotencyKey: 'same', command: 'tab.metadata' })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.refusal.code).toBe('idempotency-conflict')
  })

  it('refuses a session id used from a different connection', () => {
    const reg = registry()
    const session = create(reg)
    const other = authorize(reg, session.sessionId, { connectionId: 'conn-2' })
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.refusal.code).toBe('session-missing')
  })

  it('refuses an expired session and a revoked session', () => {
    const reg = registry()
    const expired = create(reg)
    const late = authorize(reg, expired.sessionId, { now: T0 + 31 * 60_000 })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.refusal.code).toBe('session-expired')

    const revoked = create(reg)
    reg.revoke(revoked.sessionId, T0)
    const after = authorize(reg, revoked.sessionId)
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.refusal.code).toBe('session-revoked')
  })

  it('clamps capabilities to the closed vocabulary', () => {
    const reg = registry()
    const session = reg.create({
      connectionId: 'conn-1',
      extensionId: 'ext-1',
      tokenHash: 'hash-1',
      capabilities: ['page.metadata', 'not-a-capability', 'element.click'] as never,
      now: T0,
    })
    expect(session.capabilities).toEqual(['page.metadata', 'element.click'])
  })

  it('binds and unbinds a tab and origin', () => {
    const reg = registry()
    const session = create(reg)
    reg.bindTab(session.sessionId, 7, 'https://example.com/', 'https://example.com')
    expect(session.sharedTabId).toBe(7)
    expect(session.sharedOrigin).toBe('https://example.com')
    expect(session.sharedUrl).toBe('https://example.com/')
    reg.unbindTab(session.sessionId)
    expect(session.sharedTabId).toBeNull()
    expect(session.sharedUrl).toBeNull()
  })
})
