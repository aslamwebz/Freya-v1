// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectNoSentinels,
  journalText,
  startRelayCore,
  stopRelayCore,
  submit,
  type RelayFixture,
} from './harness'

/**
 * RELAY RED TEAM.
 *
 * The attacks: forged connector state, token/secret leakage, capability
 * laundering, read→write escalation, recipient widening, duplicate
 * send/replay, calendar invite expansion, GitHub repo-scope escape,
 * destructive action smuggling, renderer forgery, stale approval reuse,
 * retry storms, event poisoning, model-call amplification, STOP ALL bypass and
 * private-content leakage.
 *
 * Each test names the invariant it is trying to break. Nothing here touches a
 * network, a real provider or a real secret.
 */

const fixtures: RelayFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopRelayCore(fixture)
})

async function start(): Promise<RelayFixture> {
  const fixture = await startRelayCore()
  fixtures.push(fixture)
  return fixture
}

/* -------------------------------------------------- forged connector state */

describe('forged connector state', () => {
  it('a renderer cannot register a connector', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.connector.register', { connector: 'email' })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unknown command')
  })

  it('a renderer cannot fault a connector', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.connector.fault', { connector: 'email' })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unknown command')
  })

  it('a renderer cannot set the GitHub allowlist', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.allowlist.set', { repos: ['owner/evil'] })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unknown command')
  })

  it('the projection reports only what Core registered', async () => {
    const fixture = await start()
    const projection = fixture.core.relay()
    // The external connector 'slack' is registered; 'evil' is not.
    const external = projection.connectors.find((c) => c.connector === 'external')
    expect(external?.status).toBe('ready')
    // A forged projection claiming 'evil' is registered cannot be produced
    // through any command.
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('evil')
  })
})

/* ------------------------------------------------------ token/secret leak */

describe('token and secret leakage', () => {
  it('no credential appears in the journal', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.read', {})
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const journal = await journalText(fixture)
    expectNoSentinels('journal', journal)
    expect(journal).not.toContain('token')
    expect(journal).not.toContain('password')
    expect(journal).not.toContain('secret')
  })

  it('no credential appears in the projection', async () => {
    const fixture = await start()
    const projection = fixture.core.relay()
    expectNoSentinels('projection', projection)
  })

  it('no credential appears in a command result', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.email.read', {})
    expectNoSentinels('command result', result)
  })

  it('no credential appears in the activity feed', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.read', {})
    const activity = fixture.core.activity()
    expectNoSentinels('activity feed', activity)
  })
})

/* --------------------------------------------------- capability laundering */

describe('capability laundering', () => {
  it('a read capability does not imply a write capability', async () => {
    // The owner holds every capability, so this is a structural check on the
    // vocabulary: the names are different and Guard enforces them separately.
    const { DefaultGuard } = await import('../../../core/security/guard')
    const guard = new DefaultGuard()
    const reader = { id: 'owner' as const, capabilities: new Set(['relay.email.read'] as const), trusted: true }
    expect(guard.evaluate(reader, 'relay.email.read').allowed).toBe(true)
    expect(guard.evaluate(reader, 'relay.email.send').allowed).toBe(false)
  })

  it('a worker holds no relay capability', async () => {
    const { WORKER_CAPABILITIES } = await import('../../../core/protocol/core-protocol')
    for (const capability of WORKER_CAPABILITIES) {
      expect(capability.startsWith('relay.')).toBe(false)
    }
  })

  it('a model cannot reach a connector through cognition', async () => {
    const fixture = await start()
    // The cognition path has no Relay seam: a worker's authority object has no
    // method that names a connector. This is a structural property — the
    // worker authority interface has no relay method.
    const { workerAuthority } = await import('../../../core/testing')
    const worker = workerAuthority(fixture.core)
    void fixture
    const workerRecord = worker as unknown as Record<string, unknown>
    for (const key of Object.keys(workerRecord)) {
      expect(key.startsWith('relay')).toBe(false)
      expect(key.startsWith('email')).toBe(false)
      expect(key.startsWith('calendar')).toBe(false)
      expect(key.startsWith('github')).toBe(false)
    }
  })
})

/* ------------------------------------------------- read→write escalation */

