import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ABSENT_OFFICE_PROJECTION, type OfficeProjection } from '../../core/office/projection'
import { OfficeSurface } from '../../src/ui/surfaces/OfficeSurface'
import { resetOfficeMirror } from '../../src/platform/officeClient'
import { resetWorkMirror } from '../../src/platform/workClient'

function projection(over: Partial<OfficeProjection> = {}): OfficeProjection {
  return {
    ...ABSENT_OFFICE_PROJECTION,
    health: 'ready',
    reason: null,
    freya: {
      stationId: 'freya',
      kind: 'freya',
      zone: 'freya',
      entityId: 'freya',
      label: 'Freya',
      state: 'idle',
      reason: 'nothing is executing',
      position: { x: 856, y: 262 },
      detail: 'Nothing is executing.',
      status: 'ready',
      counts: { stepsTotal: 0, stepsSettled: 0, stepsVerified: 0, stepsFailed: 0, actions: 0, attempts: 0 },
      live: false,
      activeStepKey: null,
      openAssignments: 0,
      approval: null,
    },
    stations: [],
    history: [],
    presenceRequests: [],
    counts: {
      runs: 0,
      runsLive: 0,
      workers: 0,
      workersByIdle: 0,
      workersWorking: 0,
      workersBlocked: 0,
      workersStopped: 0,
      workersRetired: 0,
      approvalsPending: 0,
      floorStationsShown: 0,
      floorStationsHidden: 0,
      workforceStationsShown: 0,
      workforceStationsHidden: 0,
      approvalStationsShown: 0,
      approvalStationsHidden: 0,
      historyShown: 0,
      historyHidden: 0,
    },
    sequence: 0,
    ...over,
  }
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreOffice: ReturnType<typeof vi.fn>
let coreWork: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetOfficeMirror()
  resetWorkMirror()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    office: { operation: 'presence-requested', ok: true, workerId: 'alpha' },
    work: { operation: 'run-cancelled', ok: true },
  }))
  coreOffice = vi.fn(async () => projection())
  coreWork = vi.fn(async () => null)
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreOffice: coreOffice as never,
    coreWork: coreWork as never,
    onCoreOffice: (() => () => {}) as never,
  } as never
})

afterEach(() => {
  resetOfficeMirror()
  resetWorkMirror()
  vi.restoreAllMocks()
})

