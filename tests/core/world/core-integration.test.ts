// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCore, type Core } from '../../../core/index'
import { CAPABILITIES, WORKER_CAPABILITIES, type CoreCommandName, type CoreCommandResult } from '../../../core/protocol/core-protocol'
import type { WorldCommandOutcome } from '../../../core/protocol/world'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { workerAuthority } from '../../../core/testing'
import { EphemeralWorldStore } from '../../../core/world'
import { emptyHolder, memoryStore } from './fixture'

/**
 * THE WORLD IN CORE — wiring, Guard, and the read/write split.
 *
 * The claims under test:
 *
 * 1. Core builds and owns the world, and reports an absent world honestly before it
 *    does.
 * 2. **Every world command is Guard-evaluated**, and a refusal is journalled rather
 *    than only returned.
 * 3. **No worker capability touches the world** — neither the reads nor the writes.
 * 4. **The renderer route is read-only.** The five reads work; the two owner writes are
 *    Core-internal and are not on the renderer command allowlist at all.
 * 5. A payload carrying a claim-shaped field is refused **whole**.
 * 6. Reading the world **spends nothing** and stops nothing.
 */


let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-world-core-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

let requestCounter = 0

async function startedWorld(
  options: { durable?: boolean; providers?: FakeModelProvider[] } = {},
): Promise<{ core: Core; stop: () => Promise<void> }> {
  requestCounter = 0
  const core = createCore({
    // A file, not a directory: every encrypted store in Core derives its own path by
    // appending a suffix to this one.
    dataPath: join(dir, 'events.jsonl'),
    providers: options.providers ?? [new FakeModelProvider()],
    // No `worldKey` any more: Phase 22 shares the one canonical Vault, and a binding is
    // not selected yet, so this suite supplies the port explicitly rather than opening
    // a database. Durability itself is proven in the binding-gated Vault suites; what
    // these tests are about is the Core-facing contract either way, so the default here
    // is the durable one and `{ durable: false }` is the ephemeral path.
    worldStore: options.durable === false ? new EphemeralWorldStore() : memoryStore(emptyHolder()),
  })
  await core.start()
  return { core, stop: () => core.stop() }
}

function submit(core: Core, command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> {
  requestCounter += 1
  return core.handleCommand({
    command,
    requestId: `w-${requestCounter}`,
    ...(payload === undefined ? {} : { payload }),
  })
}

function world(result: CoreCommandResult): WorldCommandOutcome | undefined {
  return result.world
}

describe('Core builds and owns the world', () => {
  it('reports a world summary once it has started', async () => {
    const { core, stop } = await startedWorld()
    const result = await submit(core, 'world.summary.read')
    expect(result.ok).toBe(true)
    const outcome = world(result)
    expect(outcome?.operation).toBe('summary')
    if (outcome?.operation !== 'summary') return
    expect(outcome.summary.health).toBe('ready')
    expect(outcome.summary.persistence.mode).toBe('encrypted')
    expect(outcome.summary.persistence.durable).toBe(true)
    await stop()
  })

  it('reports an absent world rather than an empty one when there is no durable store', async () => {
    const { core, stop } = await startedWorld({ durable: false })
    const result = await submit(core, 'world.summary.read')
    const outcome = world(result)
    if (outcome?.operation !== 'summary') throw new Error('expected a summary')
    expect(outcome.summary.health).toBe('ready')
    expect(outcome.summary.persistence.mode).toBe('ephemeral')
    expect(outcome.summary.persistence.durable).toBe(false)
    expect(outcome.summary.persistence.reason).toContain('will not survive a restart')
    await stop()
  })

  it('pushes the summary to a subscriber and delivers it on attach', async () => {
    const { core, stop } = await startedWorld()
    const seen: number[] = []
    const detach = core.onWorld((projection) => seen.push(projection.counts.entities))
    // Delivered immediately, so a window that just reloaded agrees with one that never
    // left rather than waiting for the next change to find out.
    expect(seen.length).toBe(1)
    await submit(core, 'world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Ana' })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBeGreaterThan(seen[0] ?? 0)
    detach()
    await stop()
  })
})

