// @vitest-environment node

/**
 * THE WORKFORCE RED TEAM ATTACK HARNESS.
 *
 * A reusable, deterministic, offline driver for attacking the boundaries the
 * Phase 8 Workforce lane is expected to defend. It boots a real Core over a
 * real journal with a frozen clock and sequential ids, so every attack is
 * reproducible byte-for-byte, and it exposes the seams an attacker would
 * reach for:
 *
 *  - forge a principal (owner-shaped, worker-shaped, malformed) and hand it to
 *    Guard or to the Cognition service directly;
 *  - submit a command payload that claims an identity, a capability or a
 *    decision the caller does not hold;
 *  - read the journal back off disk rather than trusting memory, so an attack
 *    that only "works" in a projection is caught;
 *  - crash the process on a live journal and boot a second one against it,
 *    which is the restart/recovery attack surface;
 *  - count provider contacts, so "idle Work spends nothing" is a measurement
 *    rather than a claim.
 *
 * The harness attacks boundaries that exist today (Guard, Cognition, Work,
 * Missions, the event schema) and pins the contracts the Workforce lane must
 * keep when it lands. It does not invent Workforce production behaviour: where
 * a worker registry or a worker principal does not exist yet, the test says
 * so and asserts the closed vocabulary that constrains it.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { expect } from 'vitest'

import { createCore, type Core, type CoreOptions } from '../../../core/index'

import { FakeModelProvider } from '../../../core/model/fake-provider'

import { parseDurableEvent } from '../../../core/events/validate'

import type { AnyCoreEvent } from '../../../core/events/envelope'

import type { Capability, PrincipalId } from '../../../core/protocol/core-protocol'

import type { WorkStepPlan } from '../../../core/work/types'

import { WORK_LIMITS } from '../../../core/work/types'

import type { Principal } from '../../../core/security/guard'

import { ownerAuthority, workerAuthority } from '../../../core/testing'

import { EventFabric } from '../../../core/events/fabric'

import { JsonlEventStore } from '../../../core/events/jsonl-store'

import { WorkEngine } from '../../../core/work/engine'

import { registerPhaseSixCapabilities, WorkRegistry } from '../../../core/work/capability'

import type { WorkCapability } from '../../../core/work/capability'

/** A synthetic secret that must never reach an untrusted sink. */
export const RED_TEAM_SECRET = 'FREYA_RED_TEAM_SECRET_7A91'

/** The frozen instant every booted Core starts its clock at. */
export const CLOCK_START = Date.parse('2026-04-01T09:00:00.000Z')

export interface AttackCore {
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

export interface CommandResult {
  requestId: string
  ok: boolean
  refusal?: { reason: string }
  error?: { message: string }
  work?: {
    operation: string
    ok: boolean
    reason?: string
    runId?: string
    stepId?: string
    approvalId?: string
    taskId?: string
    runStatus?: string
  }
  mission?: {
    operation: string
    ok: boolean
    missionId?: string
    status?: string
    reason?: string
  }
  status?: {
    stopAll: { active: boolean; activatedAt: string | null; activatedBy: PrincipalId | null }
    activeProviderCalls: number
  }
}

let idCounter = 0

function newId(): string {
  idCounter += 1
  return `id-${String(idCounter).padStart(4, '0')}`
}

/**
 * Boot a Core with the attack harness's determinism: frozen clock, sequential
 * ids, one fake provider whose contacts are counted.
 */
export async function bootAttackCore(overrides: Partial<CoreOptions> = {}): Promise<AttackCore> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-workforce-'))
  let clock = CLOCK_START
  const provider = new FakeModelProvider()

  const options: CoreOptions = {
    dataPath: join(dir, 'events.jsonl'),
    now: () => new Date(clock),
    newId,
    providers: [provider],
    ...overrides,
  }

  const core = createCore(options)
  await core.start()

