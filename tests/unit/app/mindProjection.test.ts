import { afterEach, describe, expect, it } from 'vitest'
import { createLiveAdapter } from '../../../src/ui-v2/state/live'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import { resetMissionMirror } from '../../../src/platform/missionClient'
import { resetWorkforceMirror } from '../../../src/platform/workforceClient'
import { resetAttentionMirror } from '../../../src/platform/attentionClient'
import { resetBrainMirror } from '../../../src/platform/brainClient'
import { resetWorkMirror } from '../../../src/platform/workClient'
import { resetConsciousnessMirror } from '../../../src/platform/consciousnessClient'
import { resetWorldMirror } from '../../../src/platform/worldClient'
import { resetSelfMirror } from '../../../src/platform/selfClient'
import { resetPersonalityMirror } from '../../../src/platform/personalityClient'
import { resetContextMirror } from '../../../src/platform/contextClient'
import { buildCapabilityRegistry } from '../../../core/capabilities'
import type { FreyaHostBridge } from '../../../src/platform/host'
import { DEFAULT_VOICE_CONFIG } from '../../../electron/voiceConfig'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import type { BrainProjection } from '../../../core/brain/brain'
import type { WorkProjection } from '../../../core/work/projection'
import type { MissionProjection } from '../../../core/missions/types'
import type { WorkforceProjection } from '../../../core/protocol/workforce'
import type { AttentionProjection } from '../../../core/protocol/attention'
import type { PersonalityProjection } from '../../../core/protocol/personality'
import type { ContextProjection } from '../../../core/protocol/context'
import type { ConsciousContextProjection } from '../../../core/protocol/consciousness'
import { ABSENT_CONSCIOUS_CONTEXT_PROJECTION } from '../../../core/protocol/consciousness'
import type { WorldSummaryView } from '../../../core/protocol/world'
import { ABSENT_WORLD_SUMMARY } from '../../../core/protocol/world'
import type { SelfStatusView } from '../../../core/protocol/world'

/**
 * The Mind projection's truthfulness.
 *
 * ## Why this test exists
 *
 * The Mind screen is the one surface whose failure mode is a *confident lie*: a
 * fabricated trait percentage, an invented goal date, an open question nobody
 * asked. A render test cannot catch those, because the renderer faithfully draws
 * whatever the adapter hands it. So the adapter is exercised for real, against
 * projections built the way Core builds them, and the assertions are about what
 * is *absent* as much as about what is present.
 *
 * ## The one property that matters most
 *
 * Nothing in `mind` is a number Core never took. Attention focus is a closed
 * word with no denominator; the self model carries no trait percentage; goals
 * carry no roadmap date; uncertainties are closed codes and never sentences.
 */

const NOW = '2026-10-03T01:00:00.000Z'

function coreStatus(over: Partial<CoreStatus> = {}): CoreStatus {
  return {
    lifecycle: 'ready',
    operational: true,
    eventSequence: 42,
    coreStartedAt: NOW,
    integrity: { integrity: 'ok', reason: 'Journal is healthy.', line: null, eventsRead: 42, bytesDiscarded: 0 },
    persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null },
    diagnostics: { path: null, writeFailures: 0 },
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 1 },
    providers: [
      { id: 'nanogpt', kind: 'nanogpt', status: 'configured', model: 'openai/gpt-4.1-nano', liveEnabled: true, detail: 'ready' },
    ],
    activeProviderCalls: 0,
    sessionUsage: { calls: 3, inputTokens: 1200, outputTokens: 800, unknownUsageCalls: 0 },
    durableUsage: { calls: 3, inputTokens: 1200, outputTokens: 800, unknownUsageCalls: 0 },
    faults: [],
    ...over,
  }
}

const brainProjection: BrainProjection = {
  health: 'healthy',
  reason: null,
  persistence: 'encrypted',
  durable: true,
  identity: {
    name: 'Freya',
    role: 'a persistent Core with replaceable embodiments',
    purpose: 'to be a durable, honest intelligence the owner can rely on',
    claims: [
      { claimId: 'claim-1', statement: 'Core is Freya; the model is not Freya.' },
      { claimId: 'claim-2', statement: 'Identity is typed data, not a prompt.' },
    ],
  },
  self: {
    complete: true,
    capabilities: [
      { capability: 'conversation.turn', state: 'available', cannot: ['choose a provider', 'raise a budget'] },
    ],
    limitations: [{ limitationId: 'lim-1', statement: 'I cannot remember without an encrypted Brain.' }],
  },
  counts: {
    entities: 12, relations: 30, observations: 18, memories: 9,
    admitted: 40, conflicted: 1, rejected: 2, withdrawn: 2, experiences: 5,
  },
  recentAdmissions: [],
  conflicts: [],
  sequence: 42,
}

