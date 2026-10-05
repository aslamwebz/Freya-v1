// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_MISSION_BUDGET } from '../../core/missions/autonomy/types'
import {
  MISSION_STATUSES,
  MISSION_TERMINAL_STATUSES,
  MISSION_TRANSITIONS,
  MISSION_REASONS,
  DEFAULT_MISSION_LIMITS,
  canTransitionMission,
  isLiveMissionStatus,
  isParkedMissionStatus,
  isTerminalMissionStatus,
  missionLimits,
  normaliseIntentShape,
  normaliseMissionContent,
  readMissionStatus,
  type MissionStatus,
} from '../../core/missions/types'
import { reduceMissionState, initialMissionState } from '../../core/missions/state'
import type { AnyCoreEvent } from '../../core/events/envelope'

/**
 * The Mission state machine and its input boundary.
 *
 * These are the tables, over the whole vocabulary, with no engine and no clock. A
 * transition table that is only correct when you go through the engine is not a
 * transition table; this file is where the state machine is actually defined, and
 * both the engine and the reducer read it.
 *
 * The reducer tests matter separately: the reducer is what runs on replay, so a
 * journal that claims an illegal transition must be *refused* rather than folded
 * into a state the live engine would never produce.
 */

describe('the lifecycle', () => {
  it('has exactly the twelve documented statuses', () => {
    // Written out rather than derived, so a change to the vocabulary has to be a
    // deliberate edit to this file and not just an edit to the domain.
    expect([...MISSION_STATUSES]).toEqual([
      'draft',
      'ready',
      'planning',
      'active',
      'waiting',
      'blocked',
      'approval-required',
      'verifying',
      'stopped',
      'completed',
      'failed',
      'cancelled',
    ])
  })

  it('names exactly three of them terminal', () => {
    expect([...MISSION_TERMINAL_STATUSES]).toEqual(['completed', 'failed', 'cancelled'])
    for (const status of MISSION_STATUSES) {
      expect(isTerminalMissionStatus(status)).toBe(MISSION_TERMINAL_STATUSES.includes(status as never))
    }
  })

  it('permits exactly the documented transitions', () => {
    // Written out longhand rather than derived, so the table is the specification
    // and a change to it has to be a deliberate edit.
    expect(MISSION_TRANSITIONS.draft).toEqual(['ready', 'active', 'cancelled'])
    expect(MISSION_TRANSITIONS.completed).toEqual([])
    expect(MISSION_TRANSITIONS.failed).toEqual([])
    expect(MISSION_TRANSITIONS.cancelled).toEqual([])
  })

  it('names exactly three live statuses, and the parked ones are not among them', () => {
    // Live means "may attach Work and act". Everything else is parked, and a parked
    // Mission that could still act would make `waiting` and `blocked` decorative.
    const live = MISSION_STATUSES.filter((status) => isLiveMissionStatus(status))
    expect(live).toEqual(['ready', 'planning', 'active'])
    for (const status of MISSION_STATUSES) {
      const parked = isParkedMissionStatus(status)
      expect(parked).toBe(['waiting', 'blocked', 'approval-required'].includes(status))
    }
  })

  it('reaches completed only through verifying', () => {
    // The whole point of the extra state. If `active → completed` were legal there
    // would be a window in which a Mission's status claimed it was done while nothing
    // had been established — which is where a fabricated outcome would live.
    for (const from of MISSION_STATUSES) {
      if (from === 'verifying') continue
      expect(canTransitionMission(from, 'completed')).toBe(false)
    }
    expect(canTransitionMission('verifying', 'completed')).toBe(true)
  })

  it('leaves approval-required only to a parked or live status, never to consent', () => {
    // A gate cannot be closed by the thing that opened it, and expiry lands in `blocked`
    // rather than anywhere it could be mistaken for approval.
    for (const to of MISSION_STATUSES) {
      if (['active', 'waiting', 'blocked', 'stopped', 'cancelled', 'failed'].includes(to)) continue
      expect(canTransitionMission('approval-required', to)).toBe(false)
    }
  })

  it('leaves stopped only through the owner resuming it', () => {
    // STOP ALL is a latch, not a settlement. Four edges out, and every one of them is the
    // owner acting or the owner deciding it is finished — no timer, no capability, and
    // nothing a Mission could reach for itself.
    //
    // `ready` is the autonomous resume ("the gate is open again") and `active` is the
    // owner's ("carry on"). Naming them apart is what stops a Mission being reported as
    // running when it is only reopened.
    expect(MISSION_TRANSITIONS.stopped).toEqual(['ready', 'active', 'cancelled', 'failed'])
  })

  it('has no way out of a terminal status — no resurrection', () => {
    // The single most important property in this file. Retrying means a new
    // Mission or another child Run *before* settlement; a settled Mission is
    // rewritten by nobody.
    for (const status of MISSION_TERMINAL_STATUSES) {
      for (const target of MISSION_STATUSES) {
        expect(canTransitionMission(status, target)).toBe(false)
      }
    }
  })

  it('refuses every undocumented shortcut', () => {
    const illegal: readonly [MissionStatus, MissionStatus][] = [
      ['draft', 'stopped'],
      ['draft', 'completed'],
      ['draft', 'failed'],
      ['draft', 'verifying'],
      ['active', 'draft'],
      ['active', 'active'],
      ['stopped', 'draft'],
      ['stopped', 'verifying'],
      ['ready', 'completed'],
      ['planning', 'completed'],
      ['waiting', 'completed'],
      ['blocked', 'completed'],
      ['approval-required', 'completed'],
      ['verifying', 'draft'],
      ['verifying', 'ready'],
      ['draft', 'draft'],
      ['blocked', 'blocked'],
      ['waiting', 'waiting'],
    ]
    for (const [from, to] of illegal) {
      expect(canTransitionMission(from, to)).toBe(false)
    }
  })

  it('permits exactly the legal moves', () => {
    const legal: readonly [MissionStatus, MissionStatus][] = [
      ['draft', 'ready'],
      ['draft', 'active'],
      ['draft', 'cancelled'],
      ['ready', 'planning'],
      ['ready', 'active'],
      ['planning', 'active'],
      ['active', 'waiting'],
      ['active', 'blocked'],
      ['active', 'approval-required'],
      ['active', 'verifying'],
      ['active', 'planning'],
      ['active', 'stopped'],
      ['active', 'failed'],
      ['active', 'cancelled'],
      ['waiting', 'active'],
      ['blocked', 'active'],
      ['approval-required', 'active'],
      ['verifying', 'completed'],
      ['stopped', 'ready'],
    ]
    for (const [from, to] of legal) {
      expect(canTransitionMission(from, to)).toBe(true)
    }
  })

  it('reads the pre-Phase-47 paused alias as stopped', () => {
    // `paused` meant "resumable by anyone holding mission.manage"; `stopped` means the
    // gate is latched and only the owner reopens it. A journal written before the
    // rename must keep replaying — and keep meaning what it meant.
    expect(readMissionStatus('paused')).toBe('stopped')
    expect(readMissionStatus('stopped')).toBe('stopped')
    expect(readMissionStatus('active')).toBe('active')
    // Anything the domain does not have is refused, not guessed at.
    expect(readMissionStatus('running')).toBeNull()
    expect(readMissionStatus(7)).toBeNull()
  })

  it('has closed reason codes rather than free text for durable records', () => {
    // A reason that reaches a durable event must be a code this repository chose.
    for (const reason of Object.values(MISSION_REASONS)) {
      expect(typeof reason).toBe('string')
      expect(reason.length).toBeGreaterThan(0)
    }
    expect(MISSION_REASONS.owner).toBeTruthy()
    expect(MISSION_REASONS.verification_passed).toBeTruthy()
    expect(MISSION_REASONS.verification_not_established).toBeTruthy()
    expect(MISSION_REASONS.verification_timeout).toBeTruthy()
    expect(MISSION_REASONS.deadline_expired).toBeTruthy()
    expect(MISSION_REASONS.child_run_limit).toBeTruthy()
    expect(MISSION_REASONS.concurrent_run_limit).toBeTruthy()
  })

  it('names a closed code for every way autonomy can stop', () => {
    // The four reasons a Mission parks rather than failing, plus the ones that only
    // autonomy can produce. Written as a list so adding a state without adding a reason
    // fails here.
    for (const reason of [
      'stopped',
      'resumed',
      'intent_ambiguous',
      'approval_pending',
      'approval_denied',
      'approval_expired',
      'budget_exhausted',
      'retry_ceiling',
      'concurrency_ceiling',
      'unknown_capability',
      'no_capable_worker',
      'verification_expired',
      'quantity_not_reached',
      'no_evidence',
      'interrupted',
      'wake_missed',
      'replan_ceiling',
      'plan_revised',
      'intent_corrected',
    ] as const) {
      expect(MISSION_REASONS[reason]).toBe(reason)
    }
  })
})

