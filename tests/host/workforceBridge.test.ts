// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import {
  NO_WORKFORCE_DOMAIN_REASON,
  WORKFORCE_NO_PAYLOAD,
  type WorkforceProjection,
  type WorkforceSource,
} from '../../core/protocol/workforce'

/**
 * The Workforce lane across the host and the preload bridge.
 *
 * Two halves, and they answer different questions:
 *
 *  - The **host** is where "the renderer is a projection" is decided, so it is
 *    tested here rather than only in the app: what a window receives is what
 *    Core reported, a window that has not attached receives nothing, and the
 *    host never has a workforce of its own to forward.
 *  - The **preload bridge** is the capability boundary, and its tests read the
 *    bridge's own source — the fields it refuses are only provable by looking
 *    at what it does *not* read, and `rendererPayload` is deliberately not
 *    exported.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-workforce-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

/** The smallest source the seam accepts, with a `set` for "it changed". */
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
        budget: null,
        concurrency: { active: 1, limit: 2 },
        lastActiveAt: null,
      },
    ],
    teams: [
      {
        teamId: 'team-red',
        name: 'Red',
        purpose: null,
        memberIds: ['worker-alpha'],
        state: 'active',
      },
    ],
    counts: { workers: 1, working: 1, idle: 0, waiting: 0, teams: 1 },
    sequence: 7,
    ...over,
  }
}

describe('the Workforce mirror belongs to the process, not the window', () => {
  it('reports nothing before Core has started', () => {
    // Null, not an empty projection: a host with no Core has no workforce to
    // report, and manufacturing one would make "Core is not up yet" and "there
    // are no workers" the same sentence.
    expect(host!.workforce()).toBeNull()
    const seen: WorkforceProjection[] = []
    host!.onWorkforce((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
  })

  it('pushes Core’s honest "no domain" reading the moment a window attaches', async () => {
    await host!.start()
    const seen: WorkforceProjection[] = []
    const dispose = host!.onWorkforce((projection) => seen.push(projection))

    // Delivered immediately, so a reloaded window knows where it stands without
    // asking — and what it is told is the truth about this build.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('unavailable')
    expect(seen[0]?.reason).toBe(NO_WORKFORCE_DOMAIN_REASON)
    expect(seen[0]?.workers).toEqual([])
    expect(seen[0]?.teams).toEqual([])
    dispose()
  })

  it('answers the read command, and refuses one carrying a claim', async () => {
    await host!.start()

    const read = await host!.submit({ command: 'workforce.status.read', requestId: 'w1' })
    expect(read.ok).toBe(true)
    expect(read.workforce).toEqual({ operation: 'status', ok: true })

    const claimed = await host!.submit({
      command: 'workforce.status.read',
      requestId: 'w2',
      payload: { principal: 'owner', authority: 'owner', capability: 'work.execute' },
    })
    expect(claimed.ok).toBe(false)
    expect(claimed.refusal?.reason).toBe(WORKFORCE_NO_PAYLOAD)
    expect(claimed.workforce).toEqual({
      operation: 'refused',
      ok: false,
      reason: WORKFORCE_NO_PAYLOAD,
    })
  })

  it('forwards a source into Core and mirrors what comes back', async () => {
    const { source, set } = fakeSource(readyProjection())
    await host!.stop('rebuild with a source')
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, { workforceSource: source })
    await host!.start()

    const seen: WorkforceProjection[] = []
    const dispose = host!.onWorkforce((projection) => seen.push(projection))
    expect(seen[0]?.workers.map((worker) => worker.name)).toEqual(['Alpha'])
    expect(seen[0]?.teams.map((team) => team.name)).toEqual(['Red'])
    // Core's own read agrees with what was pushed: one truth, two doors.
    expect(host!.workforce()?.sequence).toBe(7)

    // The legacy read-only mirror is not the canonical Workforce engine shape.
    // Office must project only the internal domain rather than treating a mirror
    // source as worker authority (or trying to read internal assignment fields
    // the mirror deliberately does not expose).
    expect(host!.office()?.counts.workers).toBe(0)
    expect(host!.office()?.stations.some((station) => station.kind === 'worker')).toBe(false)

    // A window detaching mid-flight does not disturb the Core it attached to —
    // the property every other mirror rests on, here as well.
    dispose()
    set(readyProjection({ sequence: 8 }))
    expect(host!.workforce()?.sequence).toBe(8)

    const second: WorkforceProjection[] = []
    host!.onWorkforce((projection) => second.push(projection))
    expect(second).toHaveLength(1)
    expect(second[0]?.sequence).toBe(8)
  })

  it('drops a window that throws rather than taking the mirror down with it', async () => {
    const { source, set } = fakeSource(readyProjection())
    await host!.stop('rebuild with a source')
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, { workforceSource: source })
    await host!.start()

    host!.onWorkforce(() => {
      throw new Error('this window is broken')
    })
    const healthy: WorkforceProjection[] = []
    host!.onWorkforce((projection) => healthy.push(projection))

    set(readyProjection({ sequence: 9 }))
    expect(healthy.length).toBeGreaterThan(1)
    expect(healthy.at(-1)?.sequence).toBe(9)
  })
})