  const harness: AttackCore = {
    core,
    provider,
    dir,
    path: join(dir, 'events.jsonl'),
    tick: (ms: number) => {
      clock += ms
    },
    journal: async () => {
      const text = await readFile(harness.path, 'utf8')
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
    },
    eventsOfType: async (prefix: string) =>
      (await harness.journal()).filter((event) => event.type.startsWith(prefix)),
    submit: async (command: string, payload?: unknown) => {
      const result = await core.handleCommand({
        command: command as never,
        requestId: 'r-attack',
        payload,
      })
      return result as CommandResult
    },
    crash: async (reason = 'attack-crash') => {
      await core.stop(reason)
    },
  }

  return harness
}

/** Tear down a harness, removing its journal directory. */
export async function disposeAttackCore(harness: AttackCore | null): Promise<void> {
  if (!harness) return
  await harness.core.stop('workforce-teardown').catch(() => undefined)
  await rm(harness.dir, { recursive: true, force: true })
}

/**
 * Boot a second Core against a crashed harness's journal.
 *
 * This is the restart attack: the new process must reconcile honestly rather
 * than resume, retry or mark successful anything the old process was doing.
 */
export async function rebootAfterCrash(harness: AttackCore): Promise<AttackCore> {
  const path = harness.path
  const dir = harness.dir
  let clock = CLOCK_START
  const provider = new FakeModelProvider()

  const core = createCore({
    dataPath: path,
    now: () => new Date(clock),
    newId,
    providers: [provider],
  })
  await core.start()

  return {
    core,
    provider,
    dir,
    path,
    tick: (ms: number) => {
      clock += ms
    },
    journal: async () => {
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
    },
    eventsOfType: async (prefix: string) =>
      (await harness.journal()).filter((event) => event.type.startsWith(prefix)),
    submit: async (command: string, payload?: unknown) => {
      const result = await core.handleCommand({
        command: command as never,
        requestId: 'r-attack',
        payload,
      })
      return result as CommandResult
    },
    crash: async (reason = 'attack-crash') => {
      await core.stop(reason)
    },
  }
}

/* ----------------------------------------------------------- principals */

/**
 * A principal an attacker would write if they could: the owner's id, the
 * owner's full capability set, and trust forged as `true`.
 *
 * Guard is expected to refuse this on `trusted` before it looks at
 * capabilities — and the Workforce lane must never hand a worker a `Principal`
 * at all, which is why the harness builds these as literals rather than
 * importing a factory.
 */
export function forgeOwnerPrincipal(): Principal {
  return {
    id: 'owner' as const,
    capabilities: new Set<Capability>([
      'cognition.grant.manage',
      'security.stop',
      'security.resume',
      'work.execute',
      'work.run.manage',
      'work.approval.decide',
      'mission.manage',
    ]),
    trusted: true,
  }
}

/** A worker-shaped principal: a scoped id, no capabilities, not trusted. */
export function forgeWorkerPrincipal(id: PrincipalId = 'agent:worker-1'): Principal {
  return { id, capabilities: new Set<Capability>(), trusted: false }
}

/** A malformed principal id, the shape a spoofed message would carry. */
export const MALFORMED_PRINCIPAL_IDS: readonly unknown[] = [
  'owner ',
  'agent:',
  'agent:bad id',
  'module:way-too-long-id-'.repeat(10),
  'root',
  'system ',
  '',
  42,
  null,
  undefined,
  {},
]

/* -------------------------------------------------------------- plans */

/** A step plan that will verify: the capability echoes the step key back. */
export function verifyingStep(key: string, input: Record<string, unknown> = {}): WorkStepPlan {
  return {
    key,
    label: `record ${key}`,
    capability: 'test.record',
    verifier: 'test.record.matches',
    input: { expect: key, ...input },
  }
}

/** A step plan naming a capability no Core has — the self-mint probe. */
export function unregisteredCapabilityStep(key: string): WorkStepPlan {
  return {
    key,
    label: 'a capability this Core does not have',
    capability: 'worker.self-minted',
    verifier: 'test.record.matches',
  }
}

