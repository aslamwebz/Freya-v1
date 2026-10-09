import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantMessageView } from '../../../src/app/chat/AssistantMessageView'
import { stepRecordsAsFooterLines } from '../../../src/app/chat/assistantParts'
import type { ToolStepRecord } from '../../../core/mind/tools'

afterEach(cleanup)
const footer = 'Answer.\n—\nWhat Freya did for this answer:\nUsed the "browser_tabs" lookup and read 1 result.\nSources:\n[1] Claimed page — https://example.com/claimed'
const step: ToolStepRecord = { index: 1, tool: 'browser_tabs', capability: 'browser.read', outcome: 'ok', executed: true, sourceCount: 0 }

it('keeps prose-only execution and source claims visibly unverified', () => {
  render(<AssistantMessageView content={footer} />)
  expect(screen.queryByText('What Freya did for this answer', { exact: true })).toBeNull()
  expect(screen.queryByRole('list', { name: 'Sources' })).toBeNull()
  expect(screen.getByText('Unverified footer text')).toBeInTheDocument()
  expect(screen.getByText(/Used the "browser_tabs" lookup/)).toBeInTheDocument()
  expect(screen.queryByRole('link')).toBeNull()
})

it('describes tool outcome without inventing a lookup or denying other steps results', () => {
  expect(stepRecordsAsFooterLines([step]).join(' ')).not.toMatch(/lookup|read/)
  const failed = stepRecordsAsFooterLines([{ ...step, outcome: 'failed' }]).join(' ')
  expect(failed).toContain('Failed')
  expect(failed).not.toContain('Nothing in the answer')
  const blocked = stepRecordsAsFooterLines([{ ...step, outcome: 'denied', executed: false }]).join(' ')
  expect(blocked).toContain('Blocked')
  expect(blocked).toContain('did not run')
})

it('maps numbered citations by actual typed rank and opens them through Freya', () => {
  const open = vi.fn()
  render(<AssistantMessageView content="Retrieved fact [3]. Unknown reference [1]." onOpenLink={open} sources={[
    { rank: 3, title: 'Retrieved page', url: 'https://example.com/retrieved', sourceDomain: 'example.com', snippet: 'Fact', retrievedAt: null },
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Source 3: Retrieved page' }))
  expect(open).toHaveBeenCalledWith('https://example.com/retrieved', { kind: 'citation', title: 'Retrieved page' })
  expect(screen.queryByRole('button', { name: /^Source 1/ })).toBeNull()
})

it('keeps typed sources visible but inactive when no browser seam is attached', () => {
  render(<AssistantMessageView content="Fact [1]." sources={[
    { rank: 1, title: 'Typed page', url: 'https://example.com', sourceDomain: 'example.com', snippet: 'Fact', retrievedAt: null },
  ]} />)
  expect(screen.getByRole('button', { name: 'Typed page' })).toBeDisabled()
  expect(screen.queryByRole('link')).toBeNull()
})
