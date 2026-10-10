import { afterEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

const loaded = vi.hoisted(() => vi.fn())
vi.mock('../../../src/app/entry', () => { loaded(); return {} })

afterEach(() => window.history.replaceState(null, '', '/'))

it('opens the shipping app even when a saved URL requests the retired v2 UI', async () => {
  window.history.replaceState(null, '', '/?ui=v2')
  await import('../../../src/main')
  await waitFor(() => expect(loaded).toHaveBeenCalled())
})
