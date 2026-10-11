// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { ActivityFeed } from '../../../src/app/chat/ActivityFeed'
import { ensureActivityAttached, resetCoreMirror } from '../../../src/platform/coreClient'
import type { FreyaHostBridge } from '../../../src/platform/host'

afterEach(() => { cleanup(); resetCoreMirror(); delete window.freyaHost })

it('presents journalled activity in a table with status, event, and time columns', async () => {
  window.freyaHost = {
    isDesktop: true,
    onCoreActivity: () => () => {},
    coreActivity: async () => [{ id: 'event-1', sequence: 1, type: 'provider.request.started', kind: 'provider.started', tone: 'busy', at: Date.now(), text: 'Model request started.' }],
  } as unknown as FreyaHostBridge
  await ensureActivityAttached()
  render(<ActivityFeed active />)
  const table = screen.getByRole('table', { name: 'Activity during this turn' })
  expect(within(table).getAllByRole('columnheader').map((node) => node.textContent)).toEqual(['Status', 'Event', 'Time'])
  expect(within(table).getByRole('cell', { name: 'Model request started.' })).toBeInTheDocument()
  expect(within(table).getByRole('cell', { name: 'busy' })).toBeInTheDocument()
})
