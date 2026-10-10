// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-proactive-test-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 6A — Unified Event Awareness & Proactive Engine', () => {
  it('exposes initial proactive status with empty subscriptions and recent observations', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const res = await core.handleCommand({
      command: 'proactive.status.read',
      requestId: 'req-status-1',
    })

    expect(res.ok).toBe(true)
    expect(res.proactive).toBeDefined()
    expect(res.proactive!.operation).toBe('status')
    expect(res.proactive!.subscriptions).toHaveLength(0)
    expect(res.proactive!.recentObservations).toHaveLength(0)
    expect(core.observationSubscriptions()).toHaveLength(0)
    expect(core.recentObservations()).toHaveLength(0)
  })

  it('ingests internal observations with provenance separating observed, claimed, and verified', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const ingestResult = await core.ingestObservation({
      sourceType: 'internal',
      sourceId: 'longhorizon',
      sourceRef: 'ms-launch-mvp',
      rawSummary: 'Milestone ms-launch-mvp reached verified status',
      goalId: 'goal-launch',
      milestoneId: 'ms-launch-mvp',
      predicate: 'milestone-settled',
    })

    expect(ingestResult.ok).toBe(true)
    expect(ingestResult.observation).toBeDefined()
    const obs = ingestResult.observation!

    // Invariant: Provenance separated
    expect(obs.sourceType).toBe('internal')
    expect(obs.sourceId).toBe('longhorizon')
    expect(obs.sourceRef).toBe('ms-launch-mvp')
    expect(obs.trust).toBe('verified_internal')
    expect(obs.verificationStatus).toBe('verified') // internal trusted subsystem
    expect(obs.claim.rawSummary).toBe('Milestone ms-launch-mvp reached verified status')
    expect(obs.claim.predicate).toBe('milestone-settled')
    expect(obs.dedupeKey).toContain('longhorizon')
    expect(obs.dedupeKey.length).toBeGreaterThanOrEqual(32)

    // Cached in recent observations
    const recent = core.recentObservations()
    expect(recent).toHaveLength(1)
    expect(recent[0]!.observationId).toBe(obs.observationId)
  })

  it('strictly rejects unauthorized external observation sources without active subscription', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // External connector observation without subscription
    const res = await core.handleCommand({
      command: 'proactive.observation.ingest',
      requestId: 'req-ext-1',
      payload: {
        sourceType: 'connector',
        sourceId: 'github-repo-monitor',
        sourceRef: 'commit-abc1234',
        rawSummary: 'New commit on main branch',
      },
    })

    expect(res.ok).toBe(false)
    expect(res.refusal).toBeDefined()
    expect(res.refusal!.reason).toContain('unauthorized-source')
    expect(res.proactive!.operation).toBe('ingest')
    expect(res.proactive!.ok).toBe(false)
  })

  it('authorizes external observations under registered subscription with consent and type limits', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // 1. Register subscription with consent
    const subRes = await core.handleCommand({
      command: 'proactive.subscription.manage',
      requestId: 'req-sub-1',
      payload: {
        action: 'subscribe',
        sourceId: 'github-repo-monitor',
        sourceType: 'connector',
        scope: 'repo:owner/my-project',
        allowedTypes: ['commit-pushed', 'release-published'],
        consentGranted: true,
      },
    })

    expect(subRes.ok).toBe(true)
    expect(subRes.proactive!.operation).toBe('subscribe')
    const subId = subRes.proactive!.subscriptionId!
    expect(subId).toBeDefined()

    expect(core.observationSubscriptions()).toHaveLength(1)
    expect(core.observationSubscriptions()[0]!.sourceId).toBe('github-repo-monitor')

    // 2. Ingest matching observation with allowed type
    const ingestRes = await core.handleCommand({
      command: 'proactive.observation.ingest',
      requestId: 'req-ext-2',
      payload: {
        sourceType: 'connector',
        sourceId: 'github-repo-monitor',
        sourceRef: 'commit-sha-456',
        predicate: 'commit-pushed',
        rawSummary: 'Commit pushed by team lead',
      },
    })

    expect(ingestRes.ok).toBe(true)
    expect(ingestRes.proactive!.operation).toBe('ingest')
    expect(ingestRes.proactive!.ok).toBe(true)

    // 3. Ingest observation with unallowed type -> rejected as scope-mismatch
    const mismatchRes = await core.handleCommand({
      command: 'proactive.observation.ingest',
      requestId: 'req-ext-3',
      payload: {
        sourceType: 'connector',
        sourceId: 'github-repo-monitor',
        sourceRef: 'issue-789',
        predicate: 'issue-opened',
        rawSummary: 'New issue opened',
      },
    })

    expect(mismatchRes.ok).toBe(false)
    expect(mismatchRes.refusal!.reason).toContain('scope-mismatch')

    // 4. Revoke subscription
    const revokeRes = await core.handleCommand({
      command: 'proactive.subscription.manage',
      requestId: 'req-revoke-1',
      payload: {
        action: 'revoke',
        subscriptionId: subId,
      },
    })

    expect(revokeRes.ok).toBe(true)
    expect(revokeRes.proactive!.operation).toBe('revoke')

    // 5. Ingest after revoke -> rejected
    const afterRevokeRes = await core.handleCommand({
      command: 'proactive.observation.ingest',
      requestId: 'req-ext-4',
      payload: {
        sourceType: 'connector',
        sourceId: 'github-repo-monitor',
        sourceRef: 'commit-sha-789',
        predicate: 'commit-pushed',
        rawSummary: 'Another commit pushed',
      },
    })

    expect(afterRevokeRes.ok).toBe(false)
    expect(afterRevokeRes.refusal!.reason).toContain('unauthorized-source')
  })

  it('reliably deduplicates repeated or replayed observations without duplicating records', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const obsInput = {
      sourceType: 'internal' as const,
      sourceId: 'workforce',
      sourceRef: 'worker-qa-1',
      predicate: 'worker-availability-changed',
      rawSummary: 'Worker worker-qa-1 transitioned to idle',
    }

    const first = await core.ingestObservation(obsInput)
    expect(first.ok).toBe(true)

    // Second identical ingestion
    const second = await core.ingestObservation(obsInput)
    expect(second.ok).toBe(false)
    expect(second.dropCode).toBe('duplicate')
    expect(second.reason).toContain('duplicate observation detected')

    // Recent observations still only contains 1 entry
    expect(core.recentObservations()).toHaveLength(1)
  })

  it('safely rejects malformed observation payloads and enforces bounds', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // Missing required fields
    const missingRes = await core.handleCommand({
      command: 'proactive.observation.ingest',
      requestId: 'req-bad-1',
      payload: {
        sourceType: 'internal',
        // missing sourceId and rawSummary
      },
    })

    expect(missingRes.ok).toBe(false)
    expect(missingRes.refusal!.reason).toContain('malformed')

    // Truncates overly long raw summary safely
    const giantText = 'A'.repeat(5000)
    const longRes = await core.ingestObservation({
      sourceType: 'internal',
      sourceId: 'system',
      sourceRef: 'ref-long',
      rawSummary: giantText,
    })

    expect(longRes.ok).toBe(true)
    expect(longRes.observation!.claim.rawSummary.length).toBeLessThanOrEqual(1024)
  })

  it('stores sensitive observation details in encrypted Vault evidence store', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Ingest with confidential details
    const res = await core.ingestObservation({
      sourceType: 'internal',
      sourceId: 'compliance',
      sourceRef: 'audit-sec-1',
      rawSummary: 'Security audit finding flagged',
      sensitivity: 'confidential',
      details: {
        secretToken: 'sensitive-api-token-xyz',
        vulnerabilityCode: 'CVE-2026-9999',
      },
    })

    expect(res.ok).toBe(true)
    const obs = res.observation!
    expect(obs.evidenceRef).toBeDefined()
    expect(obs.evidenceRef).not.toBeNull()

    // The journal event metadata on disk does NOT leak the details
    const raw = await readFile(dataPath, 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    const receivedEvent = events.find(
      (e) =>
        e.type === 'proactive.observation.received' &&
        (e.payload as Record<string, unknown>).observationId === obs.observationId,
    )
    expect(receivedEvent).toBeDefined()
    const payload = receivedEvent!.payload as Record<string, unknown>
    expect(payload.evidenceRef).toBe(obs.evidenceRef)
    expect(raw).not.toContain('sensitive-api-token-xyz')
  })

  it('recovers subscriptions and deduplication registry across Core restart with encrypted Vault', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // 1. Session 1: Create subscription and ingest observation
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    await core.subscribeObservationSource({
      subscriptionId: 'sub-persisted-1',
      sourceId: 'weather-service',
      sourceType: 'connector',
      scope: 'api:weather',
      allowedTypes: ['storm-warning'],
      consentGranted: true,
    })

    const obs = await core.ingestObservation({
      sourceType: 'connector',
      sourceId: 'weather-service',
      sourceRef: 'storm-id-001',
      predicate: 'storm-warning',
      rawSummary: 'Severe storm warning issued for area',
    })
    expect(obs.ok).toBe(true)

    // Stop Core
    await core.stop('restart-test')
    core = undefined

    // 2. Session 2: Restart from same Vault and dataPath
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Subscription survived restart
    const subs = core.observationSubscriptions()
    expect(subs).toHaveLength(1)
    expect(subs[0]!.subscriptionId).toBe('sub-persisted-1')
    expect(subs[0]!.sourceId).toBe('weather-service')
    expect(subs[0]!.active).toBe(true)

    // Deduplication key survived restart: repeating the exact same event is recognized as duplicate!
    const replayed = await core.ingestObservation({
      sourceType: 'connector',
      sourceId: 'weather-service',
      sourceRef: 'storm-id-001',
      predicate: 'storm-warning',
      rawSummary: 'Severe storm warning issued for area',
    })
    expect(replayed.ok).toBe(false)
    expect(replayed.dropCode).toBe('duplicate')
  })

  it('enforces STOP ALL immediately dropping observations and blocking subscriptions', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // Activate STOP ALL
    await core.handleCommand({
      command: 'security.stopAll',
      requestId: 'req-stop-1',
    })
    expect(core.status().stopAll.active).toBe(true)

    // Attempt ingest
    const ingestRes = await core.ingestObservation({
      sourceType: 'internal',
      sourceId: 'system',
      sourceRef: 'event-1',
      rawSummary: 'Attempted during stop all',
    })
    expect(ingestRes.ok).toBe(false)
    expect(ingestRes.dropCode).toBe('stop-all-active')

    // Attempt subscription throws/refuses
    await expect(
      core.subscribeObservationSource({
        sourceId: 'test',
        sourceType: 'internal',
        scope: 'scope',
        allowedTypes: [],
      }),
    ).rejects.toThrow('STOP ALL is active')
  })
})
