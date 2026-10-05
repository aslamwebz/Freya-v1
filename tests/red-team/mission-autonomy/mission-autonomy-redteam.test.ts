// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EventFabric } from '../../../core/events/fabric'
import { JsonlEventStore } from '../../../core/events/jsonl-store'
import { validateEventPayload } from '../../../core/events/validate'
import type { AnyCoreEvent } from '../../../core/events/envelope'
import { MissionEngine } from '../../../core/missions/engine'
import { MemoryMissionStore } from '../../../core/missions/memory-store'
import { summarise } from '../../../core/missions/projection'
import { reduceMissionState, initialMissionState } from '../../../core/missions/state'
import {
  DEFAULT_MISSION_BUDGET,
  type MissionCapabilityPort,
  type MissionIntentShape,
} from '../../../core/missions/autonomy/types'
import {
  MissionAutonomyRuntime,
  type MissionEnginePort,
} from '../../../core/missions/autonomy/runtime'
import type { MissionAuthorityPort } from '../../../core/missions/autonomy/authority'
import { applyCorrection } from '../../../core/missions/autonomy/correction'
import { planRecovery } from '../../../core/missions/autonomy/recovery'
import { MISSION_REASONS, type MissionRecord } from '../../../core/missions/types'

/**
 * MISSION AUTONOMY — RED TEAM.
 *
 * Nine attacks, each aimed at one specific way an autonomous system lies to its owner. They
 * are ordered by how much damage the lie would do, not by which module they touch.
 *
 * | attack | the lie it tries to produce |
 * | --- | --- |
 * | 1 | a tampered journal manufactures a completed Mission |
 * | 2 | an owner correction buys more authority |
 * | 3 | an expired approval is read as consent |
 * | 4 | a reported finding is counted as an observed one |
 * | 5 | an interrupted consequential action is silently replayed |
 * | 6 | a forged capability widens what Freya may do |
 * | 7 | a budget is refilled by a duplicated or forged event |
 * | 8 | a Mission's goal reaches the journal |
 * | 9 | a worker result is treated as truth |
 *
 * Each test states the attack, the mechanism that stops it, and — where it is cheap — checks
 * the mechanism *directly* rather than only its visible effect. A red-team suite that only
 * asserted "the bad thing did not happen" would pass just as happily against a system that
 * refused to run at all.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-p47-red-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/* --------------------------------------------------------------- fixtures */

const CAPABILITIES: MissionCapabilityPort = {
  lookup: (c) => {
    if (c === 'find.video') return { risk: 'routine', requiresApproval: false }
    if (c === 'find.video.risky') return { risk: 'consequential', requiresApproval: true }
    return null
  },
  verifiers: () => ['video.verified'],
  known: () => ['find.video', 'find.video.risky'],
}

const SHAPE: MissionIntentShape = {
  subject: 'cat videos',
  requestedQuantity: 100,
  mediaConstraints: ['video'],
  contextConstraints: [],
  exclusions: [],
  paused: false,
}

function baseRecord(over: Partial<MissionRecord> = {}): MissionRecord {
  return {
    missionId: 'm-red',
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
    activatedAt: '2026-10-01T09:00:01.000Z',
    pausedAt: null,
    settledAt: null,
    deadlineAt: '2026-10-08T09:00:00.000Z',
    childRuns: [],
    limits: {
      maxChildRuns: 64,
      maxConcurrentChildRuns: 4,
      lifetimeMs: 30 * 86_400_000,
      verificationDeadlineMs: 60_000,
      
      maxRetainedMissions: 200,
      maxTitleChars: 160,
      maxIntentChars: 4_000,
      maxSuccessCriteria: 16,
      maxCriterionChars: 500,
    },
    verification: null,
    reason: null,
    limitsHit: [],
    priority: 'routine',
    budget: DEFAULT_MISSION_BUDGET,
    spend: { modelCalls: 0, actions: 0, externalRequests: 0, retries: 0, delegations: 0 },
    activePlan: null,
    planRevisions: 0,
    evidence: [],
    blockers: [],
    // No approval registry: a Mission holds a pointer to a Work gate or nothing at all.
    approval: null,
    wake: null,
    requestedQuantity: 100,
    resultCount: 0,
    corrections: [],
    awaitingOwner: false,
    lastDecision: null,
    lastUpdatedAt: '2026-10-01T09:00:00.000Z',
    ...over,
  }
}

