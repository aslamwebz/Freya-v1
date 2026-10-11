import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolInventory } from '../../../src/app/office/ToolInventory'
import { ABSENT_FORGE_PROJECTION, type ForgeProjection } from '../../../core/protocol/forge'

afterEach(() => { cleanup(); delete window.freyaHost })

it('lists Core tool metadata and does not submit or invoke tools', async () => {
  const submit = vi.fn()
  window.freyaHost = {
    coreTools: async () => ({ health: 'ready', reason: null, tools: [
      { name: 'search_web', description: 'Search the web using the configured source.', capability: 'search.web', parameters: [{ name: 'query', description: 'Search query', required: true }] },
      { name: 'make_chart', description: 'Draw a chart.', capability: 'artifact.create', parameters: [] },
    ] }),
    coreSubmit: submit,
  } as never
  render(<ToolInventory />)
  expect(await screen.findByRole('heading', { name: 'search_web' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'make_chart' })).toBeInTheDocument()
  expect(screen.getByText('query')).toBeInTheDocument()
  expect(screen.getByText(/2 registered tools/)).toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})

it('distinguishes an unavailable registry from an empty live catalogue', async () => {
  const view = render(<ToolInventory />)
  expect(await screen.findByText(/Tool catalogue not connected/)).toBeInTheDocument()
  view.unmount()
  window.freyaHost = { coreTools: async () => ({ health: 'ready', reason: null, tools: [] }) } as never
  render(<ToolInventory />)
  await waitFor(() => expect(screen.getByText('No conversation tools registered.')).toBeInTheDocument())
})

it('keeps a newer package push when a slower registry read completes', async () => {
  let finish!: (value: unknown) => void
  let push!: (value: ForgeProjection) => void
  const old: ForgeProjection = { ...ABSENT_FORGE_PROJECTION, health: 'ready', reason: null, sequence: 1 }
  const current: ForgeProjection = { ...old, sequence: 2, counts: { ...old.counts, packages: 1, enabled: 1 } }
  window.freyaHost = {
    coreTools: () => new Promise(resolve => { finish = resolve }),
    coreForge: async () => old,
    onCoreForge: (listener: typeof push) => { push = listener; return () => {} },
  } as never
  render(<ToolInventory />)
  act(() => push(current))
  expect(screen.getByText('1 packages recorded · 1 enabled')).toBeInTheDocument()
  await act(async () => finish({ health: 'ready', reason: null, tools: [] }))
  expect(screen.getByText('1 packages recorded · 1 enabled')).toBeInTheDocument()
})
