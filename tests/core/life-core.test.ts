// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../core/index'
import type { CoreCommandName, CoreCommandResult } from '../../core/protocol/core-protocol'
import { lifeOwnerScope } from '../../core/testing'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { NO_LIFE_DOMAIN_REASON } from '../../core/protocol/life'
import type { LifeRecordInput } from '../../core/life/engine'
import { selectForRetention } from '../../core/life/admission'
import { deriveLifeDraft } from '../../core/life/derive'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { emptyLifeState } from '../../core/life/store'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'

/**
 * THE LIFE HISTORY DOMAIN INSIDE A REAL CORE.
 *
 * The claims this file proves: entries are durable and reconstructable after a
 * restart; provenance, revision lineage and withdrawal are preserved; a conflict
 * is disclosed rather than resolved; retention and projections are bounded; and
 * none of it costs a model call.
 */

interface Fixture {
  core: Core
  fake: FakeModelProvider
  dataPath: string
  dir: string
  submit(command: string, payload?: unknown): Promise<CoreCommandResult>
}

let requestCounter = 0

async function start(options: { vault?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-life-core-'))
  const dataPath = join(dir, 'events.jsonl')
  const fake = new FakeModelProvider()
  const core = createCore({
    dataPath,
    providers: [fake],
    attentionObserveSources: false,
    ...(options.vault && bindingAvailable
      ? { vault: { path: join(dir, 'freya.db'), keyProvider: new StaticVaultKeyProvider(testVaultKey()), binding: await loadTestBinding() } }
      : {}),
  })
  await core.start()
  return {
    core,
    fake,
    dataPath,
    dir,
    submit(command: string, payload?: unknown) {
      requestCounter += 1
      return core.handleCommand({
        command: command as CoreCommandName,
        requestId: `r-${requestCounter}`,
        payload,
      })
    },
  }
}

async function stop(fixture: Fixture | null): Promise<void> {
  if (fixture === null) return
  await fixture.core.stop('life test teardown')
  await rm(fixture.dir, { recursive: true, force: true })
}

function draft(overrides: Partial<LifeRecordInput> = {}): LifeRecordInput {
  return {
    kind: 'episode',
    title: 'A day at the observatory',
    summary: 'The owner visited the observatory.',
    body: 'The owner spent the afternoon at the observatory.',
    salience: 'medium',
    derivation: 'owner-stated',
    confidence: 'high',
    sourceDomain: 'owner',
    sourceId: null,
    actor: 'owner',
    references: [],
    occurredAt: '2026-03-01T12:00:00.000Z',
    tags: ['observatory'],
    ...overrides,
  }
}

describe('life history in Core', () => {
  it('reports unavailable before start and ready with an ephemeral store after', async () => {
    const fixture = await start()
    try {
      const projection = fixture.core.life()
      expect(projection.health).toBe('ready')
      expect(projection.persistence.mode).toBe('ephemeral')
      expect(projection.persistence.durable).toBe(false)
      expect(projection.counts.total).toBe(0)
    } finally {
      await stop(fixture)
    }
  })

  it('reports no-domain before a Core starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-life-nostart-'))
    const core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
    expect(core.life().health).toBe('unavailable')
    expect(core.life().reason).toBe(NO_LIFE_DOMAIN_REASON)
    await rm(dir, { recursive: true, force: true })
  })

  it('records an owner-stated entry with provenance and reads it back', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      const outcome = await scope.record(draft())
      expect(outcome.outcome).toBe('recorded')
      const entryId = outcome.entry!.entryId

      const projection = fixture.core.life()
      expect(projection.counts.total).toBe(1)
      expect(projection.counts.ownerStated).toBe(1)
      expect(projection.recent[0]!.entryId).toBe(entryId)
      expect(projection.recent[0]!.title).toBe('A day at the observatory')
      expect(projection.recent[0]!.summaryLength).toBe(draft().summary.length)
      expect((projection.recent[0] as unknown as Record<string, unknown>).summary).toBeUndefined()

      const read = await fixture.submit('life.entry.read', { entryId })
      expect(read.ok).toBe(true)
      expect(read.life?.entry?.body).toBe('The owner spent the afternoon at the observatory.')
      expect(read.life?.entry?.provenance.sourceDomain).toBe('owner')
      expect(read.life?.entry?.derivation).toBe('owner-stated')
      expect(read.life?.entry?.occurredAt).toBe('2026-03-01T12:00:00.000Z')
      expect(read.life?.entry?.dateKnown).toBe(true)
    } finally {
      await stop(fixture)
    }
  })

  it('never fabricates a date when evidence does not provide one', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      const outcome = await scope.record(draft({ occurredAt: null }))
      const read = await fixture.submit('life.entry.read', { entryId: outcome.entry!.entryId })
      expect(read.life?.entry?.occurredAt).toBeNull()
      expect(read.life?.entry?.dateKnown).toBe(false)
    } finally {
      await stop(fixture)
    }
  })

  it('caps confidence at the derivation class ceiling and never raises it', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      const observed = await scope.record(draft({ derivation: 'observed', confidence: 'low' }))
      expect(observed.entry!.confidence).toBe('low')
      const derived = await scope.record(
        draft({
          title: 'A derived summary',
          derivation: 'derived',
          confidence: 'verified',
          references: [{ domain: 'brain', refKind: 'memory', refId: 'memory-1', label: null }],
        }),
      )
      expect(derived.entry!.confidence).toBe('medium')
    } finally {
      await stop(fixture)
    }
  })

  it('refuses secret-shaped text and derived entries with no evidence', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      const secret = await scope.record(draft({ body: `the key is sk-${'a'.repeat(24)}` }))
      expect(secret.outcome).toBe('rejected')
      expect(secret.reason).toContain('API key')

      const noEvidence = await scope.record(
        draft({ derivation: 'derived', references: [], title: 'From nowhere' }),
      )
      expect(noEvidence.outcome).toBe('rejected')
      expect(noEvidence.reason).toContain('must name the evidence')
    } finally {
      await stop(fixture)
    }
  })

  it('keeps revision lineage traceable rather than mutating history', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      const first = await scope.record(draft())
      const entryId = first.entry!.entryId
      const revised = await scope.revise(entryId, { body: 'A corrected account.' }, 'owner corrected it')
      expect(revised.outcome).toBe('revised')
      expect(revised.entry!.revision).toBe(2)
      expect(revised.entry!.lineage).toHaveLength(1)
      expect(revised.entry!.lineage[0]!.revision).toBe(1)
      expect(revised.entry!.lineage[0]!.reason).toContain('owner corrected it')
      expect(revised.entry!.lineage[0]!.supersededContentHash).toMatch(/^[a-f0-9]{64}$/)

      const read = await fixture.submit('life.entry.read', { entryId })
      expect(read.life?.entry?.body).toBe('A corrected account.')
      expect(read.life?.entry?.revision).toBe(2)
      expect(read.life?.entry?.lineage).toHaveLength(1)
    } finally {
      await stop(fixture)
    }
  })

  it.skipIf(!bindingAvailable)('withdraws an entry and never silently reappears across restart', async () => {
    const fixture = await start({ vault: true })
    const entryId = (await lifeOwnerScope(fixture.core).record(draft())).entry!.entryId
    await lifeOwnerScope(fixture.core).withdraw(entryId, 'owner asked to forget')
    let read = await fixture.submit('life.entry.read', { entryId })
    expect(read.life?.entry?.status).toBe('withdrawn')

    const dataPath = fixture.dataPath
    const dir = fixture.dir
    await fixture.core.stop('restart for withdrawal test')

    const fake = new FakeModelProvider()
    const reopened = createCore({ dataPath, providers: [fake], attentionObserveSources: false })
    await reopened.start()
    try {
      const projection = reopened.life()
      expect(projection.counts.withdrawn).toBe(1)
      const timeline = await reopened.handleCommand({ command: 'life.timeline.read', requestId: 't1' })
      expect(timeline.life?.timeline?.items.some((item) => item.entryId === entryId)).toBe(false)
      const withWithdrawn = await reopened.handleCommand({
        command: 'life.timeline.read',
        requestId: 't2',
        payload: { includeWithdrawn: true },
      })
      const item = withWithdrawn.life?.timeline?.items.find((candidate) => candidate.entryId === entryId)
      expect(item?.status).toBe('withdrawn')
      read = await reopened.handleCommand({ command: 'life.entry.read', requestId: 't3', payload: { entryId } })
      expect(read.life?.entry?.status).toBe('withdrawn')
    } finally {
      await reopened.stop('life test teardown')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a conflict conflicted rather than resolving it by a later entry', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      const reference = [{ domain: 'brain' as const, refKind: 'memory' as const, refId: 'shared-memory', label: null }]
      const first = await scope.record(draft({ title: 'The trip was in March', references: reference }))
      const second = await scope.record(
        draft({ title: 'The trip was in June', body: 'A conflicting account.', references: reference }),
      )
      expect(second.conflicts).toContain(first.entry!.entryId)
      const projection = fixture.core.life()
      expect(projection.counts.conflicts).toBe(1)
      expect(projection.counts.conflicted).toBe(2)

      await scope.record(draft({ title: 'The trip was in September', references: reference }))
      const read = await fixture.submit('life.entry.read', { entryId: first.entry!.entryId })
      expect(read.life?.entry?.status).toBe('conflicted')
      expect(read.life?.entry?.conflicts.length).toBeGreaterThan(0)
    } finally {
      await stop(fixture)
    }
  })

  it('bounds the timeline and states the truncation', async () => {
    const fixture = await start()
    try {
      const scope = lifeOwnerScope(fixture.core)
      for (let index = 0; index < 5; index += 1) {
        await scope.record(
          draft({ title: `Entry ${index}`, occurredAt: `2026-01-0${index + 1}T00:00:00.000Z` }),
        )
      }
      const answer = await fixture.submit('life.timeline.read', { limit: 2 })
      expect(answer.life?.timeline?.items).toHaveLength(2)
      expect(answer.life?.timeline?.total).toBe(5)
      expect(answer.life?.timeline?.truncated).toBe(true)
      expect(answer.life?.timeline?.omittedCount).toBe(3)
      expect(answer.life?.timeline?.items[0]!.title).toBe('Entry 0')
    } finally {
      await stop(fixture)
    }
  })

  it('refuses payloads on the payloadless read and malformed timeline queries', async () => {
    const fixture = await start()
    try {
      const withPayload = await fixture.submit('life.status.read', { confidence: 'verified' })
      expect(withPayload.ok).toBe(false)
      expect(withPayload.life?.code).toBe('malformed-payload')

      const badKind = await fixture.submit('life.timeline.read', { kinds: ['not-a-kind'] })
      expect(badKind.ok).toBe(false)

      const badLimit = await fixture.submit('life.timeline.read', { limit: -1 })
      expect(badLimit.ok).toBe(false)

      const noId = await fixture.submit('life.entry.read', {})
      expect(noId.ok).toBe(false)

      const unknown = await fixture.submit('life.entry.read', { entryId: 'life:nope' })
      expect(unknown.ok).toBe(false)
      expect(unknown.life?.code).toBe('unknown-entry')
    } finally {
      await stop(fixture)
    }
  })

  it('derives a life entry from an autobiographical Brain memory', async () => {
    const fixture = await start()
    try {
      await fixture.submit('brain.memory.write', {
        content: 'Freya learned that she prefers mornings.',
        subject: 'freya preference',
        kind: 'autobiographical',
      })
      let total = 0
      for (let attempt = 0; attempt < 40 && total === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        total = fixture.core.life().counts.total
      }
      expect(total).toBe(1)
      const timeline = await fixture.submit('life.timeline.read')
      const item = timeline.life?.timeline?.items[0]
      expect(item?.sourceDomain).toBe('brain')
      expect(item?.derivation).toBe('observed')
      const read = await fixture.submit('life.entry.read', { entryId: item!.entryId })
      expect(read.life?.entry?.body).toBe('')
      expect(JSON.stringify(read.life?.entry)).not.toContain('prefers mornings')
    } finally {
      await stop(fixture)
    }
  })

  it('costs no model call across recording, reading and restart', async () => {
    const fixture = await start()
    const entryId = (await lifeOwnerScope(fixture.core).record(draft())).entry!.entryId
    await fixture.submit('life.status.read')
    await fixture.submit('life.timeline.read')
    await fixture.submit('life.entry.read', { entryId })
    expect(fixture.fake.calls).toBe(0)
    expect(fixture.core.status().durableUsage.calls).toBe(0)
    await stop(fixture)
  })
})

