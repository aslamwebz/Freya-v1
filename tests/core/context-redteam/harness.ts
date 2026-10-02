// @vitest-environment node

/**
 * THE PHASE 9 CONTEXT RED TEAM ATTACK HARNESS.
 *
 * A deterministic, offline driver for attacking the boundaries the Context lane
 * is expected to defend. It boots a real Core over a real journal with a frozen
 * clock and sequential ids, so every attack is reproducible byte-for-byte, and
 * it exposes the seams an attacker would reach for:
 *
 *  - forge a principal (owner-shaped, worker-shaped, untrusted) and hand it to
 *    Guard or to the Cognition service directly;
 *  - create, expire, revoke and replay a cognition authorisation, which is the
 *    live Core boundary closest to a context item's TTL and revocation;
 *  - admit a memory whose *content* claims a trust class, to prove content
 *    cannot upgrade its own provenance;
 *  - read the journal back off disk rather than trusting memory, so an attack
 *    that only "works" in a projection is caught;
 *  - crash the process and boot a second Core against the same journal, which is
 *    the restart/recovery attack surface;
 *  - count provider contacts, so "idle context spends nothing" is a measurement
 *    rather than a claim.
 *
 * It attacks boundaries that exist today (Guard, Cognition, Brain admission,
 * Work, the event schema, the encrypted stores) and pins the contracts the
 * Context lane must keep when it lands. It does not invent Context production
 * behaviour: where a resolver or a context event family does not exist yet, the
 * test says so and asserts the closed vocabulary that constrains it. The
 * assumptions themselves live in `./contract.ts`.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'vitest'

import { createCore, type Core, type CoreOptions } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { parseDurableEvent } from '../../../core/events/validate'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import type { AnyCoreEvent } from '../../../core/events/envelope'
import type { Capability, PrincipalId } from '../../../core/protocol/core-protocol'
import type { Principal } from '../../../core/security/guard'
import { ownerAuthority, workerAuthority } from '../../../core/testing'

/** A synthetic secret that must never reach an untrusted sink. */
export const RED_TEAM_SECRET = 'FREYA_RED_TEAM_SECRET_7A91'

/** A synthetic source token: a claim of provenance, never a credential. */
export const RED_TEAM_SOURCE_TOKEN = 'FREYA_RED_TEAM_SOURCE_TOKEN_C02B'

/** The frozen instant every booted Core starts its clock at. */
export const CLOCK_START = Date.parse('2026-04-01T09:00:00.000Z')

/** ISO form of the frozen instant, for constructing records by hand. */
export const CLOCK_START_ISO = new Date(CLOCK_START).toISOString()

export interface CommandResult {
  requestId: string
  ok: boolean
  refusal?: { reason: string }
  brain?: {
    operation: string
    reason?: string
    memory?: {
      memoryId: string
      kind: string
      subject: string
      status: string
      source: string
      confidence: string
    }
    recall?: {
      items: readonly { memoryId: string; subject: string; content: string; source: string }[]
      empty: boolean
    }
  }
  conversation?: {
    operation: string
    conversation?: { conversationId: string }
    turn?: { turnId: string }
  }
  status?: {
    activeProviderCalls: number
    sessionUsage: { calls: number }
    stopAll: { active: boolean }
  }
}

export interface ContextAttackCore {
  core: Core
  provider: FakeModelProvider
  /** The journal directory, kept across a crash so a second Core can boot on it. */
  dir: string
  /** The journal file path. */
  path: string
  /** Advance the frozen clock. */
  tick: (ms: number) => void
  /** Read every durable event off disk, in sequence order. */
  journal: () => Promise<AnyCoreEvent[]>
  /** Every event whose type starts with the given prefix. */
  eventsOfType: (prefix: string) => Promise<AnyCoreEvent[]>
  /** Submit a command envelope straight to Core. */
  submit: (command: string, payload?: unknown) => Promise<CommandResult>
  /** Stop the Core, keeping the journal on disk. */
  crash: (reason?: string) => Promise<void>
}

export interface ContextBootOptions {
  /** The provider to boot with. Defaults to a counting echo provider. */
  provider?: FakeModelProvider
  /** Core options merged over the harness defaults. */
  core?: Partial<CoreOptions>
}

let idCounter = 0

function newId(): string {
  idCounter += 1
  return `id-${String(idCounter).padStart(4, '0')}`
}

async function readJournal(path: string): Promise<AnyCoreEvent[]> {
  const text = await readFile(path, 'utf8')
  const events: AnyCoreEvent[] = []
  let previous = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseDurableEvent(line, previous)
    if (!parsed.ok) throw new Error(`journal line failed validation: ${parsed.reason}`)
    events.push(parsed.event)
    previous = parsed.event.sequence
  }
  return events
}