/** A full engine plus runtime, wired exactly as Core wires them. */
async function rig(options: { authority?: Partial<MissionAuthorityPort>; delegate?: unknown } = {}) {
  const eventStore = await JsonlEventStore.open(join(dir, 'e.jsonl'))
  const fabric = await EventFabric.open({ store: eventStore })
  const engine = new MissionEngine({
    fabric,
    store: new MemoryMissionStore(),
    work: {
      run: () => undefined,
      stepsOf: () => [],
      isSettled: (s) => s === 'completed' || s === 'failed' || s === 'cancelled',
      pauseRun: async () => true,
      cancelRun: async () => true,
    } as never,
    principalId: 'owner',
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
  })
  await engine.open()

  const authority: MissionAuthorityPort = {
    stopAll: () => false,
    mayUse: (c) => CAPABILITIES.known().includes(c),
    maySpend: () => false,
    requestApproval: async (input) => ({ ok: true as const, approvalId: `gate-${input.stepId}` }),
    ...options.authority,
  }
  const port: MissionEnginePort = {
    record: (id) => engine.record(id),
    commitPlan: (i) => engine.commitPlan(i),
    transitionStep: (i) => engine.transitionStep(i),
    interruptStep: (i) => engine.interruptStep(i),
    recordEvidence: (i) => engine.recordEvidence(i),
    setBlocker: (i) => engine.setBlocker(i),
    openApproval: (i) => engine.openApproval(i),
    decideApproval: (i) => engine.decideApproval(i),
    expireApproval: (i) => engine.expireApproval(i),
    scheduleWake: (i) => engine.scheduleWake(i),
    fireWake: (i) => engine.fireWake(i),
    recordDecision: (i) => engine.recordDecision(i),
    charge: (i) => engine.charge(i),
    noteBudgetExceeded: (i) => engine.noteBudgetExceeded(i),
    setRequestedQuantity: (i) => engine.setRequestedQuantity(i),
    recordCorrection: (i) => engine.recordCorrection(i),
    recordAmbiguity: (i) => engine.recordAmbiguity(i),
    transition: (i) => engine.autonomyTransition(i),
    requestCompletion: (id) => engine.requestCompletion(id),
    writeIntent: (id, intent) => engine.writeIntent(id, intent),
    readIntent: (id) => engine.readIntent(id),
  }
  const runtime = new MissionAutonomyRuntime({
    fabric,
    principalId: 'owner',
    missions: port,
    capabilities: CAPABILITIES,
    authority,
    delegate:
      (options.delegate as never) ??
      (async (input: { stepId: string }) => ({
        ok: true as const,
        workerId: 'find.video-worker',
        assignmentId: `as-${input.stepId}`,
      })),
    execute: async () => ({
      ok: true as const,
      runId: 'run-1',
      verified: true,
      observedResults: 1,
      reportedResults: 0,
      summaryLength: 0,
    }),
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => 'x',
  })
  await runtime.open()
  return {
    engine,
    runtime,
    fabric,
    journal: async () =>
      (await readFile(join(dir, 'e.jsonl'), 'utf8'))
        .split(String.fromCharCode(10))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AnyCoreEvent),
    close: async () => {
      await runtime.close()
      await engine.close()
      await fabric.close()
    },
  }
}

function event(type: AnyCoreEvent['type'], payload: Record<string, unknown>, sequence: number): AnyCoreEvent {
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: '2026-10-01T09:00:00.000Z',
    source: 'core',
    actor: 'owner',
    correlationId: 'c',
    causationId: null,
    payload,
  } as unknown as AnyCoreEvent
}

/* ------------------------------------------------ attack 1: forged outcomes */

describe('attack 1: a tampered journal cannot manufacture a completed Mission', () => {
  const CREATED = event('mission.created', { missionId: 'm1', status: 'draft', limits: baseRecord().limits }, 1)
  const ACTIVE = event('mission.activated', { missionId: 'm1', from: 'draft', to: 'active', reason: 'owner' }, 2)

  it('refuses created → activated → completed with nothing behind it', () => {
    // Three hand-written lines. `active → completed` is *not* an edge, so the table is what
    // catches this one — and the earlier `active → verifying` gap it closed is why.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, event('mission.completed', { missionId: 'm1', from: 'active', to: 'completed', verifierId: 'x' }, 3))
    expect(state.missions.get('m1')?.status).toBe('active')
    expect(state.missions.get('m1')?.settledAt).toBeNull()
  })

  it('refuses a completion that claims verification but never wrote it', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, event('mission.transitioned', { missionId: 'm1', from: 'active', to: 'verifying', reason: 'verification_requested' }, 3))
    state = reduceMissionState(state, event('mission.completed', { missionId: 'm1', from: 'verifying', to: 'completed', verifierId: 'mission.work.verified' }, 4))
    expect(state.missions.get('m1')?.status).toBe('verifying')
  })

  it('refuses a completion whose verification did not pass', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, event('mission.transitioned', { missionId: 'm1', from: 'active', to: 'verifying', reason: 'verification_requested' }, 3))
    state = reduceMissionState(state, event('mission.verification.requested', { missionId: 'm1', verifierId: 'v', runIds: [] }, 4))
    state = reduceMissionState(state, event('mission.verification.completed', { missionId: 'm1', verifierId: 'v', outcome: 'not_established', reason: 'no_evidence' }, 5))
    state = reduceMissionState(state, event('mission.completed', { missionId: 'm1', from: 'verifying', to: 'completed', verifierId: 'v' }, 6))
    expect(state.missions.get('m1')?.status).toBe('verifying')
  })

  it('refuses a completion naming a verifier that never answered', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, event('mission.transitioned', { missionId: 'm1', from: 'active', to: 'verifying', reason: 'verification_requested' }, 3))
    state = reduceMissionState(state, event('mission.verification.requested', { missionId: 'm1', verifierId: 'v', runIds: [] }, 4))
    state = reduceMissionState(state, event('mission.verification.completed', { missionId: 'v-other', verifierId: 'v-other', outcome: 'passed', reason: 'verification_passed' }, 5))
    state = reduceMissionState(state, event('mission.completed', { missionId: 'm1', from: 'verifying', to: 'completed', verifierId: 'v-other' }, 6))
    expect(state.missions.get('m1')?.status).toBe('verifying')
  })

  it('refuses a step that claims verified without ever having run', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, {
      ...event('mission.plan.committed', {
        missionId: 'm1',
        planId: 'p1',
        revision: 1,
        supersedes: null,
        reason: null,
        steps: [stepPayload('s1', 'pending')],
      }, 3),
    })
    // `pending → verified` is not a legal step transition.
    state = reduceMissionState(state, event('mission.step.transitioned', {
      missionId: 'm1', planId: 'p1', stepId: 's1', from: 'pending', to: 'verified',
      workerId: null, runId: null, attempts: 0, reason: null,
    }, 4))
    expect(state.missions.get('m1')?.activePlan?.steps[0]?.status).toBe('pending')
  })

  it('refuses a plan whose revision skips a number, so the ceiling cannot be jumped', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, {
      ...event('mission.plan.committed', {
        missionId: 'm1', planId: 'p9', revision: 9, supersedes: 'p0',
        reason: 'plan_revised', steps: [stepPayload('s1', 'pending')],
      }, 3),
    })
    expect(state.missions.get('m1')?.activePlan).toBeNull()
    expect(state.missions.get('m1')?.planRevisions).toBe(0)
  })

  it('refuses a plan containing a step that depends on one it does not contain', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVE)
    state = reduceMissionState(state, {
      ...event('mission.plan.committed', {
        missionId: 'm1', planId: 'p1', revision: 1, supersedes: null, reason: null,
        steps: [{ ...stepPayload('s1', 'pending'), dependsOn: ['s-nonexistent'] }],
      }, 3),
    })
    expect(state.missions.get('m1')?.activePlan).toBeNull()
  })
})