const workProjection: WorkProjection = {
  health: 'ready',
  reason: null,
  detailAvailable: true,
  runs: [
    {
      runId: 'run-live-1', kind: 'deterministic', status: 'running', createdAt: NOW, startedAt: NOW,
      completedAt: null, cancelledAt: null, failure: null, waitingOn: null, taskId: null,
      parentKind: 'mission', parentId: 'mission-real-1',
      progress: { stepsTotal: 3, verified: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 2, actions: 1, attempts: 1, percent: null, summary: '1 of 3 steps verified' }, limitHit: null,
      steps: [], actions: [], observations: [], verifications: [], live: true,
    },
    {
      runId: 'run-done-1', kind: 'deterministic', status: 'completed', createdAt: NOW, startedAt: NOW,
      completedAt: NOW, cancelledAt: null, failure: null, waitingOn: null, taskId: null,
      parentKind: 'mission', parentId: 'mission-real-1',
      progress: { stepsTotal: 2, verified: 2, failed: 0, cancelled: 0, skipped: 0, remaining: 0, actions: 2, attempts: 2, percent: 100, summary: 'every step verified' }, limitHit: null,
      steps: [], actions: [], observations: [], verifications: [], live: false,
    },
  ],
  tasks: [],
  approvals: [
    {
      approvalId: 'approval-1', runId: 'run-live-1', stepId: 'step-1', status: 'pending',
      capability: 'browser.read', requiredCapability: 'browser.read', risk: 'consequential',
      requestedAt: NOW, decidedAt: null, decidedBy: null, decisionSource: null, reason: null,
      justification: 'a page outside the allowlist', proposal: 'read one public page',
    },
  ],
  counts: {
    runs: 2, queued: 0, running: 1, waiting: 0, awaitingApproval: 1, paused: 0,
    completed: 1, failed: 0, cancelled: 0, pendingApprovals: 1, tasks: 0, liveCapabilities: 1,
  },
  runsRetained: 2, runsTotal: 2, runsHidden: 0,
  capabilities: ['browser.read'], verifiers: ['evidence-checked'],
  limits: { maxSteps: 64, maxActions: 128, maxDurationMs: 900000, maxAttemptsPerStep: 3 },
  sequence: 20,
}

const missionProjection: MissionProjection = {
  persistence: { mode: 'encrypted', reason: null, durable: true },
  missions: [
    {
      missionId: 'mission-real-1', status: 'active', createdAt: '2026-10-01', deadlineAt: '2026-11-01',
      settledAt: null, reason: null,
      counts: { total: 8, queued: 0, running: 1, waiting: 0, awaitingApproval: 1, paused: 0, completed: 6, failed: 0, cancelled: 0, verified: 5 },
      needsAttention: true, availableActions: ['requestCompletion', 'cancel', 'fail'], verification: null,
      priority: 'routine', planRevision: 1,
      progress: {
        steps: { total: 3, pending: 0, blocked: 0, delegated: 0, running: 1, verified: 1, failed: 0, cancelled: 0, skipped: 0 },
        planSteps: 3, observed: 2, reported: 1, requestedQuantity: null, quantitySatisfied: null,
      },
      currentStep: null,
      nextAction: { decision: 'continue', reason: 'dependency_unverified' },
      blockers: ['dependency_unverified'], pendingApproval: null,
      evidence: { total: 4, observed: 2, reported: 1, expired: 0, uncertain: 1 },
      nextWake: null, lastUpdatedAt: NOW, awaitingOwner: false,
      budgetRemaining: {
        modelCalls: 32, actions: 128, externalRequests: 32, retries: 8,
        delegations: 64, planRevisions: 8, concurrentDelegations: 4,
      },
    },
  ],
  counts: {
    total: 1, needsAttention: 1, active: 1, draft: 0, ready: 0,
    planning: 0, waiting: 0, blocked: 0, 'approval-required': 0,
    verifying: 0, stopped: 0, completed: 0, failed: 0, cancelled: 0,
  },
  limits: {
    maxChildRuns: 64, maxConcurrentChildRuns: 8, lifetimeMs: 2592000000,
    verificationDeadlineMs: 30000, maxRetainedMissions: 100, maxTitleChars: 160,
    maxIntentChars: 4000, maxSuccessCriteria: 20, maxCriterionChars: 500,
  },
  missionsRetained: 1, missionsTotal: 1, missionsHidden: 0, sequence: 30,
}

