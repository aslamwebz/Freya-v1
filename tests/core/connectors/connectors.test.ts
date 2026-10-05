// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import type { CoreCommandResult } from '../../../core/protocol/core-protocol'
import {
  FakeCalendarAdapter,
  FakeDriveAdapter,
  FakeEmailAdapter,
  FakeGitHubAdapter,
  FakeTelegramAdapter,
} from '../../../core/relay/adapters'
import type { ConnectorAuthPort } from '../../../core/connectors/engine'
import type { ConnectorKind } from '../../../core/connectors/types'

/**
 * FOCUSED PHASE 44 TESTS.
 *
 * A Core on a temp journal with deterministic fake adapters, a fake host auth
 * port and a controllable clock. Nothing here touches a network, a real
 * provider or a real secret.
 */

class FakeAuth implements ConnectorAuthPort {
  configured = new Set<ConnectorKind>()
  present = new Set<ConnectorKind>()
  lastBeginScopes: readonly string[] = []

  describe(connector: ConnectorKind): { configured: boolean; tokenPresent: boolean; reason: string | null } {
    if (!this.configured.has(connector)) {
      return { configured: false, tokenPresent: false, reason: 'no client credentials are configured for this connector' }
    }
    return { configured: true, tokenPresent: this.present.has(connector), reason: null }
  }

  async beginAuthorization(input: { connector: ConnectorKind; requestId: string; scopes: readonly string[] }) {
    this.lastBeginScopes = input.scopes
    return { ok: true as const, authorizationUrl: `https://auth.example/${input.connector}?state=fake` }
  }

  async disconnect(connector: ConnectorKind): Promise<void> {
    this.present.delete(connector)
  }
}

interface Fixture {
  core: Core
  dir: string
  journalPath: string
  clock: { now: Date }
  auth: FakeAuth
  email: FakeEmailAdapter
  drive: FakeDriveAdapter
  telegram: FakeTelegramAdapter
}

const fixtures: Fixture[] = []

async function startFixture(options: { configured?: readonly ConnectorKind[] } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-connectors-'))
  const clock = { now: new Date('2026-10-02T09:00:00.000Z') }
  const auth = new FakeAuth()
  for (const connector of options.configured ?? []) auth.configured.add(connector)
  const email = new FakeEmailAdapter()
  const drive = new FakeDriveAdapter()
  const telegram = new FakeTelegramAdapter()
  const core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [],
    now: () => clock.now,
    connectors: { auth },
    relay: {
      adapters: {
        email,
        drive,
        telegram,
        calendar: new FakeCalendarAdapter(),
        github: new FakeGitHubAdapter(),
      },
      allowlistedRepos: ['owner/repo'],
      allowlistedChats: ['chat-1'],
    },
  })
  await core.start()
  const fixture: Fixture = { core, dir, journalPath: join(dir, 'events.jsonl'), clock, auth, email, drive, telegram }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.core.stop('test teardown')
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

function submit(fixture: Fixture, command: string, payload?: unknown): Promise<CoreCommandResult> {
  return fixture.core.handleCommand({
    command: command as never,
    requestId: `test-${Math.random().toString(36).slice(2)}`,
    payload,
  })
}

async function journalText(fixture: Fixture): Promise<string> {
  try {
    return await readFile(fixture.journalPath, 'utf8')
  } catch {
    return ''
  }
}

function connectorState(fixture: Fixture, connector: ConnectorKind): string {
  const view = fixture.core.connectors().connectors.find((entry) => entry.connector === connector)
  return view?.state ?? 'missing'
}

/** Connect and authorize a connector, with the given scopes. */
async function authorize(
  fixture: Fixture,
  connector: ConnectorKind,
  scopes: readonly string[],
  options: { authority?: 'read' | 'write' } = {},
): Promise<void> {
  fixture.auth.configured.add(connector)
  fixture.auth.present.add(connector)
  const connect = await submit(fixture, 'connector.connect.start', {
    connector,
    ...(options.authority === undefined ? {} : { authority: options.authority }),
  })
  expect(connect.ok).toBe(true)
  const complete = await fixture.core.connectorAuthorizationComplete({
    connector,
    accountLabel: `${connector}@example.com`,
    scopes: [...scopes],
    expiresAt: null,
  })
  expect(complete.ok).toBe(true)
}

/* --------------------------------------------------------------- states */

