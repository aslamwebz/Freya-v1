import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeDashboard } from '../../../src/app/screens/HomeDashboard'
import { DressingStore } from '../../../src/app/dressing/store'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import type { UiSnapshot } from '../../../src/ui-v2/state/contract'
import type { SettingsCategory } from '../../../src/app/screens/Settings'
import type { VoiceView } from '../../../src/app/voice/useVoiceDock'
import { resetConversationMirror } from '../../../src/platform/conversationClient'
import { sharedComposerDraftStore } from '../../../src/app/chat/composerDraftStore'
import { sharedRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'
import { NO_CORE_SNAPSHOT, liveMind } from './mindFixtures'

// WebGL requires a real graphics context. Navigation, screens and chat remain real.
vi.mock('../../../src/app/presence/LiveOrb', () => ({ LiveOrb: () => <div aria-label="Orb graphics" /> }))

afterEach(() => {
  cleanup()
  resetConversationMirror()
  sharedComposerDraftStore().reset()
  sharedRightWorkspaceStore().reset()
})

const voice: VoiceView = {
  state: 'unreachable', projection: null, interim: '', micEnabled: false,
  capturing: false, speaking: false, muted: false, notice: '', wakeArmed: false,
  unavailableReason: 'Voice not connected', voices: [], config: null, configBusy: false,
  capabilities: { capture: false, recognition: { available: false, local: false, detail: 'Not connected' } },
}

function Harness({ initial = 'home', snapshot = NO_CORE_SNAPSHOT }: { initial?: string; snapshot?: UiSnapshot }) {
  const [route, navigate] = useState(initial)
  const [category, setCategory] = useState<SettingsCategory>('appearance')
  const [dressing] = useState(() => new DressingStore())
  const [preferences] = useState(() => new PreferencesStore())
  const props = {
    screen: route, slotsByScreen: {}, snapshot, generating: false, notice: '',
    dressing, preferences, voice, voiceTranscript: null, settingsCategory: category,
    onSettingsCategory: setCategory, onOpenDressing: vi.fn(), onSend: async () => true,
    onStopResponse: vi.fn(), researchView: null, onResearchViewChange: vi.fn(),
    onNavigate: navigate, onVoicePress: vi.fn(), onVoiceRelease: vi.fn(),
    maxMessageCharacters: 8000, browserOpen: false, browserPercent: 62,
    onBrowserPercentChange: vi.fn(), browserRequestedUrl: null,
    onBrowserOpenUrl: vi.fn(), onBrowserRequestedUrlHandled: vi.fn(), onBrowserClose: vi.fn(),
  }
  return <HomeDashboard {...props} />
}

function primary(name: string) {
  const nav = screen.getByRole('navigation', { name: 'Primary' })
  return within(nav).getByRole('button', { name: name === 'Chats' ? /Open Chats|conversation list/ : name })
}

describe('the shipping six-destination app', () => {
  it('offers exactly the approved primary destinations and can open each', () => {
    render(<Harness />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(Array.from(nav.querySelectorAll('.hd-place, .chats-history-title'), node => node.textContent?.trim()))
      .toEqual(['Home', 'Chats', 'Missions', 'Library', 'Office', 'Settings'])
    for (const name of ['Missions', 'Library', 'Office', 'Settings', 'Chats', 'Home']) {
      fireEvent.click(primary(name))
      expect(primary(name)).toHaveAttribute('aria-current', 'page')
    }
    expect(screen.getByRole('region', { name: 'Freya containment dashboard' })).toBeInTheDocument()
    expect(screen.getByAltText(/Chibi Freya/)).toBeInTheDocument()
  })

  it('keeps chat draft and the eight-icon right rail across workspace changes', () => {
    render(<Harness initial="chat" />)
    const input = screen.getByRole('textbox', { name: 'Ask Freya' })
    fireEvent.change(input, { target: { value: 'Keep this thought' } })
    const rail = screen.getByRole('tablist', { name: /workspace/i })
    expect(within(rail).getAllByRole('tab')).toHaveLength(8)
    expect(within(rail).getByRole('tab', { name: /Browser/ })).toBeDisabled()
    fireEvent.click(primary('Missions'))
    fireEvent.click(primary('Chats'))
    expect(screen.getByRole('textbox', { name: 'Ask Freya' })).toHaveValue('Keep this thought')
    expect(within(screen.getByRole('tablist', { name: /workspace/i })).getAllByRole('tab')).toHaveLength(8)
  })

  it('returns to the last Library section when switching primary destinations', () => {
    render(<Harness initial="memory" />)
    fireEvent.click(primary('Chats'))
    fireEvent.click(primary('Library'))
    expect(screen.getByRole('tabpanel', { name: 'Memory' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true')
  })

  it('navigates all Mission contexts without showing invented records', () => {
    render(<Harness initial="missions" />)
    const tabs = screen.getByRole('tablist', { name: 'Missions sections' })
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Goals', 'Missions', 'Runs', 'Chats', 'Files', 'Heartbeat'])
    for (const name of ['Goals', 'Missions', 'Runs', 'Chats', 'Files', 'Heartbeat']) {
      fireEvent.click(within(tabs).getByRole('tab', { name }))
      const panel = screen.getByRole('tabpanel', { name })
      expect(panel).toHaveTextContent(/not connected/i)
      expect(within(tabs).getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    }
    expect(screen.queryByRole('button', { name: /Enable heartbeat/i })).toBeNull()
  })

  it('puts Focus and Memory inside Library Mind and supports keyboard tabs', () => {
    render(<Harness initial="mind" />)
    expect(primary('Library')).toHaveAttribute('aria-current', 'page')
    const tabs = screen.getByRole('tablist', { name: 'Library sections' })
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Mind', 'People', 'World', 'Files', 'Search'])
    const mindTabs = screen.getByRole('tablist', { name: 'Mind sections' })
    const overview = within(mindTabs).getByRole('tab', { name: 'Overview' })
    overview.focus()
    fireEvent.keyDown(overview, { key: 'ArrowRight' })
    expect(screen.getByRole('tabpanel', { name: 'Focus' })).toHaveTextContent(/not connected/i)
    expect(within(mindTabs).getByRole('tab', { name: 'Focus' })).toHaveFocus()
    fireEvent.keyDown(within(mindTabs).getByRole('tab', { name: 'Focus' }), { key: 'End' })
    expect(screen.getByRole('tabpanel', { name: 'Memory' })).toHaveTextContent(/not connected/i)
    for (const name of ['People', 'World', 'Files', 'Search']) {
      fireEvent.click(within(tabs).getByRole('tab', { name }))
      expect(screen.getByRole('tabpanel', { name })).toHaveTextContent(/not connected/i)
    }
  })

  it.each([
    ['focus', 'Library', 'Focus'], ['memory', 'Library', 'Memory'],
    ['people', 'Library', 'People'], ['world', 'Library', 'World'],
    ['life', 'Library', 'Memory'], ['workforce', 'Office', 'Agents'],
    ['work', 'Missions', 'Runs'], ['files', 'Library', 'Files'],
    ['library/search', 'Library', 'Search'], ['office/scene', 'Office', 'Office scene'],
  ])('resolves legacy or nested %s into %s / %s', (route, destination, section) => {
    render(<Harness initial={route} />)
    expect(primary(destination)).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('tabpanel', { name: section })).toBeInTheDocument()
  })

  it('routes Home mission and team shortcuts into their workspaces', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /View mission/ }))
    expect(primary('Missions')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(primary('Home'))
    fireEvent.click(screen.getByRole('button', { name: /View your team/ }))
    expect(primary('Office')).toHaveAttribute('aria-current', 'page')
  })

  it('shows real Mission and worker projections, preserving stale and unavailable states', () => {
    const snapshot: UiSnapshot = {
      ...NO_CORE_SNAPSHOT,
      mission: { status: 'stale', source: 'live', reason: 'Connection interrupted', data: {
        rows: [{ id: 'mission-from-core', status: 'active', runs: 2, verifiedRuns: 1, needsAttention: true }], total: 3, hidden: 2, durable: true,
      } },
      workforce: { status: 'ready', source: 'live', data: { rows: [{ id: 'worker-from-core', state: 'blocked', specialization: 'Research' }], total: 1, working: 0 } },
      mind: { status: 'ready', source: 'live', data: liveMind() },
    }
    render(<Harness initial="missions" snapshot={snapshot} />)
    expect(screen.getByRole('tabpanel', { name: 'Missions' })).toHaveTextContent('mission-from-core')
    expect(screen.getByRole('tabpanel', { name: 'Missions' })).toHaveTextContent('Connection interrupted')
    expect(screen.getByRole('tabpanel', { name: 'Missions' })).toHaveTextContent(/2.*not shown/i)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    expect(screen.getByRole('tabpanel', { name: 'Runs' })).toHaveTextContent('run-live-1')
    fireEvent.click(primary('Office'))
    expect(screen.getByRole('tabpanel', { name: 'Agents' })).toHaveTextContent('Research')
    expect(screen.getByRole('tabpanel', { name: 'Agents' })).toHaveTextContent('blocked')
  })

  it('treats an empty live list differently from a missing or preview source', () => {
    const snapshot: UiSnapshot = { ...NO_CORE_SNAPSHOT, mission: { status: 'ready', source: 'live', data: { rows: [], total: 0, hidden: 0, durable: true } } }
    const view = render(<Harness initial="missions" snapshot={snapshot} />)
    expect(screen.getByRole('tabpanel', { name: 'Missions' })).toHaveTextContent('No missions reported')
    view.rerender(<Harness initial="missions" snapshot={{ ...snapshot, mission: { status: 'ready', source: 'preview', data: { rows: [{ id: 'sample-mission', status: 'active', runs: 0, verifiedRuns: 0, needsAttention: false }], total: 1, hidden: 0, durable: false } } }} />)
    expect(screen.getByRole('tabpanel', { name: 'Missions' })).toHaveTextContent(/not connected/i)
    expect(screen.queryByText('sample-mission')).toBeNull()
  })

  it('keeps Advanced collapsed in Settings and relocates old tools there', () => {
    render(<Harness initial="settings" />)
    const disclosure = screen.getByText('Advanced').closest('details')
    expect(disclosure).not.toHaveAttribute('open')
    expect(screen.queryByRole('button', { name: 'Foundry' })).toBeNull()
    fireEvent.click(screen.getByText('Advanced'))
    // jsdom does not perform the native summary toggle.
    if (disclosure) { disclosure.open = true; fireEvent(disclosure, new Event('toggle')) }
    fireEvent.click(screen.getByRole('button', { name: 'Foundry' }))
    expect(primary('Settings')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Foundry' })).toBeInTheDocument()
    expect(screen.getByText(/Foundry.*not connected/i)).toBeInTheDocument()
  })

  it('shows unavailable memory sources without reporting them as empty', () => {
    const mind = liveMind()
    const snapshot: UiSnapshot = { ...NO_CORE_SNAPSHOT, mind: { status: 'ready', source: 'live', data: {
      ...mind, owner: { ...mind.owner, contextHealth: 'unavailable', contextReason: 'Context storage cannot be read', contextItems: 0,
        personalityHealth: 'unavailable', personalityReason: 'Relationship storage cannot be read', relationshipItems: 0 },
    } } }
    render(<Harness initial="memory" snapshot={snapshot} />)
    const panel = screen.getByRole('tabpanel', { name: 'Memory' })
    expect(panel).toHaveTextContent('Context storage cannot be read')
    expect(panel).toHaveTextContent('Relationship storage cannot be read')
    expect(panel).not.toHaveTextContent('0 context items')
    expect(panel).not.toHaveTextContent('0 relationship items')
  })

  it.each(['create', 'relay', 'settings/advanced/security', 'settings/advanced/context', 'settings/advanced/harness', 'settings/advanced/diagnostics'])('opens %s under Settings Advanced', (route) => {
    render(<Harness initial={route} />)
    expect(primary('Settings')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Advanced').closest('details')).toHaveAttribute('open')
  })

  it('does not report sample weather or a made-up build on the live Home', () => {
    render(<Harness />)
    expect(screen.getByText('Weather not connected')).toBeInTheDocument()
    expect(screen.queryByText(/London.*preview/)).toBeNull()
    expect(screen.queryByText(/Build 19\.0\.1/)).toBeNull()
  })
})
