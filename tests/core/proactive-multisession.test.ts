// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import type { ModelCallOptions, ModelProvider, ModelRequest, ModelResult } from '../../core/model/provider'
import type { ProviderStatus } from '../../core/protocol/core-protocol'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-proactive-multi-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

class MultiSessionScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0

  constructor(private readonly responses: readonly string[]) {}

  status(): ProviderStatus {
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: 'scripted-1',
      detail: 'Scripted multi-session provider',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    if (options.signal?.aborted) throw new Error('aborted')
    const text = this.responses[Math.min(this.calls, this.responses.length - 1)] ?? ''
    this.calls++
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: 'scripted-1',
      text,
      inputTokens: 15,
      outputTokens: 15,
    }
  }
}

describe('Phase 6D — Production Proactive Multi-Session Verification', () => {
  it('preserves subscriptions, deduplication registry, and encrypted evidence across real Core restarts', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    const scriptedModel = new MultiSessionScriptedProvider([
      JSON.stringify({
        significanceAssessment: 'Upstream security patch available for active goal milestone',
        candidateAction: 'notify',
        justification: 'Upstream patch resolves critical milestone dependency blocker',
        verificationCriteria: 'Owner verification required',
      }),
      JSON.stringify({
        significanceAssessment: 'Performance benchmark completed for active goal',
        candidateAction: 'notify',
        justification: 'Benchmark passes target SLA criteria',
        verificationCriteria: 'Automated verification check',
      }),
    ])

    // =========================================================================
    // SESSION 1: Goal creation, observation subscription, and evidence ingest
    // =========================================================================
    core = createCore({
      dataPath,
      providers: [scriptedModel],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // 1. Create and activate a long-term goal
    const goalCreateRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'req-g1',
      payload: {
        title: 'Cloud Infrastructure Launch',
        description: 'Enduring milestone-driven cloud software launch',
      },
    })
    expect(goalCreateRes.ok).toBe(true)
    const goalId = goalCreateRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'req-g2',
      payload: { goalId },
    })

    // 2. Register authorized external observation source
    const sub = await core.subscribeObservationSource({
      subscriptionId: 'sub-cloud-monitor',
      sourceId: 'cloud-security-feed',
      sourceType: 'connector',
      scope: 'cloud:security',
      allowedTypes: ['security-patch', 'benchmark-result'],
      consentGranted: true,
    })
    expect(sub.subscriptionId).toBe('sub-cloud-monitor')

    // 3. Ingest observation with sensitive confidential details
    const ingest1 = await core.ingestObservation({
      sourceType: 'connector',
      sourceId: 'cloud-security-feed',
      sourceRef: 'patch-2026-001',
      predicate: 'security-patch',
      rawSummary: 'Security patch v2.4 released for auth service',
      goalId,
      details: {
        apiKeyUsed: 'super-secret-production-token-998877',
        vulnerabilityCode: 'CVE-2026-CLOUD-AUTH',
        remediationInstructions: 'Apply patch to auth proxy cluster',
      },
    })

    expect(ingest1.ok).toBe(true)
    if (!ingest1.ok || !ingest1.observation) return

    expect(ingest1.decision?.decision).toBe('notify')
    expect(ingest1.decision?.level).toBe(1)
    expect(ingest1.decision?.executed).toBe(true)

    const obsId1 = ingest1.observation.observationId
    const evidenceRef1 = ingest1.observation.evidenceRef
    expect(evidenceRef1).toBe(obsId1)

    // 4. Verify that plaintext journal on disk does NOT contain sensitive details
    const rawJournal1 = await readFile(dataPath, 'utf8')
    expect(rawJournal1).not.toContain('super-secret-production-token-998877')
    expect(rawJournal1).not.toContain('CVE-2026-CLOUD-AUTH')

    // 5. Verify attention received the notification
    const attention1 = core.attention()
    expect(attention1.counts.ingested).toBeGreaterThanOrEqual(1)

    // Clean shutdown of Session 1
    await core.stop('restart-to-session-2')
    core = undefined

    // =========================================================================
    // SESSION 2: Restart from persisted Vault & EventFabric
    // =========================================================================
    core = createCore({
      dataPath,
      providers: [scriptedModel],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // 1. Verify goal survived restart (reconciled safely to paused on restart per LongHorizon invariants)
    const goalProjection = core.goals()
    expect(goalProjection.counts.total).toBe(1)
    const recoveredGoal = goalProjection.goals.find((g) => g.goalId === goalId)
    expect(recoveredGoal).toBeDefined()
    expect(recoveredGoal?.state).toBe('paused')

    // Resume the goal
    const resumeRes = await core.handleCommand({
      command: 'goal.resume',
      requestId: 'req-g-resume',
      payload: { goalId },
    })
    expect(resumeRes.ok).toBe(true)
    expect(core.goals().counts.active).toBe(1)

    // 2. Verify subscription survived restart truthful in memory and store
    const subsAfterRestart = core.observationSubscriptions()
    expect(subsAfterRestart).toHaveLength(1)
    expect(subsAfterRestart[0]!.subscriptionId).toBe('sub-cloud-monitor')
    expect(subsAfterRestart[0]!.sourceId).toBe('cloud-security-feed')
    expect(subsAfterRestart[0]!.active).toBe(true)

    // 3. Verify deduplication survived restart: replayed event is recognized and dropped as duplicate
    const replayed = await core.ingestObservation({
      sourceType: 'connector',
      sourceId: 'cloud-security-feed',
      sourceRef: 'patch-2026-001',
      predicate: 'security-patch',
      rawSummary: 'Security patch v2.4 released for auth service',
      goalId,
    })

    expect(replayed.ok).toBe(false)
    expect(replayed.dropCode).toBe('duplicate')
    expect(replayed.reason).toContain('duplicate')

    // 4. Ingest new second observation under recovered subscription and goal
    const ingest2 = await core.ingestObservation({
      sourceType: 'connector',
      sourceId: 'cloud-security-feed',
      sourceRef: 'benchmark-run-002',
      predicate: 'benchmark-result',
      rawSummary: 'Benchmark run 002 passed latency threshold',
      goalId,
    })

    expect(ingest2.ok).toBe(true)
    if (!ingest2.ok) return
    expect(ingest2.decision?.decision).toBe('notify')

    // 5. Confirm STOP ALL suppresses subsequent proactive actions
    const stopRes = await core.handleCommand({
      command: 'security.stopAll',
      requestId: 'stop-panic-multi',
      payload: { reason: 'Emergency stop initiated during session 2' },
    })
    expect(stopRes.ok).toBe(true)

    const blocked = await core.ingestObservation({
      sourceType: 'connector',
      sourceId: 'cloud-security-feed',
      sourceRef: 'benchmark-run-003',
      predicate: 'benchmark-result',
      rawSummary: 'Benchmark run 003 arriving after stop all',
      goalId,
    })

    expect(blocked.ok).toBe(false)
    expect(blocked.dropCode).toBe('stop-all-active')

    // Clean shutdown of Session 2
    await core.stop('restart-to-session-3')
    core = undefined

    // =========================================================================
    // SESSION 3: Verify journal completeness and state integrity on third wake
    // =========================================================================
    core = createCore({
      dataPath,
      providers: [scriptedModel],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const rawJournalFinal = await readFile(dataPath, 'utf8')
    const finalEvents = rawJournalFinal.trim().split('\n').map((line) => JSON.parse(line))

    const decisions = finalEvents.filter((e) => e.type === 'proactive.decision.made')
    expect(decisions.length).toBeGreaterThanOrEqual(2)

    const drops = finalEvents.filter((e) => e.type === 'proactive.observation.dropped')
    expect(drops.some((d) => (d.payload as Record<string, unknown>).reason === 'duplicate')).toBe(true)
    expect(drops.some((d) => (d.payload as Record<string, unknown>).reason === 'stop-all-active')).toBe(true)
  })
})
