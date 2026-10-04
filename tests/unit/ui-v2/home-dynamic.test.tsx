import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { App } from '../../../src/ui-v2/App'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import { WindowsStore } from '../../../src/ui-v2/windows/model'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import type { UiSnapshot } from '../../../src/ui-v2/state/contract'
afterEach(cleanup)
function mount() {
  let snapshot = createPreviewAdapter().getSnapshot()
  const listeners = new Set<() => void>()
  render(<App preferences={new PreferencesStore()} windows={new WindowsStore({ width: 1400, height: 800 })}
    adapter={{ getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }} />)
  return (patch: Partial<UiSnapshot>) => act(() => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()) })
}
describe('Home presentation state', () => {
  it('refreshes memories and workforce totals when the adapter publishes a new snapshot', () => {
    const publish = mount()
    publish({ activity: { status: 'ready', source: 'preview', data: [{ id: 'new', text: 'A new shared memory', at: Date.now(), sequence: 22, tone: 'good' }] },
      workforce: { status: 'ready', source: 'preview', data: { rows: [{ id: 'one', state: 'Planning', specialization: 'New preview team' }], total: 1, working: 1 } } })
    expect(within(screen.getByRole('region', { name: 'Recent memory' })).getByText('A new shared memory')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Workforce' })).getByText('1 in preview')).toBeInTheDocument()
    expect(screen.getByText('New preview team')).toBeInTheDocument()
  })
  it('changes the attention view when selecting a focus, leaving the Brain as the centre', () => {
    mount()
    const focus = screen.getByRole('region', { name: 'Current focus' })
    fireEvent.click(within(focus).getByRole('button', { name: 'Strategy' }))
    expect(within(focus).getByRole('button', { name: 'Strategy' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: 'Attention' })).toHaveTextContent('Strategic work')
    // The centre is the Brain (cognition), not a focus-driven presence portrait.
    expect(screen.getByRole('img', { name: /Freya cognition/ })).toBeInTheDocument()
  })
  it('shows unavailable activity instead of fabricated entries', () => {
    const publish = mount()
    // A live window reports Core activity, not autobiographical memory, so an
    // unavailable feed is labelled as activity and shows the reason Core gave.
    publish({
      home: { status: 'ready', source: 'live', data: { focus: null, mission: null, attention: { focused: null, caption: 'Core reports unknown', categories: [], profiles: [] } } },
      activity: { status: 'unavailable', reason: 'No activity available' },
    })
    expect(screen.getByRole('region', { name: 'Recent activity' })).toHaveTextContent('No activity available')
  })
  it('keeps the rest of Home visible when no focus profiles are configured', () => {
    const publish = mount(), home = createPreviewAdapter().getSnapshot().home
    if (home.status !== 'ready') throw new Error('Expected preview Home')
    publish({ home: { ...home, data: { ...home.data, attention: { ...home.data.attention, profiles: [] } } } })
    expect(screen.getByRole('region', { name: 'Mission' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Recent memory' })).toBeInTheDocument()
  })
  it('excludes obsolete goals from the completion count after a data refresh', () => {
    const publish = mount(), home = createPreviewAdapter().getSnapshot().home
    if (home.status !== 'ready') throw new Error('Expected preview Home')
    publish({ home: { ...home, data: { ...home.data, goals: [{ id: 'new', text: 'A new mission goal' }] } } })
    expect(screen.getByRole('region', { name: 'Mission' })).toHaveTextContent('0/1')
  })})
