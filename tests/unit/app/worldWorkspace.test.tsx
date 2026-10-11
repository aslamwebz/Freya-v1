import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldWorkspace } from '../../../src/app/world/WorldWorkspace'
import { UnifiedWorkspace } from '../../../src/app/screens/UnifiedWorkspaces'
import { resolveRoute } from '../../../src/app/state/routes'
import { NO_CORE_SNAPSHOT, liveMind } from './mindFixtures'

afterEach(cleanup)
function Harness() {
  const [section, select] = useState('digest')
  return <WorldWorkspace section={section} onNavigate={path => select(resolveRoute(path).section)} />
}
describe('World news and research pages', () => {
  it('opens separate horizontal pages for digest, events, technology, research and setup', () => {
    render(<Harness />)
    const tabs = screen.getByRole('tablist', { name: 'World sections' })
    expect(tabs).toHaveAttribute('aria-orientation', 'horizontal')
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Daily digest', 'World events', 'Tech news', 'Product research', 'Sources & schedules'])
    for (const name of ['Daily digest', 'World events', 'Tech news', 'Product research', 'Sources & schedules']) {
      fireEvent.click(within(tabs).getByRole('tab', { name }))
      expect(screen.getByRole('tabpanel', { name })).toBeInTheDocument()
      expect(screen.getByText('Collection is off')).toBeInTheDocument()
    }
    expect(screen.queryByText(/entities|evidence records|connections/)).toBeNull()
  })
  it('exposes an owner-reviewed Goal draft, never a fake active schedule', () => {
    render(<WorldWorkspace section="sources" onNavigate={() => {} } />)
    expect(screen.getByRole('heading', { name: 'First Goal: Daily Digest' })).toBeInTheDocument()
    expect(screen.getByLabelText('Topics (comma separated)')).toBeInTheDocument()
    expect(screen.getByLabelText('Time zone')).toBeInTheDocument()
    expect(screen.getByText(/no recurring execution has been authorized/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create draft Goal in Core' })).toBeDisabled()
    expect(screen.queryByText(/next run|last updated/i)).toBeNull()
  })
  it('offers a working link from the digest empty state to its setup page', () => {
    render(<Harness />)
    expect(screen.getByText('No daily digest yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View sources & schedules' }))
    expect(screen.getByRole('tabpanel', { name: 'Sources & schedules' })).toBeInTheDocument()
  })
  it.each(['world', 'library/world'])('migrates %s to the news landing page', path => {
    expect(resolveRoute(path)).toEqual({ path: 'world/digest', destination: 'world', section: 'digest' })
  })
  it('keeps existing world knowledge counts under Library Knowledge without calling them news', () => {
    const mind = liveMind()
    const snapshot = { ...NO_CORE_SNAPSHOT, mind: { status: 'ready' as const, source: 'live' as const, data: {
      ...mind, self: { ...mind.self, world: { health: 'ready' as const, reason: null, entities: 12, edges: 4, evidenceRecords: 3, conflicts: 1, uncertainties: 2, withheld: 5, withdrawn: 0, beliefs: 0, durable: true } },
    } } }
    render(<UnifiedWorkspace path="library/knowledge" snapshot={snapshot} onNavigate={() => {}} />)
    expect(screen.getByRole('heading', { name: 'World knowledge' })).toBeInTheDocument()
    expect(screen.getByText(/12 entities/)).toBeInTheDocument()
    const tabs = screen.getByRole('tablist', { name: 'Library sections' })
    expect(within(tabs).queryByRole('tab', { name: 'World' })).toBeNull()
  })
})