describe('office surface', () => {
  it('renders the office floor with Freya’s station', async () => {
    render(<OfficeSurface />)
    expect(await screen.findByText('Freya')).toBeTruthy()
    expect(await screen.findByText('IDLE')).toBeTruthy()
  })

  it('renders a live run station', async () => {
    const proj = projection({
      stations: [
        {
          stationId: 'run:run-1',
          kind: 'run',
          zone: 'floor',
          entityId: 'run-1',
          label: 'deterministic',
          state: 'working',
          reason: 'a run is executing',
          position: { x: 380, y: 110 },
          detail: '1 of 2 steps verified, 1 remaining',
          status: 'running',
          counts: { stepsTotal: 2, stepsSettled: 1, stepsVerified: 1, stepsFailed: 0, actions: 1, attempts: 1 },
          live: true,
          activeStepKey: 'record',
          openAssignments: 0,
          approval: null,
        },
      ],
    })
    coreOffice.mockResolvedValue(proj)
    render(<OfficeSurface />)
    expect(await screen.findByText('deterministic')).toBeTruthy()
  })

  it('renders a worker station', async () => {
    const proj = projection({
      stations: [
        {
          stationId: 'worker:alpha',
          kind: 'worker',
          zone: 'workforce',
          entityId: 'alpha',
          label: 'Alpha',
          state: 'working',
          reason: 'a worker holds an open assignment',
          position: { x: 24, y: 110 },
          detail: '1 open assignment.',
          status: 'working',
          counts: { stepsTotal: 0, stepsSettled: 0, stepsVerified: 0, stepsFailed: 0, actions: 0, attempts: 0 },
          live: true,
          activeStepKey: null,
          openAssignments: 1,
          approval: null,
        },
      ],
    })
    coreOffice.mockResolvedValue(proj)
    render(<OfficeSurface />)
    expect(await screen.findByText('Alpha')).toBeTruthy()
  })

  it('opens a detail panel when a station is clicked', async () => {
    const proj = projection({
      stations: [
        {
          stationId: 'run:run-1',
          kind: 'run',
          zone: 'floor',
          entityId: 'run-1',
          label: 'deterministic',
          state: 'working',
          reason: 'a run is executing',
          position: { x: 380, y: 110 },
          detail: '1 of 2 steps verified, 1 remaining',
          status: 'running',
          counts: { stepsTotal: 2, stepsSettled: 1, stepsVerified: 1, stepsFailed: 0, actions: 1, attempts: 1 },
          live: true,
          activeStepKey: 'record',
          openAssignments: 0,
          approval: null,
        },
      ],
    })
    coreOffice.mockResolvedValue(proj)
    render(<OfficeSurface />)
    fireEvent.click(await screen.findByText('deterministic'))
    expect(await screen.findByText('Progress')).toBeTruthy()
  })

  it('cancels a run through the authorized work command', async () => {
    const proj = projection({
      stations: [
        {
          stationId: 'run:run-1',
          kind: 'run',
          zone: 'floor',
          entityId: 'run-1',
          label: 'deterministic',
          state: 'working',
          reason: 'a run is executing',
          position: { x: 380, y: 110 },
          detail: '1 of 2 steps verified, 1 remaining',
          status: 'running',
          counts: { stepsTotal: 2, stepsSettled: 1, stepsVerified: 1, stepsFailed: 0, actions: 1, attempts: 1 },
          live: true,
          activeStepKey: 'record',
          openAssignments: 0,
          approval: null,
        },
      ],
    })
    coreOffice.mockResolvedValue(proj)
    render(<OfficeSurface />)
    const stations = await screen.findAllByText('deterministic')
    fireEvent.click(stations[0]!)
    fireEvent.click(await screen.findByText('Cancel'))
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('work.run.cancel', expect.objectContaining({ runId: 'run-1' }))
    })
  })

  it('requests presence through the bounded office command', async () => {
    const proj = projection({
      stations: [
        {
          stationId: 'worker:alpha',
          kind: 'worker',
          zone: 'workforce',
          entityId: 'alpha',
          label: 'Alpha',
          state: 'working',
          reason: 'a worker holds an open assignment',
          position: { x: 24, y: 110 },
          detail: '1 open assignment.',
          status: 'working',
          counts: { stepsTotal: 0, stepsSettled: 0, stepsVerified: 0, stepsFailed: 0, actions: 0, attempts: 0 },
          live: true,
          activeStepKey: null,
          openAssignments: 1,
          approval: null,
        },
      ],
    })
    coreOffice.mockResolvedValue(proj)
    render(<OfficeSurface />)
    fireEvent.click(await screen.findByText('Alpha'))
    fireEvent.click(await screen.findByText('Request presence'))
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('office.presence.request', { workerId: 'alpha' })
    })
  })

  it('renders history entries', async () => {
    const proj = projection({
      history: [
        {
          entryId: 'history:run-1',
          runId: 'run-1',
          kind: 'deterministic',
          status: 'completed',
          createdAt: '2026-10-02T12:00:00.000Z',
          settledAt: '2026-10-02T12:00:01.000Z',
          stepsTotal: 2,
          stepsVerified: 2,
          stepsFailed: 0,
          sequence: 5,
        },
      ],
    })
    coreOffice.mockResolvedValue(proj)
    render(<OfficeSurface />)
    expect(await screen.findByText('completed')).toBeTruthy()
  })

  it('shows an absent message when Core has not reported', async () => {
    coreOffice.mockResolvedValue(null)
    render(<OfficeSurface />)
    expect(await screen.findByText(/Waiting for Freya Core/)).toBeTruthy()
  })
})
