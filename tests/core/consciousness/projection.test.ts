// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { projectConsciousContext } from '../../../core/consciousness/projection'
import {
  ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
  CONSCIOUS_UNCERTAINTY_CODES,
  NO_CONSCIOUS_CONTEXT_REASON,
} from '../../../core/protocol/consciousness'
import { CONSCIOUS_CONTEXT_LIMITS } from '../../../core/consciousness/types'
import {
  continuityFromBrain,
  selfFromBrain,
  worldFromBrain,
} from '../../../core/consciousness/adapters/brain'
import type { ConsciousLifeReading } from '../../../core/consciousness/ports'
import {
  ABSENT_ATTENTION_PROJECTION,
  type AttentionProjection,
} from '../../../core/protocol/attention'
import type { BrainProjection } from '../../../core/brain/brain'
import type { ContextProjectionView } from '../../../core/protocol/context'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import type { MissionProjection } from '../../../core/missions/types'
import { MISSION_STATUSES } from '../../../core/missions/types'
import type { OfficePresenceRequest, OfficeProjection } from '../../../core/office/types'
import type { PersonalityProjection } from '../../../core/protocol/personality'
import { ABSENT_RELAY_PROJECTION, type RelayProjection } from '../../../core/protocol/relay'
import { ABSENT_SKILL_PROJECTION, type SkillProjection } from '../../../core/protocol/skills'
import type { StopAllState } from '../../../core/state'
import { ABSENT_WORK_PROJECTION, type WorkProjection } from '../../../core/work/projection'
import { ABSENT_WORKFORCE_PROJECTION } from '../../../core/workforce/projection'
import type { WorkforceProjection } from '../../../core/workforce/types'
import type { CoreActivityEvent } from '../../../core/protocol/activity'

/**
 * The derivation, tested without a Core.
 *
 * Everything here is a pure function of projections other subsystems own, which
 * is the property that lets the whole snapshot be tested without building a Core
 * out of eleven subsystems — and, more usefully, lets a *single* subsystem be
 * taken away and the degradation path observed directly.
 *
 * Fixtures are hand-built rather than captured from a running Core on purpose: a
 * captured fixture can only ever assert what Core happened to produce, whereas a
 * hand-built one can assert what happens when a subsystem reports something Core
 * would never report — which is exactly the case the boundary has to survive.
 */

const NOW = new Date('2026-10-03T12:00:00.000Z')

const IDLE_STOP_ALL: StopAllState = { active: false, activatedAt: null, activatedBy: null }

/* ------------------------------------------------------------------ fixtures */

function coreStatus(over: Partial<CoreStatus> = {}): CoreStatus {
  return {
    lifecycle: 'ready',
    operational: true,
    persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null },
    diagnostics: { path: null, writeFailures: 0 },
    eventSequence: 42,
    coreStartedAt: '2026-10-03T09:00:00.000Z',
    integrity: { integrity: 'ok', reason: '', line: null, eventsRead: 0, bytesDiscarded: 0 },
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    guard: { defaultOutcome: 'allow', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 0 },
    providers: [],
    activeProviderCalls: 0,
    sessionUsage: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 },
    durableUsage: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 },
    faults: [],
    ...over,
  }
}

function brain(over: Partial<BrainProjection> = {}): BrainProjection {
  return {
    health: 'healthy',
    reason: null,
    persistence: 'encrypted',
    durable: true,
    identity: {
      name: 'Freya',
      role: 'assistant',
      purpose: 'help',
      claims: [{ claimId: 'c1', statement: 'truthfulness' }],
    },
    self: {
      complete: true,
      capabilities: [{ capability: 'read', state: 'available', cannot: ['write'] }],
      limitations: [{ limitationId: 'l1', statement: 'not a clinician' }],
    },
    counts: {
      entities: 3,
      relations: 2,
      observations: 1,
      memories: 4,
      admitted: 2,
      conflicted: 1,
      rejected: 1,
      withdrawn: 0,
      experiences: 0,
    },
    recentAdmissions: [
      {
        memoryId: 'm1',
        kind: 'semantic',
        subject: 'the owner prefers X',
        source: 'owner-assertion',
        confidence: 'high',
        status: 'admitted',
        admittedAt: '2026-10-03T11:00:00.000Z',
      },
    ],
    conflicts: [{ memoryId: 'm1', conflictsWith: ['m2'], detail: 'two memories disagree' }],
    sequence: 7,
    ...over,
  }
}

type RunView = NonNullable<WorkProjection['runs']>[number]

