// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import {
  NO_WORKFORCE_DOMAIN_REASON,
  WORKFORCE_NO_PAYLOAD,
  type WorkforceProjection,
  type WorkforceSource,
} from '../../core/protocol/workforce'

/**
 * The Workforce protocol, through a running Core.
 *
 * The Workforce domain's own rules are issue #10's and are not exercised here.
 * What this file covers is the seam this lane owns, and the three claims only a
 * running Core can make:
 *
 *  1. A Core with no Workforce domain says exactly that. It does not present an
 *     empty-but-ready workforce, and nothing in it is simulated.
 *  2. The one Workforce command is a read, it carries nothing, and a window
 *     that attaches a claim is refused with the protocol's own words rather
 *     than having the claim quietly dropped.
 *  3. When something *does* fill the seam, Core reports it verbatim and pushes
 *     changes — which is the whole contract issue #10 has to satisfy, and the
 *     whole of what this lane assumes about it.
 */

let dir = ''
let core: Core | undefined
let requestSeq = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-workforce-'))
  requestSeq = 0
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

interface CoreResult {
  requestId: string
  ok: boolean
  refusal?: { reason: string }
  error?: { message: string }
  workforce?: { operation: string; ok: boolean; reason?: string }
}

/** A Core with a counting provider: reading the workforce must cost nothing. */
async function started(options: Partial<CoreOptions> = {}): Promise<{
  core: Core
  calls: () => number
  send: (command: string, payload?: unknown) => Promise<CoreResult>
}> {
  let calls = 0
  const provider = new FakeModelProvider()
  vi.spyOn(provider, 'complete').mockImplementation(async () => {
    calls += 1
    return {
      requestId: 'r',
      providerId: provider.id,
      model: provider.model,
      text: 'unused',
      inputTokens: 0,
      outputTokens: 0,
    }
  })

  core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [provider],
    ...options,
  })
  await core.start()

  const instance = core
  const send = async (command: string, payload?: unknown): Promise<CoreResult> => {
    requestSeq += 1
    const result = await instance.handleCommand({
      command,
      requestId: `r-${requestSeq}`,
      ...(payload === undefined ? {} : { payload }),
    } as never)
    return result as CoreResult
  }

  return { core: instance, calls: () => calls, send }
}

/** Two workers, one team — exactly the shape the seam is expected to carry. */
function readyProjection(over: Partial<WorkforceProjection> = {}): WorkforceProjection {
  return {
    health: 'ready',
    reason: null,
    workers: [
      {
        workerId: 'worker-alpha',
        name: 'Alpha',
        teamId: 'team-red',
        specialization: 'research',
        state: 'working',
        assignment: { kind: 'run', id: 'run-1', label: 'Search the archive' },
        capabilities: ['search.web'],
        claims: [{ kind: 'capability', value: 'work.execute', assertedAt: null }],
        budget: { label: 'tokens this hour', used: 120, limit: 1_000 },
        concurrency: { active: 1, limit: 2 },
        lastActiveAt: '2026-10-01T00:00:00.000Z',
      },
      {
        workerId: 'worker-beta',
        name: 'Beta',
        teamId: null,
        specialization: null,
        state: 'idle',
        assignment: null,
        capabilities: [],
        claims: [],
        budget: null,
        concurrency: null,
        lastActiveAt: null,
      },
    ],
    teams: [
      {
        teamId: 'team-red',
        name: 'Red',
        purpose: 'reads things',
        memberIds: ['worker-alpha'],
        state: 'active',
      },
    ],
    counts: { workers: 2, working: 1, idle: 1, waiting: 0, teams: 1 },
    sequence: 41,
    ...over,
  }
}

/**
 * A source Core can read, with a `set` the test uses to say "it changed".
 *
 * Deliberately the smallest thing that satisfies `WorkforceSource`: a
 * projection and an optional subscription. If this file can drive the whole
 * chain with an object this small, the seam this lane assumed really is this
 * small — which is the point of writing the fake down first.
 */
