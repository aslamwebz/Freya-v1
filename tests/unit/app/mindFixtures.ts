import type { UiSnapshot } from '../../../src/ui-v2/state/contract'
import type { MindView } from '../../../src/ui-v2/state/contract'

/**
 * Fixtures for the Mind workspace's tests.
 *
 * Built the same way the live adapter builds them — by copying out of Core's
 * own projections — so a test that passes here is asserting on the same shapes a
 * real window sees. The conscious context is assembled from the protocol's own
 * frozen *absent* snapshot with the sections a Core that is actually reporting
 * would fill in, which is the honest middle: nothing is invented, and nothing is
 * left blank either.
 */

export const MIND_NOW = '2026-10-03T01:00:00.000Z'

/** Every resource absent: the shape of a window with no Core behind it. */
export const NO_CORE_SNAPSHOT = {
  home: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  core: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  mission: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  workforce: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  activity: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  attention: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  mind: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  provider: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
} as unknown as UiSnapshot

/**
 * A live Mind projection, as the adapter derives it from a Core that is
 * reporting everything.
 */
export function liveMind(over: Partial<MindView> = {}): MindView {
  return {
    overview: {
      lifecycle: 'running',
      operational: true,
      stopped: false,
      governorStatus: 'ready',
      grantsActive: 1,
      activeProviderCalls: 0,
      journalIntegrity: 'ok',
      persistenceMode: 'durable',
      persistenceReason: null,
      faults: [],
      sequence: 42,
      mode: 'idle',
      modeDetail: 'Nothing is executing. Core is up and listening.',
      providers: [
        {
          id: 'nanogpt',
          kind: 'nanogpt',
          status: 'configured',
          model: 'openai/gpt-4.1-nano',
          liveEnabled: true,
          detail: 'ready',
        },
      ],
      sessionCalls: 3,
      sessionInputTokens: 1200,
      sessionOutputTokens: 800,
      sessionUnknownUsageCalls: 0,
    },
    threads: [
      {
        id: 'run-live-1',
        kind: 'run',
        status: 'running',
        detail: 'running a step',
        live: true,
      },
      { id: 'mission-real-1', kind: 'mission', status: 'active', detail: 'needs attention', live: false },
      { id: 'approval-1', kind: 'approval', status: 'pending', detail: 'browser.read · risk consequential', live: false },
      { id: 'worker-1', kind: 'worker', status: 'Researching', detail: 'mission-real-1', live: true },
    ],
    attention: {
      health: 'ready',
      reason: null,
      focus: 'focused',
      counts: {
        ingested: 42,
        decisions: 18,
        doNothing: 5,
        remembered: 0,
        cued: 12,
        spoke: 4,
        interrupted: 1,
        budgetExceeded: 0,
      },
      inboxCount: 1,
      lastDecision: {
        source: 'owner',
        kind: 'message',
        outcome: 'remember',
        importance: 'normal',
        urgency: 'routine',
        reason: 'no_action_needed',
        decidedAt: MIND_NOW,
      },
    },
    self: {
      name: 'Freya',
      role: 'a persistent Core with replaceable embodiments',
      purpose: 'to be a durable, honest intelligence the owner can rely on',
      claimCount: 3,
      complete: true,
      claims: [
        { claimId: 'claim-1', statement: 'Core is Freya; the model is not Freya.' },
        { claimId: 'claim-2', statement: 'Identity is typed data, not a prompt.' },
      ],
      capabilities: [
        { capability: 'conversation.turn', state: 'seeded', cannot: ['choose a provider', 'raise a budget'] },
      ],
      limitations: [
        { limitationId: 'lim-1', statement: 'I cannot remember without an encrypted Brain.' },
      ],
      durable: true,
      reason: null,
      world: {
        health: 'ready',
        reason: null,
        entities: 12,
        edges: 30,
        evidenceRecords: 18,
        withdrawn: 2,
        conflicts: 1,
        beliefs: 4,
        uncertainties: 3,
        withheld: 1,
        durable: true,
      },
      worldSelf: {
        source: 'world.self.status.read',
        assignedCapabilities: [{ capability: 'cognition.request', held: true }],
        knownSkills: [{ name: 'brief-summary', status: 'active', verification: 'verified' }],
        models: [{ providerId: 'nanogpt', kind: 'nanogpt', live: true }],
        workerClaims: [{ workerId: 'worker-1', claimKind: 'capability', decision: 'refused' }],
        separation: {
          capabilitiesDecidedBy: 'guard',
          capabilitiesPersisted: false,
          skillIsCapability: false,
          modelProviderIsAuthority: false,
          workerClaimIsAuthority: false,
          beliefCanBeVerified: false,
          selfModelGrants: false,
        },
        readAt: MIND_NOW,
      },
    },
    missions: [
      {
        id: 'mission-real-1',
        status: 'active',
        priority: 'routine',
        needsAttention: true,
        awaitingOwner: false,
        totalRuns: 8,
        verifiedRuns: 5,
        nextDecision: 'continue',
        nextReason: 'the plan has an unverified step',
        blockers: ['approval-required'],
      },
    ],
    missionsTotal: 1,
    missionsHidden: 0,
    owner: {
      personalityHealth: 'ready',
      personalityReason: null,
      continuity: 'sustained',
      formality: 'warm',
      temperament: [{ dimension: 'warmth', level: 'high' }],
      relationshipItems: 6,
      admittedItems: 6,
      cuesAdmitted: 2,
      relationshipDurable: true,
      contextHealth: 'ready',
      contextReason: null,
      contextItems: 4,
      contextCurrent: 2,
      contextScopes: ['session'],
      contextUnresolvedReferences: 1,
      contextDurable: true,
    },
    uncertainties: [
      { code: 'mission.needs-attention', subjectKind: 'mission', subjectId: 'mission-real-1', since: MIND_NOW },
      { code: 'journal.integrity', subjectKind: 'core', subjectId: null, since: null },
    ],
    uncertaintiesOmitted: 0,
    nextActions: [
      { scope: 'mission', subjectId: 'mission-real-1', action: 'requestCompletion' },
    ],
    recentChanges: [
      { id: 'evt-42', kind: 'mission.plan.committed', sequence: 42, at: 1790956800000, tone: 'busy' },
    ],
    waiting: {
      pendingApprovals: 1,
      waitingRuns: [{ runId: 'run-wait-1', status: 'waiting', waitingSince: MIND_NOW }],
      blockedAgents: [{ workerId: 'worker-2', status: 'blocked' }],
      unfulfilledPresenceRequests: 0,
    },
    provenance: {
      basis: 'derived',
      freshness: 'fresh',
      asOf: MIND_NOW,
      sources: [
        { domain: 'work', basis: 'authoritative', freshness: 'fresh', durable: true, note: null },
        { domain: 'mission', basis: 'authoritative', freshness: 'fresh', durable: true, note: null },
      ],
    },
    consciousHealth: 'ready',
    consciousReason: null,
    absentSections: ['life'],
    ...over,
  }
}

/** A snapshot whose `mind` resource is live and everything else is absent. */
export function liveMindSnapshot(over: Partial<MindView> = {}): UiSnapshot {
  return {
    ...NO_CORE_SNAPSHOT,
    mind: { status: 'ready', source: 'live', data: liveMind(over) },
  } as UiSnapshot
}
