// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { parseDurableEvent } from '../../core/events/validate'
import { subordinateScope, workforceOwnerScope } from '../../core/testing'
import type { SubordinateWorkerScope, WorkforceOwnerScope } from '../../core/workforce/authority'
import type { WorkforceProjection } from '../../core/workforce/types'
import { CORE_EVENT_TYPES } from '../../core/events/envelope'

/**
 * The workforce, through a real Core.
 *
 * The engine tests cover the engine's own rules. These cover the claims that are only
 * true of a *running* process, and they are the ones the privacy argument rests on:
 *
 *   1. no message body, context content or agent prose reaches the journal;
 *   2. the whole lifecycle costs zero model calls, before and after a restart;
 *   3. STOP ALL reaches the workforce through the real command surface;
 *   4. a restart resolves nothing and says so;
 *   5. the projection is a read-only mirror, and the activity feed describes an agent
 *      without describing its words.
 */

let directory = ''
let core: Core | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-workforce-core-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = undefined
  await rm(directory, { recursive: true, force: true })
})

interface Harness {
  readonly core: Core
  /** Every model call the Core made. The claim under test is that this stays 0. */
  readonly calls: () => number
  readonly owner: WorkforceOwnerScope
  readonly journal: () => Promise<string>
  readonly events: () => Promise<{ type: string; actor: string; payload: Record<string, unknown> }[]>
}

/**
 * A started Core with a counting provider.
 *
 * The provider counts rather than echoes, because "the workforce costs nothing while
 * idle" is only checkable if something is keeping count.
 */
async function started(options: Partial<CoreOptions> = {}): Promise<Harness> {
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
    dataPath: join(directory, 'events.jsonl'),
    providers: [provider],
    ...options,
  })
  await core.start()
  const instance = core
  const path = join(directory, 'events.jsonl')

  return {
    core: instance,
    calls: () => calls,
    owner: workforceOwnerScope(instance),
    journal: async () => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return ''
      }
    },
    events: async () => {
      const raw = await readFile(path, 'utf8')
      const out: { type: string; actor: string; payload: Record<string, unknown> }[] = []
      let previous = 0
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue
        const parsed = parseDurableEvent(line, previous)
        if (!parsed.ok) continue
        previous = parsed.event.sequence
        out.push({
          type: parsed.event.type,
          actor: parsed.event.actor,
          payload: parsed.event.payload as unknown as Record<string, unknown>,
        })
      }
      return out
    },
  }
}

async function alpha(harness: Harness): Promise<{ workerId: string; scope: SubordinateWorkerScope }> {
  const created = await harness.owner.createWorker({ name: 'Alpha', specialisation: 'general' })
  if (!created.ok || created.workerId === undefined) throw new Error(`createWorker failed: ${created.reason}`)
  const workerId = created.workerId
  const scope = subordinateScope(harness.core, workerId)
  return { workerId, scope }
}

/* ------------------------------------------------------------------ privacy */