describe('limits', () => {
  it('publishes code-owned ceilings that a Mission cannot grow past', () => {
    expect(DEFAULT_MISSION_LIMITS.maxChildRuns).toBe(64)
    expect(DEFAULT_MISSION_LIMITS.maxConcurrentChildRuns).toBe(4)
    expect(DEFAULT_MISSION_LIMITS.maxRetainedMissions).toBe(200)
    expect(DEFAULT_MISSION_LIMITS.lifetimeMs).toBe(30 * 24 * 60 * 60_000)
    // The lifetime is a wall, not a check between operations: a verifier that
    // ignores its signal must not be able to hold a Mission open for ever.
    expect(DEFAULT_MISSION_LIMITS.verificationDeadlineMs).toBe(60_000)
  })

  it('accepts a caller narrowing a ceiling', () => {
    const limits = missionLimits({ maxChildRuns: 2 })
    expect(limits.maxChildRuns).toBe(2)
    expect(limits.maxConcurrentChildRuns).toBe(DEFAULT_MISSION_LIMITS.maxConcurrentChildRuns)
  })

  it('refuses a caller raising a ceiling', () => {
    // The property that makes the ceiling a ceiling.
    expect(() => missionLimits({ maxChildRuns: 65 })).toThrow()
    expect(() => missionLimits({ maxConcurrentChildRuns: 5 })).toThrow()
    expect(() => missionLimits({ verificationDeadlineMs: 61_000 })).toThrow()
    expect(() => missionLimits({ lifetimeMs: 31 * 24 * 60 * 60_000 })).toThrow()
  })

  it('refuses a malformed or unknown limit rather than ignoring it', () => {
    expect(() => missionLimits({ maxChildRuns: 0 })).toThrow()
    expect(() => missionLimits({ maxChildRuns: 1.5 })).toThrow()
    expect(() => missionLimits({ maxChildRuns: -1 })).toThrow()
    expect(() => missionLimits({ somethingElse: 5 } as never)).toThrow()
  })
})