describe('life pure functions', () => {
  it('selects the oldest, least salient entries for bounded retention', () => {
    const state = emptyLifeState()
    const make = (entryId: string, salience: 'low' | 'high', recordedAt: string) => {
      state.entries.set(entryId, {
        entryId,
        kind: 'episode',
        title: 't',
        summary: '',
        body: '',
        status: 'live',
        salience,
        derivation: 'observed',
        confidence: 'medium',
        provenance: {
          sourceDomain: 'system',
          sourceId: null,
          observedAt: recordedAt,
          recordedAt,
          actor: 'system',
          derivation: 'observed',
          confidence: 'medium',
        },
        references: [],
        occurredAt: null,
        recordedAt,
        updatedAt: recordedAt,
        revision: 1,
        supersedes: null,
        lineage: [],
        tags: [],
        admissionReason: 'test',
      })
    }
    make('e-high', 'high', '2026-01-01T00:00:00.000Z')
    make('e-low-old', 'low', '2026-01-02T00:00:00.000Z')
    make('e-low-new', 'low', '2026-01-03T00:00:00.000Z')
    expect(selectForRetention(state, 2)).toEqual(['e-low-old', 'e-low-new'])
  })

  it('derives a deterministic, content-free draft from an authoritative event', () => {
    const event = {
      type: 'mission.completed',
      occurredAt: '2026-02-01T00:00:00.000Z',
      actor: 'owner',
      payload: { missionId: 'mission-1', from: 'active', to: 'completed', reason: null, verifierId: 'v1' },
    } as unknown as AnyCoreEvent
    const first = deriveLifeDraft(event)
    const second = deriveLifeDraft(event)
    expect(first).not.toBeNull()
    expect(first!.entryId).toBe(second!.entryId)
    expect(first!.entryId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
    expect(first!.kind).toBe('milestone')
    expect(first!.derivation).toBe('observed')
    expect(first!.references[0]).toEqual({
      domain: 'mission',
      refKind: 'mission',
      refId: 'mission-1',
      label: null,
    })
    expect(first!.body).toBe('')
    expect(first!.summary).not.toContain('mission-1')
  })
})
