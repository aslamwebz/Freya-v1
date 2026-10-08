// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { initialCoreState, reduceCoreState } from '../../core/state'
import { createCore } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { ownerAuthority } from '../../core/testing'

let dir: string
let path: string
let quarantine: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-reconcile-'))
  path = join(dir, 'events.jsonl')
  quarantine = path + '.quarantine'
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function event(branch: 'shared' | 'old' | 'new', sequence: number, type: string, payload: unknown): AnyCoreEvent {
  return { eventId: `${branch}-${sequence}`, sequence, type, schemaVersion: 1,
    occurredAt: branch === 'new' ? '2026-10-07T19:00:00.000Z' : '2026-10-07T18:00:00.000Z',
    source: 'core', actor: 'system', correlationId: `${branch}-corr-${sequence}`, causationId: null,
    payload } as AnyCoreEvent
}
const lines = (events: readonly AnyCoreEvent[]) => events.map(e => JSON.stringify(e) + '\n').join('')
function fixture(stop = false) {
  const turn = { conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: null,
    assistantMessageId: null, contentLength: 0, requestId: null, providerId: null,
    model: null, outcome: 'started', reason: null }
  const prefix = [event('shared', 1, 'core.ready', {}), event('shared', 2, 'conversation.turn.started', turn)]
  const older = [...prefix,
    event('old', 3, 'conversation.turn.interrupted', { ...turn, conversationId: '', outcome: 'interrupted' }),
    event('old', 4, 'command.received', { commandId: 'old-command', contentLength: 1, source: 'test' }),
    ...(stop ? [event('old', 5, 'security.stop_all.activated', { by: 'owner', reason: 'old STOP must survive' })] : []),
  ]
  const fault = event('new', 3, 'core.integrity_fault', {
    reason: 'payload does not match the shape of conversation.turn.interrupted', line: 3,
    quarantinePath: quarantine, trustedPrefixEvents: 2, trustedPrefixBytes: Buffer.byteLength(lines(prefix)), damagedBytes: 100,
  })
  const newer = [...prefix, fault,
    event('new', 4, 'core.degraded', { reason: 'the event journal was found corrupt; see the preceding integrity fault' }),
    event('new', 5, 'cognition.grant.created', { grantId: 'new-grant', createdBy: 'owner',
      expiresAt: '2027-01-01T00:00:00.000Z', allowedOrigins: ['user'], allowedCauses: ['user_message'],
      goalId: null, runId: null, actor: null, backgroundAllowed: false, maxCalls: 5, maxOutputTokens: 100 }),
    event('new', 6, 'cognition.requested', { requestId: 'new-request', origin: 'user', cause: 'user_message',
      maxOutputTokens: 100, requestedModel: null, parentRunId: null, goalId: null }),
    event('new', 7, 'cognition.allowed', { requestId: 'new-request', grantId: 'new-grant' }),
    event('new', 8, 'cognition.grant.reserved', { grantId: 'new-grant', requestId: 'new-request', outputTokenBudgetReserved: 100 }),
    event('new', 9, 'model.request.started', { requestId: 'new-request', grantId: 'new-grant', providerId: 'fake',
      model: 'fake-model', maxOutputTokens: 100, startedAt: '2026-10-07T19:00:00.000Z' }),
    event('new', 10, 'model.request.completed', { requestId: 'new-request', providerId: 'fake', model: 'fake-model', inputTokens: 20, outputTokens: 10 }),
    event('new', 11, 'cognition.grant.usage_reported', { grantId: 'new-grant', requestId: 'new-request', inputTokens: 20, outputTokens: 10 }),
    event('new', 12, 'cognition.grant.revoked', { grantId: 'new-grant', revokedBy: 'owner', reason: 'keep revocation' }),
    event('new', 13, 'guard.decision', { outcome: 'deny', reason: 'journal-not-trustworthy', capability: 'cognition.request', principal: 'owner' }),
  ]
  return { prefix, older, newer }
}
async function seed(data: ReturnType<typeof fixture>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(quarantine, lines(data.older))
  await writeFile(path, lines(data.newer))
}
function unchangedIdentity(event: AnyCoreEvent) { const { sequence: _sequence, ...identity } = event; return identity }