function buildHarness(
  core: Core,
  provider: FakeModelProvider,
  dir: string,
  path: string,
  clock: { value: number },
): ContextAttackCore {
  return {
    core,
    provider,
    dir,
    path,
    tick: (ms: number) => {
      clock.value += ms
    },
    journal: () => readJournal(path),
    eventsOfType: async (prefix: string) =>
      (await readJournal(path)).filter((event) => event.type.startsWith(prefix)),
    submit: async (command: string, payload?: unknown) => {
      const result = await core.handleCommand({
        command: command as never,
        requestId: 'r-attack',
        payload,
      })
      return result as unknown as CommandResult
    },
    crash: async (reason = 'attack-crash') => {
      await core.stop(reason)
    },
  }
}

/**
 * Boot a Core with the harness's determinism: frozen clock, sequential ids, one
 * counting provider.
 */
export async function bootContextAttackCore(
  options: ContextBootOptions = {},
): Promise<ContextAttackCore> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-context-'))
  const provider = options.provider ?? new FakeModelProvider()
  const clock = { value: CLOCK_START }
  const path = join(dir, 'events.jsonl')

  const core = createCore({
    dataPath: path,
    now: () => new Date(clock.value),
    newId,
    providers: [provider],
    // A memory conversation store keeps the harness offline and deterministic;
    // tests that need encryption open their own stores.
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    ...options.core,
  })
  await core.start()

  return buildHarness(core, provider, dir, path, clock)
}

/** Tear down a harness, removing its journal directory. */
export async function disposeContextAttackCore(harness: ContextAttackCore | null): Promise<void> {
  if (!harness) return
  await harness.core.stop('context-teardown').catch(() => undefined)
  await rm(harness.dir, { recursive: true, force: true })
}

/**
 * Boot a second Core against a crashed harness's journal.
 *
 * The clock restarts at `CLOCK_START`, which is deliberate: it is the strongest
 * version of the restart attack, because anything that was only prevented by a
 * live in-memory check is given a fresh chance.
 */
export async function rebootAfterCrash(
  harness: ContextAttackCore,
  core: Partial<CoreOptions> = {},
): Promise<ContextAttackCore> {
  const provider = new FakeModelProvider()
  const clock = { value: CLOCK_START }
  const coreInstance = createCore({
    dataPath: harness.path,
    now: () => new Date(clock.value),
    newId,
    providers: [provider],
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    ...core,
  })
  await coreInstance.start()
  return buildHarness(coreInstance, provider, harness.dir, harness.path, clock)
}

/* ----------------------------------------------------------- principals */

/**
 * A principal an attacker would write if they could: the owner's id, the
 * owner's full capability set, and trust forged as `true`.
 *
 * Guard is expected to refuse an untrusted one on `trusted` before it looks at
 * capabilities. The harness builds these as literals rather than importing a
 * factory, because there is deliberately no exported principal factory.
 */
export function forgeOwnerPrincipal(trusted = true): Principal {
  return {
    id: 'owner',
    capabilities: new Set<Capability>([
      'cognition.grant.manage',
      'security.stop',
      'security.resume',
      'work.execute',
      'work.run.manage',
      'work.approval.decide',
      'mission.manage',
    ]),
    trusted,
  }
}

/** A worker-shaped principal: a scoped id, no capabilities, not trusted. */
export function forgeWorkerPrincipal(id: PrincipalId = 'agent:worker-1'): Principal {
  return { id, capabilities: new Set<Capability>(), trusted: false }
}

/** Malformed principal ids, the shape a spoofed provenance claim would carry. */
export const MALFORMED_PRINCIPAL_IDS: readonly unknown[] = [
  'owner ',
  'agent:',
  'agent:bad id',
  'root',
  'system ',
  '',
  42,
  null,
  undefined,
  {},
]

/* ---------------------------------------------------------- assertions */

/** The payload of the first event of a given type, or null. */
export function payloadOf(
  events: readonly AnyCoreEvent[],
  type: string,
): Record<string, unknown> | null {
  const found = events.find((event) => event.type === type)
  return found ? (found.payload as Record<string, unknown>) : null
}

/** Every string value anywhere in a set of events, for secret scanning. */
export function allStringValues(events: readonly AnyCoreEvent[]): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value as Record<string, unknown>)) walk(entry)
    }
  }
  for (const event of events) walk(event)
  return out
}

/** Assert a synthetic secret appears nowhere in the durable journal. */
export function expectNoSecretLeak(
  events: readonly AnyCoreEvent[],
  secret: string = RED_TEAM_SECRET,
): void {
  const leaked = allStringValues(events).filter((value) => value.includes(secret))
  expect(leaked).toEqual([])
}

/** Assert a synthetic secret appears in no supplied text. */
export function expectNoSecretInText(
  texts: readonly string[],
  secret: string = RED_TEAM_SECRET,
): void {
  const leaked = texts.filter((value) => value.includes(secret))
  expect(leaked).toEqual([])
}

/** The owner authority of a booted Core, for grant governance attacks. */
export function owner(harness: ContextAttackCore) {
  return ownerAuthority(harness.core)
}

/** A worker authority of a booted Core, for worker-boundary attacks. */
export function worker(harness: ContextAttackCore, id: PrincipalId = 'agent:worker-1') {
  return workerAuthority(harness.core, id)
}

/** Wait for a condition, so a test can observe a mid-flight state. */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
