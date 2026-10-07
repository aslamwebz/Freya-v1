import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { App } from '../../../src/ui-v2/App'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import { WindowsStore } from '../../../src/ui-v2/windows/model'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { createLiveAdapter } from '../../../src/ui-v2/state/live'
import { uiMode, type Resource, type UiSnapshot } from '../../../src/ui-v2/state/contract'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import { resetMissionMirror } from '../../../src/platform/missionClient'
import { resetWorkforceMirror } from '../../../src/platform/workforceClient'
import { resetAttentionMirror } from '../../../src/platform/attentionClient'
import { World } from '../../../src/ui-v2/workspaces/World'
import { Life } from '../../../src/ui-v2/workspaces/Life'
import { Forge } from '../../../src/ui-v2/workspaces/Forge'
import { Relay } from '../../../src/ui-v2/workspaces/Relay'
import { Mind } from '../../../src/ui-v2/workspaces/Mind'
import { BrainCore } from '../../../src/ui-v2/workspaces/BrainCore'
import { createViews } from '../../../src/ui-v2/workspaces/viewState'

afterEach(cleanup)
afterEach(() => {
  resetCoreMirror(); resetMissionMirror(); resetWorkforceMirror(); resetAttentionMirror()
})

const preview = createPreviewAdapter().getSnapshot()

/**
 * A live snapshot: every resource is a live projection or an explicit unavailable.
 * No preview fixture is mixed in, which is what a real live adapter publishes.
 */
function liveSnapshot(overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  const live = <T,>(data: T): Resource<T> => ({ status: 'ready', source: 'live', data })
  return {
    home: live({ focus: { title: 'Freya Core is running', detail: 'Idle and listening.', progress: null }, mission: '3 Missions · 1 active', attention: { focused: null, caption: 'Core reports focused', categories: [], profiles: [] } }),
    core: live({ lifecycle: 'running', sequence: 42, activeRequests: 0, stopped: false, integrity: 'ok', faultCount: 0, operational: true, persistenceDurable: true, persistenceMode: 'durable', persistenceReason: null, diagnosticsPath: null, diagnosticsWriteFailures: 0, faults: [] }),
    mission: live({ rows: [{ id: 'mission-real-1', status: 'active', runs: 5, verifiedRuns: 3, needsAttention: true }], total: 1, hidden: 0, durable: true }),
    workforce: live({ rows: [{ id: 'worker-real-1', state: 'Researching', specialization: 'Research agent' }], total: 1, working: 1 }),
    activity: live([{ id: 'act-1', text: 'Core reported a verified outcome', at: 1790956800000, sequence: 42, tone: 'good' }]),
    attention: live({ focus: 'focused', ingested: 10, decisions: 4, cued: 2, spoke: 1, interrupted: 0, budgetExceeded: 0, inboxCount: 2 }),
    provider: live({ connected: true, baseUrl: 'https://nano-gpt.com/api/v1', model: 'openai/gpt-4.1-nano', liveEnabled: true, hasKey: true, credentialState: 'stored', credentialReason: null, endpointApproved: true, detail: 'connected' }),
    ...overrides,
  }
}

function renderWorkspace(component: React.ReactNode) {
  return render(<>{component}</>)
}

