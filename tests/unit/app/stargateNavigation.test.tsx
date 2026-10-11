import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fireFreyaComponents, StargateHub } from '../../../src/app/presence/StargateHub'

vi.mock('../../../src/app/presence/LiveOrb', () => ({ LiveOrb: () => <div aria-label="Orb graphics" /> }))
afterEach(cleanup)
const targets = [
  ['Mind', 'mind/overview'], ['Focus & Attention', 'mind/focus'], ['Library', 'library/knowledge'],
  ['War Room', 'office/agents'], ['World', 'world/digest'], ['Memory', 'mind/memory'],
  ['Workflows', 'workflows/tasks'], ['Settings', 'settings/appearance'], ['Chats', 'chat'], ['Missions', 'missions/missions'],
] as const

it('uses ten current page or section shortcuts with canonical routes', () => {
  const navigate = vi.fn()
  render(<StargateHub state="calm" energy={0} onNavigate={navigate} />)
  expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(targets.map(([label]) => `Open ${label}`))
  for (const [label, route] of targets) {
    fireEvent.click(screen.getByRole('button', { name: `Open ${label}` }))
    expect(navigate).toHaveBeenLastCalledWith(route)
  }
  expect(screen.queryByRole('button', { name: 'Open Life' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open Relay' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open Foundry' })).toBeNull()
})

it('preserves Enter and Space activation of current shortcuts', () => {
  const navigate = vi.fn()
  render(<StargateHub state="calm" energy={0} onNavigate={navigate} />)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Open Chats' }), { key: 'Enter' })
  expect(navigate).toHaveBeenLastCalledWith('chat')
  fireEvent.keyDown(screen.getByRole('button', { name: 'Open Memory' }), { key: ' ' })
  expect(navigate).toHaveBeenLastCalledWith('mind/memory')
})

it('maps legacy component-fire signals to the renamed gate targets without navigating', () => {
  const navigate = vi.fn()
  render(<StargateHub state="calm" energy={0} onNavigate={navigate} />)
  act(() => fireFreyaComponents(['mission', 'workforce', 'life', 'foundry', 'relay', 'people']))
  for (const label of ['Missions', 'War Room', 'Workflows', 'Settings', 'Chats', 'Library']) {
    expect(screen.getByRole('button', { name: `Open ${label}` })).toHaveAttribute('data-hot', 'true')
  }
  expect(navigate).not.toHaveBeenCalled()
})

it('highlights current execution pages for the delegating state', () => {
  render(<StargateHub state="delegating" energy={1} onNavigate={vi.fn()} />)
  for (const label of ['War Room', 'Workflows', 'Missions']) expect(screen.getByRole('button', { name: `Open ${label}` })).toHaveAttribute('data-hot', 'true')
})
