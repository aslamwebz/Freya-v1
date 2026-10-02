// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import type { CoreCommandResult } from '../../../core/protocol/core-protocol'
import {
  FakeCalendarAdapter,
  FakeEmailAdapter,
  FakeExternalAdapter,
  FakeGitHubAdapter,
  RelayTransientError,
} from '../../../core/relay/adapters'
import { RelayEngine } from '../../../core/relay/engine'
import type { RelayEmailMessage } from '../../../core/relay/types'
import { RELAY_LIMITS } from '../../../core/relay/types'

/**
 * FOCUSED PHASE 16 TESTS.
 *
 * A Core on a temp journal with deterministic fake adapters and a
 * controllable clock. Nothing here touches a network, a real provider or a
 * real secret. The fakes hold no credentials and make no network calls.
 */

interface Fixture {
  core: Core
  dir: string
  journalPath: string
  clock: { now: Date }
  email: FakeEmailAdapter
  calendar: FakeCalendarAdapter
  github: FakeGitHubAdapter
  external: FakeExternalAdapter
}

const MESSAGES: readonly RelayEmailMessage[] = [
  {
    messageId: 'm1',
    threadId: 't1',
    from: 'alice@example.com',
    to: ['owner@example.com'],
    subject: 'Hello',
    snippet: 'A first message.',
    receivedAt: '2026-10-02T08:00:00.000Z',
    hasAttachments: false,
    attachmentCount: 0,
  },
  {
    messageId: 'm2',
    threadId: 't2',
    from: 'bob@example.com',
    to: ['owner@example.com'],
    subject: 'Second',
    snippet: 'A second message.',
    receivedAt: '2026-10-02T08:05:00.000Z',
    hasAttachments: true,
    attachmentCount: 1,
  },
]

const fixtures: Fixture[] = []

async function startFixture(options: { failTimes?: number } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-relay-'))
  const clock = { now: new Date('2026-10-02T09:00:00.000Z') }
  const email = new FakeEmailAdapter(MESSAGES, options)
  const calendar = new FakeCalendarAdapter([], options)
  const github = new FakeGitHubAdapter([], options)
  const external = new FakeExternalAdapter(options)
  const core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [],
    now: () => clock.now,
    relay: {
      adapters: { email, calendar, github, external: { slack: external } },
      allowlistedRepos: ['owner/allowed-repo'],
    },
  })
  await core.start()
  const fixture: Fixture = {
    core,
    dir,
    journalPath: join(dir, 'events.jsonl'),
    clock,
    email,
    calendar,
    github,
    external,
  }
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

async function journalEvents(fixture: Fixture): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(fixture.journalPath, 'utf8')
    return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/* ---------------------------------------------------------- availability */

