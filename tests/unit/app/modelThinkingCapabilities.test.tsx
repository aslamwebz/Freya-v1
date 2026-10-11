// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ThinkingSelector } from '../../../src/app/screens/ThinkingSelector'
const api = vi.hoisted(() => ({ readModelCatalog: vi.fn() }))
vi.mock('../../../src/platform/modelClient', () => api)
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })
it('uses only efforts reported by the selected model', async () => {
  api.readModelCatalog.mockResolvedValue({ operation: 'catalog', selected: 'test/model', models: [{ id: 'test/model', ownedBy: null, reasoningEfforts: ['low', 'xhigh'] }] })
  const change = vi.fn()
  render(<ThinkingSelector onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: /Thinking level:/ }))
  const effort = await screen.findByRole('menuitemradio', { name: 'xhigh' })
  expect(screen.queryByRole('menuitemradio', { name: /Deep|Balanced|Fast/ })).toBeNull()
  fireEvent.click(effort)
  expect(change).toHaveBeenCalledWith('xhigh')
})
it('does not guess support from a model name', async () => {
  api.readModelCatalog.mockResolvedValue({ operation: 'catalog', selected: 'gpt-5', models: [{ id: 'gpt-5', ownedBy: null }] })
  render(<ThinkingSelector />)
  fireEvent.click(screen.getByRole('button', { name: /Thinking level:/ }))
  await screen.findByText(/has not reported selectable thinking levels/)
  expect(screen.queryByRole('menuitemradio', { name: 'high' })).toBeNull()
})