/** A step plan whose input tries to smuggle structure through the boundary. */
export function smugglingStep(key: string): WorkStepPlan {
  return {
    key,
    label: 'smuggle an object through step input',
    capability: 'test.record',
    verifier: 'test.record.matches',
    input: {
      expect: key,
      nested: { deeply: { object: RED_TEAM_SECRET } },
      fn: () => RED_TEAM_SECRET,
      proto: '__proto__',
    },
  }
}

/* ---------------------------------------------------------- assertions */

/** The payload of the first event of a given type, or null. */
export function payloadOf(events: AnyCoreEvent[], type: string): Record<string, unknown> | null {
  const found = events.find((event) => event.type === type)
  return found ? (found.payload as Record<string, unknown>) : null
}

/** Every string value anywhere in a set of events, for secret scanning. */
export function allStringValues(events: AnyCoreEvent[]): string[] {
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
export function expectNoSecretLeak(events: AnyCoreEvent[], secret: string = RED_TEAM_SECRET): void {
  const leaked = allStringValues(events).filter((value) => value.includes(secret))
  expect(leaked).toEqual([])
}

/** The absolute ceiling table, re-exported so tests can assert against it. */
export { WORK_LIMITS }

/** The owner authority of a booted Core, for grant governance attacks. */
export function owner(harness: AttackCore) {
  return ownerAuthority(harness.core)
}

/** A worker authority of a booted Core, for worker-boundary attacks. */
export function worker(harness: AttackCore, id: PrincipalId = 'agent:worker-1') {
  return workerAuthority(harness.core, id)
}

/* -------------------------------------------------------------- crash */

/**
 * A capability that never returns, so a run can be stranded mid-flight.
 *
 * It listens for the abort so a graceful shutdown can still settle, but it
 * never resolves on its own — which is what a crash looks like from the
 * journal's point of view.
 */
const FOREVER: WorkCapability = {
  name: 'test.forever',
  capability: 'work.execute',
  risk: 'routine',
  describe: () => 'never returns, so a run can be stranded mid-flight',
  execute: (_request, context) =>
    new Promise((_resolve, reject) => {
      const onAbort = (): void => reject(new Error('aborted'))
      context.signal.addEventListener('abort', onAbort, { once: true })
    }),
}

/**
 * Leave a run mid-flight and abandon the journal without settling it.
 *
 * The event store is closed directly rather than through a graceful
 * `Core.stop()`, so nothing writes the terminal events a shutdown would have
 * written. That is the only way to produce the state a crash produces, and
 * it is the state recovery has to be honest about.
 *
 * Returns the stranded run's id.
 */
export async function strandRun(harness: AttackCore, key = 'forever'): Promise<string> {
  const store = await JsonlEventStore.open(harness.path)
  const fabric = await EventFabric.open({ store, now: () => new Date(CLOCK_START), newId })

  const registry = new WorkRegistry()
  registerPhaseSixCapabilities(registry)
  registry.register(FOREVER)

  const engine = new WorkEngine({
    fabric,
    authorizer: { evaluate: () => ({ allowed: true as const }) },
    registry,
    principalId: 'owner',
    now: () => new Date(CLOCK_START),
    newId,
  })

  await engine.open()

  const created = await engine.createRun({
    steps: [{ key, label: 'waits forever', capability: 'test.forever', verifier: 'test.exit.waited' }],
  })
  if (!created.ok || created.runId === undefined) {
    throw new Error(`could not create the stranded run: ${created.reason}`)
  }
  const runId = created.runId

  // Not awaited: this is the whole point. The capability never returns.
  void engine.startRun(runId)

  // Wait until the journal says a capability is executing, then abandon it.
  for (let index = 0; index < 200; index += 1) {
    const actions = [...engine.snapshot().actions.values()]
    if (actions.some((action) => action.status === 'running')) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  await fabric.close()
  return runId
}
