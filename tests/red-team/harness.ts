// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { ownerAuthority, workerAuthority } from '../../core/testing'
import type { OwnerAuthority, WorkerAuthority } from '../../core/authority'
import { FakeModelProvider } from '../../core/model/fake-provider'

/**
 * RED TEAM HARNESS — deterministic fixtures for the smoke attacks.
 *
 * Everything here is shared plumbing: a Core on a temp journal with a fake
 * provider, the synthetic sentinels from docs/RED-TEAM.md, and scrapers that
 * can sweep an entire sink for those sentinels. The attacks themselves live
 * in the test files, one family per file, so that each file names the
 * invariant it is trying to break.
 *
 * Nothing here touches a network, a real provider, or a real secret. The
 * sentinels are unmistakable fake markers, per the "Synthetic secrets" rule.
 */

/** The synthetic secrets. Never real data. */
export const RED_TEAM_SENTINELS = [
  'FREYA_RED_TEAM_SECRET_7A91',
  'FREYA_RED_TEAM_SOURCE_TOKEN_C02B',
  'FREYA_RED_TEAM_CREDENTIAL_91DD',
] as const

export type Sentinel = (typeof RED_TEAM_SENTINELS)[number]

/** One red-team fixture: a live Core, its authorities, and its fake provider. */
export interface RedTeamCore {
  core: Core
  owner: OwnerAuthority
  worker: WorkerAuthority
  fake: FakeModelProvider
  /** The journal file, for reading raw lines back. */
  journalPath: string
  dir: string
}

/** Start a Core on a fresh temp journal, with a deterministic fake provider. */
export async function startRedTeamCore(overrides: Partial<CoreOptions> = {}): Promise<RedTeamCore> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-redteam-'))
  const fake = new FakeModelProvider()
  const core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [fake], testCapabilities: true, ...overrides })
  await core.start()
  return {
    core,
    owner: ownerAuthority(core),
    worker: workerAuthority(core),
    fake,
    journalPath: join(dir, 'events.jsonl'),
    dir,
  }
}

/** Stop the Core and delete its journal. Safe to call twice. */
export async function stopRedTeamCore(fixture: RedTeamCore | null): Promise<void> {
  if (!fixture) return
  await fixture.core.stop('red-team teardown')
  await rm(fixture.dir, { recursive: true, force: true })
}

/** The journal as raw lines. An empty journal reads back as `[]`. */
export async function journalLines(fixture: RedTeamCore): Promise<string[]> {
  try {
    const raw = await readFile(fixture.journalPath, 'utf8')
    return raw.split('\n').filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

/** The journal as parsed events, in order. */
export async function journalEvents(fixture: RedTeamCore): Promise<Record<string, unknown>[]> {
  return (await journalLines(fixture)).map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Every string reachable from a value, deeply.
 *
 * The sweep is deliberately dumb: object keys, string values, array members
 * and `toString`-able leaves are all collected, so a sentinel hidden inside a
 * nested payload or an array of labels is found wherever it ended up. The
 * point of a leak test is "nowhere in this sink", not "not in the fields I
 * thought to check".
 */
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
  for (const sentinel of RED_TEAM_SENTINELS) {
    const found = deepStrings(value).filter((text) => text.includes(sentinel))
    if (found.length > 0) {
      throw new Error(
        `red-team leak: ${sentinel} reached the ${sink} sink (${found.length} occurrence(s))`,
      )
    }
  }
}

/** The standard owner-created agent grant used by several attack files. */
export async function createAgentGrant(fixture: RedTeamCore, grantId: string): Promise<void> {
  await fixture.owner.createGrant({
    grantId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowedOrigins: ['agent'],
    allowedCauses: ['run_finished'],
    backgroundAllowed: true,
    maxCalls: 10,
    maxOutputTokens: 10_000,
  })
}

/** A worker's agent_step intent, for the paths a worker is allowed to try. */
export function agentStep(prompt: string, maxOutputTokens = 1000): {
  kind: 'agent_step'
  prompt: string
  maxOutputTokens: number
} {
  return { kind: 'agent_step', prompt, maxOutputTokens }
}
