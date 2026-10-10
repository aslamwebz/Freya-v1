// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import type { ModelCallOptions, ModelProvider, ModelRequest, ModelResult } from '../../core/model/provider'
import type { ProviderStatus } from '../../core/protocol/core-protocol'
import { GovernedActionPolicy, PROBE_BUDGET_LIMITS } from '../../core/proactive/action-policy'
import { normalizeObservation } from '../../core/proactive/normalization'
import type {
  NormalizedObservation,
  ProactiveAdvisoryProposal,
  RawObservationInput,
} from '../../core/proactive/types'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-proactive-gov-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

class TestScriptedProvider implements ModelProvider {
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
      detail: 'Scripted test provider',
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
      inputTokens: 10,
      outputTokens: 10,
    }
  }
}

function makeObservation(input: Partial<RawObservationInput> & { sourceId: string; rawSummary: string }): NormalizedObservation {
  const full: RawObservationInput = {
    sourceType: input.sourceType ?? 'internal',
    sourceId: input.sourceId,
    sourceRef: input.sourceRef ?? 'ref-1',
    rawSummary: input.rawSummary,
    predicate: input.predicate,
    goalId: input.goalId,
    milestoneId: input.milestoneId,
    missionId: input.missionId,
    expiresAt: input.expiresAt,
  }
  const res = normalizeObservation(full, 'obs-gov-test', 'dedupe-gov-key', new Date().toISOString())
  if (!res.ok) throw new Error(res.reason)
  return res.observation
}