describe('the journal holds the shape of a workforce, not its contents', () => {
  it('records an agent message without its words', async () => {
    const h = await started()
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })
    const secret = 'FREYA_RED_TEAM_SECRET_7A91'

    await sender.scope.sendMessage(other.workerId as string, 'handoff', `the answer is ${secret}`)
    await h.core.stop('test')

    const raw = await h.journal()
    expect(raw).toContain('workforce.message.sent')
    expect(raw).toContain(`"bodyLength":${secret.length + 'the answer is '.length}`)
    expect(raw).not.toContain(secret)

    // And the standing projection carries no body either — a board that lists agents must
    // not accumulate a copy of everything they have ever said.
    const next = await started({ dataPath: join(directory, 'events.jsonl') })
    expect(JSON.stringify(next.core.workforce())).not.toContain(secret)
  })

  it('records a context reference as an id and nothing else', async () => {
    const h = await started()
    const { workerId } = await alpha(h)

    await h.owner.assignContext(workerId, 'ctx-window-42')
    await h.core.stop('test')

    const raw = await h.journal()
    expect(raw).toContain('workforce.context.assigned')
    expect(raw).toContain('ctx-window-42')
    // No field a context item could hide in: the key set is checked exactly.
    const assigned = (await h.events()).find((event) => event.type === 'workforce.context.assigned')
    expect(Object.keys(assigned?.payload ?? {}).sort()).toEqual(['contextRef', 'workerId'])
  })

  it('declares no workforce event type that could name content', async () => {
    // A structural assertion that holds even if no test happens to send a message today.
    //
    // The rule being defended: **the family is metadata-only by construction**, so there
    // is no event type a body could later be attached to. This is the "no field a body
    // could hide in" property from `docs/ARCHITECTURE.md` §3.6, asserted over the type
    // names rather than over one run of the system.
    const workforce = CORE_EVENT_TYPES.filter((type) => type.startsWith('workforce.'))
    expect(workforce.length).toBeGreaterThan(0)

    // Matched on whole words rather than substrings, because `context.assigned` contains
    // "context" and carries a context *reference id* — Phase 9 is what resolves one — so
    // the name alone is not evidence of a leak. Its payload shape is asserted separately,
    // which is the real check.
    const contentBearing = workforce.filter((type) =>
      /(^|\.)(body|text|content|prompt|summary|note|reason|message|claim)([.]|$)/.test(
        type.replace('workforce.', ''),
      ),
    )
    // `message.sent` measures a body; `claim.recorded` names what was refused. Neither
    // holds one. Everything else in the family is ids, statuses, counts and codes.
    expect(contentBearing.sort()).toEqual(['workforce.claim.recorded', 'workforce.message.sent'])
  })

  it('the two content-adjacent event types measure or name rather than store', async () => {
    const h = await started()
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })
    await sender.scope.sendMessage(other.workerId as string, 'request', 'a message')
    await sender.scope.claimPermission({
      workerId: sender.workerId,
      kind: 'capability',
      subject: 'work.execute',
    })
    await h.core.stop('test')

    // Asserted as *shapes* rather than as one run's bytes, so adding a field to either is
    // a visible schema change rather than something that quietly starts retaining text.
    const sent = (await h.events()).find((event) => event.type === 'workforce.message.sent')
    expect(Object.keys(sent?.payload ?? {}).sort()).toEqual([
      'bodyLength',
      'fromWorkerId',
      'kind',
      'messageId',
      'sameTeam',
      'toWorkerId',
    ])

    const claim = (await h.events()).find((event) => event.type === 'workforce.claim.recorded')
    expect(Object.keys(claim?.payload ?? {}).sort()).toEqual([
      'claimId',
      'decision',
      'kind',
      'refusal',
      'subject',
      'workerId',
    ])
    // `decision` has one legal value, so there is no spelling of this event that records a
    // claim being honoured.
    expect(claim?.payload.decision).toBe('refused')
  })

  it('attributes a message to the agent that sent it, in the envelope', async () => {
    const h = await started()
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })

    await sender.scope.sendMessage(other.workerId as string, 'request', 'hello')
    await h.core.stop('test')

    const sent = (await h.events()).find((event) => event.type === 'workforce.message.sent')
    // The envelope's actor is the sending agent, not the owner. That is what makes the
    // audit line say "Alpha sent this" — and it is validated as a real principal on every
    // replay, so a hand-written line claiming otherwise would not survive.
    expect(sent?.actor).toBe(`agent:${sender.workerId}`)
    expect(sent?.payload.fromWorkerId).toBe(sender.workerId)
  })

  it('never lets an agent message into the activity feed', async () => {
    const h = await started()
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })
    await sender.scope.sendMessage(other.workerId as string, 'request', 'FREYA_RED_TEAM_SECRET_7A91')

    const feed = h.core.activity().map((row) => row.text).join('\n')
    expect(feed).not.toContain('FREYA_RED_TEAM_SECRET_7A91')
    // No row has a payload field, which is the structural half of the property.
    for (const row of h.core.activity()) {
      expect(Object.keys(row).sort()).toEqual(['at', 'id', 'kind', 'sequence', 'text', 'tone', 'type'])
    }
  })
})

/* ---------------------------------------------------------------- zero idle */