describe('uiMode provenance helper', () => {
  it('is preview only when every resource is a preview fixture', () => {
    expect(uiMode(preview)).toBe('preview')
  })
  it('is live when any resource is a live projection', () => {
    expect(uiMode(liveSnapshot())).toBe('live')
  })
  it('is live when a live Core has not reported (unavailable is still not preview)', () => {
    const absent = liveSnapshot({ home: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' } })
    expect(uiMode(absent)).toBe('live')
  })
})

describe('shell label', () => {
  function mountWith(snapshot: UiSnapshot) {
    const listeners = new Set<() => void>()
    render(<App preferences={new PreferencesStore()} windows={ new WindowsStore({ width: 1400, height: 800 })}
      adapter={{ getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }} />)
  }
  it('labels a preview window as design preview sample data', () => {
    mountWith(preview)
    expect(screen.getByText('Design preview · Sample data')).toBeInTheDocument()
    expect(screen.queryByText('Live · projected from Freya Core')).not.toBeInTheDocument()
  })
  it('labels a live window as Live without claiming the whole shell is projected from Core', () => {
    mountWith(liveSnapshot())
    // The shell must not overclaim: several workspaces are not wired, so the global
    // label cannot assert the entire window is a Core projection.
    expect(screen.getByText('Live', { selector: '.f-preview-label' })).toBeInTheDocument()
    expect(screen.queryByText('Live · projected from Freya Core')).not.toBeInTheDocument()
  })
})

describe('static workspaces in live mode', () => {
  const views = createViews()
  const update = () => {}
  it('World shows a pending state instead of sample entities', () => {
    renderWorkspace(<World snapshot={liveSnapshot()} view={views.world} update={update} />)
    expect(screen.getByText('World is not wired yet')).toBeInTheDocument()
    expect(screen.queryByText('Sarah Chen')).not.toBeInTheDocument()
  })
  it('Life shows a pending state instead of sample history', () => {
    renderWorkspace(<Life snapshot={liveSnapshot()} view={views.life} update={update} />)
    expect(screen.getByText('Life is not wired yet')).toBeInTheDocument()
    expect(screen.queryByText('A first conversation')).not.toBeInTheDocument()
  })
  it('Forge shows a pending state instead of sample creations', () => {
    renderWorkspace(<Forge snapshot={liveSnapshot()} view={views.forge} update={update} />)
    expect(screen.getByText('Forge is not wired yet')).toBeInTheDocument()
    expect(screen.queryByText('Market intelligence studio')).not.toBeInTheDocument()
  })
  it('Relay shows a pending state instead of sample conversations', () => {
    renderWorkspace(<Relay snapshot={liveSnapshot()} view={views.relay} update={update} />)
    expect(screen.getByText('Relay is not wired yet')).toBeInTheDocument()
    expect(screen.queryByText('Jordan Kim')).not.toBeInTheDocument()
  })
  it('Mind shows a pending state instead of sample context', () => {
    renderWorkspace(<Mind snapshot={liveSnapshot()} view={views.mind} update={update} />)
    expect(screen.getByText('Mind is not wired yet')).toBeInTheDocument()
    expect(screen.queryByText('Curious')).not.toBeInTheDocument()
  })
  it('keep the finished concept design in preview mode', () => {
    const { unmount } = renderWorkspace(<World snapshot={preview} view={views.world} update={update} />)
    expect(screen.getByText('Sarah Chen')).toBeInTheDocument()
    unmount()
    renderWorkspace(<Life snapshot={preview} view={views.life} update={update} />)
    expect(screen.getByText('A first conversation')).toBeInTheDocument()
  })
})

describe('Brain / Core stays separate from Adult Freya embodiment', () => {
  const views = createViews()
  it('shows no Freya portrait in a live window', () => {
    renderWorkspace(<BrainCore snapshot={liveSnapshot()} view={views['brain-core']} update={() => {}} />)
    expect(screen.queryByLabelText('Freya workspace identity')).not.toBeInTheDocument()
    expect(screen.getByText('Live telemetry')).toBeInTheDocument()
  })
  it('reports Memory as not wired rather than sample counts in a live window', () => {
    renderWorkspace(<BrainCore snapshot={liveSnapshot()} view={views['brain-core']} update={() => {}} />)
    expect(screen.getByText('Memory is not wired yet')).toBeInTheDocument()
    expect(screen.queryByText('1,247 stored')).not.toBeInTheDocument()
  })
  it('keeps the concept art in preview mode', () => {
    renderWorkspace(<BrainCore snapshot={preview} view={views['brain-core']} update={() => {}} />)
    expect(screen.getByText('1,247 stored')).toBeInTheDocument()
  })
})

describe('live adapter carries no fake figures', () => {
  it('reports no focus percentage (null, not 0)', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    const snapshot = adapter.getSnapshot()
    if (snapshot.home.status === 'ready') {
      expect(snapshot.home.data.attention.focused).toBeNull()
    }
    disposer()
  })
  it('never falls back to preview fixtures without a bridge', async () => {
    const adapter = createLiveAdapter()
    const disposer = await adapter.attach()
    for (const resource of Object.values(adapter.getSnapshot())) {
      expect(resource.status === 'ready' ? resource.source : 'not ready').not.toBe('preview')
    }
    disposer()
  })
})

describe('Home activity is not called memory in live mode', () => {
  it('labels the live activity feed as Recent activity', () => {
    const snapshot = liveSnapshot()
    const listeners = new Set<() => void>()
    render(<App preferences={new PreferencesStore()} windows={new WindowsStore({ width: 1400, height: 800 })}
      adapter={{ getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }} />)
    expect(screen.getByRole('region', { name: 'Recent activity' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Recent memory' })).not.toBeInTheDocument()
  })
  it('labels the preview feed as Recent memory', () => {
    const listeners = new Set<() => void>()
    render(<App preferences={new PreferencesStore()} windows={new WindowsStore({ width: 1400, height: 800 })}
      adapter={{ getSnapshot: () => preview, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }} />)
    expect(screen.getByRole('region', { name: 'Recent memory' })).toBeInTheDocument()
  })
})
