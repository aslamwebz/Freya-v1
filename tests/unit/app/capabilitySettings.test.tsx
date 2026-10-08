import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCapabilityRegistry } from '../../../core/capabilities'
import { CapabilityPanel } from '../../../src/app/screens/Settings'
const host = vi.hoisted(() => ({ getCapabilitySettings: vi.fn(), setCapabilitySettings: vi.fn() }))
vi.mock('../../../src/platform/host', () => ({ hostBridge: () => host }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
describe('host-backed capability settings', () => {
  it('reads persisted selection and applies a saved reorder', async () => {
    host.getCapabilitySettings.mockResolvedValue(buildCapabilityRegistry({ chat: ['nanogpt', 'minimax'] }))
    host.setCapabilitySettings.mockResolvedValue(buildCapabilityRegistry({ chat: ['minimax', 'nanogpt'] }))
    render(<CapabilityPanel />)
    const selector = screen.getByLabelText('Conversation brain preferred provider')
    await waitFor(() => expect(selector).toHaveValue('nanogpt'))
    fireEvent.click(screen.getByLabelText('Move MiniMax up for Conversation brain'))
    await waitFor(() => expect(host.setCapabilitySettings).toHaveBeenCalledWith({ chat: ['minimax', 'nanogpt'] }))
    await waitFor(() => expect(selector).toHaveValue('minimax'))
    expect(screen.getByRole('status')).toHaveTextContent('Preference saved')
  })
  it('exposes configured alternatives and preserves the last host state if persistence fails', async () => {
    host.getCapabilitySettings.mockResolvedValue(buildCapabilityRegistry({ chat: ['nanogpt', 'minimax'] }))
    host.setCapabilitySettings.mockRejectedValue(new Error('write refused'))
    render(<CapabilityPanel />)
    const selector = screen.getByLabelText('Conversation brain preferred provider')
    await waitFor(() => expect(selector).toHaveValue('nanogpt'))
    fireEvent.change(selector, { target: { value: 'openai' } })
    await waitFor(() => expect(host.setCapabilitySettings).toHaveBeenCalledWith({ chat: ['openai', 'nanogpt', 'minimax'] }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preference was not saved'))
    expect(selector).toHaveValue('nanogpt')
  })
})
