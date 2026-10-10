import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MissionCard } from '../../../src/app/chat/MissionCard'

afterEach(cleanup)
const proposal = { goal: 'Compare models', scope: 'Read public sources', successCriteria: ['Retain evidence'] }

it('requires an explicit approval click and waits for authoritative Mission state', async () => {
  const decisions: string[] = []
  render(<MissionCard proposal={proposal} disabled={false} onDecision={async decision => { decisions.push(decision); return null }} />)
  expect(decisions).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Approve Mission' }))
  await waitFor(() => expect(decisions).toEqual(['approve']))
  expect(screen.queryByText('Mission active')).toBeNull()
})

it('shows durable steps, blockers and a paused Resume control', async () => {
  const decisions: string[] = []
  render(<MissionCard proposal={proposal} disabled={false} mission={{ proposalMessageId: 'proposal', missionId: 'mission', status: 'blocked', paused: true, steps: [{ stepId: 's1', intent: 'Read pricing', status: 'verified' }], blockers: ['step_failed'] }} onDecision={async decision => { decisions.push(decision); return null }} />)
  expect(screen.getByText('Read pricing — verified')).toBeDefined()
  expect(screen.getByText('Blocked: step_failed')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
  await waitFor(() => expect(decisions).toEqual(['resume']))
})

it('disables approval during STOP and displays Core refusal', async () => {
  const view = render(<MissionCard proposal={proposal} disabled={true} onDecision={async () => 'Permission withdrawn.'} />)
  expect((screen.getByRole('button', { name: 'Approve Mission' }) as HTMLButtonElement).disabled).toBe(true)
  view.rerender(<MissionCard proposal={proposal} disabled={false} onDecision={async () => 'Permission withdrawn.'} />)
  fireEvent.click(screen.getByRole('button', { name: 'Approve Mission' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Permission withdrawn.'))
})
