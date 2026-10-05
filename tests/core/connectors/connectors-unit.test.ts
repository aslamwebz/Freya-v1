// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  base64UrlEncode,
  createAuthRequest,
  createPkcePair,
  verifyAuthCallback,
} from '../../../core/connectors/auth'
import {
  MemoryConnectorTokenStore,
  NullConnectorTokenStore,
  TokenStoreUnavailableError,
  redactTokenRecord,
  type ConnectorTokenRecord,
} from '../../../core/connectors/token-store'
import { CONNECTOR_ACTION_POLICY, actionPolicy, isDestructiveAction, isReadAction } from '../../../core/connectors/policy'
import { grantCovers, grantIsReadwrite, knownScopes, scopesForAuthority } from '../../../core/connectors/catalog'
import {
  validateActionRequest,
  validateAuthorizationCompletion,
  validateConnectRequest,
  validateEventInput,
} from '../../../core/connectors/validation'

/** A deterministic randomness source: a counter, so values are reproducible. */
let randomCounter = 0
function fakeRandom(size: number): Uint8Array {
  randomCounter += 1
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + 3 + randomCounter) % 256
  return bytes
}

describe('PKCE and authorization requests', () => {
  it('builds a verifier/challenge pair with an S256 challenge', () => {
    const pkce = createPkcePair(fakeRandom)
    expect(pkce.method).toBe('S256')
    expect(pkce.verifier.length).toBeGreaterThan(0)
    expect(pkce.challenge.length).toBeGreaterThan(0)
    expect(pkce.challenge).not.toBe(pkce.verifier)
  })

  it('builds a request whose state and nonce are independent', () => {
    const request = createAuthRequest({
      requestId: 'req-1',
      connector: 'gmail',
      now: new Date('2026-10-02T09:00:00.000Z'),
      random: fakeRandom,
    })
    expect(request.state).not.toBe(request.nonce)
    expect(request.codeVerifier.length).toBeGreaterThan(0)
  })

  it('accepts a matching callback and refuses a forged state', () => {
    const request = createAuthRequest({
      requestId: 'req-1',
      connector: 'gmail',
      now: new Date('2026-10-02T09:00:00.000Z'),
      random: fakeRandom,
    })
    const now = new Date('2026-10-02T09:01:00.000Z')
    expect(verifyAuthCallback(request, { state: request.state, code: 'code', nonce: request.nonce }, now)).toEqual({ ok: true })
    const forged = verifyAuthCallback(request, { state: 'not-the-state', code: 'code' }, now)
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.failureCode).toBe('cross_account')
  })

  it('refuses a mismatched nonce and an expired request', () => {
    const request = createAuthRequest({
      requestId: 'req-1',
      connector: 'gmail',
      now: new Date('2026-10-02T09:00:00.000Z'),
      random: fakeRandom,
    })
    const nonce = verifyAuthCallback(request, { state: request.state, code: 'code', nonce: 'wrong' }, new Date('2026-10-02T09:01:00.000Z'))
    expect(nonce.ok).toBe(false)
    const expired = verifyAuthCallback(request, { state: request.state, code: 'code' }, new Date('2026-10-02T10:00:00.000Z'))
    expect(expired.ok).toBe(false)
  })
})

describe('token store seam', () => {
  const record: ConnectorTokenRecord = {
    connector: 'gmail',
    accountLabel: 'a@example.com',
    scopes: ['gmail.readonly'],
    accessToken: 'FREYA_CONNECTOR_SECRET_ACCESS',
    refreshToken: 'FREYA_CONNECTOR_SECRET_REFRESH',
    expiresAt: null,
    storedAt: '2026-10-02T09:00:00.000Z',
  }

  it('memory store round-trips and clears', async () => {
    const store = new MemoryConnectorTokenStore()
    expect(await store.load('gmail')).toBeNull()
    await store.save(record)
    expect((await store.load('gmail'))?.accessToken).toBe(record.accessToken)
    await store.clear('gmail')
    expect(await store.load('gmail')).toBeNull()
  })

  it('the fail-closed store refuses to persist', async () => {
    const store = new NullConnectorTokenStore('no secure storage')
    expect(store.kind).toBe('unavailable')
    await expect(store.save(record)).rejects.toBeInstanceOf(TokenStoreUnavailableError)
    expect(await store.load('gmail')).toBeNull()
  })

  it('redaction removes both tokens', () => {
    const redacted = redactTokenRecord(record)
    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain('FREYA_CONNECTOR_SECRET')
    expect(redacted.hasAccessToken).toBe(true)
    expect(redacted.hasRefreshToken).toBe(true)
  })
})

describe('policy and scopes', () => {
  it('classifies every action', () => {
    expect(isReadAction('gmail.read')).toBe(true)
    expect(isReadAction('gmail.send')).toBe(false)
    expect(isDestructiveAction('calendar.cancel')).toBe(true)
    expect(isDestructiveAction('calendar.update')).toBe(false)
    expect(actionPolicy('telegram.send').relayAction).toBe('telegram.send')
  })

  it('maps connector actions to Relay actions with distinct capabilities', () => {
    const relayActions = Object.values(CONNECTOR_ACTION_POLICY).map((policy) => policy.relayAction)
    expect(new Set(relayActions).size).toBe(relayActions.length)
  })

  it('checks scope coverage without widening', () => {
    expect(grantCovers(['gmail.readonly'], ['gmail.readonly'])).toBe(true)
    expect(grantCovers(['gmail.readonly'], ['gmail.send'])).toBe(false)
    expect(grantIsReadwrite('gmail', ['gmail.readonly'])).toBe(false)
    expect(grantIsReadwrite('gmail', ['gmail.send'])).toBe(true)
    expect(scopesForAuthority('google-calendar', 'destructive')).toEqual(['calendar.events.owned'])
    expect(knownScopes('github')).toContain('repo:issues.write')
  })
})

describe('validation', () => {
  it('accepts a connect request and refuses an unknown connector', () => {
    expect(validateConnectRequest({ connector: 'gmail' }).ok).toBe(true)
    expect(validateConnectRequest({ connector: 'slack' }).ok).toBe(false)
    expect(validateConnectRequest({ connector: 'gmail', authority: 'admin' }).ok).toBe(false)
  })

  it('refuses an action that does not belong to its connector', () => {
    const result = validateActionRequest({ connector: 'gmail', action: 'telegram.send', params: {} })
    expect(result.ok).toBe(false)
  })

  it('refuses an authorization that names a field outside the schema', () => {
    const result = validateAuthorizationCompletion({
      connector: 'gmail',
      accountLabel: 'a@example.com',
      scopes: ['gmail.readonly'],
      expiresAt: null,
      token: 'sneaky',
    })
    expect(result.ok).toBe(false)
  })

  it('bounds an event payload', () => {
    const result = validateEventInput({
      connector: 'telegram',
      kind: 'message',
      dedupeKey: 'evt-1',
      payload: { text: 'x'.repeat(20_000) },
    })
    expect(result.ok).toBe(false)
  })
})

describe('base64url', () => {
  it('emits an unpadded URL-safe string', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 62]))
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
  })
})
