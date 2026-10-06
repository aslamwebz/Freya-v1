import { afterEach, describe, expect, it } from 'vitest'
import { createLiveAdapter } from '../../../src/ui-v2/state/live'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import { resetMissionMirror } from '../../../src/platform/missionClient'
import { resetWorkforceMirror } from '../../../src/platform/workforceClient'
import { resetAttentionMirror } from '../../../src/platform/attentionClient'
import type { FreyaHostBridge } from '../../../src/platform/host'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../../../core/protocol/activity'
import type { MissionProjection, MissionSummaryView } from '../../../core/missions/types'
import { MISSION_STATUSES } from '../../../core/missions/types'
import type { WorkforceProjection } from '../../../core/protocol/workforce'
import type { AttentionProjection } from '../../../core/protocol/attention'

/**
 * The live adapter's mappings only execute when a real bridge is present.
 * These tests install a fake FreyaHostBridge so the adapter's home, mission,
 * workforce and attention projections are exercised for real â€” proving no
 * synthetic figures (focus 0%, fake names, invented stats) leak into live mode.
 */

const coreStatus: CoreStatus = {
  lifecycle: 'ready',
  eventSequence: 42,
  coreStartedAt: '2026-10-03T00:00:00.000Z',
  integrity: { integrity: 'ok', reason: 'Journal is healthy.', line: null, eventsRead: 42, bytesDiscarded: 0 },
  stopAll: { active: false, activatedAt: null, activatedBy: null },
  guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
  governor: { status: 'ready', grantsActive: 0 },
  providers: [],
  activeProviderCalls: 0,
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  faults: [],
}

const activity: CoreActivityEvent[] = [
  { id: 'evt-1', kind: 'core.started', type: 'core.started', sequence: 42, at: 1790956800000, text: 'Core started.', tone: 'good' },
  { id: 'evt-2', kind: 'core.ready', type: 'core.ready', sequence: 41, at: 1790953200000, text: 'Core ready.', tone: 'neutral' },
]

/**
 * The Phase 47 board fields, empty.
 *
 * A Mission that has never been planned has no plan, no steps, no evidence and no wake,
 * and all of that is genuinely empty rather than unknown — so this is the honest fixture
 * for a Mission that exists but has not started working.
 */
function boardFields(over: Partial<MissionSummaryView> = {}): Pick<
  MissionSummaryView,
  | 'priority'
  | 'planRevision'
  | 'progress'
  | 'currentStep'
  | 'nextAction'
  | 'blockers'
  | 'pendingApproval'
  | 'evidence'
  | 'nextWake'
  | 'lastUpdatedAt'
  | 'awaitingOwner'
  | 'budgetRemaining'
> {
  return {
    priority: 'routine',
    planRevision: null,
    progress: {
      steps: { total: 0, pending: 0, blocked: 0, delegated: 0, running: 0, verified: 0, failed: 0, cancelled: 0, skipped: 0 },
      planSteps: 0,
      observed: 0,
      reported: 0,
      requestedQuantity: null,
      quantitySatisfied: null,
    },
    currentStep: null,
    nextAction: null,
    blockers: [],
    pendingApproval: null,
    evidence: { total: 0, observed: 0, reported: 0, expired: 0, uncertain: 0 },
    nextWake: null,
    lastUpdatedAt: '2026-10-01',
    awaitingOwner: false,
    budgetRemaining: {
      modelCalls: 32,
      actions: 128,
      externalRequests: 32,
      retries: 8,
      delegations: 64,
      planRevisions: 8,
      concurrentDelegations: 4,
    },
    ...over,
  }
}