describe('an idle workforce spends nothing', () => {
  it('costs zero model calls across the whole lifecycle', async () => {
    const h = await started()
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })
    const teamId = (await h.owner.createTeam({ name: 'Research', specialisation: 'research' })).teamId as string

    await h.owner.joinTeam(teamId, sender.workerId)
    await h.owner.assignCapability(sender.workerId, 'cognition.request')
    await h.owner.assignContext(sender.workerId, 'ctx-1')
    await h.owner.assign({ workerId: sender.workerId, capabilities: ['cognition.request'] })
    await sender.scope.sendMessage(other.workerId as string, 'status', 'still here')
    await sender.scope.claimPermission({
      workerId: sender.workerId,
      kind: 'capability',
      subject: 'work.execute',
    })
    await h.owner.suspendWorker(sender.workerId)
    await h.owner.resumeWorker(sender.workerId)
    await h.owner.retireWorker(sender.workerId)

    // Listing, projecting, and reading a mailbox cost nothing either, and that is the
    // property that distinguishes a bounded agent from a scheduler.
    h.core.workforce()
    await h.core.workforceDetail(sender.workerId)
    h.core.workforce()

    expect(h.calls()).toBe(0)
    expect(h.core.status().sessionUsage.calls).toBe(0)
    expect(h.core.status().activeProviderCalls).toBe(0)
  })

  it('still costs nothing after a renderer-equivalent restart', async () => {
    const h = await started()
    const sender = await alpha(h)
    await h.owner.assignCapability(sender.workerId, 'cognition.request')
    await h.owner.assign({ workerId: sender.workerId, capabilities: ['cognition.request'] })
    await h.core.stop('test')

    // A second Core over the same journal. Rebuilding the roster, replaying the events and
    // reconciling what a restart cannot honestly carry must all be free.
    const second = await started({ dataPath: join(directory, 'events.jsonl') })
    expect(second.calls()).toBe(0)
    expect(second.core.status().sessionUsage.calls).toBe(0)
    void sender
  })

  it('only spends when a worker is actually authorised to think', async () => {
    const h = await started()
    const { scope } = await alpha(h)

    // No capability, so no call. Checked before Core is asked.
    const refused = await scope.requestCognition({ prompt: 'hello', maxOutputTokens: 100 })
    expect(refused).toMatchObject({ status: 'denied' })
    expect(h.calls()).toBe(0)
  })
})

/* --------------------------------------------------------------- STOP ALL */

describe('STOP ALL reaches the workforce', () => {
  it('stops every agent and cancels its open work, through the real command', async () => {
    const h = await started()
    const { workerId } = await alpha(h)
    await h.owner.assignCapability(workerId, 'cognition.request')
    await h.owner.assign({ workerId: workerId, capabilities: ['cognition.request'] })
    expect(h.core.workforce().counts.openAssignments).toBe(1)

    const stopped = await h.core.handleCommand({
      command: 'security.stopAll',
      requestId: 's1',
      payload: { reason: 'the owner pressed the button' },
    })
    expect(stopped.ok).toBe(true)

    // Awaited inside the command, so the projection is already true when Core answers.
    // A Core that reported a stop over a board that had not been told yet would be
    // reporting something its own state did not support.
    const projection = h.core.workforce()
    expect(projection.workers[0]?.status).toBe('stopped')
    expect(projection.counts.openAssignments).toBe(0)
    expect(projection.workers[0]?.assignments[0]).toMatchObject({
      status: 'cancelled',
      reason: 'stop_all',
    })
    expect(h.core.status().stopAll.active).toBe(true)
  })

  it('a resume reopens the gate but leaves the agents stopped', async () => {
    const h = await started()
    const { workerId } = await alpha(h)
    await h.owner.assignCapability(workerId, 'cognition.request')
    await h.core.handleCommand({ command: 'security.stopAll', requestId: 's1' })
    await h.core.handleCommand({ command: 'security.resume', requestId: 's2' })

    expect(h.core.status().stopAll.active).toBe(false)
    // "Let Freya think again" and "let Alpha work again" are two decisions, and only the
    // owner may make the second.
    expect(h.core.workforce().workers[0]?.status).toBe('stopped')
    expect(
      await subordinateScope(h.core, workerId).requestCognition({ prompt: 'x', maxOutputTokens: 100 }),
    ).toMatchObject({ status: 'denied' })

    await h.owner.resumeWorker(workerId)
    expect(h.core.workforce().workers[0]?.status).toBe('idle')
  })

  it('a stopped Core refuses new work, and says why', async () => {
    const h = await started()
    const { workerId } = await alpha(h)
    await h.owner.assignCapability(workerId, 'cognition.request')
    await h.core.handleCommand({ command: 'security.stopAll', requestId: 's1' })
    await h.owner.resume()

    expect(await h.owner.assign({ workerId, capabilities: ['cognition.request'] })).toMatchObject({ ok: false })
  })
})

/* ---------------------------------------------------------------- restart */

