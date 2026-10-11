// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ThinkingSelector, THINKING_LEVEL_KEY } from '../../../src/app/screens/ThinkingSelector'
const api = vi.hoisted(() => ({ readModelCatalog: vi.fn() }))
vi.mock('../../../src/platform/modelClient', () => api)
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })
it('uses provider default until capabilities are read', () => {
  render(<ThinkingSelector value="minimal" />)
  expect(screen.getByRole('button', { name: /Thinking level:/ })).toHaveTextContent('Provider default')
  expect(api.readModelCatalog).not.toHaveBeenCalled()
})
it('clears a stale effort without closing the capabilities menu', async () => {
  api.readModelCatalog.mockResolvedValue({ operation: 'catalog', selected: 'model', models: [{ id: 'model', ownedBy: null }] })
  const change = vi.fn()
  render(<ThinkingSelector value="high" onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: /Thinking level:/ }))
  await screen.findByText(/has not reported selectable thinking levels/)
  expect(change).toHaveBeenCalledWith('auto')
  expect(localStorage.getItem(THINKING_LEVEL_KEY)).toBe('auto')
})
it('shows a controlled effort only after the model reports support', async () => {
  api.readModelCatalog.mockResolvedValue({ operation: 'catalog', selected: 'model', models: [{ id: 'model', ownedBy: null, reasoningEfforts: ['high'] }] })
  render(<ThinkingSelector value="high" />)
  fireEvent.click(screen.getByRole('button', { name: /Thinking level:/ }))
  await screen.findByRole('menuitemradio', { name: 'high' })
  expect(screen.getByRole('button', { name: /Thinking level:/ })).toHaveTextContent('high')
})
