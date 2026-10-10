// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
  dir = await mkdtemp(join(tmpdir(), 'freya-multisession-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 5D — Multi-Session Long-Horizon Autonomous Goal Validation', () => {
  it('maintains, recovers, governs, and completes an enduring goal across 3 distinct sessions and restarts on encrypted SQLCipher Vault', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    let goalId: string
    let m1CheckpointId: string

    // =========================================================================
    // SESSION 1 — DAY 1: Goal Creation, Decomposition, Budget Initialization,
    // Milestone 1 Start & Crash Interruption
    // =========================================================================
    {
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

      // 1. Owner creates the long-term goal with custom budget policy
      const createRes = await core.handleCommand({
        command: 'goal.create',
        requestId: 's1-create',
        payload: {
          title: 'Build and Deploy Autonomous Analytic Engine',
          description: 'Multi-month software engineering product initiative',
          completionCriteria: [
            'Market opportunities researched',
            'Analytical core engine developed',
            'Telemetry and production verification active',
          ],
          budget: {
            maxModelCalls: 20,
            maxActions: 40,
            maxExternalRequests: 10,
            maxMissions: 4,
          },
        },
      })
      expect(createRes.ok).toBe(true)
      goalId = createRes.goal!.goalId!

      // 2. Propose & commit progressive roadmap with 3 interdependent milestones
      const roadmapRes = await core.handleCommand({
        command: 'goal.roadmap.set',
        requestId: 's1-roadmap',
        payload: {
          goalId,
          milestones: [
            {
              milestoneId: 'm1',
              title: 'Market & Opportunity Analysis',
              intent: 'Analyze competitive landscape and target persona needs',
              expectedOutcome: 'Clear feature specifications backed by opportunity metrics',
              acceptanceCriteria: ['Competitive review document complete', 'User metrics defined'],
              dependencies: [],
            },
            {
              milestoneId: 'm2',
              title: 'Core Engine Prototype',
              intent: 'Implement data pipeline and analytical processor',
              expectedOutcome: 'Runnable engine passing synthetic benchmarks',
              acceptanceCriteria: ['Pipeline ingestion verified', 'Analytical models functional'],
              dependencies: ['m1'],
            },
            {
              milestoneId: 'm3',
              title: 'Production Verification & Release',
              intent: 'Deploy engine to live environment and monitor stability',
              expectedOutcome: 'Zero critical defects over 72 hours of live telemetry',
              acceptanceCriteria: ['Deployment verified', 'Telemetry monitoring active'],
              dependencies: ['m2'],
            },
          ],
          advisoryNotes: ['Apply historical insight: avoid unbounded web searches during research.'],
        },
      })
      expect(roadmapRes.ok).toBe(true)

      // 3. Owner activates the goal
      const actRes = await core.handleCommand({
        command: 'goal.activate',
        requestId: 's1-activate',
        payload: { goalId },
      })
      expect(actRes.ok).toBe(true)
      expect(actRes.goal!.state).toBe('active')

      // 4. Elaborate milestone 1 mission
      const proposal = await core.elaborateMilestoneMission(goalId, 'm1')
      expect(proposal).not.toBeNull()
      expect(proposal!.milestoneId).toBe('m1')
      expect(proposal!.intent).toContain('Analyze competitive landscape')

      // 5. Derive milestone mission budget (bounded by remaining capacity: 20 calls)
      const derivedBudget = core.deriveMilestoneMissionBudget(goalId, {
        maxModelCalls: 5,
        maxActions: 10,
      })
      expect(derivedBudget.ok).toBe(true)
      if (derivedBudget.ok) {
        expect(derivedBudget.budget.maxModelCalls).toBe(5)
      }

      // 6. Record initial spend of 2 calls during milestone 1 execution
      const spendRes = await core.recordGoalSpend(goalId, { modelCalls: 2, actions: 3 })
      expect(spendRes.ok).toBe(true)
      expect(spendRes.budgetExhausted).toBe(false)

      // 7. Start in-progress checkpoint toward M1
      const goalEngine = (core as unknown as { goalEngine?: { startCheckpoint: (id: string, k: string) => Promise<{ ok: boolean; checkpointId?: string }> } }).goalEngine
      const cpStart = await goalEngine!.startCheckpoint(goalId, 'market-research')
      expect(cpStart.ok).toBe(true)
      m1CheckpointId = cpStart.checkpointId!

      // 8. Crash simulation: Core stops abruptly while checkpoint is in-progress
      await core.stop('abrupt-crash')
      core = undefined
    }

    // =========================================================================
    // SESSION 2 — DAY 2: Honest Recovery, Milestone 1 Completion,
    // and Prerequisite Evolution
    // =========================================================================
    {
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

      // 1. Inspect recovery status: no fabricated progress during downtime
      const projAfterCrash = core.goals()
      const summaryAfterCrash = projAfterCrash.goals.find((g) => g.goalId === goalId)!
      expect(summaryAfterCrash.state).toBe('paused') // active goals are honestly paused
      expect(summaryAfterCrash.counts.failed).toBe(1) // in-progress checkpoint was marked failed (restart_interrupted)
      expect(summaryAfterCrash.counts.inProgress).toBe(0)
      expect(summaryAfterCrash.counts.verified).toBe(0)

      const detailAfterCrash = await core.goalDetail(goalId)
      expect(detailAfterCrash?.roadmap?.milestones).toHaveLength(3)
      expect(detailAfterCrash?.spend?.modelCalls).toBe(2) // spend faithfully restored
      expect(detailAfterCrash?.budgetRemaining?.remainingModelCalls).toBe(18)

      // 2. Rejection of spurious or unauthorized wakes
      const spuriousWake = await core.handleContinuationWake({
        wakeId: 'wake-hallucinated',
        source: 'llm-free-text',
        goalId,
        cause: 'hallucinated_wake_cause',
        authorized: true,
      })
      expect(spuriousWake.decision.decision).toBe('wait')
      expect(spuriousWake.decision.reason).toContain('unregistered wake cause rejected')

      // 3. Continuation wake while paused returns 'pause'
      const pausedWake = await core.handleContinuationWake({
        wakeId: 'wake-recovery-paused',
        source: 'system',
        goalId,
        cause: 'restart_recovery',
        authorized: true,
      })
      expect(pausedWake.decision.decision).toBe('pause')

      // 4. Owner explicitly resumes the goal
      const resumeRes = await core.handleCommand({
        command: 'goal.resume',
        requestId: 's2-resume',
        payload: { goalId },
      })
      expect(resumeRes.ok).toBe(true)
      expect(resumeRes.goal!.state).toBe('active')

      // 5. Continuation wake now permits continuation on restart_recovery
      const wakeRecovered = await core.handleContinuationWake({
        wakeId: 'wake-recovery-active',
        source: 'system',
        goalId,
        cause: 'restart_recovery',
        authorized: true,
      })
      expect(wakeRecovered.decision.decision).toBe('continue')
      expect(wakeRecovered.decision.reason).toContain('restart_recovery')

      // 6. Complete M1 checkpoint and settle M1
      const goalEngine = (core as unknown as {
        goalEngine?: {
          startCheckpoint: (id: string, k: string) => Promise<{ ok: boolean; checkpointId?: string }>
          recordCheckpointOutcome: (gId: string, cpId: string, outcome: string, reason: string | null, attempts: number) => Promise<void>
        }
      }).goalEngine

      // Retry and pass the interrupted checkpoint m1CheckpointId (attempt 2)
      await goalEngine!.recordCheckpointOutcome(goalId, m1CheckpointId, 'passed', null, 2)

      const settleM1 = await core.handleCommand({
        command: 'goal.milestone.settle',
        requestId: 's2-settle-m1',
        payload: {
          goalId,
          milestoneId: 'm1',
          outcome: 'completed',
          evidence: { reason: 'Competitive matrix documented and target persona validated' },
        },
      })
      expect(settleM1.ok).toBe(true)

      // 7. Verify prerequisite resolution: M1 is completed, M2 is ready, M3 is blocked
      const detailM1Settled = await core.goalDetail(goalId)
      const m1Record = detailM1Settled?.roadmap?.milestones.find((m) => m.milestoneId === 'm1')
      const m2Record = detailM1Settled?.roadmap?.milestones.find((m) => m.milestoneId === 'm2')
      const m3Record = detailM1Settled?.roadmap?.milestones.find((m) => m.milestoneId === 'm3')
      expect(m1Record?.status).toBe('completed')
      expect(m2Record?.dependencies).toEqual(['m1'])
      expect(m3Record?.dependencies).toEqual(['m2'])

      // Next eligible milestone is now M2
      const nextProposal = await core.elaborateMilestoneMission(goalId)
      expect(nextProposal?.milestoneId).toBe('m2')

      // Clean maintenance shutdown
      await core.stop('clean-session2-end')
      core = undefined
    }

    // =========================================================================
    // SESSION 3 — DAY 3: Budget Enforcement, Owner Top-Up, Final Milestones
    // & Goal Verification
    // =========================================================================
    {
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

      // 1. Goal was active when Session 2 closed cleanly -> paused on recovery
      await core.handleCommand({
        command: 'goal.resume',
        requestId: 's3-resume',
        payload: { goalId },
      })

      // 2. Continuation wake on prerequisite_finished proceeds
      const wakeM2 = await core.handleContinuationWake({
        wakeId: 'wake-m2',
        source: 'missions',
        goalId,
        cause: 'prerequisite_finished',
        authorized: true,
      })
      expect(wakeM2.decision.decision).toBe('continue')

      // 3. Simulate heavy autonomous execution during M2 that exhausts remaining model budget
      // Current spend: 2 model calls. Total budget: 20 calls. Remaining: 18 calls.
      const spendExhaust = await core.recordGoalSpend(goalId, {
        modelCalls: 18,
        actions: 25,
      })
      expect(spendExhaust.ok).toBe(true)
      expect(spendExhaust.budgetExhausted).toBe(true)

      // 4. Verify auto-pause on budget exhaustion
      const detailExhausted = await core.goalDetail(goalId)
      expect(detailExhausted?.state).toBe('paused')
      expect(detailExhausted?.budgetRemaining?.remainingModelCalls).toBe(0)

      // Continuation wake is paused with budget_exhausted
      const wakeBudgetExhausted = await core.handleContinuationWake({
        wakeId: 'wake-budget-exhausted',
        source: 'system',
        goalId,
        cause: 'scheduled_review',
        authorized: true,
      })
      expect(wakeBudgetExhausted.decision.decision).toBe('pause')
      expect(wakeBudgetExhausted.decision.reason).toBe('budget_exhausted')

      // Deriving mission budget is blocked
      const derivedBlocked = core.deriveMilestoneMissionBudget(goalId)
      expect(derivedBlocked.ok).toBe(false)
      if (!derivedBlocked.ok) {
        expect(derivedBlocked.reason).toContain('goal budget exhausted')
      }

      // 5. Owner reviews progress and authorizes budget expansion
      const budgetExpandRes = await core.handleCommand({
        command: 'goal.budget.set',
        requestId: 's3-owner-budget-expansion',
        payload: {
          goalId,
          budget: {
            maxModelCalls: 35, // expands from 20 to 35 (15 new calls available)
            maxActions: 60,
          },
        },
      })
      expect(budgetExpandRes.ok).toBe(true)

      const detailAfterExpansion = await core.goalDetail(goalId)
      expect(detailAfterExpansion?.budget?.maxModelCalls).toBe(35)
      expect(detailAfterExpansion?.budgetRemaining?.remainingModelCalls).toBe(15) // 35 - 20 = 15

      // Owner resumes goal
      await core.handleCommand({
        command: 'goal.resume',
        requestId: 's3-resume-after-budget',
        payload: { goalId },
      })

      // 6. Complete M2
      const goalEngine = (core as unknown as {
        goalEngine?: {
          startCheckpoint: (id: string, k: string) => Promise<{ ok: boolean; checkpointId?: string }>
          recordCheckpointOutcome: (gId: string, cpId: string, outcome: string, reason: string | null, attempts: number) => Promise<void>
        }
      }).goalEngine

      const cpM2 = await goalEngine!.startCheckpoint(goalId, 'core-engine-impl')
      expect(cpM2.ok).toBe(true)
      await goalEngine!.recordCheckpointOutcome(goalId, cpM2.checkpointId!, 'passed', null, 1)

      const settleM2 = await core.handleCommand({
        command: 'goal.milestone.settle',
        requestId: 's3-settle-m2',
        payload: {
          goalId,
          milestoneId: 'm2',
          outcome: 'completed',
          evidence: { reason: 'Data pipeline benchmarked at 10k events/sec' },
        },
      })
      expect(settleM2.ok).toBe(true)

      // 7. Complete M3
      const cpM3 = await goalEngine!.startCheckpoint(goalId, 'production-verification')
      expect(cpM3.ok).toBe(true)
      await goalEngine!.recordCheckpointOutcome(goalId, cpM3.checkpointId!, 'passed', null, 1)

      const settleM3 = await core.handleCommand({
        command: 'goal.milestone.settle',
        requestId: 's3-settle-m3',
        payload: {
          goalId,
          milestoneId: 'm3',
          outcome: 'completed',
          evidence: { reason: 'Telemetry confirmed clean operation across staging cluster' },
        },
      })
      expect(settleM3.ok).toBe(true)

      // 8. Goal completion: verified checkpoints equal total checkpoints
      const completeRes = await core.handleCommand({
        command: 'goal.requestCompletion',
        requestId: 's3-complete-goal',
        payload: { goalId },
      })
      expect(completeRes.ok).toBe(true)
      expect(completeRes.goal!.state).toBe('completed')

      // 9. Final truth validation: state is completed, terminal, and durable
      const finalDetail = await core.goalDetail(goalId)
      expect(finalDetail?.state).toBe('completed')
      expect(finalDetail?.settledAt).not.toBeNull()
      expect(finalDetail?.reason).toBe('verification_passed')
      expect(finalDetail?.counts.verified).toBeGreaterThanOrEqual(3)
      expect(finalDetail?.availableActions).toEqual([]) // terminal state offers no further mutations
    }
  })
})
