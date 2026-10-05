// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSecureTokenStore, type SecureStorageLike } from '../../electron/connectors/token-store'
import { ConnectorOAuthCoordinator, type OAuthClient, type OAuthProviderConfig } from '../../electron/connectors/oauth'
import { fetchJson, type FetchLike } from '../../electron/connectors/http'
import { createConnectorRuntime } from '../../electron/connectors/runtime'
import { RelayAdapterError, RelayTransientError } from '../../core/relay/adapters'
import type { ConnectorTokenRecord } from '../../core/connectors/token-store'

const SECRET_ACCESS = 'FREYA_CONNECTOR_SECRET_ACCESS'
const SECRET_REFRESH = 'FREYA_CONNECTOR_SECRET_REFRESH'

function fakeSafeStorage(available = true): SecureStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('cannot decrypt')
      return text.slice(4)
    },
  }
}

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-connectors-host-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('secure token store', () => {
  it('round-trips an encrypted record and clears it', async () => {
    const path = join(dir, 'connectors.tokens')
    const store = createSecureTokenStore({ safeStorage: fakeSafeStorage(), filePath: path })
    expect(store.kind).toBe('secure')
    const record: ConnectorTokenRecord = {
      connector: 'gmail',
      accountLabel: 'a@example.com',
      scopes: ['gmail.readonly'],
      accessToken: SECRET_ACCESS,
      refreshToken: SECRET_REFRESH,
      expiresAt: null,
      storedAt: '2026-10-02T09:00:00.000Z',
    }
    await store.save(record)
    expect((await store.load('gmail'))?.accessToken).toBe(SECRET_ACCESS)
    // The file on disk must not contain the token in clear.
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(SECRET_ACCESS)
    await store.clear('gmail')
    expect(await store.load('gmail')).toBeNull()
  })

  it('is fail-closed when no secure storage is available', async () => {
    const store = createSecureTokenStore({ safeStorage: fakeSafeStorage(false), filePath: join(dir, 'none.tokens') })
    expect(store.kind).toBe('unavailable')
    await expect(
      store.save({
        connector: 'gmail',
        accountLabel: 'a@example.com',
        scopes: [],
        accessToken: SECRET_ACCESS,
        refreshToken: null,
        expiresAt: null,
        storedAt: '2026-10-02T09:00:00.000Z',
      }),
    ).rejects.toThrow()
  })
})

function providerConfig(): OAuthProviderConfig {
  return {
    connector: 'gmail',
    authorizationEndpoint: 'https://accounts.example/auth',
    tokenEndpoint: 'https://oauth.example/token',
    clientId: 'client-1',
    clientSecret: null,
    redirectUri: 'https://localhost/callback',
  }
}

function fakeOAuthClient(): OAuthClient & { exchangeCalls: number; refreshCalls: number } {
  const client = {
    exchangeCalls: 0,
    refreshCalls: 0,
    async exchange() {
      client.exchangeCalls += 1
      return { accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresInSeconds: 3600, accountLabel: 'a@example.com', scopes: ['gmail.readonly'] }
    },
    async refresh() {
      client.refreshCalls += 1
      return { accessToken: 'refreshed', refreshToken: SECRET_REFRESH, expiresInSeconds: 3600, accountLabel: 'a@example.com', scopes: ['gmail.readonly'] }
    },
  }
  return client
}

