// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MISSION_STATUSES,
  MISSION_TERMINAL_STATUSES,
  MISSION_TRANSITIONS,
  MISSION_REASONS,
  DEFAULT_MISSION_LIMITS,
  canTransitionMission,
  isTerminalMissionStatus,
  missionLimits,
  normaliseMissionContent,
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
  it('has exactly the six documented statuses', () => {
    expect([...MISSION_STATUSES]).toEqual([
      'draft',
      'active',
      'paused',
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
    expect(MISSION_TRANSITIONS.draft).toEqual(['active', 'cancelled'])
    expect(MISSION_TRANSITIONS.active).toEqual(['paused', 'completed', 'failed', 'cancelled'])
    expect(MISSION_TRANSITIONS.paused).toEqual(['active', 'failed', 'cancelled'])
    expect(MISSION_TRANSITIONS.completed).toEqual([])
    expect(MISSION_TRANSITIONS.failed).toEqual([])
    expect(MISSION_TRANSITIONS.cancelled).toEqual([])
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
      ['draft', 'paused'],
      ['draft', 'completed'],
      ['draft', 'failed'],
      ['active', 'draft'],
      ['paused', 'draft'],
      ['paused', 'completed'],
      ['active', 'active'],
      ['paused', 'paused'],
      ['draft', 'draft'],
    ]
    for (const [from, to] of illegal) {
      expect(canTransitionMission(from, to)).toBe(false)
    }
  })

  it('permits exactly the legal moves', () => {
    const legal: readonly [MissionStatus, MissionStatus][] = [
      ['draft', 'active'],
      ['draft', 'cancelled'],
      ['active', 'paused'],
      ['active', 'completed'],
      ['active', 'failed'],
      ['active', 'cancelled'],
      ['paused', 'active'],
      ['paused', 'failed'],
      ['paused', 'cancelled'],
    ]
    for (const [from, to] of legal) {
      expect(canTransitionMission(from, to)).toBe(true)
    }
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
    expect(Object.keys(content.value).sort()).toEqual(['intent', 'successCriteria', 'title'])
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

const CREATED = event('mission.created', { missionId: 'm1', status: 'draft', limits: DEFAULT_MISSION_LIMITS }, 1)
const ACTIVATED = event('mission.activated', { missionId: 'm1', from: 'draft', to: 'active' }, 2)
const PAUSED = event('mission.paused', { missionId: 'm1', from: 'active', to: 'paused', reason: 'owner' }, 3)
const RESUMED = event('mission.resumed', { missionId: 'm1', from: 'paused', to: 'active' }, 4)
const COMPLETED = event(
  'mission.completed',
  { missionId: 'm1', from: 'active', to: 'completed', verifierId: 'mission.work.verified' },
  5,
)
const CANCELLED = event('mission.cancelled', { missionId: 'm1', from: 'active', to: 'cancelled', reason: 'owner' }, 5)

describe('the fold', () => {
  it('replays the happy path', () => {
    let state = reduceMissionState(initialMissionState(), CREATED)
    expect(state.missions.get('m1')?.status).toBe('draft')
    state = reduceMissionState(state, ACTIVATED)
    expect(state.missions.get('m1')?.status).toBe('active')
    state = reduceMissionState(state, PAUSED)
    expect(state.missions.get('m1')?.status).toBe('paused')
    state = reduceMissionState(state, RESUMED)
    expect(state.missions.get('m1')?.status).toBe('active')
    state = reduceMissionState(state, COMPLETED)
    expect(state.missions.get('m1')?.status).toBe('completed')
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
    let state = reduceMissionState(initialMissionState(), CREATED)
    state = reduceMissionState(state, ACTIVATED)
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