/**
 * One `case` arm of the preload payload contract, comments stripped.
 *
 * Comments are stripped because these tests are about the code rather than the
 * commentary — several arms explain in prose exactly which field they do not
 * accept, and leaving the prose in would let a comment satisfy the assertion it
 * describes.
 */
async function contractBetween(from: string, to: string): Promise<{ source: string; contract: string }> {
  const source = await readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8')
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`the preload bridge has no region between ${from} and ${to}`)
  }
  const contract = source
    .slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join(' ')
  return { source, contract }
}

describe('the preload bridge gives a window exactly one Workforce verb', () => {
  it('names the read and nothing else in the reachable command set', async () => {
    const source = await readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8')
    const listed = source
      .slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString'))
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join(' ')

    const names = [...listed.matchAll(/'(workforce\.[^']+)'/g)].map((match) => match[1])
    expect(names).toEqual(['workforce.status.read'])
  })

  it('exposes the projection read, and no function that writes one', async () => {
    const source = await readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8')
    const api = source
      .slice(source.indexOf('const api = {'), source.indexOf('contextBridge.exposeInMainWorld'))
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')

    // Every bridge function that mentions the workforce, named. Two reads — the
    // one-shot pull and the subscription — and nothing that could create,
    // assign, claim or configure anything, because none exists to expose.
    const workforceKeys = [...api.matchAll(/^\s{2}(\w*[Ww]orkforce\w*):/gm)].map((match) => match[1])
    expect([...workforceKeys].sort()).toEqual(['coreWorkforce', 'onCoreWorkforce'])
    expect(api).not.toMatch(/workforce\w*(Submit|Create|Assign|Claim|Grant|Config)/i)
  })

  it('refuses a payload on the read instead of dropping it', async () => {
    const { contract } = await contractBetween(
      "case 'workforce.status.read'",
      "case 'mission.create'",
    )

    // The arm decides emptiness and refuses with the protocol's shared words —
    // the same sentence Core repeats — so a window learns the read takes no
    // payload rather than believing an appended field went somewhere.
    expect(contract).toContain('carriesNothing(payload)')
    expect(contract).toContain('WORKFORCE_NO_PAYLOAD')

    // And it reads no field by name. There is no `principal`, no `owner`, no
    // `authority`, no `trust`, no `provenance`, no `capability` and no `claim`
    // in the contract at all: a claim is not read, it is refused.
    for (const forbidden of [
      'principal',
      'owner',
      'authority',
      'trust',
      'provenance',
      'capability',
      'claim',
      'teamId',
      'workerId',
    ]) {
      expect(contract).not.toContain(`string('${forbidden}'`)
      expect(contract).not.toContain(`${forbidden}:`)
    }
  })

  it('keeps the refusal words identical to Core’s own', async () => {
    // One sentence, one source. If the bridge and Core could disagree about the
    // rule *or* about the words, a window could pass one and be told something
    // else by the other.
    const protocol = await readFile(
      new URL('../../core/protocol/workforce.ts', import.meta.url),
      'utf8',
    )
    const preload = await readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8')
    expect(protocol).toContain('WORKFORCE_NO_PAYLOAD')
    expect(preload).toContain('WORKFORCE_NO_PAYLOAD')
    expect(preload).not.toContain('a Workforce read carries')
  })
})