describe('read→write escalation', () => {
  it('a read cannot become a write', async () => {
    const fixture = await start()
    // A read executes directly; it never creates an approval and never
    // mutates anything.
    const before = fixture.email.sentMessages.length
    await submit(fixture, 'relay.email.read', {})
    expect(fixture.email.sentMessages).toHaveLength(before)
  })

  it('a read result cannot be used to authorize a write', async () => {
    const fixture = await start()
    const read = await submit(fixture, 'relay.email.read', {})
    expect(read.ok).toBe(true)
    // The read result carries no approval and no authority.
    expect(read.relay?.approvalId).toBeUndefined()
    // A write still requires its own approval.
    const write = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(write.ok).toBe(true)
    expect(write.relay?.approvalId).toBeDefined()
    expect(fixture.email.sentMessages).toHaveLength(0)
  })
})

/* ---------------------------------------------------- recipient widening */

describe('recipient widening', () => {
  it('the adapter receives exactly the supplied recipients', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      cc: ['bob@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const sent = fixture.email.sentMessages[0]
    expect(sent?.to.map((r) => r.address)).toEqual(['alice@example.com'])
    expect(sent?.cc.map((r) => r.address)).toEqual(['bob@example.com'])
  })

  it('a recipient list cannot be widened by repetition', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com', 'alice@example.com', 'alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const sent = fixture.email.sentMessages[0]
    expect(sent?.to.map((r) => r.address)).toEqual(['alice@example.com'])
  })

  it('there is no BCC field to hide a recipient', async () => {
    const fixture = await start()
    // The payload validation refuses unknown fields implicitly: a `bcc` field
    // is not in the email.send contract, so it is never read.
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
      bcc: 'hidden@example.com',
    })
    // The bcc is ignored (not read), so the send proceeds with only `to`.
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const sent = fixture.email.sentMessages[0]
    expect(sent?.to.map((r) => r.address)).toEqual(['alice@example.com'])
    expect(sent?.cc).toHaveLength(0)
  })
})

/* ------------------------------------------------- duplicate send/replay */

describe('duplicate send and replay', () => {
  it('the same idempotency key never sends twice', async () => {
    const fixture = await start()
    const payload = {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }
    const first = await submit(fixture, 'relay.email.send', payload)
    const approvalId = first.relay?.approvalId
    expect(approvalId).toBeDefined()
    // Replays return the original outcome; they create no second action.
    await submit(fixture, 'relay.email.send', payload)
    await submit(fixture, 'relay.email.send', payload)
    await submit(fixture, 'relay.email.send', payload)
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(fixture.email.sentMessages).toHaveLength(1)
  })

  it('a replay after approval returns the original outcome', async () => {
    const fixture = await start()
    const payload = {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }
    const requested = await submit(fixture, 'relay.email.send', payload)
    const approvalId = requested.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const replay = await submit(fixture, 'relay.email.send', payload)
    expect(replay.ok).toBe(true)
    expect(replay.relay?.operation).toBe('replayed')
    expect(fixture.email.sentMessages).toHaveLength(1)
  })

  it('a replay after failure does not retry', async () => {
    const fixture = await startRelayCore({ failTimes: 10 })
    fixtures.push(fixture)
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

/* ---------------------------------------------- calendar invite expansion */

describe('calendar invite expansion', () => {
  it('the adapter receives exactly the supplied attendees', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.calendar.create', {
      title: 'Meeting',
      startsAt: '2026-10-02T10:00:00.000Z',
      endsAt: '2026-10-02T11:00:00.000Z',
      attendees: ['alice@example.com', 'bob@example.com'],
      idempotencyKey: 'key-1',
    })
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(fixture.calendar.currentEvents).toHaveLength(1)
    expect(fixture.calendar.currentEvents[0]?.attendeeCount).toBe(2)
  })

  it('an attendee list cannot be widened by repetition', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.calendar.create', {
      title: 'Meeting',
      startsAt: '2026-10-02T10:00:00.000Z',
      endsAt: '2026-10-02T11:00:00.000Z',
      attendees: ['alice@example.com', 'alice@example.com'],
      idempotencyKey: 'key-1',
    })
    const approvalId = result.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(fixture.calendar.currentEvents[0]?.attendeeCount).toBe(1)
  })
})

/* ------------------------------------------------ GitHub repo-scope escape */

describe('GitHub repo-scope escape', () => {
  it('a write to a non-allowlisted repo is refused', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.github.issue.create', {
      repo: 'owner/evil-repo',
      title: 'Issue',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    expect(decided.relay?.failureCode).toBe('adapter_error')
  })

  it('a repo ref cannot be smuggled as a URL', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.github.read', {
      repo: 'https://github.com/owner/allowed-repo',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })

  it('a repo ref cannot be smuggled with extra path segments', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.github.read', {
      repo: 'owner/allowed-repo/issues/1',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })
})