describe('reconcile a known quarantine with later authority history', () => {
  it('retains every later event, its identity and accounting, and the original files', async () => {
    const data = fixture(true)
    await seed(data)
    const originalActive = await readFile(path, 'utf8')
    const originalQuarantine = await readFile(quarantine, 'utf8')
    const store = await JsonlEventStore.open(path)
    try {
      const report = store.knownRepairReport()
      expect(report).not.toBeNull()
      const recovered = await store.readAll()
      expect(recovered).toHaveLength(data.older.length + data.newer.length - data.prefix.length + 1)
      const byId = new Map(recovered.map(e => [e.eventId, e]))
      for (const original of data.newer) expect(unchangedIdentity(byId.get(original.eventId)!)).toEqual(unchangedIdentity(original))
      expect(byId.get('old-3')?.payload).toMatchObject({ conversationId: 'conversation-1' })
      expect(recovered.at(-1)?.type).toBe('core.integrity_repaired')
      const state = recovered.reduce(reduceCoreState, initialCoreState())
      expect(state.integrityFault).toBeNull()
      expect(state.stopAll.active).toBe(true)
      expect(state.durableUsage).toMatchObject({ calls: 1, inputTokens: 20, outputTokens: 10 })
      expect(state.grants[0]).toMatchObject({ id: 'new-grant', revokedBy: 'owner', usage: { calls: 1, outputTokenBudgetReserved: 100, inputTokens: 20, outputTokens: 10 } })
      expect(await readFile(report!.archivedDegradedPath!, 'utf8')).toBe(originalActive)
      expect(await readFile(quarantine, 'utf8')).toBe(originalQuarantine)
    } finally { await store.close() }
    const reopened = await JsonlEventStore.open(path)
    try { expect(reopened.knownRepairReport()).toBeNull(); expect((await reopened.readAll()).reduce(reduceCoreState, initialCoreState()).integrityFault).toBeNull() }
    finally { await reopened.close() }
  })

  it('starts trusted and serves cognition on two restarts without losing newer history', async () => {
    await seed(fixture())
    const provider = new FakeModelProvider()
    for (let attempt = 0; attempt < 2; attempt++) {
      const core = createCore({ dataPath: path, providers: [provider] })
      try {
        await core.start()
        expect(core.status()).toMatchObject({ lifecycle: 'ready', operational: true, integrity: { integrity: 'ok' } })
        expect((await core.conversation()).cognition.available).toBe(true)
        const outcome = await ownerAuthority(core).request({ kind: 'user_turn', prompt: 'synthetic repaired turn', maxOutputTokens: 100 })
        expect(outcome.status).toBe('allowed')
      } finally { await core.stop('test-stop') }
    }
    expect(provider.calls).toBe(2)
    const all = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as AnyCoreEvent)
    expect(all.filter(e => e.type === 'core.integrity_repaired')).toHaveLength(1)
  })

  it('preserves unrelated health faults when the journal fault is resolved', async () => {
    const data = fixture()
    data.newer.push(event('new', 14, 'core.degraded', { reason: 'independent Brain failure' }))
    await seed(data)
    const core = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
    try {
      await core.start()
      expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true, integrity: { integrity: 'ok' } })
      expect(core.status().faults).toContain('independent Brain failure')
      expect(core.status().faults).not.toContain('the event journal was found corrupt; see the preceding integrity fault')
    } finally { await core.stop('test-stop') }
  })

  it.each(['prefix mismatch', 'overlapping identities', 'interleaved times', 'extra unresolved fault', 'unknown damaged row'])('refuses %s without changing either journal', async kind => {
    const data = fixture()
    if (kind === 'prefix mismatch') data.newer[0] = { ...data.newer[0]!, correlationId: 'mismatched-prefix' }
    if (kind === 'overlapping identities') data.newer[5] = { ...data.newer[5]!, eventId: 'old-4' }
    if (kind === 'interleaved times') data.older[3] = { ...data.older[3]!, occurredAt: '2026-10-07T20:00:00.000Z' }
    if (kind === 'extra unresolved fault') data.older.push(event('old', 5, 'core.integrity_fault', { ...(data.newer[2]!.payload as object), quarantinePath: path + '.unknown' }))
    if (kind === 'unknown damaged row') data.older[3] = event('old', 4, 'core.ready', { malformed: true })
    await seed(data)
    const original = await readFile(path, 'utf8')
    const store = await JsonlEventStore.open(path)
    try { expect(store.knownRepairReport()).toBeNull(); expect(await readFile(path, 'utf8')).toBe(original) }
    finally { await store.close() }
  })

  it('does not acknowledge an unrelated unresolved fault when fixing a raw interrupted ID', async () => {
    const data = fixture()
    const olderFault = { ...data.newer[2]!, sequence: 1, eventId: 'other-fault',
      payload: { ...(data.newer[2]!.payload as object), reason: 'unknown security history corruption',
        quarantinePath: path + '.unrelated', line: 1, trustedPrefixEvents: 0 } } as AnyCoreEvent
    const raw = [olderFault, ...data.older.map(e => ({ ...e, sequence: e.sequence + 1 }))]
    await writeFile(path, lines(raw))
    const store = await JsonlEventStore.open(path)
    try {
      expect(store.knownRepairReport()).toBeNull()
      expect((await store.readAll()).reduce(reduceCoreState, initialCoreState()).integrityFault).not.toBeNull()
      expect(store.recoveryReport().trustworthy).toBe(false)
    } finally { await store.close() }
  })

  it.each([false, true])('requires earlier shared-prefix faults to be resolved (already resolved: %s)', async alreadyResolved => {
    const data = fixture()
    const earlierFault = { ...data.newer[2]!, eventId: 'earlier-fault',
      payload: { ...(data.newer[2]!.payload as object), reason: 'unrelated earlier gap',
        quarantinePath: path + '.earlier', line: 1, trustedPrefixEvents: 0 } } as AnyCoreEvent
    const inserted = [earlierFault]
    if (alreadyResolved) inserted.push({ ...event('shared', 1, 'core.integrity_repaired', {
      code: 'legacy-tool-loop-request-id', repairedEvents: 1,
      sourceQuarantinePath: path + '.earlier', archivedDegradedPath: null,
    }), eventId: 'earlier-repair' })
    // Insert the older fault/acknowledgment in the exact common prefix and adjust
    // only the synthetic fixture's envelope positions and known boundary.
    data.older = [...inserted, ...data.older].map((e, i) => ({ ...e, sequence: i + 1 }))
    data.newer = [...inserted, ...data.newer].map((e, i) => ({ ...e, sequence: i + 1 }))
    const fault = data.newer.find(e => e.eventId === 'new-3')!
    fault.payload = { ...(fault.payload as object), trustedPrefixEvents: 2 + inserted.length, line: 3 + inserted.length } as typeof fault.payload
    await seed(data)
    const store = await JsonlEventStore.open(path)
    try {
      expect(store.knownRepairReport() !== null).toBe(alreadyResolved)
      expect((await store.readAll()).reduce(reduceCoreState, initialCoreState()).integrityFault === null).toBe(alreadyResolved)
    } finally { await store.close() }
  })
})