describe('connector states', () => {
  it('reports every connector unconfigured when no client credentials exist', async () => {
    const fixture = await startFixture()
    const projection = fixture.core.connectors()
    expect(projection.health).toBe('ready')
    expect(projection.connectors).toHaveLength(5)
    expect(projection.connectors.every((entry) => entry.state === 'unconfigured')).toBe(true)
  })

  it('reports credentials-missing when configured but not authorized', async () => {
    const fixture = await startFixture({ configured: ['gmail'] })
    expect(connectorState(fixture, 'gmail')).toBe('credentials-missing')
    expect(connectorState(fixture, 'github')).toBe('unconfigured')
  })

  it('reports connected-readonly or connected-readwrite from the granted scopes', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    expect(connectorState(fixture, 'gmail')).toBe('connected-readonly')
    const view = fixture.core.connectors().connectors.find((entry) => entry.connector === 'gmail')
    expect(view?.read).toBe(true)
    expect(view?.write).toBe(false)
  })

  it('reports connected-readwrite when write scopes are granted', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    expect(connectorState(fixture, 'gmail')).toBe('connected-readwrite')
    const view = fixture.core.connectors().connectors.find((entry) => entry.connector === 'gmail')
    expect(view?.write).toBe(true)
  })

  it('reports revoked after disconnect and refuses reads', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const disconnect = await submit(fixture, 'connector.disconnect', { connector: 'gmail' })
    expect(disconnect.ok).toBe(true)
    expect(connectorState(fixture, 'gmail')).toBe('revoked')
    const read = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 10 },
    })
    expect(read.ok).toBe(false)
    expect(read.connectors?.failureCode).toBe('revoked')
  })
})

/* --------------------------------------------------------------- connect */

describe('connector connect', () => {
  it('refuses to connect an unconfigured connector', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'connector.connect.start', { connector: 'gmail' })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('unconfigured')
  })

  it('returns an authorization URL and journals only an id', async () => {
    const fixture = await startFixture({ configured: ['gmail'] })
    const result = await submit(fixture, 'connector.connect.start', { connector: 'gmail', authority: 'read' })
    expect(result.ok).toBe(true)
    expect(result.connectors?.authorizationUrl).toContain('https://auth.example/gmail')
    expect(fixture.auth.lastBeginScopes).toEqual(['gmail.readonly'])
    const journal = await journalText(fixture)
    expect(journal).toContain('connector.connection.requested')
    expect(journal).not.toContain('access_token')
  })

  it('refuses a completion that names an unknown scope', async () => {
    const fixture = await startFixture({ configured: ['gmail'] })
    await submit(fixture, 'connector.connect.start', { connector: 'gmail' })
    const result = await fixture.core.connectorAuthorizationComplete({
      connector: 'gmail',
      accountLabel: 'a@example.com',
      scopes: ['gmail.readonly', 'admin.everything'],
      expiresAt: null,
    })
    expect(result.ok).toBe(false)
    expect(result.failureCode).toBe('scope_missing')
  })

  it('refuses a completion with no pending request', async () => {
    const fixture = await startFixture({ configured: ['gmail'] })
    const result = await fixture.core.connectorAuthorizationComplete({
      connector: 'gmail',
      accountLabel: 'a@example.com',
      scopes: ['gmail.readonly'],
      expiresAt: null,
    })
    expect(result.ok).toBe(false)
    expect(result.failureCode).toBe('invalid_request')
  })
})

/* --------------------------------------------------------- read and write */

describe('read and write separation', () => {
  it('executes a read on a read-only grant', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const result = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 10 },
    })
    expect(result.ok).toBe(true)
    expect(result.connectors?.operation).toBe('read')
    const view = fixture.core.connectors().connectors.find((entry) => entry.connector === 'gmail')
    expect(view?.lastSuccessAt).toBe('2026-10-02T09:00:00.000Z')
  })

  it('refuses a send on a read-only grant before Relay is asked', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const result = await submit(fixture, 'connector.action.execute', {
      connector: 'gmail',
      action: 'gmail.send',
      params: { to: ['a@example.com'], subject: 'Hi', body: 'Body', idempotencyKey: 'k1' },
    })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('read_only')
    expect(fixture.email.sentMessages).toHaveLength(0)
  })

  it('turns a write into a Relay pending approval on a readwrite grant', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    const result = await submit(fixture, 'connector.action.execute', {
      connector: 'gmail',
      action: 'gmail.send',
      params: { to: ['a@example.com'], subject: 'Hi', body: 'Body', idempotencyKey: 'k1' },
    })
    expect(result.ok).toBe(true)
    expect(result.connectors?.operation).toBe('pending')
    expect(result.connectors?.approvalId).toBeTruthy()
    expect(fixture.email.sentMessages).toHaveLength(0)
    const view = fixture.core.connectors().connectors.find((entry) => entry.connector === 'gmail')
    expect(view?.pendingApproval).toBe(true)
  })

  it('refuses connector.read when asked to submit a write action', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    const result = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.send',
      params: { to: ['a@example.com'], subject: 'Hi', body: 'Body', idempotencyKey: 'k1' },
    })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('invalid_request')
  })

  it('refuses a connector/action mismatch', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'telegram', ['telegram.chats.read'])
    const result = await submit(fixture, 'connector.read', {
      connector: 'telegram',
      action: 'gmail.read',
      params: { query: null, limit: 10 },
    })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('invalid_request')
  })
})

