// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import type { CoreCommandResult } from '../../../core/protocol/core-protocol'
import { FakeEmailAdapter, FakeTelegramAdapter } from '../../../core/relay/adapters'
import type { ConnectorAuthPort } from '../../../core/connectors/engine'
import type { ConnectorKind } from '../../../core/connectors/types'
import type { RelayEmailMessage } from '../../../core/relay/types'

/**
 * CONNECTOR RED-TEAM.
 *
 * The attacks: forged connection state, token/secret leakage, scope escalation,
 * read-for-write, stale revocation, event replay, approval bypass and a
 * fabricated success. The sentinels are unmistakable fake markers.
 */

const SENTINELS = ['FREYA_CONNECTOR_SECRET_ACCESS', 'FREYA_CONNECTOR_SECRET_REFRESH', 'FREYA_CONNECTOR_TOKEN_9F'] as const

class FakeAuth implements ConnectorAuthPort {
  configured = new Set<ConnectorKind>()
  present = new Set<ConnectorKind>()
  describe(connector: ConnectorKind) {
    if (!this.configured.has(connector)) {
      return { configured: false, tokenPresent: false, reason: 'no client credentials are configured for this connector' }
    }
    return { configured: true, tokenPresent: this.present.has(connector), reason: null }
  }
  async beginAuthorization(input: { connector: ConnectorKind; requestId: string; scopes: readonly string[] }) {
    return { ok: true as const, authorizationUrl: `https://auth.example/${input.connector}` }
  }
  async disconnect(connector: ConnectorKind): Promise<void> {
    this.present.delete(connector)
  }
}

interface Fixture {
  core: Core
  dir: string
  journalPath: string
  auth: FakeAuth
  email: FakeEmailAdapter
  telegram: FakeTelegramAdapter
}

const fixtures: Fixture[] = []

function messages(count: number): readonly RelayEmailMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `m${index}`,
    threadId: null,
    from: 'a@example.com',
    to: ['owner@example.com'],
    subject: `Message ${index}`,
    snippet: 'snippet',
    receivedAt: '2026-10-02T08:00:00.000Z',
    hasAttachments: false,
    attachmentCount: 0,
  }))
}

async function start(configured: readonly ConnectorKind[] = []): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-connector-redteam-'))
  const auth = new FakeAuth()
  for (const connector of configured) auth.configured.add(connector)
  const email = new FakeEmailAdapter(messages(150))
  const telegram = new FakeTelegramAdapter()
  const core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [],
    now: () => new Date('2026-10-02T09:00:00.000Z'),
    connectors: { auth },
    relay: { adapters: { email, telegram }, allowlistedChats: ['chat-1'] },
  })
  await core.start()
  const fixture = { core, dir, journalPath: join(dir, 'events.jsonl'), auth, email, telegram }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.core.stop('teardown')
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

function submit(fixture: Fixture, command: string, payload?: unknown): Promise<CoreCommandResult> {
  return fixture.core.handleCommand({ command: command as never, requestId: `rt-${Math.random()}`, payload })
}

async function journal(fixture: Fixture): Promise<string> {
  try {
    return await readFile(fixture.journalPath, 'utf8')
  } catch {
    return ''
  }
}

async function authorize(fixture: Fixture, connector: ConnectorKind, scopes: readonly string[]): Promise<void> {
  fixture.auth.configured.add(connector)
  fixture.auth.present.add(connector)
  await submit(fixture, 'connector.connect.start', { connector })
  await fixture.core.connectorAuthorizationComplete({ connector, accountLabel: 'a@example.com', scopes: [...scopes], expiresAt: null })
}

/* ------------------------------------------------------ forged state */

describe('forged connection state', () => {
  it('a renderer cannot register or authorize a connector by command', async () => {
    const fixture = await start()
    for (const command of ['connector.register', 'connector.authorize', 'connector.event.ingest', 'connector.scope.grant']) {
      const result = await submit(fixture, command, { connector: 'gmail' })
      expect(result.ok).toBe(false)
    }
  })

  it('a connect request cannot smuggle a token or a scope', async () => {
    const fixture = await start(['gmail'])
    const result = await submit(fixture, 'connector.connect.start', {
      connector: 'gmail',
      token: SENTINELS[0],
      scopes: ['admin'],
    })
    expect(result.ok).toBe(false)
    expect(await journal(fixture)).not.toContain(SENTINELS[0])
  })

  it('an authorization completion cannot name a scope the build does not know', async () => {
    const fixture = await start(['gmail'])
    await submit(fixture, 'connector.connect.start', { connector: 'gmail' })
    const result = await fixture.core.connectorAuthorizationComplete({
      connector: 'gmail',
      accountLabel: 'a@example.com',
      scopes: ['gmail.readonly', 'https://www.googleapis.com/auth/drive'],
      expiresAt: null,
    })
    expect(result.ok).toBe(false)
    expect(result.failureCode).toBe('scope_missing')
  })
})