describe('connector availability', () => {
  it('reports registered connectors as ready and unregistered as unavailable', async () => {
    const fixture = await startFixture()
    const projection = fixture.core.relay()
    const email = projection.connectors.find((c) => c.connector === 'email')
    const calendar = projection.connectors.find((c) => c.connector === 'calendar')
    const github = projection.connectors.find((c) => c.connector === 'github')
    const external = projection.connectors.find((c) => c.connector === 'external')
    expect(email?.status).toBe('ready')
    expect(calendar?.status).toBe('ready')
    expect(github?.status).toBe('ready')
    expect(external?.status).toBe('ready')
  })

  it('reports unavailable when no relay stack is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-relay-empty-'))
    const core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [] })
    await core.start()
    try {
      const projection = core.relay()
      expect(projection.connectors.every((c) => c.status === 'unavailable')).toBe(true)
    } finally {
      await core.stop('teardown')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an action on a connector with no adapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-relay-partial-'))
    const clock = { now: new Date('2026-10-02T09:00:00.000Z') }
    const email = new FakeEmailAdapter(MESSAGES)
    const core = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [],
      now: () => clock.now,
      relay: { adapters: { email } },
    })
    await core.start()
    try {
      const result = await core.handleCommand({
        command: 'relay.calendar.read',
        requestId: 'test-unavailable',
        payload: {},
      })
      expect(result.ok).toBe(false)
      expect(result.relay?.failureCode).toBe('connector_unavailable')
    } finally {
      await core.stop('teardown')
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ---------------------------------------------------------------- reads */

describe('read actions', () => {
  it('executes a read directly under Guard and budget', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.read', {})
    expect(result.ok).toBe(true)
    expect(result.relay?.operation).toBe('read')
    expect(result.relay?.result?.kind).toBe('email.messages')
  })

  it('filters messages by query', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.read', { query: 'Second' })
    expect(result.ok).toBe(true)
    const messages = result.relay?.result?.kind === 'email.messages' ? result.relay.result.messages : []
    expect(messages).toHaveLength(1)
    expect(messages[0]?.messageId).toBe('m2')
  })

  it('clamps the pagination limit to the code-owned ceiling', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.read', { limit: 10_000 })
    expect(result.ok).toBe(true)
    const messages = result.relay?.result?.kind === 'email.messages' ? result.relay.result.messages : []
    expect(messages.length).toBeLessThanOrEqual(RELAY_LIMITS.maxPaginationLimit)
  })

  it('reads calendar events', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.calendar.read', {})
    expect(result.ok).toBe(true)
    expect(result.relay?.result?.kind).toBe('calendar.events')
  })

  it('reads GitHub issues', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.github.read', { repo: 'owner/allowed-repo' })
    expect(result.ok).toBe(true)
    expect(result.relay?.result?.kind).toBe('github.issues')
  })
})

/* --------------------------------------------------------------- writes */

describe('write actions', () => {
  it('creates a pending approval and does not execute', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    expect(result.relay?.operation).toBe('requested')
    expect(result.relay?.approvalId).toBeDefined()
    expect(fixture.email.sentMessages).toHaveLength(0)
  })

  it('executes after approval', async () => {
    const fixture = await startFixture()
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    expect(approvalId).toBeDefined()
    const decided = await submit(fixture, 'relay.approval.decide', {
      approvalId,
      decision: 'approved',
    })
    expect(decided.ok).toBe(true)
    expect(decided.relay?.operation).toBe('executed')
    expect(fixture.email.sentMessages).toHaveLength(1)
  })

  it('does not execute after denial', async () => {
    const fixture = await startFixture()
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', {
      approvalId,
      decision: 'denied',
    })
    expect(decided.ok).toBe(true)
    expect(decided.relay?.operation).toBe('decided')
    expect(fixture.email.sentMessages).toHaveLength(0)
  })

  it('a draft is never a send', async () => {
    const fixture = await startFixture()
    const requested = await submit(fixture, 'relay.email.draft.create', {
      to: ['alice@example.com'],
      subject: 'Draft',
      body: 'Body',
    })
    expect(requested.ok).toBe(true)
    const approvalId = requested.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(fixture.email.draftList).toHaveLength(1)
    expect(fixture.email.sentMessages).toHaveLength(0)
  })
})

/* ----------------------------------------------------------- idempotency */

