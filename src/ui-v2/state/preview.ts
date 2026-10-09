import type { MindView, Resource, UiAdapter, UiSnapshot } from './contract'
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const sample = <T,>(data: T): Resource<T> => ({ status: 'ready', source: 'preview', data })
/** Static design fixtures only. Never connects, sends messages, or executes work. */
export function createPreviewAdapter(): UiAdapter {
  const snapshot: UiSnapshot = freeze({
    home: sample({
      focus: { title: 'Product Roadmap – Phase 19', detail: 'Finalizing the workspace architecture, designs, and the next chapter.', progress: 72 },
      mission: 'Build a more abundant, connected, and fulfilling future.',
      goals: [{ id: 'beta', text: 'Advance Freya OS to global beta' }, { id: 'community', text: 'Grow aligned user community' },
        { id: 'revenue', text: 'Build sustainable revenue engine' }, { id: 'impact', text: 'Increase real-world positive impact' }],
      attention: { focused: 88, caption: 'Focused and aligned', categories: ['Creative', 'Strategic', 'Communication', 'Operations', 'Misc'], profiles: [
        { id: 'Product', label: 'Deep Work', presence: 'attentive', focused: 88, distribution: [42, 28, 18, 8, 4] },
        { id: 'Strategy', label: 'Strategic work', presence: 'planning', focused: 84, distribution: [20, 52, 14, 10, 4] },
        { id: 'Launch', label: 'Creative work', presence: 'creating', focused: 91, distribution: [54, 14, 22, 6, 4] },
      ] },
      people: [{ id: 'sarah', name: 'Sarah Chen', avatar: 0 }, { id: 'alex', name: 'Alex Morgan', avatar: 1 },
        { id: 'elena', name: 'Elena Cruz', avatar: 2 }, { id: 'jordan', name: 'Jordan Kim', avatar: 3 }],
      morePeople: 3, messages: 3, followUps: 1, meetingPrep: 2,
      world: [{ id: 'tech', title: 'Global tech', detail: 'New ideas and perspectives across the world.', icon: 'core' },
        { id: 'markets', title: 'Markets', detail: 'Signals shaping the next opportunity.', icon: 'life' },
        { id: 'innovation', title: 'Innovation', detail: 'Breakthroughs worth understanding.', icon: 'create' },
        { id: 'opportunity', title: 'Opportunities', detail: 'New possibilities for connection.', icon: 'world' }],
    }),
    core: sample({ lifecycle: 'ready', sequence: 19, activeRequests: 0, stopped: false, integrity: 'ok', faultCount: 0, operational: true, persistenceDurable: true, persistenceMode: 'durable', persistenceReason: null, diagnosticsPath: null, diagnosticsWriteFailures: 0, faults: [], governorStatus: 'ready', grantsActive: 0 }),
    attention: sample({ focus: 'focused', ingested: 42, decisions: 18, cued: 12, spoke: 4, interrupted: 1, budgetExceeded: 0, inboxCount: 3 }),
    provider: sample({ connected: true, baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, credentialState: 'stored', credentialReason: null, endpointApproved: true, detail: 'preview — sample provider configuration' }),
    mission: sample({
      rows: [
        { id: 'mission-roadmap', status: 'active', runs: 8, verifiedRuns: 5, needsAttention: false },
        { id: 'mission-community', status: 'draft', runs: 3, verifiedRuns: 1, needsAttention: true },
        { id: 'mission-world', status: 'paused', runs: 4, verifiedRuns: 2, needsAttention: false },
      ],
      total: 3, hidden: 0, durable: false,
    }),
    workforce: sample({
      rows: [
        { id: 'alpha', state: 'Researching', specialization: 'Research agent' },
        { id: 'beta', state: 'Planning', specialization: 'Strategy agent' },
        { id: 'gamma', state: 'Creating', specialization: 'Content studio' },
        { id: 'delta', state: 'Reviewing', specialization: 'Operations agent' },
      ], total: 4, working: 3,
    }),
    activity: sample([
      { id: 'a1', text: 'Reviewed the product strategy', at: 1790956800000, sequence: 19, tone: 'good' },
      { id: 'a2', text: 'Prepared a workspace concept', at: 1790953200000, sequence: 18, tone: 'neutral' },
      { id: 'a4', text: 'Researched recent technology updates', at: 1790946000000, sequence: 16, tone: 'neutral' },
      { id: 'a5', text: 'Created visual concepts for the new workspace', at: 1790942400000, sequence: 15, tone: 'good' },
      { id: 'a3', text: 'Noted a new project connection', at: 1790949600000, sequence: 17, tone: 'good' },
    ]),
    /*
     * The Mind's design preview is built out of Core's own *absent* projections,
     * not out of invented ones.
     *
     * That is the deliberate difference between this fixture and the Home one
     * beside it. Home is a marketing composition whose whole job is to look like
     * something; the Mind is a control room whose whole job is to tell the truth
     * about what is running. A preview Mind filled with fabricated traits,
     * thoughts and goal dates would teach the exact lie the screen exists to
     * prevent — so the preview shows the *unavailable* states instead, which is
     * both what a browser actually has and the state a real window spends most
     * of its life in. The shell still announces `ui-mode="preview"` for it.
     */
    mind: sample(previewMind()),
  })
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

/** The Mind a browser sees: Core's own absences, assembled and labelled. */
function previewMind(): MindView {
  return {
    overview: {
      lifecycle: 'ready',
      operational: true,
      stopped: false,
      governorStatus: 'ready',
      grantsActive: 0,
      activeProviderCalls: 0,
      journalIntegrity: 'ok',
      persistenceMode: 'durable',
      persistenceReason: null,
      faults: [],
      sequence: 0,
      mode: 'idle',
      modeDetail: 'Preview fixture. Nothing here is running.',
      providers: [],
      sessionCalls: 0,
      sessionInputTokens: null,
      sessionOutputTokens: null,
      sessionUnknownUsageCalls: 0,
    },
    threads: [],
    attention: {
      health: 'unavailable',
      reason: 'preview: the Attention domain is not projected in a browser window',
      focus: 'unknown',
      counts: null,
      inboxCount: 0,
      lastDecision: null,
    },
    self: {
      name: null,
      role: null,
      purpose: null,
      claimCount: 0,
      complete: false,
      claims: [],
      capabilities: [],
      limitations: [],
      durable: false,
      reason: 'preview: the Brain is not projected in a browser window',
      world: null,
      worldSelf: null,
    },
    missions: [],
    missionsTotal: 0,
    missionsHidden: 0,
    owner: {
      personalityHealth: 'unavailable',
      personalityReason: 'preview: no Personality projection exists in a browser window',
      continuity: null,
      formality: null,
      temperament: [],
      relationshipItems: 0,
      admittedItems: 0,
      cuesAdmitted: 0,
      relationshipDurable: null,
      contextHealth: 'unavailable',
      contextReason: 'preview: no Context projection exists in a browser window',
      contextItems: 0,
      contextCurrent: 0,
      contextScopes: [],
      contextUnresolvedReferences: 0,
      contextDurable: null,
    },
    uncertainties: [],
    uncertaintiesOmitted: 0,
    nextActions: [],
    recentChanges: [],
    waiting: { pendingApprovals: 0, waitingRuns: [], blockedAgents: [], unfulfilledPresenceRequests: 0 },
    provenance: null,
    consciousHealth: 'unavailable',
    consciousReason: 'preview: no conscious context is projected in a browser window',
    absentSections: [
      'self', 'posture', 'focus', 'attention', 'waiting', 'agents', 'practice',
      'world', 'life', 'continuity', 'recent changes', 'uncertainty', 'next actions',
    ],
  }
}