/* ---------------------------------------------------------- secrets */

describe('secret leakage', () => {
  it('no sentinel reaches the projection or the journal', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    const serialized = JSON.stringify(fixture.core.connectors())
    for (const sentinel of SENTINELS) {
      expect(serialized).not.toContain(sentinel)
      expect(await journal(fixture)).not.toContain(sentinel)
    }
  })

  it('the projection carries no token or credential field', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const serialized = JSON.stringify(fixture.core.connectors())
    expect(serialized).not.toContain('accessToken')
    expect(serialized).not.toContain('refreshToken')
    expect(serialized).not.toContain('clientSecret')
    expect(serialized).not.toContain('authorization')
  })
})

/* ------------------------------------------------------ authority */

describe('read, write and destructive authority', () => {
  it('a read-only grant cannot send', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const result = await submit(fixture, 'connector.action.execute', {
      connector: 'gmail',
      action: 'gmail.send',
      params: { to: ['a@example.com'], subject: 's', body: 'b', idempotencyKey: 'k' },
    })
    expect(result.ok).toBe(false)
    expect(fixture.email.sentMessages).toHaveLength(0)
  })

  it('a write still requires approval, and a denial prevents the send', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    const request = await submit(fixture, 'connector.action.execute', {
      connector: 'gmail',
      action: 'gmail.send',
      params: { to: ['a@example.com'], subject: 's', body: 'b', idempotencyKey: 'k' },
    })
    const approvalId = request.connectors?.approvalId
    expect(approvalId).toBeTruthy()
    const denied = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'denied' })
    expect(denied.ok).toBe(true)
    expect(fixture.email.sentMessages).toHaveLength(0)
  })

  it('replaying an idempotency key does not execute twice', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    const payload = {
      connector: 'gmail',
      action: 'gmail.send',
      params: { to: ['a@example.com'], subject: 's', body: 'b', idempotencyKey: 'same-key' },
    }
    const first = await submit(fixture, 'connector.action.execute', payload)
    const second = await submit(fixture, 'connector.action.execute', payload)
    expect(first.connectors?.operation).toBe('pending')
    expect(second.connectors?.operation).toBe('replayed')
  })
})

/* ------------------------------------------------------- revocation */

describe('revocation is immediate', () => {
  it('a read after disconnect is refused', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    await submit(fixture, 'connector.disconnect', { connector: 'gmail' })
    const result = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 5 },
    })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('revoked')
  })
})

/* ---------------------------------------------------------- events */

describe('events', () => {
  it('a malformed event is refused and a replay is denied', async () => {
    const fixture = await start(['telegram'])
    await authorize(fixture, 'telegram', ['telegram.chats.read'])
    const malformed = await fixture.core.connectorEventIngest({ connector: 'telegram', kind: '', dedupeKey: 'k' })
    expect(malformed.ok).toBe(false)
    const first = await fixture.core.connectorEventIngest({ connector: 'telegram', kind: 'message', dedupeKey: 'd1', payload: { text: 'x' } })
    expect(first.ok).toBe(true)
    const replay = await fixture.core.connectorEventIngest({ connector: 'telegram', kind: 'message', dedupeKey: 'd1', payload: { text: 'x' } })
    expect(replay.ok).toBe(false)
    expect(replay.failureCode).toBe('event_replayed')
  })
})

/* ---------------------------------------------------------- STOP ALL */

describe('STOP ALL', () => {
  it('refuses a read while stopped and allows it after resume', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    await submit(fixture, 'security.stopAll', { reason: 'rt' })
    const stopped = await submit(fixture, 'connector.read', { connector: 'gmail', action: 'gmail.read', params: { query: null, limit: 5 } })
    expect(stopped.ok).toBe(false)
    await submit(fixture, 'security.resume', { reason: 'rt' })
    const resumed = await submit(fixture, 'connector.read', { connector: 'gmail', action: 'gmail.read', params: { query: null, limit: 5 } })
    expect(resumed.ok).toBe(true)
  })
})

/* ---------------------------------------------------------- bounds */

describe('bounds', () => {
  it('clamps a huge pagination limit', async () => {
    const fixture = await start(['gmail'])
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const result = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 1_000_000 },
    })
    expect(result.ok).toBe(true)
    const read = result.connectors?.result as { kind: string; messages?: unknown[] }
    expect(read.kind).toBe('email.messages')
    expect((read.messages ?? []).length).toBeLessThanOrEqual(100)
  })

  it('refuses a read on an unconfigured connector rather than fabricating success', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 5 },
    })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('unconfigured')
  })
})
