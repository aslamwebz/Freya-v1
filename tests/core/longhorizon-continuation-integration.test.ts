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
import { CONTINUATION_WAKE_CAUSES } from '../../core/longhorizon/continuation'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-cont-int-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 5C — LongHorizon Continuation, Wakes, Recovery & Budget Hierarchy', () => {
  it('handles valid registered wake causes and rejects spurious or unauthorized wakes', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-create',
      payload: {
        title: 'Enduring Autonomous Mission',
        description: 'Multi-week strategic engineering goal',
        completionCriteria: ['Phase 1 verified'],
      },
    })
    expect(createRes.ok).toBe(true)
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-activate',
      payload: { goalId },
    })

    // 1. Verify all 5 registered wake causes succeed and permit continuation
    for (const cause of CONTINUATION_WAKE_CAUSES) {
      const outcome = await core.handleContinuationWake({
        wakeId: `wake-${cause}`,
        source: 'test-runner',
        goalId,
        cause,
        authorized: true,
      })
      expect(outcome.decision.decision).toBe('continue')
      expect(outcome.decision.reason).toContain(cause)
    }

    // 2. Reject unregistered/hallucinated wake causes
    const hallucinatedOutcome = await core.handleContinuationWake({
      wakeId: 'wake-hallucinated',
      source: 'test-runner',
      goalId,
      cause: 'hallucinated_model_continuation',
      authorized: true,
    })
    expect(hallucinatedOutcome.decision.decision).toBe('wait')
    expect(hallucinatedOutcome.decision.reason).toContain('unregistered wake cause rejected')

    // 3. Reject unauthorized wake sources
    const unauthorizedOutcome = await core.handleContinuationWake({
      wakeId: 'wake-unauthorized',
      source: 'untrusted-channel',
      goalId,
      cause: 'scheduled_review',
      authorized: false,
    })
    expect(unauthorizedOutcome.decision.decision).toBe('wait')
    expect(unauthorizedOutcome.decision.reason).toContain('unauthorized wake source rejected')

    // 4. Reject wake with no goal
    const noGoalOutcome = await core.handleContinuationWake({
      wakeId: 'wake-no-goal',
      source: 'test-runner',
      goalId: null,
      cause: 'scheduled_review',
      authorized: true,
    })
    expect(noGoalOutcome.decision.decision).toBe('wait')
    expect(noGoalOutcome.decision.reason).toContain('no goal is referenced')

    // 5. Reject wake on non-open goal
    const nonOpenOutcome = await core.handleContinuationWake({
      wakeId: 'wake-nonexistent',
      source: 'test-runner',
      goalId: 'nonexistent-goal-id',
      cause: 'scheduled_review',
      authorized: true,
    })
    expect(nonOpenOutcome.decision.decision).toBe('wait')
    expect(nonOpenOutcome.decision.reason).toContain('the goal is not open')
  })

  it('halts all continuation attempts immediately when STOP ALL is active', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-create',
      payload: {
        title: 'Mission Under Safety Guard',
        description: 'Verify stop-all gating',
      },
    })
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-activate',
      payload: { goalId },
    })

    // Activate STOP ALL
    const stopRes = await core.handleCommand({
      command: 'security.stopAll',
      requestId: 'cmd-stop',
    })
    expect(stopRes.ok).toBe(true)

    // Attempt continuation wake
    const outcome = await core.handleContinuationWake({
      wakeId: 'wake-stop-all',
      source: 'test-runner',
      goalId,
      cause: 'scheduled_review',
      authorized: true,
    })
    expect(outcome.decision.decision).toBe('wait')
    expect(outcome.decision.reason).toBe('STOP ALL is active')
  })

  it('respects milestone eligibility and waits when prerequisites are unfulfilled', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-create',
      payload: {
        title: 'Multi-Milestone Goal',
        description: 'Track milestone prerequisites in continuation',
        roadmap: {
          milestones: [
            {
              milestoneId: 'm1',
              title: 'First Milestone',
              intent: 'Foundation work',
              expectedOutcome: 'Foundation established',
              acceptanceCriteria: ['Core setup verified'],
              dependencies: [],
            },
            {
              milestoneId: 'm2',
              title: 'Second Milestone',
              intent: 'Dependent work',
              expectedOutcome: 'Feature implemented on top of foundation',
              acceptanceCriteria: ['Integration complete'],
              dependencies: ['m1'],
            },
          ],
        },
      },
    })
    expect(createRes.ok).toBe(true)
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-activate',
      payload: { goalId },
    })

    // With M1 pending, M1 is eligible -> continuation continues
    const wake1 = await core.handleContinuationWake({
      wakeId: 'wake-1',
      source: 'test-runner',
      goalId,
      cause: 'scheduled_review',
      authorized: true,
    })
    expect(wake1.decision.decision).toBe('continue')

    // Settle M1 as completed
    await core.handleCommand({
      command: 'goal.milestone.settle',
      requestId: 'cmd-settle-m1',
      payload: {
        goalId,
        milestoneId: 'm1',
        outcome: 'completed',
      },
    })

    // Now M2 is ready -> continuation continues
    const wake2 = await core.handleContinuationWake({
      wakeId: 'wake-2',
      source: 'test-runner',
      goalId,
      cause: 'prerequisite_finished',
      authorized: true,
    })
    expect(wake2.decision.decision).toBe('continue')

    // Settle M2 as completed
    await core.handleCommand({
      command: 'goal.milestone.settle',
      requestId: 'cmd-settle-m2',
      payload: {
        goalId,
        milestoneId: 'm2',
        outcome: 'completed',
      },
    })

    // All milestones settled -> no more eligible milestones
    const wake3 = await core.handleContinuationWake({
      wakeId: 'wake-3',
      source: 'test-runner',
      goalId,
      cause: 'scheduled_review',
      authorized: true,
    })
    expect(wake3.decision.decision).toBe('wait')
    expect(wake3.decision.reason).toContain('waiting on milestone dependencies')
  })

  it('enforces non-widening budget hierarchy, derives Mission budgets, and pauses on budget exhaustion', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // 1. Create goal with constrained budget
    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-create',
      payload: {
        title: 'Budget Governed Goal',
        description: 'Enforce budget hierarchy and bounds',
        budget: {
          maxModelCalls: 10,
          maxActions: 20,
          maxExternalRequests: 5,
          maxMissions: 2,
        },
      },
    })
    expect(createRes.ok).toBe(true)
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-activate',
      payload: { goalId },
    })

    // 2. Check initial budget detail
    const detailInitial = await core.goalDetail(goalId)
    expect(detailInitial?.budget).toBeDefined()
    expect(detailInitial?.budget?.maxModelCalls).toBe(10)
    expect(detailInitial?.spend?.modelCalls).toBe(0)
    expect(detailInitial?.budgetRemaining?.remainingModelCalls).toBe(10)

    // 3. Derive milestone Mission budget: requested budget cannot widen beyond remaining goal capacity
    const derivedLarge = core.deriveMilestoneMissionBudget(goalId, {
      maxModelCalls: 50, // requests 50, but parent only has 10 remaining
      maxActions: 100, // requests 100, but parent only has 20 remaining
    })
    expect(derivedLarge.ok).toBe(true)
    if (derivedLarge.ok) {
      expect(derivedLarge.budget.maxModelCalls).toBe(10) // strictly clamped to 10
      expect(derivedLarge.budget.maxActions).toBe(20) // strictly clamped to 20
    }

    // 4. Record spend incrementally
    const spendRes1 = await core.recordGoalSpend(goalId, {
      modelCalls: 4,
      actions: 6,
    })
    expect(spendRes1.ok).toBe(true)
    expect(spendRes1.budgetExhausted).toBe(false)

    const detailAfterSpend = await core.goalDetail(goalId)
    expect(detailAfterSpend?.spend?.modelCalls).toBe(4)
    expect(detailAfterSpend?.budgetRemaining?.remainingModelCalls).toBe(6)

    // Derived mission budget is now clamped to the updated remaining capacity (6)
    const derivedMid = core.deriveMilestoneMissionBudget(goalId, { maxModelCalls: 10 })
    expect(derivedMid.ok).toBe(true)
    if (derivedMid.ok) {
      expect(derivedMid.budget.maxModelCalls).toBe(6)
    }

    // 5. Owner updates budget via governed command
    const budgetUpdateRes = await core.handleCommand({
      command: 'goal.budget.set',
      requestId: 'cmd-budget-update',
      payload: {
        goalId,
        budget: {
          maxModelCalls: 15,
          maxActions: 30,
        },
      },
    })
    expect(budgetUpdateRes.ok).toBe(true)

    const detailAfterOwnerUpdate = await core.goalDetail(goalId)
    expect(detailAfterOwnerUpdate?.budget?.maxModelCalls).toBe(15)
    expect(detailAfterOwnerUpdate?.budgetRemaining?.remainingModelCalls).toBe(11) // 15 - 4 = 11

    // 6. Record spend that exhausts model calls
    const spendRes2 = await core.recordGoalSpend(goalId, {
      modelCalls: 11, // consumes the remaining 11
    })
    expect(spendRes2.ok).toBe(true)
    expect(spendRes2.budgetExhausted).toBe(true)

    // Goal must be auto-paused with remaining capacity 0
    const detailExhausted = await core.goalDetail(goalId)
    expect(detailExhausted?.state).toBe('paused')
    expect(detailExhausted?.budgetRemaining?.remainingModelCalls).toBe(0)

    // Continuation wake must decide 'pause' with reason 'budget_exhausted'
    const wakeExhausted = await core.handleContinuationWake({
      wakeId: 'wake-exhausted',
      source: 'test-runner',
      goalId,
      cause: 'scheduled_review',
      authorized: true,
    })
    expect(wakeExhausted.decision.decision).toBe('pause')
    expect(wakeExhausted.decision.reason).toBe('budget_exhausted')

    // Deriving a new mission budget is refused when capacity is 0
    const derivedZero = core.deriveMilestoneMissionBudget(goalId)
    expect(derivedZero.ok).toBe(false)
    if (!derivedZero.ok) {
      expect(derivedZero.reason).toContain('goal budget exhausted')
    }
  })

  it('reconciles honestly across restarts: pauses active goals, fails in-progress checkpoints, and restores state on encrypted vault', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // --- Session 1 ---
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

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-create',
      payload: {
        title: 'Restart Resilience Goal',
        description: 'Verify honest restart recovery and lack of fabricated completion',
        completionCriteria: ['Checkpoint verified'],
      },
    })
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-activate',
      payload: { goalId },
    })

    // Start a checkpoint toward this goal (created as in-progress in journal)
    const goalEngine = (core as unknown as { goalEngine?: { startCheckpoint: (id: string, k: string) => Promise<{ ok: boolean; checkpointId?: string }> } }).goalEngine
    const cpStart = await goalEngine!.startCheckpoint(goalId, 'integration-test')
    expect(cpStart.ok).toBe(true)

    // Simulate unexpected termination / restart without clean settlement
    await core.stop('crash-simulation')
    core = undefined

    // --- Session 2 ---
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

    const recoveredDetail = await core.goalDetail(goalId)
    expect(recoveredDetail).not.toBeNull()

    // 1. Goal was active when process died -> must be PAUSED (never fabricates running or complete)
    expect(recoveredDetail!.state).toBe('paused')
    expect(recoveredDetail!.settledAt).toBeNull()

    // 2. Checkpoint was in-progress when process died -> must be FAILED with restart_interrupted
    expect(recoveredDetail!.counts.failed).toBe(1)
    expect(recoveredDetail!.counts.inProgress).toBe(0)
    expect(recoveredDetail!.counts.verified).toBe(0)

    // 3. Continuation wake on paused goal returns 'pause'
    const wakePaused = await core.handleContinuationWake({
      wakeId: 'wake-recovery-1',
      source: 'test-runner',
      goalId,
      cause: 'restart_recovery',
      authorized: true,
    })
    expect(wakePaused.decision.decision).toBe('pause')

    // 4. Owner explicitly resumes the goal
    const resumeRes = await core.handleCommand({
      command: 'goal.resume',
      requestId: 'cmd-resume',
      payload: { goalId },
    })
    expect(resumeRes.ok).toBe(true)

    // 5. With owner authorization restored, restart_recovery continuation wake succeeds
    const wakeResumed = await core.handleContinuationWake({
      wakeId: 'wake-recovery-2',
      source: 'test-runner',
      goalId,
      cause: 'restart_recovery',
      authorized: true,
    })
    expect(wakeResumed.decision.decision).toBe('continue')
    expect(wakeResumed.decision.reason).toContain('restart_recovery')
  })
})
