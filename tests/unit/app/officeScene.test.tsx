import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { OfficeProjection, OfficeStation } from '../../../core/office/types'
import { ABSENT_OFFICE_PROJECTION } from '../../../core/office/projection'
import { OfficeRoom } from '../../../src/app/office/OfficeRoom'

afterEach(cleanup)

function station(id: string, kind: OfficeStation['kind'], state: OfficeStation['state']): OfficeStation {
  return {
    stationId: id, entityId: id, kind, zone: kind === 'freya' ? 'freya' : 'workforce', label: kind === 'freya' ? 'Freya' : 'Research agent', state,
    reason: state === 'blocked' ? 'suspended by the owner' : 'nothing is executing', position: { x: 24, y: 110 },
    detail: `${id} detail`, status: state, live: false, activeStepKey: null, openAssignments: 0, approval: null,
    counts: { stepsTotal: 0, stepsSettled: 0, stepsVerified: 0, stepsFailed: 0, actions: 0, attempts: 0 },
  }
}
function office(stations: readonly OfficeStation[] = []): OfficeProjection {
  return { ...ABSENT_OFFICE_PROJECTION, health: 'ready', reason: null, freya: station('freya', 'freya', 'idle'), stations,
    counts: { ...ABSENT_OFFICE_PROJECTION.counts, workforceStationsShown: stations.length, workers: stations.length }, sequence: 42 }
}

describe('the live Office scene', () => {
  it('distinguishes unavailable Office from an empty live room', () => {
    const view = render(<OfficeRoom projection={ABSENT_OFFICE_PROJECTION} />)
    expect(screen.getByText(/War Room scene not connected/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Inspect Freya/ })).toBeNull()
    view.rerender(<OfficeRoom projection={office()} />)
    expect(screen.getByText(/No agent workstations reported/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Inspect Freya/ })).toBeInTheDocument()
  })

  it('inspects only projected stations and clears removed agent details', () => {
    const worker = station('worker-7', 'worker', 'blocked')
    const view = render(<OfficeRoom projection={office([worker])} />)
    fireEvent.click(screen.getByRole('button', { name: /Inspect Research agent/ }))
    const details = screen.getByRole('region', { name: 'Station details' })
    expect(details).toHaveTextContent('worker-7 detail')
    expect(details).toHaveTextContent('blocked')
    view.rerender(<OfficeRoom projection={office()} />)
    expect(screen.getByRole('region', { name: 'Station details' })).not.toHaveTextContent('worker-7')
  })

  it('changes the view without changing reported agent state', () => {
    render(<OfficeRoom projection={office([station('worker-7', 'worker', 'blocked')])} />)
    const room = screen.getByRole('group', { name: 'War Room floor' })
    const initial = room.getAttribute('style')
    fireEvent.click(screen.getByRole('button', { name: 'Rotate War Room right' }))
    expect(room.getAttribute('style')).not.toBe(initial)
    expect(screen.getByRole('button', { name: /Inspect Research agent/ })).toHaveTextContent('blocked')
    fireEvent.click(screen.getByRole('button', { name: 'Reset War Room view' }))
    expect(room.getAttribute('style')).toBe(initial)
  })

  it('discloses stations omitted by the Core projection', () => {
    const projection = office()
    render(<OfficeRoom projection={{ ...projection, counts: { ...projection.counts, workforceStationsHidden: 3 } }} />)
    expect(screen.getByText(/3 additional stations are not shown/i)).toBeInTheDocument()
  })

  it('announces Freya’s locked state even when Core lifecycle is ready', () => {
    const projection = office()
    render(<OfficeRoom projection={{ ...projection, freya: { ...station('freya', 'freya', 'locked'), status: 'ready', reason: 'STOP ALL is latched' } }} />)
    expect(screen.getByRole('button', { name: /Inspect Freya.*locked/i })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Station details' })).toHaveTextContent('locked')
  })
})