const workforceProjection: WorkforceProjection = {
  health: 'ready',
  reason: null,
  workers: [
    {
      workerId: 'worker-1', name: 'Alpha', teamId: null, specialization: 'Research agent',
      state: 'Researching', assignment: { kind: 'mission', id: 'mission-real-1', label: 'mission-real-1' },
      capabilities: ['cognition.request'], claims: [], budget: null,
      concurrency: { active: 1, limit: 1 }, lastActiveAt: NOW,
    },
  ],
  teams: [],
  counts: { workers: 1, working: 1, idle: 0, waiting: 0, teams: 0 },
  sequence: 10,
}

const attentionProjection: AttentionProjection = {
  health: 'ready',
  reason: null,
  schemaVersion: 1,
  sequence: 10,
  focus: 'focused',
  counts: { ingested: 42, decisions: 18, doNothing: 5, remembered: 0, cued: 12, spoke: 4, interrupted: 1, budgetExceeded: 0 },
  lastDecision: {
    decisionId: 'd-1', eventId: 'attn-1', source: 'owner', kind: 'message', outcome: 'remember',
    importance: 'normal', urgency: 'normal', reason: 'remembered', cueCode: null,
    focus: 'focused', decidedAt: NOW,
  },
  directive: null,
  inbox: [
    {
      eventId: 'attn-1', source: 'owner', kind: 'message', goalRef: null, severityHint: 'normal',
      textLength: 20, observedAt: NOW, dueAt: null, outcome: 'remember',
    },
  ],
  schedules: [],
  limits: {
    maxInboxEntries: 50, maxSchedules: 10, maxInterruptsPerWindow: 5,
    maxSpeaksPerWindowPerSource: 3, cooldownAfterInterruptMs: 30000, budgetWindowMs: 3600000,
  },
}

const personalityProjection: PersonalityProjection = {
  health: 'unavailable',
  reason: 'this Core has no Personality domain: no relationship record exists, and none is simulated',
  schemaVersion: 1,
  sequence: 0,
  persistence: { mode: 'ephemeral', durable: false, reason: 'no store', faultReason: null, retained: 0 },
  temperament: null,
  items: [],
  counts: { items: 0, admitted: 0, candidate: 0, rejected: 0, superseded: 0, retired: 0, cuesAdmitted: 0, dropped: 0 },
  interpretation: null,
  expression: null,
  repetition: null,
  presenceCue: null,
  limits: { maxRelationshipItems: 0, maxCueOffersPerTurn: 0, maxLedgerEntries: 0 },
}

const contextProjection: ContextProjection = {
  health: 'unavailable',
  reason: 'this Core has no Context domain: no context item exists, and none is simulated',
  items: [],
  references: [],
  counts: { items: 0, current: 0, expired: 0, revoked: 0, references: 0, unresolvedReferences: 0 },
  sequence: 0,
}