describe('idempotency and replay protection', () => {
  it('a replayed send returns the original outcome without re-executing', async () => {
    const fixture = await startFixture()
    const payload = {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }
    const first = await submit(fixture, 'relay.email.send', payload)
    const approvalId = first.relay?.approvalId
    expect(approvalId).toBeDefined()
    // A second request with the same key is a replay: it returns the pending
    // approval rather than creating a second one.
    const second = await submit(fixture, 'relay.email.send', payload)
    expect(second.ok).toBe(true)
    expect(second.relay?.operation).toBe('replayed')
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const replay = await submit(fixture, 'relay.email.send', payload)
    expect(replay.ok).toBe(true)
    expect(replay.relay?.operation).toBe('replayed')
    expect(fixture.email.sentMessages).toHaveLength(1)
  })

  it('a replayed send after approval does not send twice', async () => {
    const fixture = await startFixture()
    const payload = {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }
    const requested = await submit(fixture, 'relay.email.send', payload)
    const approvalId = requested.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    await submit(fixture, 'relay.email.send', payload)
    await submit(fixture, 'relay.email.send', payload)
    expect(fixture.email.sentMessages).toHaveLength(1)
  })

  it('a replayed failed send does not retry', async () => {
    const fixture = await startFixture({ failTimes: 10 })
    const payload = {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }
    const requested = await submit(fixture, 'relay.email.send', payload)
    const approvalId = requested.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    const replay = await submit(fixture, 'relay.email.send', payload)
    expect(replay.ok).toBe(true)
    expect(replay.relay?.operation).toBe('replayed')
  })
})

/* --------------------------------------------------------------- retry */

describe('retry policy', () => {
  it('retries a transient failure a bounded number of times', async () => {
    const fixture = await startFixture({ failTimes: 1 })
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(true)
    expect(fixture.email.sentMessages).toHaveLength(1)
  })

  it('gives up after maxRetries and records the failure', async () => {
    const fixture = await startFixture({ failTimes: 10 })
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    expect(decided.relay?.failureCode).toBe('transient_error')
    const events = await journalEvents(fixture)
    const failed = events.find((e) => e.type === 'relay.action.failed')
    expect(failed?.payload).toMatchObject({ retries: RELAY_LIMITS.maxRetries })
  })

  it('does not retry a non-transient failure', async () => {
    const fixture = await startFixture()
    const engine = (fixture.core as unknown as { relayEngine: RelayEngine }).relayEngine
    // Force a non-transient failure by using an unregistered external connector.
    const result = await submit(fixture, 'relay.external.invoke', {
      connector: 'unregistered',
      operation: 'do-thing',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    expect(decided.relay?.failureCode).toBe('adapter_error')
    const events = await journalEvents(fixture)
    const failed = events.find((e) => e.type === 'relay.action.failed')
    expect(failed?.payload).toMatchObject({ retries: 0 })
    void engine
  })
})

/* --------------------------------------------------------------- budget */

describe('budgets and rate limits', () => {
  it('refuses a send when the send cap is reached', async () => {
    const fixture = await startFixture()
    for (let i = 0; i < RELAY_LIMITS.maxSendsPerWindow; i++) {
      const requested = await submit(fixture, 'relay.email.send', {
        to: ['alice@example.com'],
        subject: 'Hello',
        body: 'Body',
        idempotencyKey: `key-${i}`,
      })
      const approvalId = requested.relay?.approvalId
      await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    }
    const overflow = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-overflow',
    })
    expect(overflow.ok).toBe(false)
    expect(overflow.relay?.failureCode).toBe('budget_exceeded')
  })

  it('refuses an action when the per-connector cap is reached', async () => {
    const fixture = await startFixture()
    for (let i = 0; i < RELAY_LIMITS.maxActionsPerConnectorPerWindow; i++) {
      await submit(fixture, 'relay.email.read', {})
    }
    const overflow = await submit(fixture, 'relay.email.read', {})
    expect(overflow.ok).toBe(false)
    expect(overflow.relay?.failureCode).toBe('budget_exceeded')
  })
})

/* ----------------------------------------------------------- validation */

describe('validation', () => {
  it('refuses an invalid email address', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.send', {
      to: 'not-an-email',
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })

  it('refuses an invalid repo ref', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.github.read', { repo: 'owner/repo/extra' })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })

  it('refuses a repo ref that is a URL', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.github.read', { repo: 'https://github.com/owner/repo' })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })

  it('refuses a write without an idempotency key', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })

  it('refuses an end time before the start time', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.calendar.create', {
      title: 'Meeting',
      startsAt: '2026-10-02T10:00:00.000Z',
      endsAt: '2026-10-02T09:00:00.000Z',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })

  it('refuses an unknown action', async () => {
    const fixture = await startFixture()
    const engine = (fixture.core as unknown as { relayEngine: RelayEngine }).relayEngine
    const result = await engine.execute({ action: 'email.delete', payload: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failureCode).toBe('unknown_action')
    }
  })
})