function run(over: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-1',
    kind: 'deterministic',
    status: 'running',
    createdAt: '2026-10-03T11:00:00.000Z',
    startedAt: '2026-10-03T11:00:01.000Z',
    completedAt: null,
    cancelledAt: null,
    failure: null,
    waitingOn: 'a step label',
    taskId: null,
    parentKind: null,
    parentId: null,
    progress: {
      stepsTotal: 2,
      verified: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      remaining: 2,
      actions: 0,
      attempts: 0,
      percent: null,
      summary: '',
    },
    limitHit: null,
    steps: [],
    actions: [],
    observations: [],
    verifications: [],
    live: true,
    ...over,
  }
}

function work(over: Partial<WorkProjection> = {}): WorkProjection {
  return {
    ...ABSENT_WORK_PROJECTION,
    health: 'ready',
    reason: null,
    detailAvailable: true,
    counts: {
      runs: 1,
      queued: 0,
      running: 1,
      waiting: 0,
      awaitingApproval: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pendingApprovals: 0,
      tasks: 0,
      liveCapabilities: 1,
    },
    runs: [run()],
    ...over,
  }
}

/**
 * Every Mission-status counter, at zero.
 *
 * Built from `MISSION_STATUSES` rather than written out, for the same reason the
 * projection itself does: a status added to the domain must be counted, and a hand-written
 * list of twelve is a place for one to be missed.
 */
function zeroCounts(): MissionProjection['counts'] {
  return {
    total: 0,
    ...Object.fromEntries(MISSION_STATUSES.map((status) => [status, 0])),
    needsAttention: 0,
  } as MissionProjection['counts']
}

function mission(over: Partial<MissionProjection> = {}): MissionProjection {
  return {
    persistence: { mode: 'encrypted', reason: null, durable: true },
    missions: [],
    counts: zeroCounts(),
    limits: {
      maxChildRuns: 64,
      maxConcurrentChildRuns: 4,
      lifetimeMs: 1,
      verificationDeadlineMs: 1,
      maxRetainedMissions: 200,
      maxTitleChars: 160,
      maxIntentChars: 4000,
      maxSuccessCriteria: 16,
      maxCriterionChars: 500,
    },
    missionsRetained: 0,
    missionsTotal: 0,
    missionsHidden: 0,
    sequence: 3,
    ...over,
  }
}

function workforce(over: Partial<WorkforceProjection> = {}): WorkforceProjection {
  return {
    ...ABSENT_WORKFORCE_PROJECTION,
    health: 'ready',
    reason: null,
    detailAvailable: true,
    workers: [],
    teams: [],
    counts: {
      workers: 0,
      idle: 0,
      working: 0,
      blocked: 0,
      stopped: 0,
      retired: 0,
      teams: 0,
      openAssignments: 0,
      messagesSent: 0,
      refusedClaims: 0,
    },
    assignmentsRetained: 0,
    assignmentsTotal: 0,
    assignmentsHidden: 0,
    messagesRetained: 0,
    messagesTotal: 0,
    messagesHidden: 0,
    sequence: 5,
    ...over,
  }
}

function skills(over: Partial<SkillProjection> = {}): SkillProjection {
  return {
    ...ABSENT_SKILL_PROJECTION,
    health: 'ready',
    reason: null,
    persistence: { mode: 'encrypted', durable: true, reason: null },
    sequence: 9,
    ...over,
  }
}

function personality(over: Partial<PersonalityProjection> = {}): PersonalityProjection {
  return {
    health: 'ready',
    reason: null,
    schemaVersion: 1,
    sequence: 11,
    persistence: { mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 },
    temperament: null,
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
    limits: { maxRelationshipItems: 256, maxCueOffersPerTurn: 4, maxLedgerEntries: 64 },
    ...over,
  }
}

function attention(over: Partial<AttentionProjection> = {}): AttentionProjection {
  return { ...ABSENT_ATTENTION_PROJECTION, health: 'ready', reason: null, sequence: 13, ...over }
}

function context(over: Partial<ContextProjectionView> = {}): ContextProjectionView {
  return {
    persistence: { mode: 'encrypted', durable: true, reason: null },
    activeScope: null,
    declaredScopes: [],
    agentContext: { wired: false, available: false, reason: 'nothing has been plugged in' },
    items: [],
    counts: { live: 0, revoked: 0, expired: 0, retained: 0, declaredScopes: 0 },
    limits: { maxItems: 64, maxLivePerScope: 16, maxScopes: 16 },
    sequence: 17,
    ...over,
  }
}