const consciousContext: ConsciousContextProjection = {
  ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
  health: 'ready',
  reason: null,
  self: {
    state: 'available', note: null,
    name: 'Freya',
    role: 'a persistent Core with replaceable embodiments',
    purpose: 'to be a durable, honest intelligence the owner can rely on',
    claimCount: 3,
    capabilities: [{ capability: 'conversation.turn', state: 'available', cannot: ['choose a provider', 'raise a budget'] }],
    limitations: [{ limitationId: 'lim-1', statement: 'I cannot remember without an encrypted Brain.' }],
    complete: true,
  },
  focus: {
    state: 'available', note: null,
    attentionFocus: 'focused', primaryRunId: 'run-live-1', primaryMissionId: 'mission-real-1',
    liveRuns: 1, runningRuns: 1, waitingRuns: 0, activeMissions: 1, workingAgents: 1, scope: null,
  },
  attention: {
    state: 'available', note: null,
    focus: 'focused',
    counts: { ingested: 42, decisions: 18, doNothing: 5, remembered: 0, cued: 12, spoke: 4, interrupted: 1, budgetExceeded: 0 },
    lastDecision: {
      decisionId: 'd-1', source: 'owner', kind: 'message', outcome: 'remember',
      importance: 'normal', urgency: 'normal', reason: 'remembered', cueCode: null, decidedAt: NOW,
    },
    directive: null, inbox: [], schedulesDue: 0, schedulesPending: 0,
  },
  waiting: {
    state: 'available', note: null,
    approvals: [], pendingApprovals: 1,
    waitingRuns: [{ runId: 'run-wait-1', status: 'waiting', waitingSince: NOW }],
    blockedTasks: [], blockedAgents: [{ workerId: 'worker-2', status: 'blocked' }],
    unfulfilledPresenceRequests: [],
  },
  life: { state: 'absent', note: 'Phase 21 is not in this build', entries: null, admitted: null, recalled: null, durable: null, recent: [], listed: 0, omitted: 0 },
  uncertainty: {
    state: 'available', note: null,
    items: [
      { code: 'mission.needs-attention', subjectKind: 'mission', subjectId: 'mission-real-1', since: NOW },
      { code: 'journal.integrity', subjectKind: 'core', subjectId: null, since: null },
    ],
    listed: 2, omitted: 0,
  },
  nextActions: {
    state: 'available', note: null,
    items: [{ scope: 'mission', subjectId: 'mission-real-1', action: 'requestCompletion' }],
    listed: 1, omitted: 0,
  },
  recentChanges: {
    state: 'available', note: null,
    items: [{ id: 'evt-42', kind: 'mission.activated', sequence: 42, at: 1790956800000, tone: 'busy' }],
    listed: 1, omitted: 0,
  },
  provenance: {
    basis: 'derived', freshness: 'fresh', durableSequence: 42, asOf: NOW,
    sources: [
      { domain: 'work', basis: 'authoritative', freshness: 'fresh', sequence: 20, detailAvailable: true, durable: true, note: null },
      { domain: 'mission', basis: 'authoritative', freshness: 'fresh', sequence: 30, detailAvailable: true, durable: true, note: null },
    ],
  },
}

const worldSummary: WorldSummaryView = {
  ...ABSENT_WORLD_SUMMARY,
  health: 'ready',
  reason: null,
  counts: {
    entities: 12, referenceEntities: 4, evidenceBackedEntities: 8, edges: 30, derivedEdges: 10,
    claimedEdges: 20, evidenceRecords: 18, withdrawnRecords: 2, supersededRecords: 1,
    danglingEdges: 0, withheld: 1, conflicts: 1, beliefs: 4,
  },
  uncertainties: { listed: 3, total: 3, items: [] },
  conflicts: { listed: 0, total: 1, items: [] },
  persistence: { mode: 'encrypted', durable: true, reason: null, faultReason: null },
}

const selfStatus: SelfStatusView = {
  schemaVersion: 1,
  sequence: 5,
  identity: {
    source: 'brain_identity',
    name: 'Freya',
    role: 'a persistent Core with replaceable embodiments',
    purpose: 'to be a durable, honest intelligence the owner can rely on',
    stableTraits: [], communicationPrinciples: [], continuityPrinciples: [], claims: [],
  },
  role: { descriptor: 'a persistent Core', source: 'brain_identity', securityStateOwner: 'guard_and_governor', securityStateAvailableHere: false },
  assignedCapabilities: {
    source: 'guard_evaluation',
    items: [{ capability: 'cognition.request', held: true, decidedBy: 'guard' }],
    total: 1, listed: 1,
  },
  knownSkills: {
    source: 'skills_domain',
    items: [{ skillId: 'skill-1', name: 'brief-summary', status: 'active', version: 1, verification: 'verified' }],
    total: 1, listed: 1,
  },
  modelIdentity: {
    source: 'provider_set',
    items: [{ providerId: 'nanogpt', kind: 'nanogpt', live: true }],
    total: 1, listed: 1,
  },
  workerClaims: {
    source: 'workforce_claim_ledger',
    items: [{ workerId: 'worker-1', principalId: 'agent:worker-1', claimKind: 'capability', decision: 'refused', isAuthority: false }],
    total: 1, listed: 1,
  },
  beliefs: { source: 'world_evidence', items: [], total: 0, listed: 0 },
  limitations: { source: 'brain_self_definition', items: [], total: 0, listed: 0 },
  uncertainties: { listed: 0, total: 0, items: [] },
  separation: {
    capabilitiesDecidedBy: 'guard',
    capabilitiesPersisted: false,
    skillIsCapability: false,
    modelProviderIsAuthority: false,
    workerClaimIsAuthority: false,
    beliefCanBeVerified: false,
    selfModelGrants: false,
  },
}