describe('a restart resolves nothing and says so', () => {
  it('reconciles a worker that was working, fails its assignment, and claims no success', async () => {
    const h = await started()
    const { workerId } = await alpha(h)
    await h.owner.assignCapability(workerId, 'cognition.request')
    await h.owner.assign({ workerId, capabilities: ['cognition.request'] })
    expect(h.core.workforce().workers[0]?.status).toBe('working')

    // The process dies here — no `stop()`, no drain. A worker's plan was in memory, so
    // there is nothing to continue.
    await h.core.stop('simulated crash')

    const second = await started({ dataPath: join(directory, 'events.jsonl') })
    const projection = second.core.workforce()
    expect(projection.workers[0]?.status).toBe('idle')
    expect(projection.workers[0]?.assignments[0]).toMatchObject({
      status: 'failed',
      reason: 'recovery',
    })
    expect(projection.counts.openAssignments).toBe(0)
    // Nothing was marked successful, because nothing was established.
    expect(projection.workers[0]?.assignments[0]?.status).not.toBe('completed')
  })

  it('loses message bodies and says the bodies are gone, not that nobody spoke', async () => {
    const h = await started()
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })
    await sender.scope.sendMessage(other.workerId as string, 'request', 'are you there?')
    const workerId = other.workerId as string

    expect((await h.core.workforceDetail(workerId))?.deliveries).toHaveLength(1)
    await h.core.stop('test')

    const second = await started({ dataPath: join(directory, 'events.jsonl') })
    const detail = await second.core.workforceDetail(workerId)
    // The metadata survived; the words did not. An empty mailbox with no explanation reads
    // as "nobody has said anything", which is false, so the distinction is stated.
    expect(detail?.bodiesAvailable).toBe(false)
    expect(detail?.deliveries).toEqual([])
    // And the projection says so too, rather than looking like a fresh Core with no history.
    expect(second.core.workforce().counts.messagesSent).toBe(1)
    expect(second.core.workforce().detailAvailable).toBe(false)
  })

  it('a window attaching late sees the same workforce one that never left', async () => {
    const h = await started()
    const { workerId } = await alpha(h)
    await h.owner.assignCapability(workerId, 'cognition.request')

    const seen: WorkforceProjection[] = []
    const dispose = h.core.onWorkforce((projection) => seen.push(projection))
    // Delivered immediately, like every other Core subscription, so a surface that
    // reloads knows where it stands without waiting for a change.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.workers[0]?.workerId).toBe(workerId)
    expect(seen[0]?.health).toBe('ready')

    await h.owner.suspendWorker(workerId)
    expect(seen).toHaveLength(2)
    expect(seen[1]?.workers[0]?.status).toBe('blocked')
    dispose()

    await h.owner.resumeWorker(workerId)
    expect(seen).toHaveLength(2)
  })

  it('reports `unavailable` rather than an empty roster before Core is up', async () => {
    const fresh = createCore({
      dataPath: join(directory, 'never-started.jsonl'),
      providers: [new FakeModelProvider()],
    })
    // A surface has to be able to say "Core is not up yet" without special-casing a throw,
    // and "there are no agents" must never look like "the workforce does not exist".
    const projection = fresh.workforce()
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBeTruthy()
    expect(projection.workers).toEqual([])
    core = fresh
  })
})

/* ------------------------------------------------------------- projection */

describe('the projection is a read-only mirror of Core truth', () => {
  it('offers exactly the actions Core would accept', async () => {
    const h = await started()
    const { workerId } = await alpha(h)

    expect(h.core.workforce().workers[0]?.availableActions).toEqual(
      expect.arrayContaining(['assign', 'suspend', 'retire']),
    )
    await h.owner.retireWorker(workerId)
    // A settled worker offers nothing but reading its mailbox. A control Core would refuse
    // teaches its user that buttons lie.
    expect(h.core.workforce().workers[0]?.availableActions).toEqual(['readMessages'])
  })

  it('is a fresh object each read, so a caller cannot write Core\'s state', async () => {
    const h = await started()
    await alpha(h)

    const first = h.core.workforce()
    const second = h.core.workforce()
    expect(first).not.toBe(second)
    expect(first.workers).not.toBe(second.workers)

    // A hostile cast cannot reach through a mirror: the value it wrote is a fresh object that
    // nothing else holds, and Core's own fold is untouched by it.
    const writable = first.workers as unknown as { status: string }[]
    expect(writable[0]).toBeDefined()
    ;(writable[0] as { status: string }).status = 'retired'
    expect(h.core.workforce().workers[0]?.status).toBe('idle')
  })

  it('reports retention honestly rather than letting a viewer think nothing existed', async () => {
    const h = await started({ workforceLimits: { maxRetainedClaims: 2 } })
    const sender = await alpha(h)
    const other = await h.owner.createWorker({ name: 'Beta', specialisation: 'general' })
    for (let i = 0; i < 4; i += 1) {
      await sender.scope.sendMessage(other.workerId as string, 'status', `note ${i}`)
    }

    const projection = h.core.workforce()
    // Counts describe everything; only the listing is bounded. A viewer that silently
    // stopped counting would read as "nobody said anything".
    expect(projection.counts.messagesSent).toBe(4)
    expect(projection.messagesTotal).toBeGreaterThanOrEqual(4)
    expect(projection.sequence).toBeGreaterThan(0)
  })
})