function office(over: Partial<OfficeProjection> = {}): OfficeProjection {
  return {
    health: 'ready',
    reason: null,
    freya: null,
    stations: [],
    history: [],
    presenceRequests: [],
    counts: {
      runs: 0,
      runsLive: 0,
      workers: 0,
      workersByIdle: 0,
      workersWorking: 0,
      workersBlocked: 0,
      workersStopped: 0,
      workersRetired: 0,
      approvalsPending: 0,
      floorStationsShown: 0,
      floorStationsHidden: 0,
      workforceStationsShown: 0,
      workforceStationsHidden: 0,
      approvalStationsShown: 0,
      approvalStationsHidden: 0,
      historyShown: 0,
      historyHidden: 0,
    },
    sequence: 19,
    ...over,
  }
}

function relay(over: Partial<RelayProjection> = {}): RelayProjection {
  return { ...ABSENT_RELAY_PROJECTION, health: 'ready', reason: null, sequence: 23, ...over }
}

function activity(count: number): CoreActivityEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `a${index}`,
    kind: 'core.ready' as const,
    type: 'core.ready' as const,
    sequence: index + 1,
    at: Date.parse('2026-10-03T10:00:00.000Z') + index * 1000,
    text: `synthetic activity sentence ${index}`,
    tone: 'neutral' as const,
  }))
}

function presenceRequests(): OfficePresenceRequest[] {
  return [{ workerId: 'w1', requestedAt: '2026-10-03T11:30:00.000Z', fulfilled: false }]
}

/**
 * A Phase 21 Life reading, for the tests that need one to exist.
 *
 * Deliberately minimal and deliberately *not* the shape Phase 21 will ship: it is
 * the port contract, which is a consumer-side promise. Phase 21 satisfies this port
 * with a real adapter; nothing here pretends to know how it will store a history.
 */
function life(over: Partial<ConsciousLifeReading> = {}): ConsciousLifeReading {
  return {
    health: 'ready',
    sequence: 12,
    durable: true,
    reason: null,
    authority: 'life',
    entries: 4,
    admitted: 3,
    recalled: 2,
    recent: [
      {
        entryId: 'life-2',
        kind: 'shift',
        at: '2026-10-02T09:00:00.000Z',
        textLength: 240,
        confidence: 0.8,
      },
      {
        entryId: 'life-1',
        kind: 'shift',
        at: '2026-10-01T09:00:00.000Z',
        textLength: 180,
        confidence: 0.7,
      },
    ],
    ...over,
  }
}

/**
 * Every subsystem present and healthy, *with* Life.
 *
 * The one case where `health` is `'ready'`, and it needs an explicit Life reading:
 * Phase 21 has not landed, so no real Core can produce it. Building it here is how
 * the "everything present" path stays tested, and the tests that use it are the ones
 * that must keep passing after Phase 21 integrates for real.
 */
function completeInput() {
  const theBrain = brain()
  return {
    status: coreStatus(),
    stopAll: IDLE_STOP_ALL,
    brain: theBrain,
    // Wired exactly the way `FreyaCore.consciousness()` wires them, so the fixture
    // cannot drift into a shape Core never produces.
    self: selfFromBrain(theBrain),
    world: worldFromBrain(theBrain),
    continuity: continuityFromBrain(theBrain),
    life: life(),
    work: work(),
    mission: mission(),
    workforce: workforce(),
    skills: skills(),
    personality: personality(),
    attention: attention(),
    context: context(),
    office: office(),
    relay: relay(),
    activity: activity(3),
    presenceRequests: presenceRequests(),
    pendingRequests: [],
    faults: [],
  }
}

/** Nothing present at all: the degraded-by-absence case. */
function emptyInput() {
  return {
    status: null,
    stopAll: IDLE_STOP_ALL,
    brain: null,
    self: null,
    world: null,
    continuity: null,
    life: null,
    work: null,
    mission: null,
    workforce: null,
    skills: null,
    personality: null,
    attention: null,
    context: null,
    office: null,
    relay: null,
    activity: [],
    presenceRequests: [],
    pendingRequests: [],
    faults: [],
  }
}

/* ---------------------------------------------------------------- the tests */