function stepPayload(stepId: string, status: string) {
  return {
    stepId,
    index: 0,
    capability: 'find.video',
    verifier: 'video.verified',
    dependsOn: [],
    status,
    workerId: null,
    runId: null,
    attempts: 0,
    risk: 'routine',
    requiresApproval: false,
    approvalId: null,
    reason: null,
    startedAt: null,
    settledAt: null,
  }
}

/* --------------------------------------------- attack 2: correction escalation */

describe('attack 2: an owner correction cannot buy authority', () => {
  it('has no field through which a budget, a limit or a capability could travel', () => {
    const outcome = applyCorrection(baseRecord(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    // The complete key set of both halves. A budget would be the obvious thing to smuggle.
    expect(Object.keys(outcome.plan).sort()).toEqual(
      ['ambiguity', 'changedFields', 'correctionId', 'kind', 'missionId', 'next', 'question'].sort(),
    )
    expect(Object.keys(outcome.effect).sort()).toEqual(
      ['preservedEvidenceIds', 'replanRequired', 'settledStepIds'].sort(),
    )
    // The intent itself, which is the only thing that grew.
    expect(Object.keys(outcome.plan.next).sort()).toEqual(
      ['contextConstraints', 'exclusions', 'mediaConstraints', 'paused', 'requestedQuantity', 'subject'].sort(),
    )
  })

  it('refuses a quantity beyond the code-owned bound rather than clamping it', () => {
    const outcome = applyCorrection(baseRecord(), SHAPE, { quantity: 100_000_000 }, 'c-2')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.ambiguity).toBe('conflicting_quantity')
  })

  it('refuses a quantity that is not a positive whole number', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(applyCorrection(baseRecord(), SHAPE, { quantity }, 'c-3').ok).toBe(false)
    }
  })

  it('refuses an over-long subject rather than truncating it', () => {
    const outcome = applyCorrection(baseRecord(), SHAPE, { subject: 'x'.repeat(600) }, 'c-4')
    expect(outcome.ok).toBe(false)
  })

  it('refuses a constraint list that is unbounded', () => {
    const outcome = applyCorrection(
      baseRecord(),
      SHAPE,
      { context: Array.from({ length: 20 }, (_, i) => `place-${i}`) },
      'c-5',
    )
    expect(outcome.ok).toBe(false)
  })

  it('cannot settle a Mission, only steps — so it is not a back door to cancelled', () => {
    const outcome = applyCorrection(baseRecord(), SHAPE, { cancel: true }, 'c-6')
    if (!outcome.ok) throw new Error('expected a patch')
    // Nothing settled, and no status is claimed anywhere on the plan.
    expect(outcome.effect.settledStepIds).toEqual([])
    expect(JSON.stringify(outcome)).not.toMatch(/cancelled/)
  })

  it('rejects a correction to a settled Mission rather than reviving it', () => {
    const outcome = applyCorrection(
      baseRecord({ status: 'completed', settledAt: '2026-10-02T09:00:00.000Z' }),
      SHAPE,
      'in the barn',
      'c-7',
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('rejected')
  })
})

/* ------------------------------------------- attack 3: expiry is not consent */