describe('oauth coordinator', () => {
  it('builds a PKCE authorization URL and completes a matching callback', async () => {
    const store = createSecureTokenStore({ safeStorage: fakeSafeStorage(), filePath: join(dir, 'tokens') })
    const client = fakeOAuthClient()
    const coordinator = new ConnectorOAuthCoordinator({
      tokenStore: store,
      client,
      configs: { gmail: providerConfig() },
      now: () => new Date('2026-10-02T09:00:00.000Z'),
    })
    const begin = coordinator.begin('gmail', 'req-1', ['gmail.readonly'])
    expect(begin.ok).toBe(true)
    if (!begin.ok) return
    const url = new URL(begin.authorizationUrl)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBeTruthy()
    const state = url.searchParams.get('state') ?? ''
    const result = await coordinator.complete({ connector: 'gmail', callback: { state, code: 'code-1' } })
    expect(result.ok).toBe(true)
    expect(coordinator.tokenPresent('gmail')).toBe(true)
    expect(client.exchangeCalls).toBe(1)
  })

  it('refuses a callback whose state does not match', async () => {
    const store = createSecureTokenStore({ safeStorage: fakeSafeStorage(), filePath: join(dir, 'tokens') })
    const coordinator = new ConnectorOAuthCoordinator({
      tokenStore: store,
      client: fakeOAuthClient(),
      configs: { gmail: providerConfig() },
      now: () => new Date('2026-10-02T09:00:00.000Z'),
    })
    coordinator.begin('gmail', 'req-1', ['gmail.readonly'])
    const result = await coordinator.complete({ connector: 'gmail', callback: { state: 'forged', code: 'code-1' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failureCode).toBe('cross_account')
  })

  it('serializes concurrent refreshes', async () => {
    const store = createSecureTokenStore({ safeStorage: fakeSafeStorage(), filePath: join(dir, 'tokens') })
    const client = fakeOAuthClient()
    const coordinator = new ConnectorOAuthCoordinator({
      tokenStore: store,
      client,
      configs: { gmail: providerConfig() },
      now: () => new Date('2026-10-02T09:00:00.000Z'),
    })
    await store.save({
      connector: 'gmail',
      accountLabel: 'a@example.com',
      scopes: ['gmail.readonly'],
      accessToken: 'old',
      refreshToken: SECRET_REFRESH,
      expiresAt: null,
      storedAt: '2026-10-02T09:00:00.000Z',
    })
    const [first, second] = await Promise.all([coordinator.refresh('gmail'), coordinator.refresh('gmail')])
    expect(first?.accessToken).toBe('refreshed')
    expect(second?.accessToken).toBe('refreshed')
    expect(client.refreshCalls).toBe(1)
  })
})

describe('bounded http', () => {
  it('refuses a host outside the allowlist and a non-https URL', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike
    await expect(
      fetchJson(fetchImpl, { url: 'https://evil.example/x', method: 'GET', token: 't', allowedHosts: ['api.github.com'] }),
    ).rejects.toBeInstanceOf(RelayAdapterError)
    await expect(
      fetchJson(fetchImpl, { url: 'http://api.github.com/x', method: 'GET', token: 't', allowedHosts: ['api.github.com'] }),
    ).rejects.toBeInstanceOf(RelayAdapterError)
  })

  it('treats a 429 as transient and an oversized body as a refusal', async () => {
    const rateLimited = (async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '' })) as unknown as FetchLike
    await expect(
      fetchJson(rateLimited, { url: 'https://api.github.com/x', method: 'GET', token: 't', allowedHosts: ['api.github.com'] }),
    ).rejects.toBeInstanceOf(RelayTransientError)
    const oversized = (async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'x'.repeat(1_100_000) })) as unknown as FetchLike
    await expect(
      fetchJson(oversized, { url: 'https://api.github.com/x', method: 'GET', token: 't', allowedHosts: ['api.github.com'] }),
    ).rejects.toBeInstanceOf(RelayAdapterError)
  })
})

describe('connector runtime', () => {
  it('reports unconfigured with no provider configs and registers adapters', async () => {
    const runtime = await createConnectorRuntime({
      safeStorage: fakeSafeStorage(),
      tokenFilePath: join(dir, 'tokens'),
      configs: {},
      oauthClient: fakeOAuthClient(),
      fetchImpl: vi.fn() as unknown as FetchLike,
    })
    expect(runtime.storeKind).toBe('secure')
    expect(runtime.auth.describe('gmail').configured).toBe(false)
    expect(runtime.adapters.email).toBeDefined()
    expect(runtime.adapters.drive).toBeDefined()
    expect(runtime.adapters.telegram).toBeDefined()
  })

  it('refuses to begin an authorization when no secure store exists', async () => {
    const runtime = await createConnectorRuntime({
      safeStorage: fakeSafeStorage(false),
      tokenFilePath: join(dir, 'tokens'),
      configs: { gmail: providerConfig() },
      oauthClient: fakeOAuthClient(),
      fetchImpl: vi.fn() as unknown as FetchLike,
    })
    expect(runtime.storeKind).toBe('unavailable')
    const begun = await runtime.auth.beginAuthorization({ connector: 'gmail', requestId: 'r', scopes: ['gmail.readonly'] })
    expect(begun.ok).toBe(false)
  })
})