describe('a snapshot derived from nothing', () => {
  it('is unavailable rather than ready with empty lists', () => {
    const snapshot = projectConsciousContext(emptyInput(), NOW)
    expect(snapshot.health).toBe('unavailable')
    expect(snapshot.reason).toBe(NO_CONSCIOUS_CONTEXT_REASON)
    expect(snapshot.provenance.freshness).toBe('absent')
    // Every row is *named* as absent rather than the list being empty. An empty
    // `sources` would leave a consumer to infer which subsystems are missing,
    // and "I cannot tell you what is missing" is a worse answer than "all of
    // these are missing" — it is the difference between a stated absence and an
    // absence of a statement.
    expect(snapshot.provenance.sources).toHaveLength(14)
    expect(snapshot.provenance.sources.every((row) => row.freshness === 'absent')).toBe(true)
    expect(snapshot.provenance.sources.map((row) => row.domain)).toEqual([
      'core',
      'brain',
      'life',
      'self',
      'world',
      'work',
      'mission',
      'workforce',
      'skills',
      'personality',
      'attention',
      'context',
      'office',
      'relay',
    ])
  })

  it('says nothing about which subsystems a build has before Core has started', () => {
    // The contrast with the case above is deliberate. Once Core is up, the
    // snapshot names what is missing; before it is up, the frozen constant names
    // nothing at all, because at that point Core does not know what the build
    // contains either — and a list of eleven absent subsystems would be a claim
    // about the build made by a function that has not yet read it.
    expect(ABSENT_CONSCIOUS_CONTEXT_PROJECTION.provenance.sources).toEqual([])
  })

  it('states every section absent rather than reporting zero as fact', () => {
    const snapshot = projectConsciousContext(emptyInput(), NOW)
    for (const section of [
      snapshot.self,
      snapshot.posture,
      snapshot.focus,
      snapshot.attention,
      snapshot.waiting,
      snapshot.agents,
      snapshot.practice,
      snapshot.world,
      snapshot.continuity,
      snapshot.recentChanges,
      snapshot.uncertainty,
      snapshot.nextActions,
    ] as const) {
      expect(section.state, JSON.stringify(section)).toBe('absent')
    }
  })

  it('never turns an absent subsystem into an empty world', () => {
    const snapshot = projectConsciousContext(emptyInput(), NOW)
    expect(snapshot.world.entities).toBeNull()
    expect(snapshot.world.memories).toBeNull()
    expect(snapshot.world.conflicted).toBeNull()
    expect(snapshot.continuity.items).toEqual([])
    expect(snapshot.agents.workers).toEqual([])
    expect(snapshot.posture.continuity).toBeNull()
    expect(snapshot.self.name).toBeNull()
  })
})

describe('a snapshot derived from everything', () => {
  it('is ready, and says it was derived rather than authoritative', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.health).toBe('ready')
    expect(snapshot.reason).toBeNull()
    expect(snapshot.provenance.basis).toBe('derived')
    expect(snapshot.provenance.freshness).toBe('fresh')
    expect(snapshot.provenance.durableSequence).toBe(42)
    expect(snapshot.provenance.asOf).toBe(NOW.toISOString())
  })

  it('names every contributing source and attributes each one', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.provenance.sources.map((row) => row.domain)).toEqual([
      'core',
      'brain',
      'life',
      'self',
      'world',
      'work',
      'mission',
      'workforce',
      'skills',
      'personality',
      'attention',
      'context',
      'office',
      'relay',
    ])
    const office = snapshot.provenance.sources.find((row) => row.domain === 'office')
    expect(office?.basis, 'the Office is itself a derivation inside Core').toBe('derived')
    const work = snapshot.provenance.sources.find((row) => row.domain === 'work')
    expect(work?.basis).toBe('authoritative')
  })

  it('publishes the limits it was built under', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.limits).toEqual({ ...CONSCIOUS_CONTEXT_LIMITS })
  })

  it('answers what Freya is focused on, from identifiers rather than titles', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.focus.state).toBe('available')
    expect(snapshot.focus.primaryRunId).toBe('run-1')
    expect(snapshot.focus.liveRuns).toBe(1)
    expect(snapshot.focus.runningRuns).toBe(1)
    expect(snapshot.focus.attentionFocus).toBe(ABSENT_ATTENTION_PROJECTION.focus)
  })

  it('reports the most recent change by durable sequence, newest first', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.recentChanges.items.map((row) => row.sequence)).toEqual([3, 2, 1])
    expect(snapshot.recentChanges.listed).toBe(3)
    expect(snapshot.recentChanges.omitted).toBe(0)
  })

  it('reports an unfulfilled presence request as uncertainty', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.uncertainty.items).toContainEqual({
      code: 'presence.unfulfilled',
      subjectKind: 'worker',
      subjectId: 'w1',
      since: '2026-10-03T11:30:00.000Z',
    })
  })

  it('reports a memory subject as a length, and never as a subject', () => {
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.continuity.items).toEqual([
      {
        memoryId: 'm1',
        kind: 'semantic',
        source: 'owner-assertion',
        confidence: 'high',
        status: 'admitted',
        subjectLength: 'the owner prefers X'.length,
        admittedAt: '2026-10-03T11:00:00.000Z',
      },
    ])
    expect(Object.keys(snapshot.continuity.items[0] ?? {}).sort()).toEqual([
      'admittedAt',
      'confidence',
      'kind',
      'memoryId',
      'source',
      'status',
      'subjectLength',
    ])
  })
})