describe('every world command is Guard-evaluated', () => {
  it('holds exactly two world capabilities, neither of them a worker one', () => {
    const worldCapabilities = CAPABILITIES.filter((capability) => capability.startsWith('world.'))
    expect(worldCapabilities).toEqual(['world.status.read', 'world.statement.submit'])
    for (const capability of worldCapabilities) {
      expect(WORKER_CAPABILITIES).not.toContain(capability)
    }
  })

  it('refuses a world read for a principal Guard does not trust', async () => {
    const { core, stop } = await startedWorld()
    // A worker's authority object has no world method on it at all, so there is nothing
    // to call even before Guard is consulted.
    const worker = workerAuthority(core, 'agent:alpha')
    expect(Object.keys(worker).sort()).toEqual(['principalId', 'request'])
    // And a worker principal holds neither world capability, whichever route is taken.
    for (const capability of ['world.status.read', 'world.statement.submit']) {
      expect(capability in worker).toBe(false)
    }
    await stop()
  })

  it('answers a world command refusal with `ok: false` on the envelope as well', async () => {
    const { core, stop } = await startedWorld()
    // An unknown command is the cheapest way to see the refusal shape Core uses, and
    // the same shape a Guard refusal lands in.
    const result = await submit(core, 'world.entity.create' as CoreCommandName, { name: 'Atlas' })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unknown command')
    expect(result.world).toBeUndefined()
    await stop()
  })
})

describe('the renderer route is read-only', () => {
  it('answers all five reads', async () => {
    const { core, stop } = await startedWorld()

    const summary = world(await submit(core, 'world.summary.read'))
    expect(summary?.operation).toBe('summary')

    const entities = world(await submit(core, 'world.entities.read'))
    expect(entities?.operation).toBe('entities')

    const relations = world(await submit(core, 'world.relations.read'))
    expect(relations?.operation).toBe('relations')

    const self = world(await submit(core, 'self.status.read'))
    expect(self?.operation).toBe('self')

    const detail = world(await submit(core, 'world.entity.read', { entityId: 'ent_0123456789abcdef' }))
    expect(detail?.operation).toBe('entity')

    await stop()
  })

  it('admits an owner statement, and the owner statement is a claim not a fact', async () => {
    const { core, stop } = await startedWorld()
    const result = await submit(core, 'world.statement.submit', {
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    })
    expect(result.ok).toBe(true)
    const outcome = world(result)
    if (outcome?.operation !== 'submitted') throw new Error('expected a submission')
    expect(outcome.evidenceId).toMatch(/^wev-/)
    expect(outcome.summary.counts.claimedEdges).toBe(1)

    const graph = world(await submit(core, 'world.relations.read'))
    if (graph?.operation !== 'relations') throw new Error('expected a graph')
    expect(graph.relations.edges[0]?.provenance.source).toBe('owner-assertion')
    expect(graph.relations.edges[0]?.provenance.epistemic).toBe('asserted')
    await stop()
  })

  it('withdraws a claim the owner named by id', async () => {
    const { core, stop } = await startedWorld()
    const submitted = world(await submit(core, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
    }))
    if (submitted?.operation !== 'submitted') throw new Error('expected a submission')

    const withdrawn = world(
      await submit(core, 'world.statement.withdraw', {
        targetEvidenceId: submitted.evidenceId,
        reason: 'that is not right',
      }),
    )
    expect(withdrawn?.operation).toBe('withdrawn')
    const entities = world(await submit(core, 'world.entities.read'))
    if (entities?.operation !== 'entities') throw new Error('expected entities')
    expect(entities.entities.entities.some((entity) => entity.name === 'Ana')).toBe(false)
    await stop()
  })

  it('refuses a statement whose payload states its own trust', async () => {
    const { core, stop } = await startedWorld()
    // Every one of these is refused **whole**, by name. A payload that arrived with
    // `authority: 'owner'` in it is not a payload whose owner field happens to be
    // ignored: treating it as one would make the attempt invisible, and the attempt is
    // the thing worth seeing.
    for (const key of ['authority', 'source', 'trust', 'actor', 'verified', 'principal', 'grant', 'epistemic']) {
      const result = await submit(core, 'world.statement.submit', {
        kind: 'entity',
        entityType: 'person',
        name: 'Ana',
        [key]: 'owner',
      })
      expect(result.ok).toBe(false)
      const outcome = world(result)
      if (outcome?.operation !== 'refused') throw new Error(`expected a refusal for ${key}`)
      expect(outcome.code).toBe('claim_fields_not_admissible')
    }
    await stop()
  })

  it('refuses a confidence outside the closed vocabulary rather than ranking it as undefined', async () => {
    const { core, stop } = await startedWorld()
    // A rank comparison against a value that is not in the vocabulary yields
    // `undefined`, which compares as "not greater than the ceiling" and would therefore
    // slip through. Membership is checked first, which is the whole point.
    for (const confidence of ['certain', 'owner', '', 1, true, {}]) {
      const result = await submit(core, 'world.statement.submit', {
        kind: 'entity',
        entityType: 'person',
        name: 'Ana',
        confidence,
      })
      expect(result.ok).toBe(false)
      const outcome = world(result)
      if (outcome?.operation !== 'refused') throw new Error('expected a refusal')
      expect(outcome.code).toBe('confidence_above_channel')
    }
    // An explicit `null` means "I am not stating one", which is different from stating
    // a bad one, and takes the channel's own ceiling.
    const stated = await submit(core, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      confidence: null,
    })
    expect(stated.ok).toBe(true)
    await stop()
  })

  it('refuses a payload that is not a world statement at all', async () => {
    const { core, stop } = await startedWorld()
    for (const payload of [[], 'a string', 42, null]) {
      const result = await submit(core, 'world.statement.submit', payload)
      expect(result.ok).toBe(false)
    }
    await stop()
  })
})