describe('private content normalisation', () => {
  const valid = {
    title: 'Find me another job',
    intent: 'Look for roles that fit and apply to the good ones.',
    successCriteria: ['Three applications sent', 'Two replies'],
  }

  it('accepts and trims ordinary content', () => {
    const content = normaliseMissionContent(valid)
    expect(content.ok).toBe(true)
    if (!content.ok) return
    expect(content.value.title).toBe('Find me another job')
    expect(content.value.successCriteria).toHaveLength(2)
  })

  it('refuses an over-long title', () => {
    expect(normaliseMissionContent({ ...valid, title: 'x'.repeat(161) }).ok).toBe(false)
  })

  it('refuses an over-long intent', () => {
    expect(normaliseMissionContent({ ...valid, intent: 'x'.repeat(4001) }).ok).toBe(false)
  })

  it('refuses too many success criteria and over-long ones', () => {
    expect(normaliseMissionContent({ ...valid, successCriteria: Array.from({ length: 17 }, () => 'a') }).ok).toBe(false)
    expect(normaliseMissionContent({ ...valid, successCriteria: ['x'.repeat(501)] }).ok).toBe(false)
  })

  it('refuses empty content rather than storing a blank Mission', () => {
    expect(normaliseMissionContent({ ...valid, title: '   ' }).ok).toBe(false)
    expect(normaliseMissionContent({ ...valid, intent: '' }).ok).toBe(false)
  })

  it('accepts a Mission with no success criteria, which may refine them later', () => {
    expect(normaliseMissionContent({ ...valid, successCriteria: [] }).ok).toBe(true)
    expect(normaliseMissionContent({ ...valid, successCriteria: undefined }).ok).toBe(true)
  })

  it('treats content as data and strips control characters', () => {
    // No HTML execution, no dynamic code: content is only ever stored and later
    // rendered as text. Stripping control characters stops a terminal escape from
    // surviving into a window title or a log line.
    //
    // The escape is constructed rather than typed, so this source file carries no
    // control byte of its own.
    const ESCAPE = String.fromCharCode(27)
    const content = normaliseMissionContent({
      ...valid,
      title: `Job${ESCAPE}[31m hunt`,
      intent: ['line one', 'line two'].join(String.fromCharCode(10)),
    })
    expect(content.ok).toBe(true)
    if (!content.ok) return
    expect(content.value.title).not.toContain(ESCAPE)
    expect(content.value.title).toBe('Job[31m hunt')
    expect(content.value.intent).toContain('line two')
  })

  it('collapses absurd whitespace rather than storing padding', () => {
    const content = normaliseMissionContent({ ...valid, title: 'a'.padEnd(200, ' ') })
    expect(content.ok).toBe(true)
    if (!content.ok) return
    expect(content.value.title).toBe('a')
  })

  it('rejects a non-string where text belongs, rather than coercing it', () => {
    expect(normaliseMissionContent({ ...valid, title: 42 as never }).ok).toBe(false)
    expect(normaliseMissionContent({ ...valid, successCriteria: [7] as never }).ok).toBe(false)
    expect(normaliseMissionContent({ ...valid, successCriteria: 'a,b' as never }).ok).toBe(false)
  })

  it('carries no identity field at all', () => {
    const content = normaliseMissionContent(valid)
    if (!content.ok) return
    // C3/C8: a caller cannot name a principal, and Mission content has no slot
    // for one even if it tried.
    //
    // `intentShape` is new in Phase 47 and is the only addition. It is the
    // machine-patchable half of the goal — a subject, a quantity and three constraint
    // lists — and it is here rather than in the journal because every one of its fields
    // is a word.
    expect(Object.keys(content.value).sort()).toEqual(['intent', 'intentShape', 'successCriteria', 'title'])
  })
})