/** A mission that offers two actions, so Stop All has something to withhold. */
function activeMission(): MissionProjection {
  return mission({
    missions: [
      {
        missionId: 'mi-1',
        status: 'active',
        createdAt: '2026-10-03T10:00:00.000Z',
        deadlineAt: '2026-10-03T11:00:00.000Z',
        settledAt: null,
        reason: null,
        counts: {
          total: 0,
          queued: 0,
          running: 0,
          waiting: 0,
          awaitingApproval: 0,
          paused: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          verified: 0,
        },
        needsAttention: false,
        availableActions: ['pause', 'resume'],
        verification: null,
        // Phase 47's board fields. Present and empty here because this fixture is about
        // *two actions on a Mission*, not about a Mission in progress — and the
        // projection must still be well-typed for a Mission that has never been planned.
        priority: 'routine',
        planRevision: null,
        progress: {
          steps: {
            total: 0,
            pending: 0,
            blocked: 0,
            delegated: 0,
            running: 0,
            verified: 0,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
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
        lastUpdatedAt: '2026-10-03T10:00:00.000Z',
        awaitingOwner: false,
        budgetRemaining: {
          modelCalls: 0,
          actions: 0,
          externalRequests: 0,
          retries: 0,
          delegations: 0,
          planRevisions: 0,
          concurrentDelegations: 0,
        },
      },
    ],
    counts: { ...zeroCounts(), total: 1, active: 1 },
  })
}

describe('the same durable state twice', () => {
  it('produces the same snapshot', () => {
    const input = completeInput()
    expect(projectConsciousContext(input, NOW)).toEqual(projectConsciousContext(input, NOW))
  })

  it('produces the same snapshot whatever order the activity feed arrived in', () => {
    const input = completeInput()
    const forwards = projectConsciousContext(input, NOW)
    const backwards = projectConsciousContext({ ...input, activity: [...input.activity].reverse() }, NOW)
    expect(backwards).toEqual(forwards)
  })

  it('produces the same snapshot whatever order the inbox arrived in', () => {
    const inbox = [
      {
        eventId: 'e1',
        source: 'owner' as const,
        kind: 'message' as const,
        goalRef: null,
        severityHint: 'normal' as const,
        textLength: 3,
        observedAt: '2026-10-03T10:00:00.000Z',
        dueAt: null,
        outcome: null,
      },
      {
        eventId: 'e2',
        source: 'owner' as const,
        kind: 'message' as const,
        goalRef: null,
        severityHint: 'low' as const,
        textLength: 4,
        observedAt: '2026-10-03T10:00:05.000Z',
        dueAt: null,
        outcome: null,
      },
    ]
    const input = completeInput()
    const a = projectConsciousContext({ ...input, attention: attention({ inbox }) }, NOW)
    const b = projectConsciousContext(
      { ...input, attention: attention({ inbox: [...inbox].reverse() }) },
      NOW,
    )
    expect(a.attention.inbox.map((item) => item.eventId)).toEqual(['e2', 'e1'])
    expect(b.attention.inbox).toEqual(a.attention.inbox)
  })
})

describe('a subsystem taken away', () => {
  it('is reported as absent in its own section and as degraded overall', () => {
    const input = completeInput()
    const withoutWorkforce = projectConsciousContext({ ...input, workforce: null }, NOW)
    expect(withoutWorkforce.health).toBe('degraded')
    expect(withoutWorkforce.reason).toContain('workforce')
    expect(withoutWorkforce.agents.state).toBe('absent')
    expect(withoutWorkforce.waiting.blockedAgents).toEqual([])
    // Everything that did not depend on the Workforce is still there.
    expect(withoutWorkforce.focus.state).toBe('available')
    expect(withoutWorkforce.recentChanges.listed).toBe(3)
  })

  it('leaves every other section intact rather than collapsing the snapshot', () => {
    const input = completeInput()
    // The Brain and the three ports it answers are taken together, because that is
    // the only shape a real Core produces: with no Brain there is no producer, so
    // `selfFromBrain(null)` is `null` and the port has nothing to say. Setting only
    // `brain: null` would leave ports answering for a Brain that is not there, which
    // is precisely the two-authorities-for-one-fact failure the ports exist to stop.
    const withoutBrain = projectConsciousContext(
      {
        ...input,
        brain: null,
        self: selfFromBrain(null),
        world: worldFromBrain(null),
        continuity: continuityFromBrain(null),
      },
      NOW,
    )
    expect(withoutBrain.self.state).toBe('absent')
    expect(withoutBrain.world.state).toBe('absent')
    expect(withoutBrain.continuity.state).toBe('absent')
    // Work, Mission, Workforce and Attention are untouched by a missing Brain.
    expect(withoutBrain.focus.state).toBe('available')
    expect(withoutBrain.agents.state).toBe('available')
    expect(withoutBrain.recentChanges.listed).toBe(3)
  })

  it('says unknown rather than absent when a source is present but unreadable', () => {
    const input = completeInput()
    // Re-derived from the degraded Brain, again because that is what Core does. The
    // interesting assertion is that a *present but unreadable* producer yields
    // `'degraded'`, not `'absent'`: a person told "Freya has no account of herself"
    // when the truth is "we could not read it" would draw the wrong conclusion about
    // her, which is the whole reason the two absences are kept apart.
    const unreadable = brain({ health: 'degraded', reason: 'the store could not be opened' })
    const degradedBrain = projectConsciousContext(
      {
        ...input,
        brain: unreadable,
        self: selfFromBrain(unreadable),
        world: worldFromBrain(unreadable),
        continuity: continuityFromBrain(unreadable),
      },
      NOW,
    )
    expect(degradedBrain.provenance.sources.find((row) => row.domain === 'brain')?.freshness).toBe(
      'unknown',
    )
    expect(degradedBrain.world.state).toBe('degraded')
    expect(degradedBrain.self.state).toBe('degraded')
    expect(degradedBrain.health).toBe('degraded')
  })
})

describe('freshness', () => {
  it('is stale for a subsystem that lost its volatile half, not absent', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext({ ...input, work: work({ detailAvailable: false }) }, NOW)
    const row = snapshot.provenance.sources.find((entry) => entry.domain === 'work')
    expect(row?.freshness).toBe('stale')
    expect(row?.detailAvailable).toBe(false)
    expect(row?.note).toContain('restart')
    // Stale still means usable: the section is built, and says it is thinner.
    expect(snapshot.waiting.state).toBe('available')
  })

  it('is stale for a non-durable store, and says so in words', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      { ...input, brain: brain({ persistence: 'ephemeral', durable: false }) },
      NOW,
    )
    const row = snapshot.provenance.sources.find((entry) => entry.domain === 'brain')
    expect(row?.freshness).toBe('stale')
    expect(row?.durable).toBe(false)
    expect(row?.note).toContain('restart')
  })

  it('takes the weakest reading across every source', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      { ...input, work: work({ detailAvailable: false }) },
      NOW,
    )
    expect(snapshot.provenance.freshness).toBe('stale')
  })

  it('is absent for a Core that is only booting', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      { ...input, status: coreStatus({ lifecycle: 'booting' }) },
      NOW,
    )
    expect(snapshot.health).toBe('unavailable')
    expect(snapshot.provenance.sources.find((row) => row.domain === 'core')?.freshness).toBe(
      'absent',
    )
  })
})