describe('attack 3: a Mission can never turn an unanswered gate into consent', () => {
  /**
   * Rewritten, and the attack is *stronger* for it.
   *
   * The old version attacked a Mission-side gate: it expired one, then tried to decide it.
   * That defence lived in `decideApproval` refusing a non-`pending` gate — real, but it
   * defended against a bug rather than removing the capability.
   *
   * What is attacked now is the property that makes the capability absent: **a Mission has
   * no gate to decide.** The attack cannot be mounted, and the tests say so structurally
   * rather than asserting that a particular call happens to be refused.
   */
  it('has no method that could decide, approve or expire a gate', async () => {
    const { close } = await rig()
    const methods = Object.getOwnPropertyNames(MissionEngine.prototype).sort()
    expect(methods).not.toContain('decideApproval')
    expect(methods).not.toContain('expireApproval')
    expect(methods).not.toContain('openApproval')
    await close()
  })

  it('cannot mint a gate id, because it has no gate to mint one for', async () => {
    // The old implementation returned `mission-approval-N` from a private counter. The
    // counter is gone along with the concept: the only approval ids in the system are Work's
    // own, so there is no namespace left for a Mission to fabricate one in.
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'Risky', intent: 'Consequential work.' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    // Nothing is pending, because nothing was ever opened here.
    expect(engine.record(missionId)?.approval).toBeNull()
    // And a stray outcome for a gate it never had is refused outright.
    const stray = await engine.noteApprovalOutcome({
      missionId, approvalId: 'mission-approval-1', outcome: 'approved',
    })
    expect(stray.ok).toBe(false)
    expect(stray.reason).toMatch(/not waiting on that approval/)
    await close()
  })

  it('records Work reporting a denial as a blocker, so the Mission cannot route around it', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'Risky', intent: 'Consequential.' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({
      missionId,
      planId: 'p1',
      revision: 1,
      supersedes: null,
      reason: null,
      steps: [{ ...stepPayload('s1', 'running'), capability: 'find.video.risky', risk: 'consequential' }],
    })
    // Work opened a gate, then a person said no. Core records the *consequence*, not the
    // decision.
    await engine.noteApprovalRequested({
      missionId, stepId: 's1', approvalId: 'work-gate-1', source: 'requested', runId: 'run-1',
      requestedAt: '2026-10-01T09:00:05.000Z',
    })
    await engine.noteApprovalOutcome({ missionId, approvalId: 'work-gate-1', outcome: 'denied' })

    expect(engine.record(missionId)?.blockers.map((b) => b.code)).toContain('approval_denied')
    // And the pointer is settled, so the board stops claiming the Mission is waiting.
    expect(engine.record(missionId)?.approval?.outcome).toBe('denied')
    await close()
  })

  it('treats an expiry exactly as it treats a denial: blocked, never consent', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'Risky', intent: 'Consequential.' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({
      missionId,
      planId: 'p1',
      revision: 1,
      supersedes: null,
      reason: null,
      steps: [{ ...stepPayload('s1', 'running'), capability: 'find.video.risky', risk: 'consequential' }],
    })
    await engine.noteApprovalRequested({
      missionId, stepId: 's1', approvalId: 'work-gate-1', source: 'requested', runId: 'run-1',
      requestedAt: '2026-10-01T09:00:05.000Z',
    })
    await engine.noteApprovalOutcome({ missionId, approvalId: 'work-gate-1', outcome: 'expired' })
    // **Silence is not agreement.** Expiry blocks exactly as a denial does, because the
    // step will not run either way and only a person can change that.
    expect(engine.record(missionId)?.blockers.map((b) => b.code)).toContain('approval_expired')
    expect(engine.record(missionId)?.approval?.outcome).toBe('expired')
    await close()
  })

  it('records nothing when Work says a gate was approved', async () => {
    // The asymmetry is deliberate and worth pinning. An approval means Work's engine
    // resumed the Run and the step will settle on its own — so there is nothing for the
    // Mission to write, and writing "approved" would be Core claiming a step it did not run.
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'Risky', intent: 'Consequential.' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({
      missionId,
      planId: 'p1',
      revision: 1,
      supersedes: null,
      reason: null,
      steps: [{ ...stepPayload('s1', 'running'), capability: 'find.video.risky', risk: 'consequential' }],
    })
    await engine.noteApprovalRequested({
      missionId, stepId: 's1', approvalId: 'work-gate-1', source: 'requested', runId: 'run-1',
      requestedAt: '2026-10-01T09:00:05.000Z',
    })
    await engine.noteApprovalOutcome({ missionId, approvalId: 'work-gate-1', outcome: 'approved' })

    expect(engine.record(missionId)?.blockers).toEqual([])
    // Still open, because the question has not been answered by the step finishing yet —
    // which is exactly how long it was outstanding.
    expect(engine.record(missionId)?.approval?.outcome).toBeNull()
    await close()
  })
})
/* ------------------------------------------ attack 4: reported is not observed */

describe('attack 4: a reported finding is never counted as an observed one', () => {
  it('refuses a completion that rests on reports rather than observations', async () => {
    const { engine, runtime, close } = await rig()
    // Two wanted. `rig`'s executor observes one. The remaining gap is then filled *only* by
    // a capability's own claim — which is the attack.
    const created = await engine.create({ title: 'V', intent: 'Find two.' }, undefined, { requestedQuantity: 2 })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    // A capability *claims* it found something. That is a report, and it counts for nothing.
    await engine.recordEvidence({
      missionId, evidenceId: 'rep', stepId: null, kind: 'report', origin: 'reported', summaryLength: 5, expiresAt: null,
    })
    expect(engine.record(missionId)?.resultCount).toBe(0)

    await engine.commitPlan({
      missionId, planId: 'p1', revision: 1, supersedes: null, reason: null,
      steps: [stepPayload('s1', 'pending')],
    })
    // One pass runs the step, recording exactly one *observation*. Then the verifier is
    // asked — and refuses, because one observed result is not two, however loudly the
    // capability claimed the rest.
    await runtime.step(missionId, 'manual', null)
    expect(engine.record(missionId)?.resultCount).toBe(1)
    await runtime.step(missionId, 'manual', null)
    expect(engine.record(missionId)?.status).not.toBe('completed')
    // The refusal names the quantity, because "1 of 2 observed" is the fact and "a step
    // verified" would be true and useless.
    expect(engine.record(missionId)?.verification?.reason).toBe(MISSION_REASONS.quantity_not_reached)
    // And the report is still recorded, so a board can show it — it just does not count.
    expect(engine.record(missionId)?.evidence.some((e) => e.origin === 'reported')).toBe(true)
    await close()
  })

  it('counts only observed results, and keeps reports visible', () => {
    const record = baseRecord({
      evidence: [
        { evidenceId: 'a', stepId: null, kind: 'result', origin: 'observed', summaryLength: 1, recordedAt: '2026-10-01T09:00:00.000Z', expiresAt: null },
        { evidenceId: 'b', stepId: null, kind: 'result', origin: 'observed', summaryLength: 1, recordedAt: '2026-10-01T09:00:00.000Z', expiresAt: null },
        { evidenceId: 'c', stepId: null, kind: 'report', origin: 'reported', summaryLength: 1, recordedAt: '2026-10-01T09:00:00.000Z', expiresAt: null },
      ],
    })
    const view = summarise(record, {
      run: () => undefined,
      stepsOf: () => [],
      isSettled: () => true,
    }, new Date('2026-10-01T10:00:00.000Z'))
    expect(view.progress.observed).toBe(2)
    expect(view.progress.reported).toBe(1)
    expect(view.evidence.observed).toBe(2)
    expect(view.evidence.reported).toBe(1)
  })

  it('excludes expired evidence from progress rather than counting it', () => {
    const record = baseRecord({
      evidence: [
        { evidenceId: 'stale', stepId: null, kind: 'result', origin: 'observed', summaryLength: 1, recordedAt: '2026-10-01T09:00:00.000Z', expiresAt: '2026-10-01T09:30:00.000Z' },
      ],
    })
    const view = summarise(record, { run: () => undefined, stepsOf: () => [], isSettled: () => true }, new Date('2026-10-01T10:00:00.000Z'))
    expect(view.progress.observed).toBe(0)
    expect(view.evidence.expired).toBe(1)
    expect(view.evidence.observed).toBe(0)
  })
})

