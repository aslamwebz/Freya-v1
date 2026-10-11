import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Explorer } from '../../../src/app/explorer/Explorer'
import type { ExplorerSnapshot } from '../../../shared/contracts/explorer'
afterEach(cleanup)
const snapshot: ExplorerSnapshot = { generatedAt: new Date().toISOString(), source: 'test registry', limitations: [], nodes: [
  { id: 'a', name: 'Core', type: 'process', purpose: 'Admission', status: 'ready', process: 'Core', source: 'core/index.ts', updatedAt: null, version: null, actions: [] },
  { id: 'b', name: 'Vault', type: 'store', purpose: 'Encrypted persistence', status: 'active', process: 'Core', source: 'core/vault', updatedAt: null, version: null, actions: [] },
], edges: [{ id: 'ab', from: 'a', to: 'b', kind: 'architecture', label: 'requires' }] }
it('keeps selection across graph, table and details and filters the same records', () => {
  render(<Explorer snapshot={snapshot} />)
  // Selection must happen before SVG pointer capture retargets the later click.
  const graphNode = screen.getByRole('button', { name: 'Vault' })
  Object.defineProperty(graphNode.closest('svg')!, 'setPointerCapture', { value: () => {} })
  fireEvent.pointerDown(graphNode, { pointerId: 1, clientX: 100, clientY: 100 })
  const inspector = screen.getByRole('complementary', { name: 'Record inspector' })
  expect(within(inspector).getByRole('heading', { name: 'Vault' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Table' }))
  expect(screen.getAllByRole('row')).toHaveLength(3)
  expect(screen.getByRole('row', { name: /Vault store/ })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
  expect(within(inspector).getByRole('heading', { name: 'Vault' })).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search explorer' }), { target: { value: 'encrypted' } })
  fireEvent.click(screen.getByRole('tab', { name: 'Table' }))
  expect(screen.getAllByRole('row')).toHaveLength(2)
})