describe('bounds', () => {
  it('caps the recent-change list and discloses what it left off', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      { ...input, activity: activity(CONSCIOUS_CONTEXT_LIMITS.maxRecentChanges + 10) },
      NOW,
    )
    expect(snapshot.recentChanges.listed).toBe(CONSCIOUS_CONTEXT_LIMITS.maxRecentChanges)
    expect(snapshot.recentChanges.omitted).toBe(10)
    // The newest survive, not whichever slice happened to land in the window.
    expect(snapshot.recentChanges.items[0]?.sequence).toBe(
      CONSCIOUS_CONTEXT_LIMITS.maxRecentChanges + 10,
    )
  })

  it('does not grow with the size of the activity feed', () => {
    const input = completeInput()
    const small = projectConsciousContext({ ...input, activity: activity(5) }, NOW)
    const large = projectConsciousContext({ ...input, activity: activity(5000) }, NOW)
    expect(small.recentChanges.items.length).toBe(5)
    expect(large.recentChanges.items.length).toBe(CONSCIOUS_CONTEXT_LIMITS.maxRecentChanges)
  })

  it('caps the agent list and discloses the remainder', () => {
    const input = completeInput()
    const many = Array.from({ length: 30 }, (_unused, index) => ({
      workerId: `w${index}`,
      name: `worker ${index}`,
      specialisation: 'general' as const,
      status: 'idle' as const,
      createdAt: '2026-10-03T10:00:00.000Z',
      settledAt: null,
      reason: null,
      teams: [],
      capabilities: [],
      contextRefs: [],
      budget: {
        maxAssignments: 1,
        maxOpenAssignments: 1,
        maxAssignmentMs: 1,
        maxCognitionCalls: 1,
        maxCognitionTokens: 1,
        maxMessages: 1,
      },
      spend: {
        assignments: 0,
        openAssignments: 0,
        cognitionCalls: 0,
        cognitionTokens: 0,
        messages: 0,
      },
      remaining: { assignments: 1, openAssignments: 1, cognitionCalls: 1, cognitionTokens: 1, messages: 1 },
      availableActions: [],
      limitsHit: [],
      assignments: [],
      refusedClaims: 0,
    }))
    const snapshot = projectConsciousContext(
      {
        ...input,
        workforce: workforce({
          workers: many,
          counts: {
            workers: 30,
            idle: 30,
            working: 0,
            blocked: 0,
            stopped: 0,
            retired: 0,
            teams: 0,
            openAssignments: 0,
            messagesSent: 0,
            refusedClaims: 0,
          },
        }),
      },
      NOW,
    )
    expect(snapshot.agents.workers).toHaveLength(CONSCIOUS_CONTEXT_LIMITS.maxAgents)
    expect(snapshot.agents.counts?.workers, 'the total, not the shown slice').toBe(30)
  })
})

