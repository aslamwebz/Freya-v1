// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../../core/index'
import type { CoreCommandResult } from '../../../core/protocol/core-protocol'
import {
  FakeCalendarAdapter,
  FakeEmailAdapter,
  FakeExternalAdapter,
  FakeGitHubAdapter,
} from '../../../core/relay/adapters'
import type { RelayEmailMessage } from '../../../core/relay/types'

/**
 * RELAY RED-TEAM HARNESS.
 *
 * A Core on a temp journal with deterministic fake adapters and a controllable
 * clock. Nothing here touches a network, a real provider or a real secret.
 * The sentinels are unmistakable fake markers, per the "synthetic secrets"
 * rule.
 */

export const RELAY_SENTINELS = [
  'FREYA_RELAY_SECRET_7A91',
  'FREYA_RELAY_TOKEN_C02B',
  'FREYA_RELAY_CREDENTIAL_91DD',
] as const

export interface RelayFixture {
  core: Core
  clock: { now: Date }
  email: FakeEmailAdapter
  calendar: FakeCalendarAdapter
  github: FakeGitHubAdapter
  external: FakeExternalAdapter
  journalPath: string
  dir: string
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
]

export async function startRelayCore(
  overrides: Partial<CoreOptions> & { failTimes?: number } = {},
): Promise<RelayFixture> {
  const { failTimes, ...coreOptions } = overrides
  const dir = await mkdtemp(join(tmpdir(), 'freya-relay-redteam-'))
  const clock = { now: new Date('2026-10-02T09:00:00.000Z') }
  const email = new FakeEmailAdapter(MESSAGES, { failTimes })
  const calendar = new FakeCalendarAdapter([], { failTimes })
  const github = new FakeGitHubAdapter([], { failTimes })
  const external = new FakeExternalAdapter({ failTimes })
  const core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [],
    now: () => clock.now,
    relay: {
      adapters: { email, calendar, github, external: { slack: external } },
      allowlistedRepos: ['owner/allowed-repo'],
    },
    // Attention observation is on so the connector-signal integration can be
    // tested: a read that returns results delivers a fixed-text signal.
    attentionObserveSources: true,
    ...coreOptions,
  })
  await core.start()
  return {
    core,
    clock,
    email,
    calendar,
    github,
    external,
    journalPath: join(dir, 'events.jsonl'),
    dir,
  }
}

export async function stopRelayCore(fixture: RelayFixture | null): Promise<void> {
  if (!fixture) return
  await fixture.core.stop('red-team teardown')
  await rm(fixture.dir, { recursive: true, force: true })
}

export function submit(
  fixture: RelayFixture,
  command: string,
  payload?: unknown,
): Promise<CoreCommandResult> {
  return fixture.core.handleCommand({
    command: command as never,
    requestId: `rt-${Math.random().toString(36).slice(2)}`,
    payload,
  })
}

export async function journalText(fixture: RelayFixture): Promise<string> {
  try {
    return await readFile(fixture.journalPath, 'utf8')
  } catch {
    return ''
  }
}

/** Every string reachable from a value, deeply. */
export function deepStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const member of value) deepStrings(member, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      out.push(key)
      deepStrings(member, out)
    }
  }
  return out
}

/** Fail with a named sink if any sentinel appears anywhere in the value. */
export function expectNoSentinels(sink: string, value: unknown): void {
  for (const sentinel of RELAY_SENTINELS) {
    const found = deepStrings(value).filter((text) => text.includes(sentinel))
    if (found.length > 0) {
      throw new Error(
        `red-team leak: ${sentinel} reached the ${sink} sink (${found.length} occurrence(s))`,
      )
    }
  }
}