function fakeSource(initial: WorkforceProjection): {
  source: WorkforceSource
  set: (next: WorkforceProjection) => void
} {
  let current = initial
  const listeners = new Set<(projection: WorkforceProjection) => void>()
  return {
    source: {
      projection: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    set: (next) => {
      current = next
      for (const listener of [...listeners]) listener(next)
    },
  }
}

describe('a Core with no Workforce domain says so', () => {
  it('reports no domain rather than an empty-but-ready workforce', async () => {
    const harness = await started()
    const projection = harness.core.workforce()

    // The distinction the whole surface rests on: "unavailable" with Core's own
    // sentence, never `ready` with zeroes — a person reading an empty team as
    // "everyone is off today" is being told something false about a subsystem
    // that does not exist.
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBe(NO_WORKFORCE_DOMAIN_REASON)
    expect(projection.workers).toEqual([])
    expect(projection.teams).toEqual([])
    expect(projection.counts).toEqual({ workers: 0, working: 0, idle: 0, waiting: 0, teams: 0 })
    expect(projection.sequence).toBe(0)
  })

  it('answers the one Workforce command, which is a read', async () => {
    const harness = await started()
    const result = await harness.send('workforce.status.read')
    expect(result.ok).toBe(true)
    expect(result.workforce).toEqual({ operation: 'status', ok: true })
    expect(harness.calls()).toBe(0)
  })

  it('refuses every claim a window might attach to the read', async () => {
    const harness = await started()

    // Each of these is a field a compromised renderer would reach for if a
    // Workforce write existed: an owner, a principal, an authority, a trust
    // level, a provenance, a capability, and a claim. None is read — and each
    // is *refused*, so the window is told the read takes no payload instead of
    // being left believing the field went somewhere.
    const claims: unknown[] = [
      { principal: 'owner' },
      { owner: 'owner' },
      { authority: 'owner' },
      { trust: 'delegated' },
      { provenance: 'renderer' },
      { capability: 'work.execute' },
      { claims: [{ kind: 'capability', value: 'work.execute' }] },
      { principal: 'agent:alpha', authority: 'full' },
      'owner',
      ['owner'],
    ]

    for (const payload of claims) {
      const result = await harness.send('workforce.status.read', payload)
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toBe(WORKFORCE_NO_PAYLOAD)
      expect(result.workforce).toEqual({
        operation: 'refused',
        ok: false,
        reason: WORKFORCE_NO_PAYLOAD,
      })
    }

    // And the projection never moved: a read that was refused changed nothing.
    expect(harness.core.workforce().reason).toBe(NO_WORKFORCE_DOMAIN_REASON)
    expect(harness.calls()).toBe(0)
  })

  it('accepts an empty payload, because an empty payload carries nothing', async () => {
    const harness = await started()
    const empty = await harness.send('workforce.status.read', {})
    expect(empty.ok).toBe(true)
    expect(empty.workforce?.operation).toBe('status')
  })

  it('still reads once shutdown has started', async () => {
    // The same reasoning as every other status read: a window winding down
    // still has to be able to say what the workforce is, and the read is the
    // only Workforce command there is, so there is nothing mutating left over
    // for shutdown to be missing.
    const harness = await started()
    await harness.core.stop('test-teardown')
    core = undefined

    const result = await harness.core.handleCommand({
      command: 'workforce.status.read',
      requestId: 'r-after-stop',
    } as never)
    expect((result as CoreResult).ok).toBe(true)
    expect((result as CoreResult).workforce?.operation).toBe('status')
  })

  it('names no other Workforce command at all', async () => {
    const harness = await started()
    // There is no `workforce.worker.create`, no `workforce.assign`, no
    // `workforce.claim.submit` to fall through to `unknown command`: the
    // vocabulary simply does not contain them, which is the correct answer for
    // every one of them.
    for (const command of [
      'workforce.worker.create',
      'workforce.team.create',
      'workforce.assign',
      'workforce.capability.grant',
      'workforce.claim.submit',
    ]) {
      const result = await harness.send(command, { workerId: 'worker-alpha' })
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toMatch(/unknown command/)
    }
  })
})

describe('the Workforce seam, once something fills it', () => {
  it('reports what the source says, verbatim', async () => {
    const { source } = fakeSource(readyProjection())
    const harness = await started({ workforceSource: source })
    const projection = harness.core.workforce()

    expect(projection.health).toBe('ready')
    expect(projection.workers.map((worker) => worker.name)).toEqual(['Alpha', 'Beta'])
    expect(projection.teams.map((team) => team.name)).toEqual(['Red'])
    expect(projection.counts.workers).toBe(2)
    // The claim rides along as data, next to the capability Core assigned —
    // two separate lists, exactly as the protocol declares them.
    expect(projection.workers[0]?.capabilities).toEqual(['search.web'])
    expect(projection.workers[0]?.claims[0]?.value).toBe('work.execute')
  })

  it('pushes to subscribers when the source moves', async () => {
    const { source, set } = fakeSource(readyProjection())
    const harness = await started({ workforceSource: source })

    const seen: WorkforceProjection[] = []
    const dispose = harness.core.onWorkforce((projection) => seen.push(projection))
    // Delivered immediately, like every other mirror: a window attaching late
    // agrees with one that never left.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('ready')

    set(
      readyProjection({
        workers: [],
        teams: [],
        counts: { workers: 0, working: 0, idle: 0, waiting: 0, teams: 0 },
        sequence: 42,
      }),
    )
    expect(seen).toHaveLength(2)
    expect(seen[1]?.sequence).toBe(42)

    dispose()
    set(readyProjection({ sequence: 43 }))
    expect(seen).toHaveLength(2)
  })

  it('reports a source that throws rather than letting it take the read down', async () => {
    const broken: WorkforceSource = {
      projection: () => {
        throw new Error('the workforce store is gone')
      },
    }
    const harness = await started({ workforceSource: broken })

    const projection = harness.core.workforce()
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toMatch(/could not be read/)
    expect(projection.reason).toContain('the workforce store is gone')
    expect(projection.workers).toEqual([])

    // And the command still answers: an unreadable workforce is a stated
    // condition, not a broken Core.
    const result = await harness.send('workforce.status.read')
    expect(result.ok).toBe(true)
  })

  it('costs no model calls to read, mirror or push', async () => {
    const { source, set } = fakeSource(readyProjection())
    const harness = await started({ workforceSource: source })
    harness.core.onWorkforce(() => {})
    await harness.send('workforce.status.read')
    set(readyProjection({ sequence: 99 }))
    expect(harness.calls()).toBe(0)
  })
})
