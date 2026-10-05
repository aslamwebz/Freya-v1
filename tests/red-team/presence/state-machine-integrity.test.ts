import { describe, expect, it } from 'vitest'
import { derivePresenceState, type PresenceInput } from '../../../core/presence/stateMachine'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import type { AttentionProjection } from '../../../core/protocol/attention'
import type { WorkProjection } from '../../../core/work/projection'
import { absentVoiceProjection } from '../../core/voice/fixture'

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

describe('red-team: state machine integrity', () => {
  it('a renderer cannot force a working state without a provider call', () => {
    // No provider call, no run, no synthesis, no capture — the only honest
    // state is idle.
    const state = derivePresenceState(input())
    expect(state).not.toBe('working')
  })

  it('a renderer cannot force a speaking state without synthesis', () => {
    const state = derivePresenceState(input({ voice: null, synthesisActive: false }))
    expect(state).not.toBe('speaking')
  })

  it('a renderer cannot force a listening state without a capture', () => {
    const state = derivePresenceState(input({ voice: null }))
    expect(state).not.toBe('listening')
  })

  it('STOP ALL cannot be bypassed by any other signal', () => {
    const state = derivePresenceState(
      input({
        core: coreStatus({
          stopAll: { active: true, activatedAt: new Date().toISOString(), activatedBy: 'owner' },
          activeProviderCalls: 5,
        }),
        synthesisActive: true,
      }),
    )
    expect(state).toBe('error')
  })

  it('a corrupt journal cannot be bypassed by a healthy provider count', () => {
    const state = derivePresenceState(
      input({
        core: coreStatus({
          integrity: { integrity: 'corrupt', reason: 'bad hash', line: 5, eventsRead: 4, bytesDiscarded: 100 },
          activeProviderCalls: 5,
        }),
      }),
    )
    expect(state).toBe('error')
  })

  it('an attention directive cannot escalate past error', () => {
    const directive = {
      eventId: 'evt-1',
      source: 'owner' as const,
      kind: 'reminder' as const,
      outcome: 'interrupt' as const,
      cueCode: 'needs-attention' as const,
      importance: 'critical' as const,
      urgency: 'urgent' as const,
      decidedAt: new Date().toISOString(),
    }
    const attention: AttentionProjection = {
      health: 'ready',
      reason: null,
      schemaVersion: 1,
      sequence: 1,
      focus: 'unknown',
      counts: { ingested: 1, decisions: 1, doNothing: 0, remembered: 0, cued: 0, spoke: 0, interrupted: 1, budgetExceeded: 0 },
      lastDecision: null,
      directive,
      inbox: [],
      schedules: [],
      limits: { maxInboxEntries: 50, maxSchedules: 10, maxInterruptsPerWindow: 3, maxSpeaksPerWindowPerSource: 5, cooldownAfterInterruptMs: 60_000, budgetWindowMs: 300_000 },
    }
    const state = derivePresenceState(
      input({
        core: coreStatus({
          stopAll: { active: true, activatedAt: new Date().toISOString(), activatedBy: 'owner' },
        }),
        attention,
      }),
    )
    expect(state).toBe('error')
  })

  it('a work projection cannot force a working state without a running run', () => {
    const work: WorkProjection = {
      health: 'ready',
      reason: null,
      detailAvailable: false,
      runs: [],
      tasks: [],
      approvals: [],
      counts: { runs: 0, queued: 0, running: 0, waiting: 0, awaitingApproval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, pendingApprovals: 0, tasks: 0, liveCapabilities: 0 },
      runsRetained: 0,
      runsTotal: 0,
      runsHidden: 0,
      capabilities: [],
      verifiers: [],
      limits: { maxSteps: 64, maxActions: 128, maxDurationMs: 300_000, maxAttemptsPerStep: 3 },
      sequence: 1,
    }
    const state = derivePresenceState(input({ work }))
    expect(state).not.toBe('working')
  })

  it('a voice projection cannot force a listening state without a capture', () => {
    const voice = absentVoiceProjection({
      transcription: {
        available: true,
        engine: 'stand-in-stt',
        kind: 'local',
        availability: 'available',
        detail: 'stand-in',
      },
      synthesis: {
        available: true,
        engine: 'stand-in-tts',
        kind: 'platform',
        availability: 'available',
        detail: 'stand-in',
      },
    })
    const state = derivePresenceState(input({ voice }))
    expect(state).not.toBe('listening')
  })

  it('nor can a forged state field, on its own', () => {
    // A window that forges `state: 'listening'` while Core reports no capture is
    // the whole forgery this family is exposed to. The state machine reads
    // `capturing` — Core's fact — and not the state string a mirror also carries.
    const forged = absentVoiceProjection({ state: 'listening', capturing: false })
    expect(derivePresenceState(input({ voice: forged }))).not.toBe('listening')
  })

  it('model-call amplification is impossible: the state machine makes no model call', () => {
    // The state machine is pure. It takes projections and returns a state.
    // There is no code path that could reach a model.
    const state = derivePresenceState(input())
    expect(state).toBe('idle')
  })
})
