import { describe, expect, it } from 'vitest'
import {
  derivePresenceState,
  deriveWorkSummary,
  buildPresenceFrame,
  type PresenceInput,
} from '../../core/presence/stateMachine'
import type { CoreStatus } from '../../core/protocol/core-protocol'
import type { AttentionProjection } from '../../core/protocol/attention'
import type { WorkProjection } from '../../core/work/projection'
import type { PersonalityProjection } from '../../core/protocol/personality'
import type { VoiceProjection } from '../../core/protocol/conversation'

function coreStatus(overrides: Partial<CoreStatus> = {}): CoreStatus {
  return {
    lifecycle: 'ready',
    eventSequence: 1,
    coreStartedAt: '2026-01-01T00:00:00.000Z',
    integrity: { integrity: 'ok', reason: 'no fault', line: null, eventsRead: 1, bytesDiscarded: 0 },
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 0 },
    providers: [],
    activeProviderCalls: 0,
    sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    faults: [],
    ...overrides,
  }
}

function attentionProjection(overrides: Partial<AttentionProjection> = {}): AttentionProjection {
  return {
    health: 'ready',
    reason: null,
    schemaVersion: 1,
    sequence: 1,
    focus: 'unknown',
    counts: {
      ingested: 0,
      decisions: 0,
      doNothing: 0,
      remembered: 0,
      cued: 0,
      spoke: 0,
      interrupted: 0,
      budgetExceeded: 0,
    },
    lastDecision: null,
    directive: null,
    inbox: [],
    schedules: [],
    limits: {
      maxInboxEntries: 50,
      maxSchedules: 10,
      maxInterruptsPerWindow: 3,
      maxSpeaksPerWindowPerSource: 5,
      cooldownAfterInterruptMs: 60_000,
      budgetWindowMs: 300_000,
    },
    ...overrides,
  }
}

function workProjection(overrides: Partial<WorkProjection> = {}): WorkProjection {
  return {
    health: 'ready',
    reason: null,
    detailAvailable: false,
    runs: [],
    tasks: [],
    approvals: [],
    counts: {
      runs: 0,
      queued: 0,
      running: 0,
      waiting: 0,
      awaitingApproval: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pendingApprovals: 0,
      tasks: 0,
      liveCapabilities: 0,
    },
    runsRetained: 0,
    runsTotal: 0,
    runsHidden: 0,
    capabilities: [],
    verifiers: [],
    limits: { maxSteps: 64, maxActions: 128, maxDurationMs: 300_000, maxAttemptsPerStep: 3 },
    sequence: 1,
    ...overrides,
  }
}

function personalityProjection(overrides: Partial<PersonalityProjection> = {}): PersonalityProjection {
  return {
    health: 'ready',
    reason: null,
    schemaVersion: 1,
    sequence: 1,
    temperament: null,
    persistence: { mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 },
    items: [],
    counts: {
      items: 0,
      admitted: 0,
      candidate: 0,
      rejected: 0,
      superseded: 0,
      retired: 0,
      cuesAdmitted: 0,
      dropped: 0,
    },
    interpretation: null,
    expression: null,
    repetition: null,
    presenceCue: null,
    limits: { maxRelationshipItems: 100, maxCueOffersPerTurn: 3, maxLedgerEntries: 50 },
    ...overrides,
  }
}

function voiceProjection(overrides: Partial<VoiceProjection> = {}): VoiceProjection {
  return {
    transcription: { available: false, engine: null, detail: 'no engine' },
    synthesis: { available: false, engine: null, detail: 'no engine' },
    capturing: false,
    sessionId: null,
    limits: { maxDurationMs: 30_000, maxAudioBytes: 4_194_304, format: 'pcm-s16le' },
    localOnly: true,
    faults: [],
    ...overrides,
  }
}

function input(overrides: Partial<PresenceInput> = {}): PresenceInput {
  return {
    core: coreStatus(),
    attention: null,
    work: null,
    personality: null,
    voice: null,
    synthesisActive: false,
    sequence: 0,
    ...overrides,
  }
}

function makeFrame(value: PresenceInput, stateSince = 1_234): ReturnType<typeof buildPresenceFrame> {
  return buildPresenceFrame(value, stateSince)
}

