import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Mind } from '../../../src/ui-v2/workspaces/Mind'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { createViews } from '../../../src/ui-v2/workspaces/viewState'
import type { MindView, Resource, UiSnapshot } from '../../../src/ui-v2/state/contract'

afterEach(cleanup)

const views = createViews()
const update = () => {}

/**
 * The Mind workspace, wired.
 *
 * The workspace this file covers used to be a pending card in live mode and a
 * module-constant concept design in preview mode — fabricated traits, a
 * "72% complete" focus list and dated goals that no Core anywhere measures.
 * These tests pin the replacement: one projection-driven renderer, in both
 * window modes, that shows live / stale / unavailable / degraded states as the
 * facts they are and invents nothing along the way.
 */

/** A complete live MindView, assembled only from fields the contract defines. */
function mindFixture(overrides: Partial<MindView> = {}): MindView {
  const base: MindView = {
    overview: {
      lifecycle: 'running',
      operational: true,
      stopped: false,
      governorStatus: 'ready',
      grantsActive: 2,
      activeProviderCalls: 1,
      journalIntegrity: 'ok',
      persistenceMode: 'durable',
      persistenceReason: null,
      faults: [],
      sequence: 42,
      mode: 'working',
      modeDetail: '1 provider request executing right now.',
      providers: [{ id: 'nano-gpt', kind: 'model', status: 'configured', model: 'openai/gpt-4.1-nano', liveEnabled: true, detail: 'connected' }],
      sessionCalls: 7,
      sessionInputTokens: 1200,
      sessionOutputTokens: null,
      sessionUnknownUsageCalls: 3,
    },
    threads: [
      { id: 'run-2', kind: 'run', status: 'waiting', detail: 'waiting on owner', live: false },
      { id: 'run-1', kind: 'run', status: 'executing', detail: null, live: true },
      { id: 'mission-1', kind: 'mission', status: 'active', detail: 'needs attention', live: false },
    ],
    attention: {
      health: 'ready',
      reason: null,
      focus: 'focused',
      counts: { ingested: 12, decisions: 5, doNothing: 1, remembered: 2, cued: 3, spoke: 1, interrupted: 0, budgetExceeded: 0 },
      inboxCount: 4,
      lastDecision: { source: 'attention', kind: 'cue', outcome: 'spoke', importance: 'medium', urgency: 'low', reason: 'budget-ok', decidedAt: '2026-10-09T00:00:00.000Z' },
    },
    self: {
      name: 'Freya',
      role: 'cognitive partner',
      purpose: 'Think clearly with the owner.',
      claimCount: 3,
      complete: true,
      claims: [{ claimId: 'claim-1', statement: 'I am Freya.' }],
      capabilities: [{ capability: 'research', state: 'seeded', cannot: ['act'] }],
      limitations: [{ limitationId: 'limit-1', statement: 'I cannot browse without a grant.' }],
      durable: true,
      reason: null,
      world: {
        health: 'ready', reason: null, entities: 4, edges: 6, evidenceRecords: 9,
        withdrawn: 1, conflicts: 0, beliefs: 2, uncertainties: 1, withheld: 3, durable: true,
      },
      worldSelf: {
        source: 'world.self.status.read',
        assignedCapabilities: [{ capability: 'research', held: true }],
        knownSkills: [],
        models: [{ providerId: 'nano-gpt', kind: 'model', live: true }],
        workerClaims: [],
        separation: { freyaIsNotTheModel: true },
        readAt: '2026-10-09T00:00:00.000Z',
      },
    },
    missions: [{
      id: 'mission-1', status: 'active', priority: 'high', needsAttention: true, awaitingOwner: false,
      totalRuns: 4, verifiedRuns: 2, nextDecision: 'continue', nextReason: 'evidence-incomplete', blockers: [],
    }],
    missionsTotal: 1,
    missionsHidden: 0,
    owner: {
      personalityHealth: 'unavailable',
      personalityReason: 'the Personality domain has not reported',
      continuity: null, formality: null, temperament: [],
      relationshipItems: 0, admittedItems: 0, cuesAdmitted: 0, relationshipDurable: null,
      contextHealth: 'ready', contextReason: null,
      contextItems: 5, contextCurrent: 2, contextScopes: ['project'], contextUnresolvedReferences: 0, contextDurable: true,
    },
    uncertainties: [{ code: 'evidence-missing', subjectKind: 'belief', subjectId: 'belief-1', since: null }],
    uncertaintiesOmitted: 1,
    nextActions: [{ scope: 'work', subjectId: 'run-1', action: 'resume' }],
    recentChanges: [{ id: 'ev-1', kind: 'journal-repaired', sequence: 40, at: 1790956800000, tone: 'good' }],
    waiting: {
      pendingApprovals: 1,
      waitingRuns: [{ runId: 'run-2', status: 'waiting', waitingSince: null }],
      blockedAgents: [],
      unfulfilledPresenceRequests: 0,
    },
    provenance: {
      basis: 'live-projection', freshness: 'fresh', asOf: '2026-10-09T00:00:00.000Z',
      sources: [{ domain: 'attention', basis: 'mirror', freshness: 'fresh', durable: true, note: null }],
    },
    consciousHealth: 'degraded',
    consciousReason: 'the world model did not answer in time',
    absentSections: ['practice'],
  }
  return { ...base, ...overrides }
}

function snapshotWith(mind: Resource<MindView>): UiSnapshot {
  return { mind } as unknown as UiSnapshot
}