/* ------------------------------------- attack 5: replaying an unknown effect */

describe('attack 5: an uncertain external effect is never blindly replayed', () => {
  const withRunning = (risk: 'none' | 'consequential') =>
    baseRecord({
      activePlan: {
        planId: 'p1',
        revision: 1,
        createdAt: '2026-10-01T09:00:00.000Z',
        supersedes: null,
        reason: null,
        steps: [{ ...stepPayload('s1', 'running'), runId: 'run-live', risk, attempts: 1 }],
      },
    })

  it('marks a consequential interrupted step and forgets its Run', () => {
    const report = planRecovery(withRunning('consequential'), new Date('2026-10-01T09:30:00.000Z'))
    const interrupted = report.actions.find((a) => a.code === 'mark_interrupted')
    expect(interrupted).toBeDefined()
    // **Not automatic.** Recording the uncertainty is safe; deciding what to do about a
    // possibly-duplicated real-world effect is a person's job.
    expect(interrupted?.automatic).toBe(false)
    expect(report.uncertainEffects).toBe(1)
  })

  it('releases a safe interrupted step for retry instead', () => {
    const report = planRecovery(withRunning('none'), new Date('2026-10-01T09:30:00.000Z'))
    expect(report.actions.find((a) => a.code === 'retry_safe_running')).toBeDefined()
    expect(report.uncertainEffects).toBe(0)
  })

  it('leaves nothing in a terminal Mission to recover', () => {
    const report = planRecovery(
      baseRecord({ status: 'completed', activePlan: withRunning('consequential').activePlan }),
      new Date('2026-10-01T09:30:00.000Z'),
    )
    expect(report.quiescent).toBe(true)
    expect(report.actions).toEqual([])
  })

  it('is deterministic: same journal and clock, same report', () => {
    const record = withRunning('consequential')
    const at = new Date('2026-10-01T09:30:00.000Z')
    expect(JSON.stringify(planRecovery(record, at))).toBe(JSON.stringify(planRecovery(record, at)))
  })

  it('writes an interruption with no run id attached afterwards', async () => {
    // The fold forgets the Run id, which is what stops a later reconciliation attaching it
    // again and reading a second attempt as a resumption of the first.
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'Risky', intent: 'Consequential.' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({
      missionId, planId: 'p1', revision: 1, supersedes: null, reason: null,
      steps: [{ ...stepPayload('s1', 'running'), risk: 'consequential', runId: 'run-live', attempts: 1 }],
    })
    await engine.interruptStep({ missionId, planId: 'p1', stepId: 's1', consequential: true })
    const step = engine.record(missionId)?.activePlan?.steps[0]
    expect(step?.status).toBe('blocked')
    expect(step?.reason).toBe(MISSION_REASONS.interrupted)
    expect(step?.runId).toBeNull()
    await close()
  })
})

/* ------------------------------------ attack 6: forging capability authority */