const missionProjection: MissionProjection = {
  persistence: { mode: 'encrypted', reason: null, durable: true },
  missions: [
    { missionId: 'mission-real-1', status: 'active', createdAt: '2026-10-01', deadlineAt: '2026-11-01', settledAt: null, reason: null,
      counts: { total: 8, queued: 0, running: 0, waiting: 0, awaitingApproval: 0, paused: 0, completed: 5, failed: 1, cancelled: 0, verified: 5 },
      needsAttention: true, availableActions: ['requestCompletion', 'stop', 'correct', 'cancel', 'fail'], verification: null,
      ...boardFields() },
    { missionId: 'mission-real-2', status: 'draft', createdAt: '2026-10-02', deadlineAt: '2026-11-02', settledAt: null, reason: null,
      counts: { total: 3, queued: 0, running: 0, waiting: 0, awaitingApproval: 0, paused: 0, completed: 1, failed: 0, cancelled: 0, verified: 1 },
      needsAttention: false, availableActions: ['activate', 'stop', 'correct', 'cancel'], verification: null,
      ...boardFields({ lastUpdatedAt: '2026-10-02' }) },
  ],
  // Every status has a counter, derived from the domain's vocabulary rather than written
  // out — the same reason the projection builds it that way.
  counts: {
    total: 2,
    ...Object.fromEntries(MISSION_STATUSES.map((status) => [status, 0])),
    draft: 1,
    active: 1,
    needsAttention: 1,
  } as MissionProjection['counts'],
  limits: { maxChildRuns: 64, maxConcurrentChildRuns: 8, lifetimeMs: 2592000000, verificationDeadlineMs: 30000, maxRetainedMissions: 100, maxTitleChars: 160, maxIntentChars: 4000, maxSuccessCriteria: 20, maxCriterionChars: 500 },
  missionsRetained: 2, missionsTotal: 2, missionsHidden: 0, sequence: 10,
}

const workforceProjection: WorkforceProjection = {
  health: 'ready',
  reason: null,
  workers: [
    { workerId: 'worker-1', name: 'Alpha', teamId: null, specialization: 'Research agent', state: 'Researching', assignment: null, capabilities: [], claims: [], budget: null, concurrency: null, lastActiveAt: null },
    { workerId: 'worker-2', name: 'Beta', teamId: null, specialization: 'Strategy agent', state: 'Planning', assignment: null, capabilities: [], claims: [], budget: null, concurrency: null, lastActiveAt: null },
  ],
  teams: [],
  counts: { workers: 2, working: 1, idle: 1, waiting: 0, teams: 0 },
  sequence: 10,
}

const attentionProjection: AttentionProjection = {
  health: 'ready',
  reason: null,
  schemaVersion: 1,
  sequence: 10,
  focus: 'focused',
  counts: { ingested: 42, decisions: 18, doNothing: 5, remembered: 0, cued: 12, spoke: 4, interrupted: 1, budgetExceeded: 0 },
  lastDecision: null,
  directive: null,
  inbox: [{ eventId: 'attn-1', source: 'owner', kind: 'message', goalRef: null, severityHint: 'normal', textLength: 20, observedAt: '2026-10-03T01:00:00.000Z', dueAt: null, outcome: null }],
  schedules: [],
  limits: { maxInboxEntries: 50, maxSchedules: 10, maxInterruptsPerWindow: 5, maxSpeaksPerWindowPerSource: 3, cooldownAfterInterruptMs: 30000, budgetWindowMs: 3600000 },
}

