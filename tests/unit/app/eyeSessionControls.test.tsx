import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EyeSessionControls } from '../../../src/app/chat/EyeSessionControls'
import { sharedDockedBrowserStore } from '../../../src/app/chat/BrowserWorkspace'
import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'
const api = vi.hoisted(() => ({ listSessions: vi.fn(async () => ({ operation: 'session-list', sessions: [{ sessionId: 'saved', subject: 'A saved collection', resultCount: 1, targetCount: 10, state: 'partial' }] })), readSession: vi.fn(), pauseSession: vi.fn(), cancelSession: vi.fn(), resumeSession: vi.fn(), collectSession: vi.fn() }))
vi.mock('../../../src/platform/researchClient', () => ({ researchMirror: () => api }))
const session: NonNullable<ResearchCommandOutcome['session']> = { sessionId: 'first', ownerText: '  find ten articles  ', state: 'active', intentVersion: 1, intent: { subject: 'articles', targetCount: 10, mediaType: 'web', constraints: [], exclusions: [], site: null }, page: 1, resultCount: 1, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', lastError: null, persistence: { durable: false, mode: 'ephemeral', reason: 'Ephemeral' }, results: [{ resultId: 'r1', url: 'https://example.org/article', title: 'Article', snippet: 'Retrieved article', sourceDomain: 'example.org', rank: 1, mediaType: 'web', confidence: 'probable', collection: 'Sources', providerId: 'brave' }] }
afterEach(() => { cleanup(); sharedDockedBrowserStore().reset(); vi.clearAllMocks() })
describe('Finder collections in Eye', () => {
  it('reads saved sessions and asks Core to pause, without inventing session state', async () => {
    const onChange = vi.fn()
    api.pauseSession.mockResolvedValue({ operation: 'session-paused', session: { ...session, state: 'paused' } })
    render(<EyeSessionControls view={{ mode: 'eye', outcome: { operation: 'session-read', session } }} onChange={onChange} />)
    await screen.findByRole('option', { name: /A saved collection/ })
    fireEvent.click(screen.getByRole('button', { name: 'Pause search' }))
    await waitFor(() => expect(api.pauseSession).toHaveBeenCalledWith('first'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ session: expect.objectContaining({ state: 'paused' }) }) })))
  })
  it('opens all retrieved findings with exact original request provenance', async () => {
    render(<EyeSessionControls view={{ mode: 'eye', outcome: { operation: 'session-read', session } }} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open all findings' }))
    expect(sharedDockedBrowserStore().activeTab()).toMatchObject({ url: 'https://example.org/article', origin: { from: 'eye', ownerText: '  find ten articles  ' } })
  })
  it('selects the saved session through Core, preserving its actual outcome', async () => {
    api.readSession.mockResolvedValue({ operation: 'session-read', session: { ...session, sessionId: 'saved', state: 'partial' } })
    const onChange = vi.fn()
    render(<EyeSessionControls view={{ mode: 'eye', outcome: { operation: 'session-read', session } }} onChange={onChange} />)
    await screen.findByRole('option', { name: /A saved collection/ })
    fireEvent.change(screen.getByLabelText('Eye session'), { target: { value: 'saved' } })
    await waitFor(() => expect(api.readSession).toHaveBeenCalledWith('saved'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ session: expect.objectContaining({ sessionId: 'saved' }) }) })))
  })
})
