import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GoalRecords } from '../../../src/app/screens/GoalRecords'
import { MissionRecords } from '../../../src/app/screens/MissionRecords'
import { ABSENT_GOAL_PROJECTION } from '../../../core/protocol/longhorizon'
import { ABSENT_MISSION_PROJECTION } from '../../../core/missions/projection'
const bridge = vi.hoisted(() => ({ coreGoals: vi.fn(), coreMission: vi.fn(), coreSubmit: vi.fn() }))
vi.mock('../../../src/platform/host', () => ({ hostBridge: () => bridge }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Core record actions', () => {
  it('creates a Goal through Core and displays a refusal without claiming success', async () => {
    bridge.coreGoals.mockResolvedValue(ABSENT_GOAL_PROJECTION)
    bridge.coreSubmit.mockResolvedValue({ ok: false, goal: { ok: false, reason: 'No goal grant' } })
    render(<GoalRecords />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Goal' })).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Brush teeth' } })
    fireEvent.change(screen.getByLabelText('Goal description'), { target: { value: 'Daily habit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }))
    await waitFor(() => expect(bridge.coreSubmit).toHaveBeenCalledWith('goal.create', { title: 'Brush teeth', description: 'Daily habit', completionCriteria: [] }))
    expect(await screen.findByText('No goal grant')).toBeTruthy()
  })

  it('reads one Mission privately before editing and submits the saved text', async () => {
    bridge.coreMission.mockResolvedValue({ ...ABSENT_MISSION_PROJECTION, missions: [{ missionId: 'm-1', status: 'draft', availableActions: ['activate', 'cancel'], counts: { completed: 0 } }] })
    bridge.coreSubmit.mockImplementation(async (command: string) => command === 'mission.read'
      ? { ok: true, mission: { ok: true, detail: { content: { title: 'Old title', intent: 'Old intent', successCriteria: [] } } } }
      : { ok: true, mission: { ok: true, operation: 'updated' } })
    render(<MissionRecords />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Mission' }))
    await waitFor(() => expect(screen.getByLabelText('Mission title')).toHaveProperty('value', 'Old title'))
    fireEvent.change(screen.getByLabelText('Mission title'), { target: { value: 'Changed title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Mission' }))
    await waitFor(() => expect(bridge.coreSubmit).toHaveBeenCalledWith('mission.update', { missionId: 'm-1', title: 'Changed title', intent: 'Old intent', successCriteria: [] }))
  })
})