function installFakeBridge(status: CoreStatus): void {
  const bridge: FreyaHostBridge = {
    isDesktop: true,
    getCapabilitySettings: async () => buildCapabilityRegistry(),
    setCapabilitySettings: async (preferences) => buildCapabilityRegistry(preferences),
    getRuntimeInfo: async () => ({ version: '0.1.0', electron: '44.5.0', platform: 'win32', arch: 'x64', userData: '', workspaceFile: '', dev: false }),
    loadWorkspace: async () => null,
    saveWorkspace: async () => true,
    onCollect: () => {},
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    providerConfig: async () => ({ baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, credentialState: 'stored', credentialReason: null }),
    saveProviderConfig: async () => ({ baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, credentialState: 'stored', credentialReason: null }),
    attachmentPick: async () => null,
    mediaThumbnail: async () => null,
    mediaDocument: async () => null,
    mediaVideo: async () => null,
    browserState: async () => ({ available: false, active: false, reason: '', publicAvailable: false, extensionPaired: false, extensionLive: false, journalTrustworthy: true, runtimeStatus: 'surfaceUnavailable', activeTabId: null, tabs: [], tabCount: 0, recovery: null, summary: '', sessions: [], phase51: [], described: 0, staleRefs: 0, mediaObserved: 0, refusals: 0 }),
    browserExecute: async () => ({ ok: false, command: 'page.navigate', target: null, code: 'subsystem-disabled', reason: '', escalation: null }),
    voiceConfig: async () => DEFAULT_VOICE_CONFIG,
    saveVoiceConfig: async (patch) => ({ ...DEFAULT_VOICE_CONFIG, ...patch }),
    coreSubmit: async (command) => command === 'self.status.read'
      ? { requestId: 'r-1', ok: true, world: { operation: 'self', ok: true, self: selfStatus } }
      : { requestId: 'r-1', ok: false, refusal: { reason: 'not allowed in this test' } },
    coreStatus: async () => status,
    coreGoals: async () => null,
    onCoreStatus: () => () => {},
    coreActivity: async () => [],
    onCoreActivity: () => () => {},
    coreConversation: async () => null,
    onCoreConversation: () => () => {},
    coreVoice: async () => null,
    onCoreVoice: () => () => {},
    onCoreVoiceTranscript: () => () => {},
    onVoiceOutput: () => () => {},
    reportVoiceCapabilities: () => {},
    coreBrain: async () => brainProjection,
    onCoreBrain: () => () => {},
    coreWork: async () => workProjection,
    onCoreWork: () => () => {},
    coreMission: async () => missionProjection,
    onCoreMission: () => () => {},
    coreWorkforce: async () => workforceProjection,
    onCoreWorkforce: () => () => {},
    coreContext: async () => contextProjection,
    onCoreContext: () => () => {},
    corePersonality: async () => personalityProjection,
    onCorePersonality: () => () => {},
    coreAttention: async () => attentionProjection,
    onCoreAttention: () => () => {},
    coreRelay: async () => null,
    onCoreRelay: () => () => {},
    coreSkills: async () => null,
    onCoreSkills: () => () => {},
    coreLife: async () => null,
    onCoreLife: () => () => {},
    coreConsciousness: async () => consciousContext,
    onCoreConsciousness: () => () => {},
    coreLifeLoop: async () => null,
    onCoreLifeLoop: () => () => {},
    coreWorld: async () => worldSummary,
    onCoreWorld: () => () => {},
    coreFoundry: async () => null,
    onCoreFoundry: () => () => {},
    coreOffice: async () => null,
    onCoreOffice: () => () => {},
  }
  window.freyaHost = bridge
}