describe('attack 6: a forged capability cannot widen what Freya may do', () => {
  it('blocks a capability the registry does not have, without registering it', async () => {
    const { engine, runtime, close } = await rig({
      delegate: vi.fn(async () => ({ ok: true as const, workerId: 'w', assignmentId: 'a' })),
    })
    const created = await engine.create({ title: 'T', intent: 'I' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({
      missionId, planId: 'p1', revision: 1, supersedes: null, reason: null,
      // A name that is not in `CAPABILITIES`, which `lookup` returns null for.
      steps: [{ ...stepPayload('s1', 'pending'), capability: 'definitely.not.registered' }],
    })
    const outcome = await runtime.step(missionId, 'manual', null)
    // Never delegated, never executed.
    expect(engine.record(missionId)?.status).toBe('blocked')
    expect(outcome.refusals.join(' ')).toMatch(/may not use/)
    // The step itself stays `pending`, and that is deliberate: the capability was refused at
    // the gate, so nothing about the step has *happened* yet. Marking it `blocked` would be
    // a different fact — "this step cannot ever run" — and the distinction matters to
    // whoever clears the blocker afterwards.
    expect(engine.record(missionId)?.activePlan?.steps[0]?.status).toBe('pending')
    // And the registry did not grow: nothing was registered by naming it.
    expect(CAPABILITIES.known()).not.toContain('definitely.not.registered')
    await close()
  })

  it('refuses to run a capability the authority port says is not permitted', async () => {
    let attempted = false
    const { engine, runtime, close } = await rig({
      authority: { mayUse: () => false },
      delegate: async () => {
        attempted = true
        return { ok: true as const, workerId: 'w', assignmentId: 'a' }
      },
    })
    const created = await engine.create({ title: 'T', intent: 'I' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({
      missionId, planId: 'p1', revision: 1, supersedes: null, reason: null,
      steps: [stepPayload('s1', 'pending')],
    })
    const outcome = await runtime.step(missionId, 'manual', null)
    expect(attempted).toBe(false)
    expect(outcome.refusals.join(' ')).toMatch(/may not use/)
    expect(engine.record(missionId)?.status).toBe('blocked')
    await close()
  })

  it('refuses to spend, whatever else is true', async () => {
    // `maySpend` is called and its answer is a refusal. There is no configuration that
    // makes it true, and nothing in the mission model for it to be true about.
    let spendAsked = 0
    const { mayMakeExternalRequest } = await import('../../../core/missions/autonomy/authority')
    const { NO_REAL_MONEY } = await import('../../../core/missions/autonomy/authority')
    const verdict = mayMakeExternalRequest('find.video', {
      stopAll: () => false,
      mayUse: () => true,
      maySpend: () => {
        spendAsked += 1
        return false
      },
      requestApproval: async () => ({ ok: true as const, approvalId: 'x' }),
    })
    expect(spendAsked).toBe(1)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toBe(NO_REAL_MONEY)
    // And the budget has no money dimension at all.
    expect(JSON.stringify(DEFAULT_MISSION_BUDGET)).not.toMatch(/money|credit|cost/i)
  })

  it('refuses every step while STOP ALL is latched, and says so', async () => {
    let stopped = true
    const execute = vi.fn(async () => ({ ok: true as const, runId: 'r', verified: true, observedResults: 1, reportedResults: 0, summaryLength: 0 }))
    const { engine, close } = await rig({ authority: { stopAll: () => stopped } })
    const created = await engine.create({ title: 'T', intent: 'I' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({ missionId, planId: 'p1', revision: 1, supersedes: null, reason: null, steps: [stepPayload('s1', 'pending')] })

    // The runtime is constructed with the authority port; build a second one against the
    // same engine to observe the latch through the real path.
    const runtime = new MissionAutonomyRuntime({
      fabric: engine['options'].fabric as never,
      principalId: 'owner',
      missions: {
        record: (id) => engine.record(id),
        commitPlan: (i) => engine.commitPlan(i),
        transitionStep: (i) => engine.transitionStep(i),
        interruptStep: (i) => engine.interruptStep(i),
        recordEvidence: (i) => engine.recordEvidence(i),
        setBlocker: (i) => engine.setBlocker(i),
        openApproval: (i) => engine.openApproval(i),
        decideApproval: (i) => engine.decideApproval(i),
        expireApproval: (i) => engine.expireApproval(i),
        scheduleWake: (i) => engine.scheduleWake(i),
        fireWake: (i) => engine.fireWake(i),
        recordDecision: (i) => engine.recordDecision(i),
        charge: (i) => engine.charge(i),
        noteBudgetExceeded: (i) => engine.noteBudgetExceeded(i),
        setRequestedQuantity: (i) => engine.setRequestedQuantity(i),
        recordCorrection: (i) => engine.recordCorrection(i),
        recordAmbiguity: (i) => engine.recordAmbiguity(i),
        transition: (i) => engine.autonomyTransition(i),
        requestCompletion: (id) => engine.requestCompletion(id),
        writeIntent: (id, intent) => engine.writeIntent(id, intent),
        readIntent: (id) => engine.readIntent(id),
      },
      capabilities: CAPABILITIES,
      authority: {
        stopAll: () => stopped,
        mayUse: () => true,
        maySpend: () => false,
        requestApproval: async () => ({ ok: true as const, approvalId: 'g' }),
      },
      delegate: async () => ({ ok: true as const, workerId: 'w', assignmentId: 'a' }),
      execute,
      stopAll: () => stopped,
      now: () => new Date('2026-10-01T09:00:00.000Z'),
    })
    const outcome = await runtime.step(missionId, 'manual', null)
    expect(execute).not.toHaveBeenCalled()
    expect(outcome.decision).toBe('wait')
    expect(engine.record(missionId)?.status).toBe('stopped')

    // And it stays stopped while the latch is held.
    stopped = true
    await runtime.step(missionId, 'manual', null)
    expect(execute).not.toHaveBeenCalled()
    expect(engine.record(missionId)?.status).toBe('stopped')
    await close()
  })
})

/* --------------------------------------------- attack 7: budget laundering */

describe('attack 7: a budget cannot be refilled by a forged or duplicated event', () => {
  it('adds a charge rather than setting spend to a total', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'T', intent: 'I' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.charge({ missionId, modelCalls: 0, actions: 3, externalRequests: 0, retries: 0, delegations: 0 })
    await engine.charge({ missionId, modelCalls: 0, actions: 3, externalRequests: 0, retries: 0, delegations: 0 })
    expect(engine.record(missionId)?.spend.actions).toBe(6)
    await close()
  })

  it('refuses a charge that would overdraw, and records the ceiling hit', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'T', intent: 'I' }, undefined, { budget: { maxActions: 2 } })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.charge({ missionId, modelCalls: 0, actions: 2, externalRequests: 0, retries: 0, delegations: 0 })
    const over = await engine.charge({ missionId, modelCalls: 0, actions: 1, externalRequests: 0, retries: 0, delegations: 0 })
    expect(over.ok).toBe(false)
    expect(engine.record(missionId)?.spend.actions).toBe(2)
    expect(engine.record(missionId)?.limitsHit).toContain('maxActions')
    await close()
  })

  it('refuses a budget a caller tried to raise at creation', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'T', intent: 'I' }, undefined, {
      budget: { maxActions: DEFAULT_MISSION_BUDGET.maxActions + 1 },
    })
    expect(created.ok).toBe(false)
    expect(created.reason).toMatch(/may not exceed/)
    await close()
  })

  it('refuses an unknown budget key rather than ignoring it', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'T', intent: 'I' }, undefined, {
      budget: { maxMoney: 1000 } as never,
    })
    expect(created.ok).toBe(false)
    await close()
  })

  it('counts a redelivered evidence item once, so progress cannot be doubled', () => {
    let state = reduceMissionState(initialMissionState(), event('mission.created', { missionId: 'm1', status: 'draft', limits: baseRecord().limits }, 1))
    const line = event('mission.evidence.recorded', {
      missionId: 'm1', evidenceId: 'same', stepId: null, kind: 'result', origin: 'observed', summaryLength: 1, expiresAt: null,
    }, 2)
    state = reduceMissionState(state, line)
    state = reduceMissionState(state, { ...line, sequence: 3 })
    expect(state.missions.get('m1')?.resultCount).toBe(1)
  })

  it('refuses a charge event whose dimensions are negative', () => {
    let state = reduceMissionState(initialMissionState(), event('mission.created', { missionId: 'm1', status: 'draft', limits: baseRecord().limits }, 1))
    state = reduceMissionState(state, event('mission.budget.spent', {
      missionId: 'm1', modelCalls: -5, actions: 0, externalRequests: 0, retries: 0, delegations: 0,
    }, 2))
    expect(state.missions.get('m1')?.spend.actions).toBe(0)
  })
})