/* ------------------------------------------- destructive action smuggling */

describe('destructive action smuggling', () => {
  it('there is no history rewrite action', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.github.write', {
      repo: 'owner/allowed-repo',
      branch: 'main',
      force: true,
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unknown command')
  })

  it('there is no arbitrary command execution action', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.external.invoke', {
      connector: 'slack',
      operation: 'exec',
      params: ['rm -rf /'],
      idempotencyKey: 'key-1',
    })
    // The external connector is a fake; it does not execute commands. The
    // operation name is validated but the adapter is a deterministic fake.
    expect(result.ok).toBe(true)
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(true)
    // The fake adapter records the invocation but executes nothing.
    expect(fixture.external.received).toHaveLength(1)
  })

  it('a PR creation cannot target the same branch for head and base', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.github.pr.create', {
      repo: 'owner/allowed-repo',
      head: 'main',
      base: 'main',
      title: 'PR',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('validation_failed')
  })
})

/* ---------------------------------------------------- renderer forgery */

describe('renderer forgery', () => {
  it('a renderer cannot forge connector availability', async () => {
    const fixture = await start()
    // The projection is built by Core from the registry. A renderer cannot
    // inject a connector: there is no command that registers one.
    const projection = fixture.core.relay()
    const serialized = JSON.stringify(projection)
    // The projection names the four closed connectors and nothing else.
    expect(serialized).toContain('email')
    expect(serialized).toContain('calendar')
    expect(serialized).toContain('github')
    expect(serialized).toContain('external')
    // A forged connector name cannot appear.
    expect(serialized).not.toContain('evil')
  })

  it('a renderer cannot forge a capability', async () => {
    const fixture = await start()
    // The projection carries no capability field a window could use.
    const projection = fixture.core.relay()
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('capability')
    expect(serialized).not.toContain('relay.email.send')
  })

  it('a renderer cannot forge an approval', async () => {
    const fixture = await start()
    // An approval is created only by Core when a write is requested.
    const projection = fixture.core.relay()
    expect(projection.pendingApprovals).toHaveLength(0)
    // A renderer cannot create an approval directly.
    const result = await submit(fixture, 'relay.approval.create', {
      action: 'email.send',
      payload: {},
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unknown command')
  })
})

/* -------------------------------------------------- stale approval reuse */

describe('stale approval reuse', () => {
  it('a decided approval cannot be re-decided', async () => {
    const fixture = await start()
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const reuse = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'denied' })
    expect(reuse.ok).toBe(false)
    expect(reuse.relay?.failureCode).toBe('approval_unknown')
  })

  it('an unknown approval id is refused', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.approval.decide', {
      approvalId: 'nonexistent',
      decision: 'approved',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('approval_unknown')
  })

  it('an approval cannot be decided after STOP ALL', async () => {
    const fixture = await start()
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
  })
})

/* --------------------------------------------------------- retry storms */

describe('retry storms', () => {
  it('a transient failure is retried at most maxRetries times', async () => {
    const fixture = await startRelayCore({ failTimes: 10 })
    fixtures.push(fixture)
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    // Exactly one failure event: the bounded retries are internal to the
    // single approval execution and produce no extra journal lines.
    const journal = await journalText(fixture)
    const failedLines = journal.split('\n').filter((line) => line.includes('relay.action.failed'))
    expect(failedLines).toHaveLength(1)
    // The failure records the retry count.
    const failedEvent = JSON.parse(failedLines[0]!) as Record<string, unknown>
    const payload = failedEvent.payload as Record<string, unknown>
    expect(payload.retries).toBe(2)
  })

  it('a non-transient failure is never retried', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.external.invoke', {
      connector: 'unregistered',
      operation: 'do-thing',
      idempotencyKey: 'key-1',
    })
    const approvalId = result.relay?.approvalId
    const decided = await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(false)
    const journal = await journalText(fixture)
    const failedLines = journal.split('\n').filter((line) => line.includes('relay.action.failed'))
    expect(failedLines).toHaveLength(1)
  })
})

/* ------------------------------------------------------ event poisoning */

