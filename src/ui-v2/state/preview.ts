import type { Resource, UiAdapter, UiSnapshot } from './contract'
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
      focus: { title: 'Product Roadmap — Phase 19', detail: 'Finalizing the workspace architecture, designs, and the next chapter.', progress: 72 },
      mission: 'Build a more abundant, connected, and fulfilling future.',
      goals: [{ id: 'beta', text: 'Advance Freya OS to global beta' }, { id: 'community', text: 'Grow an aligned user community' },
        { id: 'revenue', text: 'Build a sustainable revenue engine' }, { id: 'impact', text: 'Increase positive real-world impact' }],
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
    core: sample({ lifecycle: 'ready', sequence: 19, activeRequests: 0, stopped: false, integrity: 'ok', faultCount: 0 }),
    attention: sample({ focus: 'focused', ingested: 42, decisions: 18, cued: 12, spoke: 4, interrupted: 1, budgetExceeded: 0, inboxCount: 3 }),
    provider: sample({ connected: true, baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, detail: 'preview — sample provider configuration' }),
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
  })
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}