/* --------------------------------------------------------------- scopes */

describe('scopes', () => {
  it('refuses a read whose scope the grant does not include', async () => {
    const fixture = await startFixture()
    // A readwrite grant is required for write; a grant carrying only the write
    // scope is refused a read because the read scope is a separate name.
    await authorize(fixture, 'gmail', ['gmail.send'])
    const result = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 10 },
    })
    expect(result.ok).toBe(false)
    expect(result.connectors?.failureCode).toBe('scope_missing')
  })
})

/* ---------------------------------------------------------------- events */

describe('connector events', () => {
  it('refuses an event for a disconnected connector', async () => {
    const fixture = await startFixture({ configured: ['telegram'] })
    const result = await fixture.core.connectorEventIngest({
      connector: 'telegram',
      kind: 'message',
      dedupeKey: 'evt-1',
      payload: { text: 'hello' },
    })
    expect(result.ok).toBe(false)
    expect(result.failureCode).toBe('connection_required')
  })

  it('accepts an authenticated event and rejects a replay', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'telegram', ['telegram.chats.read'])
    const first = await fixture.core.connectorEventIngest({
      connector: 'telegram',
      kind: 'message',
      dedupeKey: 'evt-1',
      payload: { text: 'hello' },
    })
    expect(first.ok).toBe(true)
    const replay = await fixture.core.connectorEventIngest({
      connector: 'telegram',
      kind: 'message',
      dedupeKey: 'evt-1',
      payload: { text: 'hello' },
    })
    expect(replay.ok).toBe(false)
    expect(replay.failureCode).toBe('event_replayed')
    const journal = await journalText(fixture)
    expect(journal).not.toContain('hello')
  })
})

/* --------------------------------------------------------------- STOP ALL */

describe('STOP ALL', () => {
  it('refuses connector actions and events while stopped', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly'])
    const stop = await submit(fixture, 'security.stopAll', { reason: 'test' })
    expect(stop.ok).toBe(true)
    const read = await submit(fixture, 'connector.read', {
      connector: 'gmail',
      action: 'gmail.read',
      params: { query: null, limit: 10 },
    })
    expect(read.ok).toBe(false)
    expect(read.connectors?.failureCode).toBe('stop_all')
    const event = await fixture.core.connectorEventIngest({
      connector: 'gmail',
      kind: 'message',
      dedupeKey: 'evt-stop',
      payload: {},
    })
    expect(event.ok).toBe(false)
    expect(event.failureCode).toBe('stop_all')
  })
})

/* ---------------------------------------------------------- status command */

describe('status command', () => {
  it('refuses a status read that carries fields', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'connector.status.read', { connector: 'gmail' })
    expect(result.ok).toBe(false)
    expect(result.connectors?.reason).toContain('carries no payload')
  })

  it('answers a payloadless status read', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'connector.status.read')
    expect(result.ok).toBe(true)
    expect(result.connectors?.operation).toBe('status')
  })
})

/* ------------------------------------------------------------ no secrets */

describe('no secret projection', () => {
  it('never puts a token-shaped value in the projection or journal', async () => {
    const fixture = await startFixture()
    await authorize(fixture, 'gmail', ['gmail.readonly', 'gmail.send'])
    const serialized = JSON.stringify(fixture.core.connectors())
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('refresh_token')
    expect(serialized).not.toContain('client_secret')
    const journal = await journalText(fixture)
    expect(journal).not.toContain('access_token')
    expect(journal).not.toContain('refresh_token')
  })
})
