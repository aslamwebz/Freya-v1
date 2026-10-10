import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantMessageView } from '../../../src/app/chat/AssistantMessageView'
import { stepRecordsAsFooterLines } from '../../../src/app/chat/assistantParts'
import type { ToolStepRecord } from '../../../core/mind/tools'

afterEach(cleanup)
it('does not silently choose one URL for an ambiguous legacy citation rank', () => {
  render(<AssistantMessageView content="Fact [1]." onOpenLink={() => {}} sources={[
    { rank: 1, title: 'One', url: 'https://example.org/one', sourceDomain: 'example.org', snippet: 'One snippet', retrievedAt: null },
    { rank: 1, title: 'Two', url: 'https://example.org/two', sourceDomain: 'example.org', snippet: 'Two snippet', retrievedAt: null },
  ]} />)
  expect(screen.queryByRole('button', { name: /^Source 1:/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'One' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Two' })).toBeInTheDocument()
})
it('previews only typed source snippets, domains and their actual retrieval date', () => {
  render(<AssistantMessageView content="Finding [2]." sources={[
    { rank: 2, title: 'Actual page', url: 'https://example.org/page', sourceDomain: 'example.org', snippet: 'A bounded retrieved snippet.', retrievedAt: '2026-10-09T12:00:00Z' },
  ]} />)
  expect(screen.getByText('A bounded retrieved snippet.')).toBeInTheDocument()
  expect(screen.getByText('example.org')).toBeInTheDocument()
  expect(screen.getByText('Retrieved 2026-10-09')).toBeInTheDocument()
})
it('distinguishes empty search results from an actual failed or blocked search', () => {
  const { rerender } = render(<AssistantMessageView content="No result." steps={[{ index: 1, tool: 'web_search', capability: 'search.web', outcome: 'ok', executed: true, sourceCount: 0 }]} />)
  expect(screen.getByRole('status')).toHaveTextContent('The search returned no sources.')
  rerender(<AssistantMessageView content="Could not retrieve." steps={[{ index: 1, tool: 'web_search', capability: 'search.web', outcome: 'failed', executed: true, sourceCount: 0 }]} />)
  expect(screen.getByRole('status')).toHaveTextContent('Search failed')
  rerender(<AssistantMessageView content="Blocked." steps={[{ index: 1, tool: 'web_search', capability: 'search.web', outcome: 'denied', executed: false, sourceCount: 0 }]} />)
  expect(screen.getByRole('status')).toHaveTextContent('Search was blocked')
})
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

it('displays thinking scope word count in the reasoning summary', () => {
  render(<AssistantMessageView content="<think>First plan the steps and verify the facts.</think>\n\nFinal answer." />)
  expect(screen.getByText('Thinking')).toBeInTheDocument()
  expect(screen.getByText('8 words')).toBeInTheDocument()
  expect(screen.getByText(/Final answer\./)).toBeInTheDocument()
})

it('renders structured tool execution step cards with capabilities and outcomes', () => {
  const onOpenExecution = vi.fn()
  const steps: ToolStepRecord[] = [
    { index: 1, tool: 'web_search', capability: 'search.web', outcome: 'ok', executed: true, sourceCount: 3 },
    { index: 2, tool: 'browser_tabs', capability: 'browser.read', outcome: 'denied', executed: false, sourceCount: 0 },
  ]
  render(<AssistantMessageView content="Done." steps={steps} onOpenExecution={onOpenExecution} />)
  expect(screen.getByText('What Freya did for this answer')).toBeInTheDocument()
  expect(screen.getByText('web_search')).toBeInTheDocument()
  expect(screen.getByText('search.web')).toBeInTheDocument()
  expect(screen.getByText('browser_tabs')).toBeInTheDocument()
  expect(screen.getByText('browser.read')).toBeInTheDocument()
  expect(screen.getByText('Verified OK')).toBeInTheDocument()
  expect(screen.getByText('Blocked')).toBeInTheDocument()
  expect(screen.getByText('Refused')).toBeInTheDocument()

  const inspectBtn = screen.getByRole('button', { name: 'Inspect execution steps in right workspace' })
  fireEvent.click(inspectBtn)
  expect(onOpenExecution).toHaveBeenCalledTimes(1)
})

it('reports non-search tool failures and blocked operations accurately', () => {
  const failedSteps: ToolStepRecord[] = [
    { index: 1, tool: 'browser_tabs', capability: 'browser.read', outcome: 'failed', executed: true, sourceCount: 0 },
  ]
  const { rerender } = render(<AssistantMessageView content="Answer." steps={failedSteps} />)
  expect(screen.getByText('One or more tool operations failed during execution.')).toBeInTheDocument()

  const deniedSteps: ToolStepRecord[] = [
    { index: 1, tool: 'canvas_open', capability: 'work.execute', outcome: 'denied', executed: false, sourceCount: 0 },
  ]
  rerender(<AssistantMessageView content="Answer." steps={deniedSteps} />)
  expect(screen.getByText('One or more tool operations were blocked by Core Guard.')).toBeInTheDocument()
})

it('renders unclosed thinking block and preserves trailing truncation notice in message body', () => {
  const content = '<think>\nreasoning about timeline\n\n[Response safely preserved up to maximum message length]'
  render(<AssistantMessageView content={content} />)
  expect(screen.getByText('Thinking')).toBeInTheDocument()
  expect(screen.getByText(/reasoning about timeline/)).toBeInTheDocument()
  expect(screen.getByText('[Response safely preserved up to maximum message length]')).toBeInTheDocument()
  expect(screen.queryByText('Freya did not return a written answer for this turn.')).toBeNull()
})