describe('Stop All', () => {
  it('withholds every offered action and discloses how many', () => {
    const input = completeInput()
    const offering = activeMission()
    const active = projectConsciousContext({ ...input, mission: offering }, NOW)
    expect(active.nextActions.items).toEqual([
      { scope: 'mission', subjectId: 'mi-1', action: 'pause' },
      { scope: 'mission', subjectId: 'mi-1', action: 'resume' },
    ])

    const stopped = projectConsciousContext(
      {
        ...input,
        mission: offering,
        stopAll: { active: true, activatedAt: NOW.toISOString(), activatedBy: 'owner' },
      },
      NOW,
    )
    expect(stopped.nextActions.items).toEqual([])
    expect(stopped.nextActions.listed).toBe(0)
    expect(stopped.nextActions.omitted, 'withheld, not absent').toBe(2)
    expect(stopped.nextActions.note).toContain('STOP ALL')
  })

  it('still reports the stop itself, above everything else', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      {
        ...input,
        stopAll: { active: true, activatedAt: NOW.toISOString(), activatedBy: 'owner' },
        status: coreStatus({
          stopAll: { active: true, activatedAt: NOW.toISOString(), activatedBy: 'owner' },
        }),
      },
      NOW,
    )
    expect(snapshot.stopAll.active).toBe(true)
    expect(snapshot.stopAll.activatedBy).toBe('owner')
    expect(snapshot.stopAll.activatedAt).toBe(NOW.toISOString())
    // Reading is not acting: the rest of the picture is still there.
    expect(snapshot.self.state).toBe('available')
    expect(snapshot.focus.state).toBe('available')
  })
})

describe('coherence', () => {
  it('changes when the authoritative state underneath it changes', () => {
    const input = completeInput()
    const before = projectConsciousContext(input, NOW)
    const after = projectConsciousContext(
      {
        ...input,
        work: work({
          counts: {
            runs: 1,
            queued: 0,
            running: 0,
            waiting: 1,
            awaitingApproval: 0,
            paused: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            pendingApprovals: 0,
            tasks: 0,
            liveCapabilities: 1,
          },
          runs: [run({ status: 'waiting' })],
        }),
      },
      NOW,
    )
    expect(after).not.toEqual(before)
    expect(after.focus.runningRuns).toBe(0)
    expect(after.focus.waitingRuns).toBe(1)
    expect(after.waiting.waitingRuns.map((entry) => entry.status)).toEqual(['waiting'])
  })

  it('changes when the journal grows, through the durable sequence', () => {
    const input = completeInput()
    const before = projectConsciousContext(input, NOW)
    const after = projectConsciousContext(
      { ...input, status: coreStatus({ eventSequence: 99 }) },
      NOW,
    )
    expect(after.provenance.durableSequence).toBe(99)
    expect(after.provenance.durableSequence).not.toBe(before.provenance.durableSequence)
  })

  it('names the longest-running live run as the focus, not the newest', () => {
    const input = completeInput()
    const base = work().runs[0] as NonNullable<WorkProjection['runs'][number]>
    const snapshot = projectConsciousContext(
      {
        ...input,
        work: work({
          runs: [
            { ...base, runId: 'run-new', createdAt: '2026-10-03T11:30:00.000Z' },
            { ...base, runId: 'run-old', createdAt: '2026-10-03T09:00:00.000Z' },
          ],
        }),
      },
      NOW,
    )
    expect(snapshot.focus.primaryRunId).toBe('run-old')
  })
})