/* ------------------------------------------------------- structured intent */

describe('the structured intent', () => {
  it('accepts a countable goal and keeps every constraint separate', () => {
    const shape = normaliseIntentShape({
      subject: 'cat videos',
      quantity: 100,
      media: ['video'],
      context: ['in the barn'],
      exclusions: ['no horror'],
    })
    expect(shape.ok).toBe(true)
    if (!shape.ok) return
    // The acceptance case, as data. `context` is a named field, which is what lets
    // "in the barn" patch one constraint without touching the subject, the quantity
    // or the media type.
    expect(shape.value.subject).toBe('cat videos')
    expect(shape.value.requestedQuantity).toBe(100)
    expect(shape.value.mediaConstraints).toEqual(['video'])
    expect(shape.value.contextConstraints).toEqual(['in the barn'])
    expect(shape.value.exclusions).toEqual(['no horror'])
    expect(shape.value.paused).toBe(false)
  })

  it('treats an absent quantity as absent, not as zero', () => {
    // "Find some cat videos" and "find zero cat videos" are different requests, and
    // reporting the second as the first would be a lie about the goal.
    const shape = normaliseIntentShape({ subject: 'cat videos' })
    expect(shape.ok).toBe(true)
    if (!shape.ok) return
    expect(shape.value.requestedQuantity).toBeNull()
  })

  it('refuses a quantity that is not a positive whole number', () => {
    // Refused rather than clamped: silently turning "about a thousand" into 1000 would
    // be the owner being told they asked for something they did not.
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(normaliseIntentShape({ subject: 'x', quantity }).ok).toBe(false)
    }
    expect(normaliseIntentShape({ subject: 'x', quantity: 100_001 }).ok).toBe(false)
  })

  it('de-duplicates a constraint rather than counting it twice', () => {
    // "in the barn, in the barn" is one constraint stated twice, and keeping both
    // would make a constraint count disagree with the number of things it names.
    const shape = normaliseIntentShape({ subject: 'x', context: ['in the barn', 'in the barn'] })
    expect(shape.ok).toBe(true)
    if (!shape.ok) return
    expect(shape.value.contextConstraints).toEqual(['in the barn'])
  })

  it('refuses a constraint list that is not a list, or is unbounded', () => {
    expect(normaliseIntentShape({ subject: 'x', context: 'in the barn' as never }).ok).toBe(false)
    expect(normaliseIntentShape({ subject: 'x', context: Array.from({ length: 9 }, () => 'x') }).ok).toBe(false)
  })

  it('is optional, and absent means no structured goal at all', () => {
    // A Mission with no countable goal is a legitimate Mission — "help with my
    // house move" — so the shape being null is a supported case rather than a
    // half-filled one.
    expect(normaliseMissionContent({ title: 'T', intent: 'I' }).ok).toBe(true)
    const content = normaliseMissionContent({ title: 'T', intent: 'I' })
    if (!content.ok) return
    expect(content.value.intentShape).toBeNull()
    expect(normaliseMissionContent({ title: 'T', intent: 'I', intentShape: null }).ok).toBe(true)
  })
})