describe('presence state machine', () => {
  it('derives idle when nothing is happening', () => {
    expect(derivePresenceState(input())).toBe('idle')
  })

  it('derives error when STOP ALL is active', () => {
    const state = derivePresenceState(
      input({ core: coreStatus({ stopAll: { active: true, activatedAt: new Date().toISOString(), activatedBy: 'owner' } }) }),
    )
    expect(state).toBe('error')
  })

  it('derives error when the journal is corrupt', () => {
    const state = derivePresenceState(
      input({ core: coreStatus({ integrity: { integrity: 'corrupt', reason: 'bad hash', line: 5, eventsRead: 4, bytesDiscarded: 100 } }) }),
    )
    expect(state).toBe('error')
  })

  it('derives degraded when Core is degraded', () => {
    const state = derivePresenceState(input({ core: coreStatus({ lifecycle: 'degraded' }) }))
    expect(state).toBe('degraded')
  })

  it('derives speaking when synthesis is active', () => {
    const state = derivePresenceState(input({ synthesisActive: true }))
    expect(state).toBe('speaking')
  })

  it('derives listening when a capture is open', () => {
    const state = derivePresenceState(input({ voice: voiceProjection({ capturing: true, sessionId: 'test-session' }) }))
    expect(state).toBe('listening')
  })

  it('derives working when a provider call is in flight', () => {
    const state = derivePresenceState(input({ core: coreStatus({ activeProviderCalls: 1 }) }))
    expect(state).toBe('working')
  })

  it('derives working when a run is executing', () => {
    const state = derivePresenceState(
      input({ work: workProjection({ counts: { runs: 1, queued: 0, running: 1, waiting: 0, awaitingApproval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, pendingApprovals: 0, tasks: 1, liveCapabilities: 1 } }) }),
    )
    expect(state).toBe('working')
  })

  it('derives attention when there is an attention directive', () => {
    const directive = {
      eventId: 'evt-1',
      source: 'owner' as const,
      kind: 'reminder' as const,
      outcome: 'subtle-cue' as const,
      cueCode: 'gentle-nudge' as const,
      importance: 'normal' as const,
      urgency: 'normal' as const,
      decidedAt: new Date().toISOString(),
    }
    const state = derivePresenceState(
      input({ attention: attentionProjection({ directive }) }),
    )
    expect(state).toBe('attention')
  })

  it('derives attention when there is a personality cue', () => {
    const cue = { cueId: 'cue-1', kind: 'greeting' as const, mode: 'offer' as const }
    const state = derivePresenceState(
      input({ personality: personalityProjection({ presenceCue: cue }) }),
    )
    expect(state).toBe('attention')
  })

  it('STOP ALL outranks synthesis', () => {
    const state = derivePresenceState(
      input({
        core: coreStatus({ stopAll: { active: true, activatedAt: new Date().toISOString(), activatedBy: 'owner' } }),
        synthesisActive: true,
      }),
    )
    expect(state).toBe('error')
  })

  it('synthesis outranks capture', () => {
    const state = derivePresenceState(
      input({
        voice: voiceProjection({ capturing: true }),
        synthesisActive: true,
      }),
    )
    expect(state).toBe('speaking')
  })

  it('capture outranks working', () => {
    const state = derivePresenceState(
      input({
        core: coreStatus({ activeProviderCalls: 1 }),
        voice: voiceProjection({ capturing: true }),
      }),
    )
    expect(state).toBe('listening')
  })
})

describe('presence work summary', () => {
  it('returns null when no work is running', () => {
    expect(deriveWorkSummary(null)).toBeNull()
    expect(deriveWorkSummary(workProjection())).toBeNull()
  })

  it('returns a summary when a run is executing', () => {
    const summary = deriveWorkSummary(
      workProjection({ counts: { runs: 1, queued: 0, running: 1, waiting: 0, awaitingApproval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, pendingApprovals: 0, tasks: 1, liveCapabilities: 1 } }),
    )
    expect(summary).not.toBeNull()
    expect(summary?.running).toBe(1)
    expect(summary?.label).toBe('a run is executing')
  })

  it('returns a summary when a run is waiting for approval', () => {
    const summary = deriveWorkSummary(
      workProjection({ counts: { runs: 1, queued: 0, running: 0, waiting: 0, awaitingApproval: 1, paused: 0, completed: 0, failed: 0, cancelled: 0, pendingApprovals: 1, tasks: 1, liveCapabilities: 0 } }),
    )
    expect(summary).not.toBeNull()
    expect(summary?.awaitingApproval).toBe(1)
    expect(summary?.label).toBe('a run is waiting for your decision')
  })
})

describe('presence frame builder', () => {
  it('is deterministic and preserves the host-supplied state entry time', () => {
    const source = input()
    const first = makeFrame(source, 42)
    const second = makeFrame(source, 42)
    expect(first).toEqual(second)
    expect(first.stateSince).toBe(42)
  })

  it('builds a frame with the correct schema version', () => {
    const frame = makeFrame(input())
    expect(frame.schemaVersion).toBe(1)
  })

  it('builds a frame with the correct state', () => {
    const frame = makeFrame(input({ core: coreStatus({ activeProviderCalls: 1 }) }))
    expect(frame.state).toBe('working')
  })

  it('builds a frame with the correct animation', () => {
    const frame = makeFrame(input({ core: coreStatus({ activeProviderCalls: 1 }) }))
    expect(frame.animation).toBe('glow')
  })

  it('builds a frame with voice capture status', () => {
    const frame = makeFrame(
      input({ voice: voiceProjection({ capturing: true, sessionId: 'test-session' }) }),
    )
    expect(frame.voiceCapture.active).toBe(true)
    expect(frame.voiceCapture.sessionId).toBe('test-session')
  })

  it('builds a frame with attention directive', () => {
    const directive = {
      eventId: 'evt-1',
      source: 'owner' as const,
      kind: 'reminder' as const,
      outcome: 'subtle-cue' as const,
      cueCode: 'gentle-nudge' as const,
      importance: 'normal' as const,
      urgency: 'normal' as const,
      decidedAt: new Date().toISOString(),
    }
    const frame = makeFrame(
      input({ attention: attentionProjection({ directive }) }),
    )
    expect(frame.attention).not.toBeNull()
    expect(frame.attention?.cueCode).toBe('gentle-nudge')
  })

  it('builds a frame with work summary', () => {
    const frame = makeFrame(
      input({ work: workProjection({ counts: { runs: 1, queued: 0, running: 1, waiting: 0, awaitingApproval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, pendingApprovals: 0, tasks: 1, liveCapabilities: 1 } }) }),
    )
    expect(frame.work).not.toBeNull()
    expect(frame.work?.running).toBe(1)
  })
})