describe('honesty about what it does not know', () => {
  it('reports a pending provider call as uncertainty', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext({ ...input, pendingRequests: ['req-1'] }, NOW)
    expect(snapshot.uncertainty.items).toContainEqual({
      code: 'cognition.request-pending',
      subjectKind: 'core',
      subjectId: null,
      since: null,
    })
  })

  it('reports a closed governor as uncertainty', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      { ...input, status: coreStatus({ governor: { status: 'deny_all', grantsActive: 0 } }) },
      NOW,
    )
    expect(snapshot.uncertainty.items.some((row) => row.code === 'cognition.governor-closed')).toBe(true)
  })

  it('reports a damaged journal as uncertainty', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      {
        ...input,
        status: coreStatus({
          integrity: { integrity: 'corrupt', reason: 'damaged', line: 9, eventsRead: 3, bytesDiscarded: 2 },
        }),
      },
      NOW,
    )
    expect(snapshot.uncertainty.items.some((row) => row.code === 'journal.integrity')).toBe(true)
  })

  it('reports unknown usage as uncertainty rather than as zero', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      {
        ...input,
        status: coreStatus({
          durableUsage: { calls: 2, inputTokens: null, outputTokens: null, unknownUsageCalls: 1 },
        }),
      },
      NOW,
    )
    expect(snapshot.uncertainty.items.some((row) => row.code === 'cognition.usage-unknown')).toBe(true)
  })

  it('never uses a code outside the closed set', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext(
      { ...input, pendingRequests: ['a'], faults: ['b'], activity: activity(2) },
      NOW,
    )
    for (const row of snapshot.uncertainty.items) {
      expect(CONSCIOUS_UNCERTAINTY_CODES as readonly string[], row.code).toContain(row.code)
    }
  })

  it('orders uncertainty by declared priority, so the cap drops the least important', () => {
    const input = completeInput()
    const snapshot = projectConsciousContext({ ...input, brain: brain(), pendingRequests: ['r'] }, NOW)
    const codes = snapshot.uncertainty.items.map((row) => row.code)
    // `memory.conflict` is declared before `cognition.request-pending`, so it leads.
    expect(codes.indexOf('memory.conflict')).toBeLessThan(codes.indexOf('cognition.request-pending'))
  })
})

describe('derived readings are marked as derived', () => {
  it('labels exactly the sections this phase computes', () => {
    // The sections below are pure derivations; the sections beside them are lifted.
    // A consumer distinguishes them by reading `provenance`, so the two facts that
    // matter are that both are stated and that neither is silently "authoritative".
    const snapshot = projectConsciousContext(completeInput(), NOW)
    expect(snapshot.provenance.basis).toBe('derived')
    expect(
      snapshot.provenance.sources.every((row) => row.basis === 'authoritative' || row.basis === 'derived'),
    ).toBe(true)
  })
})

describe('the absent snapshot', () => {
  it('is frozen, so a shared reference cannot be edited into a lie', () => {
    expect(Object.isFrozen(ABSENT_CONSCIOUS_CONTEXT_PROJECTION)).toBe(true)
    expect(ABSENT_CONSCIOUS_CONTEXT_PROJECTION.health).toBe('unavailable')
    expect(ABSENT_CONSCIOUS_CONTEXT_PROJECTION.reason).toBe(NO_CONSCIOUS_CONTEXT_REASON)
  })

  it('carries no value a consumer could mistake for a fact', () => {
    const absent = ABSENT_CONSCIOUS_CONTEXT_PROJECTION
    expect(absent.stopAll.active).toBe(false)
    expect(absent.world.entities).toBeNull()
    expect(absent.focus.attentionFocus).toBe('unknown')
    expect(absent.provenance.durableSequence).toBe(0)
    expect(absent.limits.maxSources).toBe(0)
  })
})