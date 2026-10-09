import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CoreHealth } from '../../../src/app/screens/CoreHealth'
import type { CoreView } from '../../../src/ui-v2/state/contract'

afterEach(cleanup)
const core: CoreView = { lifecycle: 'degraded', operational: true, sequence: 5, activeRequests: 0,
  stopped: false, integrity: 'ok', faultCount: 2, persistenceDurable: false, persistenceMode: 'ephemeral-fallback',
  persistenceReason: 'disk unavailable', diagnosticsPath: 'runtime.jsonl', faults: ['disk unavailable', 'Brain damaged'],
  diagnosticsWriteFailures: 1, governorStatus: 'unknown', grantsActive: 0 }

it('shows temporary event history and every fault without marking Core offline', () => {
  render(<CoreHealth core={core} />)
  fireEvent.click(screen.getByText('TEMPORARY'))
  expect(screen.getByText(/Core is operational/)).toBeVisible()
  expect(screen.getByText(/Event history for this session will not survive a restart/)).toBeVisible()
  expect(screen.getByText('disk unavailable')).toBeVisible()
  expect(screen.getByText('Brain damaged')).toBeVisible()
  expect(screen.getByText(/runtime.jsonl/)).toBeVisible()
  expect(screen.getByText(/1 diagnostics write/)).toBeVisible()
})

it('shows degraded health for a usable Core with durable persistence', () => {
  render(<CoreHealth core={{ ...core, persistenceDurable: true }} />)
  expect(screen.getByText('DEGRADED')).toBeVisible()
  expect(screen.queryByText('TEMPORARY')).not.toBeInTheDocument()
})
