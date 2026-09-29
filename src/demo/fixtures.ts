/**
 * DEMO DATA — not live.
 *
 * Every value here is fictional and is rendered with a visible DEMO marker in
 * the shell. It exists so the command centre can be evaluated as an
 * information design. Nothing in this file is read by, or claims to be, a
 * real system.
 */

export interface FocusCard {
  title: string
  detail: string
  progress: number
  stats: { label: string; value: string }[]
}

export interface WorkRow {
  id: string
  title: string
  progress: number
  next: string
  due: string
}

export interface AttentionRow {
  id: string
  title: string
  detail: string
  due: string
  severity: 'critical' | 'decision'
}

export interface WorkforceRow {
  id: string
  name: string
  role: string
  status: 'working' | 'waiting' | 'idle'
}

export interface ActivityRow {
  id: string
  text: string
  ago: string
  tone: 'neutral' | 'good' | 'busy'
}

export interface Dashboard {
  demo: true
  focus: FocusCard
  work: WorkRow[]
  attention: AttentionRow[]
  workforce: WorkforceRow[]
  activity: ActivityRow[]
}

export function demoDashboard(): Dashboard {
  return {
    demo: true,
    focus: {
      title: 'Establish the Phase 1 execution model',
      detail:
        'Confirm that every kind of long work — chat, research, an agent, a swarm — converges on the same run structure.',
      progress: 34,
      stats: [
        { label: 'Next milestone', value: 'Run structure signed off' },
        { label: 'Target', value: 'Phase 1' },
        { label: 'Blocking', value: 'None' },
      ],
    },
    work: [
      {
        id: 'demo-w1',
        title: 'Surface manager hardening',
        progress: 72,
        next: 'Multi-monitor clamping',
        due: 'This week',
      },
      {
        id: 'demo-w2',
        title: 'Presence state rendering',
        progress: 45,
        next: 'Reduce idle cost further',
        due: 'This week',
      },
      {
        id: 'demo-w3',
        title: 'Vault storage contract',
        progress: 12,
        next: 'Phase 1 — not started',
        due: 'Not scheduled',
      },
    ],
    attention: [
      {
        id: 'demo-a1',
        title: 'Approve the local search scope',
        detail: 'Which roots the Searcher may read. Nothing is indexed yet.',
        due: 'Before Phase 1',
        severity: 'decision',
      },
      {
        id: 'demo-a2',
        title: 'Confirm the autonomy tier',
        detail: 'Freya currently holds no capabilities. This is a placeholder request.',
        due: 'Before Phase 1',
        severity: 'critical',
      },
    ],
    workforce: [
      { id: 'demo-wf1', name: 'Archivist', role: 'Search & retrieval', status: 'idle' },
      { id: 'demo-wf2', name: 'Smith', role: 'Build & verification', status: 'working' },
      { id: 'demo-wf3', name: 'Liaison', role: 'Relay & messaging', status: 'waiting' },
      { id: 'demo-wf4', name: 'Warden', role: 'Policy & safety', status: 'idle' },
    ],
    activity: [
      { id: 'demo-act1', text: 'Workspace layout restored from disk', ago: 'on launch', tone: 'good' },
      { id: 'demo-act2', text: 'Surface manager passed its unit suite', ago: 'on launch', tone: 'good' },
      { id: 'demo-act3', text: 'No cognition is running. Zero inference used.', ago: 'now', tone: 'neutral' },
    ],
  }
}