/* ------------------------------------------------------------------ fold */

function event(type: AnyCoreEvent['type'], payload: Record<string, unknown>, sequence: number): AnyCoreEvent {
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: '2026-10-01T09:00:00.000Z',
    source: 'core',
    actor: 'owner',
    correlationId: 'c1',
    causationId: null,
    payload,
  } as unknown as AnyCoreEvent
}

const CREATED = event(
  'mission.created',
  { missionId: 'm1', status: 'draft', limits: DEFAULT_MISSION_LIMITS, budget: DEFAULT_MISSION_BUDGET },
  1,
)
const ACTIVATED = event('mission.activated', { missionId: 'm1', from: 'draft', to: 'active' }, 2)
const PAUSED = event('mission.paused', { missionId: 'm1', from: 'active', to: 'stopped', reason: 'owner' }, 3)
const RESUMED_ACTIVE = event('mission.resumed', { missionId: 'm1', from: 'stopped', to: 'active', reason: 'resumed' }, 4)

/**
 * The autonomous resume: `stopped -> ready`.
 *
 * A second, distinct fact. An owner pressing Resume wants the Mission to *run*; autonomy,
 * after a wake, only knows that the gate is open again and that planning is the next thing
 * that has to happen. Naming them apart is what keeps "carried on" from meaning two things.
 */
const RESUMED_READY = event('mission.resumed', { missionId: 'm1', from: 'stopped', to: 'ready', reason: 'resumed' }, 4)

/**
 * Into `verifying`, which is now the only edge into `completed`.
 *
 * The Phase 47 state exists so that "we are checking" and "it is done" are two facts.
 * Without this line in the happy path, the completion below would be an illegal
 * transition — and the test would be asserting a fabrication.
 */
const VERIFYING = event(
  'mission.transitioned',
  { missionId: 'm1', from: 'active', to: 'verifying', reason: 'verification_requested', verifierId: null },
  5,
)

/**
 * The two verification events that must precede a completion.
 *
 * They are part of the happy path rather than an afterthought, because a
 * `mission.completed` line with nothing behind it is exactly the fabrication the
 * reducer refuses. An earlier version of this file folded a bare `completed` and
 * called it the happy path, which is the bug in test form.
 */
const VERIFICATION_REQUESTED = event(
  'mission.verification.requested',
  { missionId: 'm1', verifierId: 'mission.work.verified', runIds: [] },
  6,
)
const VERIFICATION_PASSED = event(
  'mission.verification.completed',
  { missionId: 'm1', verifierId: 'mission.work.verified', outcome: 'passed', reason: 'verification_passed' },
  7,
)