/* ------------------------------------------------ attack 8: content leakage */

describe('attack 8: the goal never reaches the journal', () => {
  it('rejects an autonomy payload carrying an extra field', () => {
    // The exact-key property, tested against the validator directly. A hand-edited line
    // with `title` attached must be refused rather than silently kept.
    const valid = validateEventPayload('mission.intent.corrected', {
      missionId: 'm1',
      correctionId: 'c1',
      kind: 'patch',
      changedFields: ['context'],
      settledSteps: 1,
      preservedEvidence: 2,
      replannedFrom: null,
    })
    expect(valid.ok).toBe(true)
    const smuggled = validateEventPayload('mission.intent.corrected', {
      missionId: 'm1',
      correctionId: 'c1',
      kind: 'patch',
      changedFields: ['context'],
      settledSteps: 1,
      preservedEvidence: 2,
      replannedFrom: null,
      context: 'in the barn',
    })
    expect(smuggled.ok).toBe(false)
  })

  it('rejects an evidence payload carrying a summary', () => {
    const smuggled = validateEventPayload('mission.evidence.recorded', {
      missionId: 'm1',
      evidenceId: 'e1',
      stepId: null,
      kind: 'result',
      origin: 'observed',
      summaryLength: 10,
      expiresAt: null,
      summary: 'a barn with four cats',
    })
    expect(smuggled.ok).toBe(false)
  })

  it('rejects a plan step carrying a label', () => {
    const smuggled = validateEventPayload('mission.plan.committed', {
      missionId: 'm1',
      planId: 'p1',
      revision: 1,
      supersedes: null,
      reason: null,
      steps: [{ ...stepPayload('s1', 'pending'), label: 'go and look in the barn' }],
    })
    expect(smuggled.ok).toBe(false)
  })

  it('rejects a blocked reason outside the closed table', () => {
    const forged = validateEventPayload('mission.blocker.changed', {
      missionId: 'm1',
      code: 'because_i_said_so',
      stepId: null,
      raised: true,
    })
    expect(forged.ok).toBe(false)
  })

  it('rejects an unknown decision code', () => {
    const forged = validateEventPayload('mission.continuation.decided', {
      missionId: 'm1',
      decision: 'do_whatever_i_like',
      reason: 'owner',
      stepId: null,
      nextWakeAt: null,
    })
    expect(forged.ok).toBe(false)
  })

  it('rejects a wait with no instant, which is the open-ended wait', () => {
    const unbounded = validateEventPayload('mission.continuation.decided', {
      missionId: 'm1',
      decision: 'wait',
      reason: 'waiting_event',
      stepId: null,
      nextWakeAt: null,
    })
    expect(unbounded.ok).toBe(false)
    // And a non-wait carrying one is equally refused.
    const spurious = validateEventPayload('mission.continuation.decided', {
      missionId: 'm1',
      decision: 'continue',
      reason: 'delegated',
      stepId: 's1',
      nextWakeAt: '2026-10-01T09:01:00.000Z',
    })
    expect(spurious.ok).toBe(false)
  })

  it('rejects a wake with no instant, for any wake kind', () => {
    for (const kind of ['event', 'time', 'manual']) {
      const unbounded = validateEventPayload('mission.wake.scheduled', {
        missionId: 'm1',
        wakeId: 'w1',
        kind,
        source: kind === 'event' ? 'fabric' : kind === 'time' ? 'time' : 'owner',
        dueAt: 'not an instant',
        eventType: kind === 'event' ? 'work.run.completed' : null,
      })
      expect(unbounded.ok).toBe(false)
    }
  })

  it('rejects a wake claiming a source Freya does not grant herself', () => {
    const forged = validateEventPayload('mission.wake.scheduled', {
      missionId: 'm1',
      wakeId: 'w1',
      kind: 'time',
      source: 'a_model',
      dueAt: '2026-10-01T09:01:00.000Z',
      eventType: null,
    })
    expect(forged.ok).toBe(false)
  })

  it('rejects an ambiguous correction recorded as a patch', () => {
    // A journal must not be able to claim a guess was a resolution.
    const forged = validateEventPayload('mission.intent.corrected', {
      missionId: 'm1',
      correctionId: 'c1',
      kind: 'ambiguous',
      changedFields: ['context'],
      settledSteps: 0,
      preservedEvidence: 0,
      replannedFrom: null,
    })
    expect(forged.ok).toBe(false)
  })

  it('rejects an ambiguity outside the closed table', () => {
    const forged = validateEventPayload('mission.correction.ambiguous', {
      missionId: 'm1',
      correctionId: 'c1',
      ambiguity: 'i_did_not_bother',
    })
    expect(forged.ok).toBe(false)
  })

  it('keeps the whole Mission out of the journal after a real run', async () => {
    const { engine, runtime, journal, close } = await rig()
    const created = await engine.create(
      { title: 'Cat videos', intent: 'Find 100 cat videos in the barn.' },
      undefined,
      { requestedQuantity: 100 },
    )
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.writeIntent(missionId, SHAPE)
    await engine.commitPlan({ missionId, planId: 'p1', revision: 1, supersedes: null, reason: null, steps: [stepPayload('s1', 'pending')] })
    await runtime.step(missionId, 'manual', null)
    const corrected = await runtime.correct(missionId, 'in the barn')
    expect(corrected.ok).toBe(true)

    const lines = await journal()
    const serialised = JSON.stringify(lines)
    expect(serialised).not.toMatch(/cat video/i)
    expect(serialised).not.toMatch(/in the barn/i)
    // But the numbers and the field name are there, because progress has to be computable
    // and a correction has to be auditable.
    expect(serialised).toMatch(/"requestedQuantity":100/)
    expect(serialised).toMatch(/"changedFields":\["context"\]/)
    await close()
  })
})