describe('Phase 6C — Governed Proactive Action & Boundaries', () => {
  describe('Governed Action Policy Unit Tests', () => {
    it('evaluates Level 1 pre-authorized actions: ignore, record, defer, notify', () => {
      const policy = new GovernedActionPolicy()
      const obs = makeObservation({ sourceId: 'src-1', rawSummary: 'Test observation' })

      const ignoreDecision = policy.evaluate(
        { candidateAction: 'ignore', confidence: 0.9, justification: 'Noise', modelTokensUsed: 0, wasOverridden: false },
        obs,
      )
      expect(ignoreDecision.decision).toBe('ignore')
      expect(ignoreDecision.level).toBe(1)
      expect(ignoreDecision.requiresApproval).toBe(false)
      expect(ignoreDecision.executed).toBe(true)

      const recordDecision = policy.evaluate(
        { candidateAction: 'record', confidence: 0.8, justification: 'Save for later', modelTokensUsed: 0, wasOverridden: false },
        obs,
      )
      expect(recordDecision.decision).toBe('record')
      expect(recordDecision.level).toBe(1)
      expect(recordDecision.requiresApproval).toBe(false)
      expect(recordDecision.executed).toBe(true)

      const deferDecision = policy.evaluate(
        { candidateAction: 'defer', confidence: 0.8, justification: 'Wait for window', modelTokensUsed: 0, wasOverridden: false },
        obs,
      )
      expect(deferDecision.decision).toBe('defer')
      expect(deferDecision.level).toBe(1)
      expect(deferDecision.requiresApproval).toBe(false)
      expect(deferDecision.executed).toBe(true)

      const notifyDecision = policy.evaluate(
        { candidateAction: 'notify', confidence: 0.85, justification: 'Important update', modelTokensUsed: 0, wasOverridden: false },
        obs,
      )
      expect(notifyDecision.decision).toBe('notify')
      expect(notifyDecision.level).toBe(1)
      expect(notifyDecision.requiresApproval).toBe(false)
      expect(notifyDecision.executed).toBe(true)
    })

    it('enforces Level 2 diagnostic probe budget and escalates to Level 3 upon exhaustion', () => {
      const policy = new GovernedActionPolicy()
      const obs = makeObservation({ sourceId: 'src-1', rawSummary: 'Test observation' })

      const proposal: ProactiveAdvisoryProposal = {
        candidateAction: 'investigate',
        confidence: 0.75,
        justification: 'Probe needed',
        modelTokensUsed: 50,
        wasOverridden: false,
      }

      // Probes 1 to maxProbes (3) should succeed at Level 2
      for (let i = 1; i <= PROBE_BUDGET_LIMITS.maxProbes; i++) {
        const decision = policy.evaluate(proposal, obs)
        expect(decision.decision).toBe('investigate')
        expect(decision.level).toBe(2)
        expect(decision.requiresApproval).toBe(false)
        expect(decision.executed).toBe(true)
      }

      // 4th probe should exhaust budget and escalate to Level 3 approval request
      const escalatedDecision = policy.evaluate(proposal, obs)
      expect(escalatedDecision.decision).toBe('request_approval')
      expect(escalatedDecision.level).toBe(3)
      expect(escalatedDecision.requiresApproval).toBe(true)
      expect(escalatedDecision.executed).toBe(false)
      expect(escalatedDecision.reason).toContain('budget exhausted')
    })

    it('allows Level 1 continuation when all prerequisites are met', () => {
      const policy = new GovernedActionPolicy()
      const obs = makeObservation({
        sourceId: 'src-1',
        rawSummary: 'Resource unblocked',
        goalId: 'goal-1',
        missionId: 'mission-1',
      })

      const proposal: ProactiveAdvisoryProposal = {
        candidateAction: 'continue_existing_mission',
        confidence: 0.95,
        justification: 'Dependency completed, ready to continue',
        modelTokensUsed: 100,
        wasOverridden: false,
      }

      const decision = policy.evaluate(proposal, obs, {
        checkContinuationPrerequisites: () => ({
          goalIsActive: true,
          missionIsWaiting: true,
          milestonePreconditionsMet: true,
          budgetRemaining: 5,
          principalAuthorized: true,
          stopAllActive: false,
        }),
      })

      expect(decision.decision).toBe('continue_existing_mission')
      expect(decision.level).toBe(1)
      expect(decision.requiresApproval).toBe(false)
      expect(decision.executed).toBe(true)
      expect(decision.actionRef).toBe('mission-1')
    })

    it('escalates continuation to Level 3 request_approval when prerequisites fail', () => {
      const policy = new GovernedActionPolicy()
      const obs = makeObservation({
        sourceId: 'src-1',
        rawSummary: 'Resource unblocked',
        goalId: 'goal-1',
        missionId: 'mission-1',
      })

      const proposal: ProactiveAdvisoryProposal = {
        candidateAction: 'continue_existing_mission',
        confidence: 0.95,
        justification: 'Dependency completed',
        modelTokensUsed: 100,
        wasOverridden: false,
      }

      // Test when budget is exhausted
      const noBudgetDecision = policy.evaluate(proposal, obs, {
        checkContinuationPrerequisites: () => ({
          goalIsActive: true,
          missionIsWaiting: true,
          milestonePreconditionsMet: true,
          budgetRemaining: 0,
          principalAuthorized: true,
          stopAllActive: false,
        }),
      })

      expect(noBudgetDecision.decision).toBe('request_approval')
      expect(noBudgetDecision.level).toBe(3)
      expect(noBudgetDecision.requiresApproval).toBe(true)
      expect(noBudgetDecision.executed).toBe(false)
      expect(noBudgetDecision.reason).toContain('budget exhausted')

      // Test when mission is not waiting
      const activeMissionDecision = policy.evaluate(proposal, obs, {
        checkContinuationPrerequisites: () => ({
          goalIsActive: true,
          missionIsWaiting: false,
          milestonePreconditionsMet: true,
          budgetRemaining: 5,
          principalAuthorized: true,
          stopAllActive: false,
        }),
      })

      expect(activeMissionDecision.decision).toBe('request_approval')
      expect(activeMissionDecision.level).toBe(3)
      expect(activeMissionDecision.requiresApproval).toBe(true)
      expect(activeMissionDecision.executed).toBe(false)
      expect(activeMissionDecision.reason).toContain('mission not waiting')
    })

    it('suppresses and defers proactive action when STOP ALL is active', () => {
      const policy = new GovernedActionPolicy()
      const obs = makeObservation({ sourceId: 'src-1', rawSummary: 'Test observation' })

      const proposal: ProactiveAdvisoryProposal = {
        candidateAction: 'notify',
        confidence: 0.9,
        justification: 'Notify owner',
        modelTokensUsed: 0,
        wasOverridden: false,
      }

      const decision = policy.evaluate(proposal, obs, {
        stopAllActive: () => true,
      })

      expect(decision.decision).toBe('defer')
      expect(decision.level).toBe(1)
      expect(decision.executed).toBe(false)
      expect(decision.requiresApproval).toBe(false)
      expect(decision.reason).toContain('STOP ALL is active')
    })
  })

  describe('Core Integration & Proactive Action Execution', () => {
    it('routes Level 1 notify decisions through Attention engine and records proactive.decision.made', async () => {
      const dataPath = join(dir, 'events.jsonl')
      const scriptedModel = new TestScriptedProvider([
        JSON.stringify({
          significanceAssessment: 'Security alert impacts milestone dependencies',
          candidateAction: 'notify',
          justification: 'Security alert impacts milestone dependencies',
          verificationCriteria: 'Owner verification required',
        }),
      ])

      core = createCore({
        dataPath,
        providers: [scriptedModel],
        skipAttentionTimer: true,
      })
      await core.start()

      // Create and activate goal so relevance filter associates the observation
      const createRes = await core.handleCommand({
        command: 'goal.create',
        requestId: 'req-g1',
        payload: {
          title: 'Infrastructure Security Goal',
          description: 'Ensure stack security and handle dependencies',
        },
      })
      expect(createRes.ok).toBe(true)
      const goalId = createRes.goal!.goalId!

      await core.handleCommand({
        command: 'goal.activate',
        requestId: 'req-g2',
        payload: { goalId },
      })

      // Subscribe to alert source
      await core.subscribeObservationSource({
        sourceId: 'security-feed',
        sourceType: 'connector',
        scope: 'security:threats',
        allowedTypes: ['alert'],
        consentGranted: true,
      })

      // Ingest observation
      const ingestResult = await core.ingestObservation({
        sourceType: 'connector',
        sourceId: 'security-feed',
        sourceRef: 'sec-alert-001',
        predicate: 'alert',
        rawSummary: 'Critical CVE detected on target stack',
        goalId,
      })

      expect(ingestResult.ok).toBe(true)
      if (!ingestResult.ok) return

      expect(ingestResult.decision?.decision).toBe('notify')
      expect(ingestResult.decision?.level).toBe(1)
      expect(ingestResult.decision?.executed).toBe(true)

      // Verify that proactive.decision.made event was appended to fabric
      const raw = await readFile(dataPath, 'utf8')
      const events = raw.trim().split('\n').map((line) => JSON.parse(line))
      const decisionEvent = events.find((e) => e.type === 'proactive.decision.made')
      expect(decisionEvent).toBeDefined()
      expect(decisionEvent?.payload).toMatchObject({
        observationId: ingestResult.observation.observationId,
        decision: 'notify',
        level: 1,
      })

      // Verify attention projection contains the ingested notification
      const attention = core.attention()
      expect(attention.counts.ingested).toBeGreaterThanOrEqual(1)
    })

    it('emits proactive.decision.made with Level 3 when approval is required', async () => {
      const dataPath = join(dir, 'events.jsonl')
      const scriptedModel = new TestScriptedProvider([
        JSON.stringify({
          significanceAssessment: 'New toolchain requires review',
          candidateAction: 'request_approval',
          justification: 'New external tool available requiring owner authorization',
          verificationCriteria: 'Owner verification and grant',
        }),
      ])

      core = createCore({
        dataPath,
        providers: [scriptedModel],
        skipAttentionTimer: true,
      })
      await core.start()

      const createRes = await core.handleCommand({
        command: 'goal.create',
        requestId: 'req-g3',
        payload: {
          title: 'Toolchain Modernization Goal',
          description: 'Adopt modern toolchains with owner approval',
        },
      })
      expect(createRes.ok).toBe(true)
      const goalId = createRes.goal!.goalId!

      await core.handleCommand({
        command: 'goal.activate',
        requestId: 'req-g4',
        payload: { goalId },
      })

      await core.subscribeObservationSource({
        sourceId: 'tool-registry',
        sourceType: 'connector',
        scope: 'tools',
        allowedTypes: ['tool-update'],
        consentGranted: true,
      })

      const result = await core.ingestObservation({
        sourceType: 'connector',
        sourceId: 'tool-registry',
        sourceRef: 'tool-001',
        predicate: 'tool-update',
        rawSummary: 'New compiler toolchain available',
        goalId,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.decision?.decision).toBe('request_approval')
      expect(result.decision?.level).toBe(3)
      expect(result.decision?.requiresApproval).toBe(true)
      expect(result.decision?.executed).toBe(false)

      const raw = await readFile(dataPath, 'utf8')
      const events = raw.trim().split('\n').map((line) => JSON.parse(line))
      const decisionEvent = events.find((e) => e.type === 'proactive.decision.made')
      expect(decisionEvent).toBeDefined()
      expect(decisionEvent?.payload).toMatchObject({
        decision: 'request_approval',
        level: 3,
      })
    })

    it('honors Core emergency STOP ALL and suppresses execution', async () => {
      const dataPath = join(dir, 'events.jsonl')
      const scriptedModel = new TestScriptedProvider([])

      core = createCore({
        dataPath,
        providers: [scriptedModel],
        skipAttentionTimer: true,
      })
      await core.start()

      await core.subscribeObservationSource({
        sourceId: 'src-feed',
        sourceType: 'connector',
        scope: 'test',
        allowedTypes: ['test-event'],
        consentGranted: true,
      })

      // Activate STOP ALL via security.stopAll command
      const stopRes = await core.handleCommand({
        command: 'security.stopAll',
        requestId: 'stop-panic-1',
        payload: { reason: 'Test emergency pause' },
      })
      expect(stopRes.ok).toBe(true)

      const result = await core.ingestObservation({
        sourceType: 'connector',
        sourceId: 'src-feed',
        sourceRef: 'ref-stop',
        predicate: 'test-event',
        rawSummary: 'Observation arriving during STOP ALL',
      })

      expect(result.ok).toBe(false)
      expect(result.dropCode).toBe('stop-all-active')
      expect(result.reason).toContain('STOP ALL is active')

      // Confirm observation dropped event in fabric
      const raw = await readFile(dataPath, 'utf8')
      const events = raw.trim().split('\n').map((line) => JSON.parse(line))
      const droppedEvent = events.find((e) => e.type === 'proactive.observation.dropped')
      expect(droppedEvent).toBeDefined()
      expect(droppedEvent?.payload).toMatchObject({
        reason: 'stop-all-active',
      })
    })
  })
})