describe('the read commands are argument-free or narrowly bounded', () => {
  it('refuses a payload on the two payloadless reads', async () => {
    const { core, stop } = await startedWorld()
    for (const command of ['world.summary.read', 'self.status.read'] as const) {
      const result = await submit(core, command, { anything: 'at all' })
      expect(result.ok).toBe(false)
      const outcome = world(result)
      if (outcome?.operation !== 'refused') throw new Error('expected a refusal')
      expect(outcome.code).toBe('no-payload')
    }
    await stop()
  })

  it('refuses an unknown field on the entity list, so a read cannot become a query', async () => {
    const { core, stop } = await startedWorld()
    const result = await submit(core, 'world.entities.read', { where: 'name = "Ana"' })
    expect(result.ok).toBe(false)
    const outcome = world(result)
    if (outcome?.operation !== 'refused') throw new Error('expected a refusal')
    expect(outcome.code).toBe('unknown-field')
    await stop()
  })

  it('refuses an unknown entity kind rather than treating it as no filter', async () => {
    const { core, stop } = await startedWorld()
    const result = await submit(core, 'world.entities.read', { kind: 'unicorn' })
    expect(result.ok).toBe(false)
    await stop()
  })

  it('refuses a graph read that asks for more than two hops', async () => {
    const { core, stop } = await startedWorld()
    for (const maxDepth of [3, 99, -1, 1.5, '2']) {
      const result = await submit(core, 'world.relations.read', { maxDepth })
      expect(result.ok).toBe(false)
    }
    await stop()
  })

  it('refuses an entity read that asks for anything but one id', async () => {
    const { core, stop } = await startedWorld()
    for (const payload of [{}, { entityId: 'a', extra: 1 }, { entityIds: ['a'] }]) {
      const result = await submit(core, 'world.entity.read', payload)
      expect(result.ok).toBe(false)
    }
    await stop()
  })
})

describe('reading the world spends nothing and stops nothing', () => {
  it('makes no provider call for any world read', async () => {
    const provider = new FakeModelProvider()
    const { core, stop } = await startedWorld({ providers: [provider] })
    const before = provider.calls

    await submit(core, 'world.summary.read')
    await submit(core, 'world.entities.read')
    await submit(core, 'world.relations.read')
    await submit(core, 'self.status.read')
    await submit(core, 'world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Ana' })
    await submit(core, 'world.entities.read')

    // The whole subsystem, read and written, must leave the meter untouched.
    expect(provider.calls).toBe(before)
    await stop()
  })

  it('leaves STOP ALL exactly as it found it', async () => {
    const { core, stop } = await startedWorld()
    const before = core.status().stopAll
    await submit(core, 'world.summary.read')
    await submit(core, 'world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Ana' })
    expect(core.status().stopAll).toEqual(before)
    await stop()
  })

  it('still reads while STOP ALL is active, because reading is not acting', async () => {
    const { core, stop } = await startedWorld()
    await submit(core, 'security.stopAll', { reason: 'the red team asked' })
    expect(core.status().stopAll.active).toBe(true)
    const result = await submit(core, 'world.summary.read')
    expect(result.ok).toBe(true)
    // The world still refuses to *grow* while stopped: nothing new may be believed
    // while Freya cannot act on what she believes.
    const submitted = await submit(core, 'world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Bo' })
    expect(submitted.ok).toBe(false)
    await stop()
  })
})