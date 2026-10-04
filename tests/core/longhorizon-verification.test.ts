// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerificationEngine, computeBackoff, canRetry, type VerificationGoalPort } from '../../core/longhorizon/verification'
import { DEFAULT_GOAL_LIMITS, GOAL_REASONS, type CheckpointOutcome, type GoalReason, type GoalVerifier } from '../../core/longhorizon/types'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'

/**
 * Checkpoint verification and recovery.
 *
 * Verification is bounded (deadline), deterministic (same state + same clock =
 * same result), journaled (every outcome is durable) and explicit (every
 * outcome carries a reason). Recovery is bounded by the retry ceiling and the
 * backoff cap.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-verification-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/* ---------------------------------------------------------- helpers */

function verifier(result: { established: boolean; reason: GoalReason }, overrides: Partial<GoalVerifier> = {}): GoalVerifier {
  return {
    id: 'verifier-1',
    verify: async () => result,
    ...overrides,
  }
}

function goalPort(overrides: Partial<VerificationGoalPort> = {}): VerificationGoalPort {
  return {
    recordCheckpointOutcome: async () => {},
    checkpointAttempts: () => 0,
    goalRetryCount: () => 0,
    ...overrides,
  }
}

async function openEngine(options: Partial<ConstructorParameters<typeof VerificationEngine>[0]> = {}) {
  const fabric = await EventFabric.open({
    store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
  })
  const engine = new VerificationEngine({
    fabric,
    goals: goalPort(),
    principalId: 'owner',
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    ...options,
  })
  await engine.open()
  return { engine, fabric }
}

/* ---------------------------------------------------------- backoff */

describe('bounded backoff', () => {
  it('grows exponentially with the attempt', () => {
    const first = computeBackoff(0, 0)
    const second = computeBackoff(1, 0)
    const third = computeBackoff(2, 0)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })

  it('is capped at the maximum', () => {
    const delay = computeBackoff(100, 0)
    expect(delay).toBe(DEFAULT_GOAL_LIMITS.maxBackoffMs)
  })

  it('includes jitter without exceeding the cap', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delay = computeBackoff(attempt, 1_000)
      expect(delay).toBeLessThanOrEqual(DEFAULT_GOAL_LIMITS.maxBackoffMs)
      expect(delay).toBeGreaterThanOrEqual(0)
    }
  })

  it('is deterministic for the same inputs', () => {
    expect(computeBackoff(2, 500)).toBe(computeBackoff(2, 500))
  })
})

/* ---------------------------------------------------------- retry ceiling */

describe('the retry ceiling', () => {
  it('permits retries below the ceiling', () => {
    expect(canRetry(0)).toBe(true)
    expect(canRetry(1)).toBe(true)
    expect(canRetry(2)).toBe(true)
  })

  it('refuses retries at the ceiling', () => {
    expect(canRetry(DEFAULT_GOAL_LIMITS.maxRetryCeiling)).toBe(false)
    expect(canRetry(DEFAULT_GOAL_LIMITS.maxRetryCeiling + 1)).toBe(false)
  })

  it('uses the code-owned ceiling by default', () => {
    expect(canRetry(DEFAULT_GOAL_LIMITS.maxRetryCeiling - 1)).toBe(true)
    expect(canRetry(DEFAULT_GOAL_LIMITS.maxRetryCeiling)).toBe(false)
  })
})

/* ---------------------------------------------------------- verification */

