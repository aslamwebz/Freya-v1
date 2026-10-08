import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThinkingSelector } from '../../../src/app/screens/ThinkingSelector'
import { ModelSelector } from '../../../src/app/screens/ModelSelector'
const api = vi.hoisted(() => ({ readModelCatalog: vi.fn(), selectModel: vi.fn() }))
const coreApi = vi.hoisted(() => ({ attach: vi.fn() }))
vi.mock('../../../src/platform/modelClient', () => api)
vi.mock('../../../src/platform/coreClient', () => ({ coreMirror: () => ({ subscribe: () => () => {} }), ensureCoreAttached: coreApi.attach }))
vi.mock('../../../src/platform/host', () => ({ hostBridge: () => undefined }))
beforeEach(() => {
  localStorage.clear()
  coreApi.attach.mockResolvedValue({ status: null })
  api.readModelCatalog.mockResolvedValue({ operation: 'catalog', defaultModel: 'MiniMax-M3', selected: null, models: [
    { id: 'MiniMax-M3', ownedBy: 'minimax', providerId: 'minimax' },
    { id: 'anthropic/claude', ownedBy: 'anthropic', providerId: 'nanogpt' },
    { id: 'small', ownedBy: 'local', providerId: 'local' },
    { id: 'small', ownedBy: 'openai', providerId: 'openai' },
  ] })
  api.selectModel.mockImplementation(async (selected, selectedProviderId) => ({ operation: 'selected', selected, selectedProviderId }))
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
describe('App Mode model picker', () => {
  it('reports the actual model selection from a degraded operational Core', async () => {
    coreApi.attach.mockResolvedValue({ status: { lifecycle: 'degraded', operational: true,
      modelSelection: { model: 'anthropic/claude', providerId: 'nanogpt', defaultModel: 'MiniMax-M3' } } })
    render(<ModelSelector defaultModel="MiniMax-M3" />)
    expect(await screen.findByText('claude')).toBeVisible()
    expect(api.readModelCatalog).not.toHaveBeenCalled()
  })

  it('keeps favorites visible while searching across provider names and model names', async () => {
    localStorage.setItem('freya.favoriteModels', JSON.stringify(['MiniMax-M3']))
    render(<ModelSelector defaultModel="MiniMax-M3" />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    await screen.findByRole('button', { name: 'claude NanoGPT' })
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'NanoGPT' } })
    expect(screen.getByRole('button', { name: 'MiniMax-M3 MiniMax' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'claude NanoGPT' }))
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledWith('anthropic/claude', 'nanogpt'))
  })
  it('keeps saved favorites visible and unavailable when refreshed provider discovery fails', async () => {
    localStorage.setItem('freya.favoriteModels', JSON.stringify(['nanogpt:anthropic/claude']))
    api.readModelCatalog.mockResolvedValue({ operation: 'catalog', models: [{ id: 'MiniMax-M3', ownedBy: 'minimax', providerId: 'minimax' }], reason: 'Model discovery unavailable for: nanogpt.' })
    render(<><ThinkingSelector /><ModelSelector defaultModel={null} /></>)
    expect(api.readModelCatalog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    // Reopening uses the session cache; explicit Refresh performs discovery.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh catalogue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalogue' }))
    const favorite = await screen.findByRole('button', { name: 'claude NanoGPT · unavailable' })
    expect(favorite).toBeDisabled()
    await screen.findByText('Model discovery unavailable for: nanogpt.')
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'MiniMax' } })
    expect(favorite).toBeVisible()
    expect(api.selectModel).not.toHaveBeenCalled()
  })
  it('distinguishes identical model names from separate providers and persists scoped favorites', async () => {
    render(<ModelSelector defaultModel={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh catalogue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalogue' }))
    await screen.findByRole('button', { name: 'small Local small model' })
    fireEvent.click(screen.getByRole('button', { name: 'Add small (Local small model) to favorites' }))
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'OpenAI' } })
    expect(screen.getByRole('button', { name: 'small Local small model' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'small OpenAI' }))
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledWith('small', 'openai'))
    expect(JSON.parse(localStorage.getItem('freya.favoriteModels')!)).toEqual(['local:small'])
  })
})