/* ---------------------------------------------------------- allowlist */

describe('GitHub repo allowlist', () => {
  it('refuses a write to a repo that is not allowlisted', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.github.issue.create', {
      repo: 'owner/other-repo',
      title: 'Issue',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    expect(decided.relay?.failureCode).toBe('adapter_error')
  })

  it('allows a write to an allowlisted repo', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.github.issue.create', {
      repo: 'owner/allowed-repo',
      title: 'Issue',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(true)
    expect(fixture.github.currentIssues).toHaveLength(1)
  })
})

/* -------------------------------------------------------------- privacy */

describe('privacy', () => {
  it('the journal holds no message content', async () => {
    const fixture = await startFixture()
    await submit(fixture, 'relay.email.read', {})
    const events = await journalEvents(fixture)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('A first message.')
    expect(serialized).not.toContain('A second message.')
  })

  it('the journal holds no email body or subject', async () => {
    const fixture = await startFixture()
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Secret subject',
      body: 'Secret body',
      idempotencyKey: 'key-1',
    })
    const events = await journalEvents(fixture)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('Secret subject')
    expect(serialized).not.toContain('Secret body')
  })

  it('the projection holds no content', async () => {
    const fixture = await startFixture()
    const projection = fixture.core.relay()
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('A first message.')
    expect(serialized).not.toContain('Secret')
  })
})

/* ----------------------------------------------------------- STOP ALL */

describe('STOP ALL', () => {
  it('refuses every relay action while stopped', async () => {
    const fixture = await startFixture()
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    const read = await submit(fixture, 'relay.email.read', {})
    expect(read.ok).toBe(false)
    expect(read.relay?.failureCode).toBe('stop_all')
    const write = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(write.ok).toBe(false)
    expect(write.relay?.failureCode).toBe('stop_all')
  })

  it('refuses an approval decision while stopped', async () => {
    const fixture = await startFixture()
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    expect(decided.relay?.failureCode).toBe('stop_all')
    expect(fixture.email.sentMessages).toHaveLength(0)
  })

  it('resumes after the owner clears the latch', async () => {
    const fixture = await startFixture()
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    await submit(fixture, 'security.resume', {})
    const read = await submit(fixture, 'relay.email.read', {})
    expect(read.ok).toBe(true)
  })
})

/* ---------------------------------------------------------- restart */

describe('restart recovery', () => {
  it('cancels a pending approval whose content did not survive', async () => {
    const fixture = await startFixture()
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    expect(approvalId).toBeDefined()
    await fixture.core.stop('restart')

    const core2 = createCore({
      dataPath: fixture.journalPath,
      providers: [],
      now: () => fixture.clock.now,
      relay: {
        adapters: {
          email: fixture.email,
          calendar: fixture.calendar,
          github: fixture.github,
          external: { slack: fixture.external },
        },
        allowlistedRepos: ['owner/allowed-repo'],
      },
    })
    await core2.start()
    try {
      const projection = core2.relay()
      expect(projection.pendingApprovals).toHaveLength(0)
      const decided = await core2.handleCommand({
        command: 'relay.approval.decide',
        requestId: 'test-replay',
        payload: { approvalId, decision: 'approved' },
      })
      expect(decided.ok).toBe(false)
      expect(decided.relay?.failureCode).toBe('approval_unknown')
    } finally {
      await core2.stop('teardown')
    }
  })

  it('replays a completed action after restart without re-executing', async () => {
    const fixture = await startFixture()
    const payload = {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }
    const requested = await submit(fixture, 'relay.email.send', payload)
    const approvalId = requested.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    await fixture.core.stop('restart')

    const email2 = new FakeEmailAdapter(MESSAGES)
    const core2 = createCore({
      dataPath: fixture.journalPath,
      providers: [],
      now: () => fixture.clock.now,
      relay: {
        adapters: {
          email: email2,
          calendar: fixture.calendar,
          github: fixture.github,
          external: { slack: fixture.external },
        },
        allowlistedRepos: ['owner/allowed-repo'],
      },
    })
    await core2.start()
    try {
      const replay = await core2.handleCommand({
        command: 'relay.email.send',
        requestId: 'test-replay',
        payload,
      })
      expect(replay.ok).toBe(true)
      expect(replay.relay?.operation).toBe('replayed')
      expect(email2.sentMessages).toHaveLength(0)
    } finally {
      await core2.stop('teardown')
    }
  })
})