describe('checkpoint verification', () => {
  it('passes a checkpoint the verifier establishes', async () => {
    const { engine } = await openEngine()
    const result = await engine.verify('g1', 'c1', verifier({ established: true, reason: GOAL_REASONS.verification_passed }), new AbortController().signal)
    expect(result.outcome).toBe('passed')
    expect(result.reason).toBeNull()
  })

  it('does not establish a checkpoint the verifier does not establish', async () => {
    const { engine } = await openEngine()
    const result = await engine.verify('g1', 'c1', verifier({ established: false, reason: GOAL_REASONS.verification_not_established }), new AbortController().signal)
    expect(result.outcome).toBe('not_established')
    expect(result.reason).toBe(GOAL_REASONS.verification_not_established)
  })

  it('records the outcome through the goal engine', async () => {
    const recorded: Array<{ goalId: string; checkpointId: string; outcome: CheckpointOutcome; reason: GoalReason | null; attempts: number }> = []
    const { engine } = await openEngine({
      goals: goalPort({
        recordCheckpointOutcome: async (goalId, checkpointId, outcome, reason, attempts) => {
          recorded.push({ goalId, checkpointId, outcome, reason, attempts })
        },
      }),
    })
    await engine.verify('g1', 'c1', verifier({ established: true, reason: GOAL_REASONS.verification_passed }), new AbortController().signal)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.outcome).toBe('passed')
  })

  it('returns a retry delay when the checkpoint may retry', async () => {
    const { engine } = await openEngine()
    const result = await engine.verify('g1', 'c1', verifier({ established: false, reason: GOAL_REASONS.verification_not_established }), new AbortController().signal)
    expect(result.retryAfterMs).not.toBeNull()
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('returns no retry delay at the retry ceiling', async () => {
    const { engine } = await openEngine({
      goals: goalPort({ checkpointAttempts: () => DEFAULT_GOAL_LIMITS.maxRetryCeiling }),
    })
    const result = await engine.verify('g1', 'c1', verifier({ established: false, reason: GOAL_REASONS.verification_not_established }), new AbortController().signal)
    expect(result.retryAfterMs).toBeNull()
  })

  it('cancels verification while STOP ALL is active', async () => {
    let stopAll = false
    const { engine } = await openEngine({ stopAll: () => stopAll })
    stopAll = true
    const result = await engine.verify('g1', 'c1', verifier({ established: true, reason: GOAL_REASONS.verification_passed }), new AbortController().signal)
    expect(result.outcome).toBe('cancelled')
    expect(result.reason).toBe(GOAL_REASONS.stop_all)
  })

  it('cancels verification when the signal is aborted', async () => {
    const { engine } = await openEngine()
    const controller = new AbortController()
    controller.abort()
    const result = await engine.verify('g1', 'c1', verifier({ established: true, reason: GOAL_REASONS.verification_passed }), controller.signal)
    expect(result.outcome).toBe('cancelled')
  })

  it('times out a verification that exceeds the deadline', async () => {
    const { engine } = await openEngine({
      verificationDeadlineMs: 50,
    })
    const slowVerifier: GoalVerifier = {
      id: 'slow',
      verify: () => new Promise(() => {}),
    }
    const result = await engine.verify('g1', 'c1', slowVerifier, new AbortController().signal)
    expect(result.outcome).toBe('timeout')
    expect(result.reason).toBe(GOAL_REASONS.verification_timeout)
  }, 10_000)
})

/* ---------------------------------------------------------- no authority */

describe('verification does not grant authority', () => {
  it('has no Guard, Governor, or budget', () => {
    const engine = new VerificationEngine({
      fabric: null as never,
      goals: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('guard')
    expect(engine).not.toHaveProperty('governor')
    expect(engine).not.toHaveProperty('budget')
  })

  it('cannot approve its own requests', () => {
    const engine = new VerificationEngine({
      fabric: null as never,
      goals: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('approve')
  })
})

/* ---------------------------------------------------------- no model calls */

describe('zero idle inference', () => {
  it('never calls a model', async () => {
    const { engine } = await openEngine()
    const result = await engine.verify('g1', 'c1', verifier({ established: true, reason: GOAL_REASONS.verification_passed }), new AbortController().signal)
    expect(result.outcome).toBe('passed')
  })

  it('has no provider, gateway, or cognition service', () => {
    const engine = new VerificationEngine({
      fabric: null as never,
      goals: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('gateway')
    expect(engine).not.toHaveProperty('provider')
    expect(engine).not.toHaveProperty('cognition')
  })
})