function installFakeBridge() {
  const bridge: FreyaHostBridge = {
    isDesktop: true,
    getRuntimeInfo: async () => ({ version: '0.1.0', electron: '44.5.0', platform: 'win32', arch: 'x64', userData: '', workspaceFile: '', dev: false }),
    loadWorkspace: async () => null,
    saveWorkspace: async () => true,
    // The picker is a host dialog; a fake bridge refuses rather than pretending a
    // file was chosen, which is the behaviour the renderer has to survive.
    attachmentPick: async () => ({ ok: false, reason: 'no host in this test' }),
    // A refusal, like every other host call in this fake. A window that asked for a
    // picture here gets nothing, which is the honest answer and lets the card decide
    // to draw nothing rather than a placeholder.
    mediaThumbnail: async () => ({ ok: false, dataUrl: null, bytes: 0, format: null, claimedType: null, reason: 'no host in this test' }),
    mediaDocument: async () => ({ ok: false, reason: 'no host in this test' }),
    onCollect: () => {},
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    browserState: async () => ({
      available: false,
      active: false,
      reason: 'not enabled in this test',
      publicAvailable: false,
      extensionPaired: false,
      extensionLive: false,
      journalTrustworthy: true,
      summary: 'browser unavailable',
      sessions: [],
      handoffs: [],
      described: 0,
      staleRefs: 0,
      mediaObserved: 0,
      refusals: 0,
    }),
    browserExecute: async (request) => ({
      ok: false,
      command: request.command,
      target: null,
      code: 'subsystem-disabled',
      reason: 'not enabled in this test',
      escalation: null,
    }),
    providerConfig: async () => ({ baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, credentialState: 'stored' as const, credentialReason: null }),
    saveProviderConfig: async () => ({ baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, credentialState: 'stored' as const, credentialReason: null }),
    coreSubmit: async () => ({ requestId: 'r', ok: false, refusal: { reason: 'not allowed' } }),
    coreStatus: async () => coreStatus,
    onCoreStatus: () => () => {},
    coreActivity: async () => activity,
    onCoreActivity: () => () => {},
    coreConversation: async () => null,
    onCoreConversation: () => () => {},
    coreVoice: async () => null,
    onCoreVoice: () => () => {},
    onCoreVoiceTranscript: () => () => {},
    onVoiceOutput: () => () => {},
    reportVoiceCapabilities: () => {},
    coreBrain: async () => null,
    onCoreBrain: () => () => {},
    coreWork: async () => null,
    onCoreWork: () => () => {},
    coreMission: async () => missionProjection,
    onCoreMission: () => () => {},
    coreWorkforce: async () => workforceProjection,
    onCoreWorkforce: () => () => {},
    coreContext: async () => null,
    onCoreContext: () => () => {},
    corePersonality: async () => null,
    onCorePersonality: () => () => {},
    coreAttention: async () => attentionProjection,
    onCoreAttention: () => () => {},
    coreRelay: async () => null,
    onCoreRelay: () => () => {},
    coreSkills: async () => null,
    onCoreSkills: () => () => {},
    coreLife: async () => null,
    onCoreLife: () => () => {},
    coreFoundry: async () => null,
    onCoreFoundry: () => () => {},
    coreOffice: async () => null,
    onCoreOffice: () => () => {},
    // The conscious-context lane, declared on the bridge and deliberately unused by
    // any surface yet. Answering `null` here is the honest fake: this build reports
    // the lane but no surface reads it, and a fake that invented a snapshot would
    // make the absence look tested.
    coreConsciousness: async () => null,
    onCoreConsciousness: () => () => {},
    coreLifeLoop: async () => null,
    onCoreLifeLoop: () => () => {},
    // The World summary lane, same reasoning as the conscious-context lane above:
    // Core and the host both implement it and no surface reads it yet. `null` is the
    // honest fake, and it is also what keeps the declaration honest — this fake is a
    // complete `FreyaHostBridge`, so a lane added to the interface without an
    // implementation on the far side fails to compile here rather than at runtime.
    coreWorld: async () => null,
    onCoreWorld: () => () => {},
  }
  window.freyaHost = bridge
}

afterEach(() => {
  delete window.freyaHost
  resetCoreMirror(); resetMissionMirror(); resetWorkforceMirror(); resetAttentionMirror()
})

describe('live adapter with a fake bridge', () => {
  it('projects real mission rows without fake names or completion percentages', async () => {
    installFakeBridge()
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const snapshot = adapter.getSnapshot()
    if (snapshot.mission.status !== 'ready') throw new Error('expected mission ready')
    expect(snapshot.mission.data.rows).toHaveLength(2)
    expect(snapshot.mission.data.rows[0]?.id).toBe('mission-real-1')
    expect(snapshot.mission.data.rows[0]?.verifiedRuns).toBe(5)
    expect(snapshot.mission.data.rows[0]?.runs).toBe(8)
    disposer()
  })

  it('reports attention focus as a closed state, not a percentage', async () => {
    installFakeBridge()
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const snapshot = adapter.getSnapshot()
    if (snapshot.attention.status !== 'ready') throw new Error('expected attention ready')
    expect(snapshot.attention.data.focus).toBe('focused')
    if (snapshot.home.status !== 'ready') throw new Error('expected home ready')
    expect(snapshot.home.data.attention.focused).toBeNull()
    disposer()
  })

  it('projects real workforce rows', async () => {
    installFakeBridge()
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const snapshot = adapter.getSnapshot()
    if (snapshot.workforce.status !== 'ready') throw new Error('expected workforce ready')
    expect(snapshot.workforce.data.rows).toHaveLength(2)
    expect(snapshot.workforce.data.rows[0]?.id).toBe('worker-1')
    expect(snapshot.workforce.data.total).toBe(2)
    disposer()
  })

  it('does not fall back to preview fixtures when the bridge is absent', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    for (const resource of Object.values(adapter.getSnapshot())) {
      expect(resource.status === 'ready' ? resource.source : 'not ready').not.toBe('preview')
    }
    disposer()
  })
})