const live = (data: MindView): Resource<MindView> => ({ status: 'ready', source: 'live', data })

describe('Mind workspace — live projection', () => {
  it('renders Core-reported posture words and counts, and derives nothing extra', () => {
    render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(screen.getByText('working', { selector: '.f-badge' })).toBeInTheDocument()
    expect(screen.getByText('1 provider request executing right now.')).toBeInTheDocument()
    expect(screen.getByText('Governor').closest('.f-summary-line')?.textContent).toContain('ready')
    expect(screen.getByText('Grants held').closest('.f-summary-line')?.textContent).toContain('2')
    expect(screen.getByText('nano-gpt · model')).toBeInTheDocument()
  })

  it('says STOP ALL is latched before anything else can read as healthy', () => {
    const stopped = mindFixture()
    const overview = { ...stopped.overview, stopped: true, mode: 'stopped' as const, modeDetail: 'STOP ALL is latched.' }
    render(<Mind snapshot={snapshotWith(live({ ...stopped, overview }))} view={views.mind} update={update} />)
    expect(screen.getByText('latched')).toBeInTheDocument()
    expect(screen.getByText('stopped', { selector: '.f-badge' })).toBeInTheDocument()
  })

  it('reports an unavailable Attention domain with its reason instead of zeroes', () => {
    const attention = { ...mindFixture().attention, health: 'unavailable' as const, reason: 'the Attention domain is not reporting', counts: null }
    render(<Mind snapshot={snapshotWith(live(mindFixture({ attention })))} view={views.mind} update={update} />)
    expect(screen.getByText('No Attention domain is reporting')).toBeInTheDocument()
    expect(screen.getByText('the Attention domain is not reporting')).toBeInTheDocument()
    expect(screen.queryByText('Ingested')).not.toBeInTheDocument()
  })

  it('shows the withheld count rather than claiming Freya holds nothing private', () => {
    render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(screen.getByText('Withheld')).toBeInTheDocument()
    // 3 is the withheld count from the fixture; it must appear as itself.
    expect(screen.getAllByText('3').length).toBeGreaterThan(0)
  })

  it('marks a degraded conscious context without hiding what did arrive', () => {
    render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(screen.getByText('degraded', { selector: '.f-badge' })).toBeInTheDocument()
    expect(screen.getByText('the world model did not answer in time')).toBeInTheDocument()
    expect(screen.getByText('practice')).toBeInTheDocument()
  })

  it('names an absent section instead of drawing an empty list', () => {
    render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(screen.getByText('Not in this build')).toBeInTheDocument()
    expect(screen.getByText('practice')).toBeInTheDocument()
  })

  it('renders null usage as an em dash, never as a measured zero', () => {
    render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(/Token totals are a lower bound/)).toBeInTheDocument()
  })

  it('is read-only: the surface offers no control that could drive Core', () => {
    const { container } = render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('prints no percentage anywhere, because nothing in Core measures one', () => {
    const { container } = render(<Mind snapshot={snapshotWith(live(mindFixture()))} view={views.mind} update={update} />)
    expect(container.textContent ?? '').not.toMatch(/%/)
  })
})

describe('Mind workspace — resource states', () => {
  it('waits while the projection is loading', () => {
    render(<Mind snapshot={snapshotWith({ status: 'loading' })} view={views.mind} update={update} />)
    expect(screen.getByText('Waiting for Freya Core')).toBeInTheDocument()
  })

  it("reports unavailability with Core's own reason rather than an empty board", () => {
    render(<Mind snapshot={snapshotWith({ status: 'unavailable', reason: 'No Freya Core is reachable from this window.' })} view={views.mind} update={update} />)
    expect(screen.getByText('Mind is not reporting')).toBeInTheDocument()
    expect(screen.getByText('No Freya Core is reachable from this window.')).toBeInTheDocument()
  })

  it('labels a stale projection and still renders the data it holds', () => {
    const stale: Resource<MindView> = { status: 'stale', source: 'live', data: mindFixture(), reason: 'Core stopped pushing' }
    render(<Mind snapshot={snapshotWith(stale)} view={views.mind} update={update} />)
    expect(screen.getByText(/Stale projection — Core stopped pushing/)).toBeInTheDocument()
    expect(screen.getByText('nano-gpt · model')).toBeInTheDocument()
  })
})

describe('Mind workspace — design preview', () => {
  it("labels itself as a preview and shows the fixture's honest absences", () => {
    const preview = createPreviewAdapter().getSnapshot()
    render(<Mind snapshot={preview} view={views.mind} update={update} />)
    expect(screen.getByText('Design preview. No Core is projected in this window, so nothing here is live.')).toBeInTheDocument()
    expect(screen.getByText('Preview fixture. Nothing here is running.')).toBeInTheDocument()
    expect(screen.getByText('the Attention domain is not projected in a browser window', { exact: false })).toBeInTheDocument()
  })

  it('carries no fabricated trait, percentage or dated goal from the old concept art', () => {
    const preview = createPreviewAdapter().getSnapshot()
    const { container } = render(<Mind snapshot={preview} view={views.mind} update={update} />)
    const text = container.textContent ?? ''
    for (const lie of ['Curious', 'Empathetic', '72% complete', 'Launch Freya Phase 19', 'Mar 2025', 'You trust me']) {
      expect(text).not.toContain(lie)
    }
    expect(text).not.toMatch(/%/)
  })
})