afterEach(() => {
  delete window.freyaHost
  resetCoreMirror(); resetMissionMirror(); resetWorkforceMirror(); resetAttentionMirror()
  resetBrainMirror(); resetWorkMirror(); resetConsciousnessMirror(); resetWorldMirror()
  resetSelfMirror(); resetPersonalityMirror(); resetContextMirror()
})

/** The only non-obvious helper: a snapshot whose mind resource is ready. */
async function attachWith(status: CoreStatus) {
  installFakeBridge(status)
  const adapter = createLiveAdapter()
  const disposer = await adapter.attach()
  return { adapter, disposer }
}

function readyMind(adapter: ReturnType<typeof createLiveAdapter>) {
  const mind = adapter.getSnapshot().mind
  if (mind.status !== 'ready') throw new Error('expected ready')
  return mind.data
}

describe('the Mind projection reports only what Core carries', () => {
  it('is live and derived from the projections Core published', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    const mind = adapter.getSnapshot().mind
    expect(mind.status).toBe('ready')
    if (mind.status !== 'ready') throw new Error('expected ready')
    expect(mind.source).toBe('live')
    expect(mind.data.overview.lifecycle).toBe('ready')
    expect(mind.data.overview.governorStatus).toBe('ready')
    expect(mind.data.overview.grantsActive).toBe(1)
    expect(mind.data.overview.providers[0]?.id).toBe('nanogpt')
    expect(mind.data.consciousHealth).toBe('ready')
    disposer()
  })

  it('derives one mode word, and STOP ALL outranks everything', async () => {
    const idle = await attachWith(coreStatus())
    if (idle.adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    expect(readyMind(idle.adapter).overview.mode).toBe('idle')
    idle.disposer()

    const busy = await attachWith(coreStatus({ activeProviderCalls: 2 }))
    if (busy.adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    expect(readyMind(busy.adapter).overview.mode).toBe('working')
    expect(readyMind(busy.adapter).overview.activeProviderCalls).toBe(2)
    busy.disposer()

    const stopped = await attachWith(coreStatus({ stopAll: { active: true, activatedAt: NOW, activatedBy: 'owner' }, activeProviderCalls: 2, faults: ['a fault'] }))
    if (stopped.adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    expect(readyMind(stopped.adapter).overview.mode).toBe('stopped')
    expect(readyMind(stopped.adapter).overview.stopped).toBe(true)
    stopped.disposer()
  })

  it('lists live threads and settled runs are not among them', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const threads = readyMind(adapter).threads
    const ids = threads.map((thread) => thread.id)
    expect(ids).toContain('run-live-1')
    expect(ids).toContain('mission-real-1')
    expect(ids).toContain('worker-1')
    expect(ids).toContain('approval-1')
    // A run the engine reports as settled is history, not a thread.
    expect(ids).not.toContain('run-done-1')
    // The one that occupies the engine in this process is marked as such.
    expect(threads.find((thread) => thread.id === 'run-live-1')?.live).toBe(true)
    expect(threads.find((thread) => thread.id === 'approval-1')?.live).toBe(false)
    disposer()
  })

  it('reports attention as a closed focus word and closed counts', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const attention = readyMind(adapter).attention
    expect(attention.health).toBe('ready')
    expect(attention.focus).toBe('focused')
    expect(attention.counts?.ingested).toBe(42)
    expect(attention.lastDecision?.reason).toBe('remembered')
    // No denominator exists for a focus reading, so there is no percentage.
    expect(JSON.stringify(attention)).not.toMatch(/\d\s*%/)
    disposer()
  })

  it('projects the self model from Core\'s own statements and invents no trait', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const self = readyMind(adapter).self
    expect(self.name).toBe('Freya')
    expect(self.claims.map((claim) => claim.claimId)).toEqual(['claim-1', 'claim-2'])
    expect(self.limitations[0]?.statement).toBe('I cannot remember without an encrypted Brain.')
    expect(self.durable).toBe(true)
    // The compartment read happened through the one owner command this lane has.
    expect(self.worldSelf?.source).toBe('world.self.status.read')
    expect(self.worldSelf?.assignedCapabilities).toEqual([{ capability: 'cognition.request', held: true }])
    expect(self.worldSelf?.separation.selfModelGrants).toBe(false)
    // A worker claim is reported as a claim, with Core's own decision beside it.
    expect(self.worldSelf?.workerClaims[0]?.decision).toBe('refused')
    // World counts come from the world summary, and `withheld` is not hidden.
    expect(self.world?.entities).toBe(12)
    expect(self.world?.withheld).toBe(1)
    expect(self.world?.uncertainties).toBe(3)
    disposer()
  })

  it('projects Missions as status and counts, never as titles or roadmap dates', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const mind = readyMind(adapter)
    expect(mind.missions).toHaveLength(1)
    expect(mind.missions[0]?.id).toBe('mission-real-1')
    expect(mind.missions[0]?.status).toBe('active')
    expect(mind.missions[0]?.nextDecision).toBe('continue')
    expect(mind.missions[0]?.blockers).toEqual(['dependency_unverified'])
    expect(mind.missions[0]?.verifiedRuns).toBe(5)
    // No title, intent or date field exists to be filled in.
    expect(Object.keys(mind.missions[0] ?? {})).not.toContain('title')
    expect(Object.keys(mind.missions[0] ?? {})).not.toContain('deadline')
    expect(JSON.stringify(mind.missions)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    disposer()
  })

  it('shows owner context as unavailable when the domains report absent', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const owner = readyMind(adapter).owner
    expect(owner.personalityHealth).toBe('unavailable')
    expect(owner.personalityReason).toContain('no Personality domain')
    expect(owner.continuity).toBeNull()
    expect(owner.formality).toBeNull()
    expect(owner.temperament).toEqual([])
    expect(owner.relationshipDurable).toBeNull()
    expect(owner.contextHealth).toBe('unavailable')
    expect(owner.contextItems).toBe(0)
    disposer()
  })

  it('reports uncertainties as closed codes and never as sentences', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const mind = readyMind(adapter)
    expect(mind.uncertainties.map((item) => item.code)).toEqual(['mission.needs-attention', 'journal.integrity'])
    expect(mind.absentSections).toContain('life')
    expect(mind.provenance?.sources.map((source) => source.domain)).toEqual(['work', 'mission'])
    disposer()
  })

  it('never publishes a preview fixture in a live window', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    for (const resource of Object.values(adapter.getSnapshot())) {
      expect(resource.status === 'ready' ? resource.source : 'not ready').not.toBe('preview')
    }
    disposer()
  })

  it('reports unavailable with a reason when no Core is reachable', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const mind = adapter.getSnapshot().mind
    expect(mind.status).toBe('unavailable')
    if (mind.status === 'unavailable') expect(mind.reason).toBe('No Freya Core is reachable from this window.')
    disposer()
  })

  it('carries no hidden reasoning, prompt or model output anywhere in the shape', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const mind = readyMind(adapter)

    /**
     * Every key in the projection, at every depth.
     *
     * The property is checked on the *shape*, because that is where a leak would
     * live: a field named `reasoning` or `prompt` would be a place a model's
     * answer could be put, and a projection with no such field has nowhere to
     * put one. Checking the values instead would be a string list somebody has
     * to maintain forever.
     */
    const keys: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return }
      if (value === null || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        keys.push(key)
        walk(child)
      }
    }
    walk(mind)
    for (const forbidden of ['thought', 'monologue', 'reasoning', 'prompt', 'chainOfThought', 'completion', 'traits', 'innerState']) {
      expect(keys, `no field named ${forbidden} may exist on the Mind projection`).not.toContain(forbidden)
    }
    disposer()
  })

  it('prints no percentage for anything nothing measured', async () => {
    const { adapter, disposer } = await attachWith(coreStatus())
    if (adapter.getSnapshot().mind.status !== 'ready') throw new Error('expected ready')
    const mind = readyMind(adapter)
    // Attention focus has no denominator, so there is no percentage to print.
    expect(JSON.stringify(mind.attention)).not.toMatch(/\d\s*%/)
    // The self model carries no trait meter, so there is no percentage there either.
    const selfKeys = JSON.stringify(mind.self)
    expect(selfKeys).not.toMatch(/\d\s*%/)
    // And the overview is counts and closed words only.
    expect(JSON.stringify(mind.overview)).not.toMatch(/\d\s*%/)
    disposer()
  })
})