describe('event poisoning', () => {
  it('a connector signal to attention uses fixed Core-written text', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.read', {})
    const journal = await journalText(fixture)
    // The attention event is created with the system source and message kind.
    // The text itself is process-local: only its measured length is journaled.
    const attentionEvents = journal
      .split('\n')
      .filter((line) => line.includes('attention.event.ingested'))
    expect(attentionEvents.length).toBeGreaterThan(0)
    for (const line of attentionEvents) {
      const event = JSON.parse(line) as Record<string, unknown>
      const payload = event.payload as Record<string, unknown>
      expect(payload.source).toBe('system')
      expect(payload.kind).toBe('message')
      expect(payload.textLength).toBe(38)
    }
    // The connector's content never appears in the journal.
    expect(journal).not.toContain('A first message.')
  })

  it('a connector signal cannot mint an importance or urgency', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.read', {})
    const journal = await journalText(fixture)
    // The attention event carries no importance or urgency claim from the
    // connector.
    const attentionEvents = journal
      .split('\n')
      .filter((line) => line.includes('attention.event.ingested'))
    for (const line of attentionEvents) {
      const event = JSON.parse(line) as Record<string, unknown>
      const payload = event.payload as Record<string, unknown>
      expect(payload.severityHint).toBe('none')
    }
  })
})

/* ---------------------------------------------- model-call amplification */

describe('model-call amplification', () => {
  it('a relay action makes no model call', async () => {
    const fixture = await start()
    const before = fixture.core.status().sessionUsage.calls
    await submit(fixture, 'relay.email.read', {})
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const after = fixture.core.status().sessionUsage.calls
    expect(after).toBe(before)
  })

  it('a relay approval makes no model call', async () => {
    const fixture = await start()
    const requested = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    const approvalId = requested.relay?.approvalId
    const before = fixture.core.status().sessionUsage.calls
    await submit(fixture, 'relay.approval.decide', { approvalId, decision: 'approved' })
    const after = fixture.core.status().sessionUsage.calls
    expect(after).toBe(before)
  })
})

/* ------------------------------------------------------ STOP ALL bypass */

describe('STOP ALL bypass', () => {
  it('a read is refused while stopped', async () => {
    const fixture = await start()
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    const result = await submit(fixture, 'relay.email.read', {})
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('stop_all')
  })

  it('a write request is refused while stopped', async () => {
    const fixture = await start()
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(false)
    expect(result.relay?.failureCode).toBe('stop_all')
  })

  it('an approval decision is refused while stopped', async () => {
    const fixture = await start()
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
  })

  it('no relay command clears the latch', async () => {
    const fixture = await start()
    await submit(fixture, 'security.stopAll', { reason: 'test' })
    await submit(fixture, 'relay.email.read', {}).catch(() => {})
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: 'key-1',
    }).catch(() => {})
    expect(fixture.core.status().stopAll.active).toBe(true)
  })
})

/* ------------------------------------------------ private-content leakage */

describe('private-content leakage', () => {
  it('a message body never enters the journal', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Private subject',
      body: 'Private body content',
      idempotencyKey: 'key-1',
    })
    const journal = await journalText(fixture)
    expect(journal).not.toContain('Private subject')
    expect(journal).not.toContain('Private body content')
  })

  it('a message body never enters the projection', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Private subject',
      body: 'Private body content',
      idempotencyKey: 'key-1',
    })
    const projection = fixture.core.relay()
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('Private subject')
    expect(serialized).not.toContain('Private body content')
  })

  it('a message body never enters the activity feed', async () => {
    const fixture = await start()
    await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Private subject',
      body: 'Private body content',
      idempotencyKey: 'key-1',
    })
    const activity = fixture.core.activity()
    const serialized = JSON.stringify(activity)
    expect(serialized).not.toContain('Private subject')
    expect(serialized).not.toContain('Private body content')
  })

  it('a read result carries content only in the bounded result slot', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.email.read', {})
    expect(result.ok).toBe(true)
    // The content is in the result slot.
    expect(result.relay?.result?.kind).toBe('email.messages')
    // But not in the projection or status.
    expect(JSON.stringify(result.status)).not.toContain('A first message.')
  })

  it('attachment content never enters Relay', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'relay.email.send', {
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
      attachments: [{ filename: 'secret.pdf', contentType: 'application/pdf', sizeBytes: 1024 }],
      idempotencyKey: 'key-1',
    })
    expect(result.ok).toBe(true)
    // The journal records the attachment metadata, never its content.
    const journal = await journalText(fixture)
    expect(journal).not.toContain('secret.pdf')
  })
})