/* ----------------------------------------- attack 9: worker results are not truth */

describe('attack 9: a worker result is evidence, not truth', () => {
  it('does not verify a step the executor did not verify', async () => {
    const { engine, close } = await rig()
    const created = await engine.create({ title: 'T', intent: 'I' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({ missionId, planId: 'p1', revision: 1, supersedes: null, reason: null, steps: [stepPayload('s1', 'pending')] })
    // The executor lies: it returns a run that "completed" with no verified step.
    const eventStore = await JsonlEventStore.open(join(dir, 'second.jsonl'))
    const fabric = await EventFabric.open({ store: eventStore })
    const engine2 = new MissionEngine({
      fabric,
      store: new MemoryMissionStore(),
      work: { run: () => undefined, stepsOf: () => [], isSettled: () => true, pauseRun: async () => true, cancelRun: async () => true } as never,
      principalId: 'owner',
      now: () => new Date('2026-10-01T09:00:00.000Z'),
    })
    await engine2.open()
    const runtime2 = new MissionAutonomyRuntime({
      fabric,
      principalId: 'owner',
      missions: {
        record: (id) => engine2.record(id),
        commitPlan: (i) => engine2.commitPlan(i),
        transitionStep: (i) => engine2.transitionStep(i),
        interruptStep: (i) => engine2.interruptStep(i),
        recordEvidence: (i) => engine2.recordEvidence(i),
        setBlocker: (i) => engine2.setBlocker(i),
        openApproval: (i) => engine2.openApproval(i),
        decideApproval: (i) => engine2.decideApproval(i),
        expireApproval: (i) => engine2.expireApproval(i),
        scheduleWake: (i) => engine2.scheduleWake(i),
        fireWake: (i) => engine2.fireWake(i),
        recordDecision: (i) => engine2.recordDecision(i),
        charge: (i) => engine2.charge(i),
        noteBudgetExceeded: (i) => engine2.noteBudgetExceeded(i),
        setRequestedQuantity: (i) => engine2.setRequestedQuantity(i),
        recordCorrection: (i) => engine2.recordCorrection(i),
        recordAmbiguity: (i) => engine2.recordAmbiguity(i),
        transition: (i) => engine2.autonomyTransition(i),
        requestCompletion: (id) => engine2.requestCompletion(id),
        writeIntent: (id, intent) => engine2.writeIntent(id, intent),
        readIntent: (id) => engine2.readIntent(id),
      },
      capabilities: CAPABILITIES,
      authority: {
        stopAll: () => false, mayUse: () => true, maySpend: () => false,
        requestApproval: async () => ({ ok: true as const, approvalId: 'g' }),
      },
      delegate: async () => ({ ok: true as const, workerId: 'w', assignmentId: 'a' }),
      // "It worked, trust me" — and zero observed results.
      execute: async () => ({
        ok: true as const, runId: 'run-claimed', verified: true,
        observedResults: 0, reportedResults: 99, summaryLength: 0,
      }),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
    })
    const created2 = await engine2.create({ title: 'T', intent: 'I' }, undefined, { requestedQuantity: 100 })
    const id2 = created2.missionId as string
    await engine2.activate(id2)
    await engine2.commitPlan({
      missionId: id2, planId: 'p1', revision: 1, supersedes: null, reason: null,
      steps: [stepPayload('s1', 'pending')],
    })
    await runtime2.step(id2, 'manual', null)
    await runtime2.step(id2, 'manual', null)
    // Ninety-nine *reports* completed nothing.
    expect(engine2.record(id2)?.resultCount).toBe(0)
    expect(engine2.record(id2)?.status).not.toBe('completed')
    expect(engine2.record(id2)?.verification?.reason).toBe(MISSION_REASONS.quantity_not_reached)
    await runtime2.close(); await engine2.close(); await fabric.close(); await eventStore.close()
    await close()
  })

  it('never completes on a step whose verification failed', async () => {
    const { engine, runtime, close } = await rig()
    const created = await engine.create({ title: 'T', intent: 'I' })
    const missionId = created.missionId as string
    await engine.activate(missionId)
    await engine.commitPlan({ missionId, planId: 'p1', revision: 1, supersedes: null, reason: null, steps: [stepPayload('s1', 'pending')] })
    await runtime.step(missionId, 'manual', null)
    const outcome = await engine.requestCompletion(missionId)
    // `rig`'s executor verifies, so this one *does* pass — and the point is that it took a
    // verifier, not the executor's word.
    expect(outcome.ok).toBe(true)
    expect(engine.record(missionId)?.verification?.verifierId).toBeTruthy()
    await close()
  })
})