/* ------------------------------------------------------- invite safety */

describe('calendar invite safety', () => {
  it('passes exactly the supplied attendees to the adapter', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.calendar.create', {
      title: 'Meeting',
      startsAt: '2026-10-02T10:00:00.000Z',
      endsAt: '2026-10-02T11:00:00.000Z',
      attendees: ['alice@example.com', 'bob@example.com'],
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(fixture.calendar.currentEvents).toHaveLength(1)
    expect(fixture.calendar.currentEvents[0]?.attendeeCount).toBe(2)
  })
})

/* ----------------------------------------------------- recipient safety */

describe('email recipient safety', () => {
  it('passes exactly the supplied recipients to the adapter', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      cc: ['bob@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(fixture.email.sentMessages).toHaveLength(1)
    const sent = fixture.email.sentMessages[0]
    expect(sent?.to.map((r) => r.address)).toEqual(['alice@example.com'])
    expect(sent?.cc.map((r) => r.address)).toEqual(['bob@example.com'])
  })

  it('deduplicates repeated recipients', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com', 'alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const sent = fixture.email.sentMessages[0]
    expect(sent?.to.map((r) => r.address)).toEqual(['alice@example.com'])
  })
})

/* ------------------------------------------------------- external */

describe('external connectors', () => {
  it('invokes a registered external connector after approval', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.external.invoke', {
      connector: 'slack',
      operation: 'post-message',
      params: ['general'],
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(true)
    expect(fixture.external.received).toHaveLength(1)
  })

  it('refuses an unregistered external connector', async () => {
    const fixture = await startFixture()
    const result = await submit(fixture, 'relay.external.invoke', {
      connector: 'unregistered',
      operation: 'do-thing',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    expect(decided.relay?.failureCode).toBe('adapter_error')
  })
})

/* ------------------------------------------------------- capabilities */

describe('capability boundaries', () => {
  it('read access does not imply write access', async () => {
    const fixture = await startFixture()
    // The read capability and the write capability are different names in the
    // closed vocabulary. A principal holding only the read capability is
    // refused by Guard before the engine is reached.
    const { DefaultGuard } = await import('../../../core/security/guard')
    const guard = new DefaultGuard()
    const reader = { id: 'owner', capabilities: new Set(['relay.email.read']), trusted: true }
    const readDecision = guard.evaluate(reader, 'relay.email.read')
    expect(readDecision.allowed).toBe(true)
    const writeDecision = guard.evaluate(reader, 'relay.email.send')
    expect(writeDecision.allowed).toBe(false)
    if (!writeDecision.allowed) {
      expect(writeDecision.reason).toBe('principal does not hold the capability')
    }
  })

  it('a worker holds no relay capability', async () => {
    const { WORKER_CAPABILITIES } = await import('../../../core/protocol/core-protocol')
    for (const capability of WORKER_CAPABILITIES) {
      expect(capability.startsWith('relay.')).toBe(false)
    }
  })
})
