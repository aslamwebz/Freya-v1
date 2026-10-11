import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UnifiedWorkspace } from '../../../src/app/screens/UnifiedWorkspaces'
import { PRIMARY_DESTINATIONS, resolveRoute } from '../../../src/app/state/routes'
import { NO_CORE_SNAPSHOT } from './mindFixtures'

afterEach(cleanup)

it('opens War Room on Agents and migrates old skills/tools shortcuts', () => {
  expect(PRIMARY_DESTINATIONS.find(([id]) => id === 'office')?.[1]).toBe('War Room')
  for (const path of ['office', 'war-room', 'workforce']) expect(resolveRoute(path).path).toBe('office/agents')
  for (const path of ['skills', 'settings/advanced/skills']) expect(resolveRoute(path).path).toBe('office/skills')
  for (const path of ['tools', 'war-room/tools']) expect(resolveRoute(path).path).toBe('office/tools')
})

it('shows Core names on agent cards, separately from their roles and IDs', () => {
  render(<UnifiedWorkspace path="office/agents" snapshot={{ ...NO_CORE_SNAPSHOT,
    workforce: { status: 'ready', source: 'live', data: { total: 3, working: 1, rows: [
      { id: 'worker-alpha', name: 'Alpha', state: 'working', specialization: 'Research' },
      { id: 'worker-beta', name: 'Beta', state: 'idle', specialization: 'Planning' },
      { id: 'worker-third', name: 'Archivist', state: 'blocked', specialization: null },
    ] } },
  }} onNavigate={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'War Room' })).toBeInTheDocument()
  const cards = screen.getAllByRole('article')
  expect(cards.map(card => within(card).getByRole('heading').textContent)).toEqual(['Alpha', 'Beta', 'Archivist'])
  expect(cards[0]).toHaveTextContent('working')
  expect(cards[0]).toHaveTextContent('Research')
  expect(cards[0]).toHaveTextContent('worker-alpha')
  expect(screen.getByRole('tablist', { name: 'War Room sections' })).toHaveAttribute('aria-orientation', 'horizontal')
})

it('shows Alpha and Beta slots without claiming missing workers exist or run', () => {
  render(<UnifiedWorkspace path="office/agents" snapshot={NO_CORE_SNAPSHOT} onNavigate={vi.fn()} />)
  for (const name of ['Alpha', 'Beta']) {
    const card = screen.getByRole('heading', { name }).closest('article')
    expect(card).toHaveTextContent('Not connected')
    expect(card).not.toHaveTextContent('working')
  }
})

it('shows the Skills catalogue inside War Room and navigates to Tools', () => {
  const navigate = vi.fn()
  render(<UnifiedWorkspace path="office/skills" snapshot={NO_CORE_SNAPSHOT} onNavigate={navigate} />)
  expect(screen.getByRole('tabpanel', { name: 'Skills' })).toHaveTextContent('Skills are not available')
  fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))
  expect(navigate).toHaveBeenCalledWith('office/tools')
})