const COMPLETED = event(
  'mission.completed',
  { missionId: 'm1', from: 'verifying', to: 'completed', verifierId: 'mission.work.verified' },
  8,
)
const CANCELLED = event('mission.cancelled', { missionId: 'm1', from: 'active', to: 'cancelled', reason: 'owner' }, 5)

describe('the fold', () => {
  it('replays the happy path', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    expect(state.missions.get('m1')?.status).toBe('draft')
    state = reduceMissionState(state, ACTIVATED)
    expect(state.missions.get('m1')?.status).toBe('active')
    state = reduceMissionState(state, PAUSED)
    expect(state.missions.get('m1')?.status).toBe('stopped')
    state = reduceMissionState(state, RESUMED_ACTIVE)
    expect(state.missions.get('m1')?.status).toBe('active')
    // Checking, then asked, then answered, and only then concluded.
    state = reduceMissionState(state, VERIFYING)
    expect(state.missions.get('m1')?.status).toBe('verifying')
    state = reduceMissionState(state, VERIFICATION_REQUESTED)
    state = reduceMissionState(state, VERIFICATION_PASSED)
    state = reduceMissionState(state, COMPLETED)
    expect(state.missions.get('m1')?.status).toBe('completed')
    expect(state.missions.get('m1')?.verification?.state).toBe('passed')
  })

  it('replays the autonomous resume as ready, not running', () => {
    // The other half of the pair. Same origin, same event name, different destination — and
    // a journal that cannot tell them apart could not answer "did it ever start working
    // again, or was it only reopened?".
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, PAUSED)
    state = reduceMissionState(state, RESUMED_READY)
    expect(state.missions.get('m1')?.status).toBe('ready')
    // And from `ready` it cannot reach `completed` without running and verifying first.
    state = reduceMissionState(state, event('mission.completed', { missionId: 'm1', from: 'ready', to: 'completed', verifierId: 'v' }, 5))
    expect(state.missions.get('m1')?.status).toBe('ready')
  })

  it('refuses a completed claim with no verification behind it', () => {
    // The sharpest forgery available. Three hand-written lines — created, activated,
    // completed — would otherwise fold into a Mission that reports itself achieved with
    // nothing having established anything, which is the fabricated outcome the Red Team
    // gauntlet calls zero-tolerance.
    //
    // Phase 47 adds a second, independent guard: `verifying → completed` is the only
    // edge, so the journal must also claim verification *began*. The verification-record
    // check below is still the load-bearing one, because it names a verifier.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, COMPLETED)
    expect(state.missions.get('m1')?.status).toBe('active')
    expect(state.missions.get('m1')?.verification).toBeNull()
  })

  it('refuses a completed claim that skipped the verifying state', () => {
    // Same forgery, with the new state *acknowledged* — a journal that claims checking
    // happened but never wrote the `verifying` transition. The transition table is what
    // catches this one, which is why `verifying` is the only edge.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, VERIFICATION_REQUESTED)
    state = reduceMissionState(state, VERIFICATION_PASSED)
    state = reduceMissionState(state, COMPLETED)
    expect(state.missions.get('m1')?.status).toBe('active')
  })

  it('refuses a completed claim naming a verifier that never passed', () => {
    // The verifier id has to be the one that actually answered, or a journal could
    // borrow a passing verifier's name from another Mission's history.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, VERIFYING)
    state = reduceMissionState(state, VERIFICATION_REQUESTED)
    state = reduceMissionState(state, VERIFICATION_PASSED)
    const borrowed = event(
      'mission.completed',
      { missionId: 'm1', from: 'verifying', to: 'completed', verifierId: 'mission.something.else' },
      7,
    )
    state = reduceMissionState(state, borrowed)
    // Stays verifying: the Mission is still checking, and a completion naming a
    // verifier that never passed does not end that.
    expect(state.missions.get('m1')?.status).toBe('verifying')
  })

  it('refuses a completed claim whose verification did not pass', () => {
    // A verification that asked and did not establish is not a licence to conclude,
    // however confident the surrounding text is.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, VERIFYING)
    state = reduceMissionState(state, VERIFICATION_REQUESTED)
    const notEstablished = event(
      'mission.verification.completed',
      { missionId: 'm1', verifierId: 'mission.work.verified', outcome: 'not_established', reason: 'child_run_unverified' },
      6,
    )
    state = reduceMissionState(state, notEstablished)
    state = reduceMissionState(state, COMPLETED)
    expect(state.missions.get('m1')?.status).toBe('verifying')
  })

  it('refuses a completed claim with no verifier named at all', () => {
    // A completion with no verifier named cannot be corroborated against the
    // verification record, so it is refused � and the Mission stays verifying because
    // the question is still open.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, VERIFYING)
    state = reduceMissionState(state, VERIFICATION_REQUESTED)
    state = reduceMissionState(state, VERIFICATION_PASSED)
    const anonymous = event(
      'mission.completed',
      { missionId: 'm1', from: 'verifying', to: 'completed', verifierId: null },
      7,
    )
    state = reduceMissionState(state, anonymous)
    expect(state.missions.get('m1')?.status).toBe('verifying')
  })

  it('refuses an impossible transition in a hand-written journal', () => {
    // A journal claiming `draft → completed` is refused rather than folded. The
    // reducer is what runs on replay, so if it accepted this, a tampered or
    // truncated log could manufacture a completed Mission with no verification.
    let state = reduceMissionState(initialMissionState(), CREATED)
    const forged = event('mission.completed', { missionId: 'm1', from: 'draft', to: 'completed', verifierId: 'x' }, 2)
    state = reduceMissionState(state, forged)
    expect(state.missions.get('m1')?.status).toBe('draft')
  })

  it('refuses to move a settled Mission', () => {
    // Settled by a real completion — asked, passed, concluded — so the cancellation
    // below is refused because the Mission is *settled*, not because the completion
    // itself was refused.
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(state, VERIFICATION_REQUESTED)
    state = reduceMissionState(state, VERIFYING)
    state = reduceMissionState(state, VERIFICATION_PASSED)
    state = reduceMissionState(state, COMPLETED)
    state = reduceMissionState(state, CANCELLED)
    expect(state.missions.get('m1')?.status).toBe('completed')
  })

  it('records a child Run attachment without touching private content', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(
      state,
      event('mission.run.attached', { missionId: 'm1', runId: 'r1', taskId: null }, 3),
    )
    const mission = state.missions.get('m1')
    expect(mission?.childRuns).toEqual(['r1'])
    // There is nowhere in the record for a title to have gone.
    expect(JSON.stringify(mission)).not.toMatch(/find me another job/i)
  })

  it('deduplicates a repeated child Run attachment', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    const attach = event('mission.run.attached', { missionId: 'm1', runId: 'r1', taskId: null }, 3)
    state = reduceMissionState(state, attach)
    state = reduceMissionState(state, attach)
    // Replay and a duplicated delivery must not inflate the count, or the limit
    // would be enforced against a number that is not real.
    expect(state.missions.get('m1')?.childRuns).toEqual(['r1'])
  })

  it('keeps verification history as codes, not evidence', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
    state = reduceMissionState(
      state,
      event(
        'mission.verification.requested',
        { missionId: 'm1', verifierId: 'mission.work.verified', runIds: ['r1'] },
        3,
      ),
    )
    expect(state.missions.get('m1')?.verification?.state).toBe('requested')
    state = reduceMissionState(
      state,
      event(
        'mission.verification.completed',
        { missionId: 'm1', verifierId: 'mission.work.verified', outcome: 'passed', detail: null },
        4,
      ),
    )
    const verification = state.missions.get('m1')?.verification
    expect(verification?.state).toBe('passed')
    // Evidence never enters the record; only a closed outcome code does.
    expect(JSON.stringify(verification)).not.toMatch(/evidence/i)
  })

  it('ignores an event for a Mission it has never seen', () => {
    const state = reduceMissionState(
      initialMissionState(),
      event('mission.activated', { missionId: 'ghost', from: 'draft', to: 'active' }, 1),
    )
    expect(state.missions.size).toBe(0)
  })

  it('advances its own sequence so replay is deterministic', () => {
    const state = reduceMissionState(initialMissionState(), CREATED)
    expect(state.sequence).toBe(1)
  })
})