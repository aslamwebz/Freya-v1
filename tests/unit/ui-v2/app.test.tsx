import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { App } from '../../../src/ui-v2/App'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import { WindowsStore } from '../../../src/ui-v2/windows/model'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
afterEach(cleanup)
function mount() {
  const preferences = new PreferencesStore()
  const windows = new WindowsStore({ width: 1200, height: 800 })
  render(<App preferences={preferences} windows={windows} adapter={createPreviewAdapter()} />)
  return { preferences, windows }
}
function navigate(name: string) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Freya workspaces' })).getByRole('button', { name }))
}
describe('fresh Freya website shell', () => {
  it('labels the sample data and exposes every workspace without contacting a backend', () => {
    mount()
    expect(screen.getByText('Design preview · Sample data')).toBeInTheDocument()
    for (const name of ['Mission', 'Forge', 'World', 'Life', 'Relay', 'Workforce', 'Widgets', 'Brain / Core']) {
      expect(within(screen.getByRole('navigation')).getByRole('button', { name })).toBeInTheDocument()
    }
  })
  it('customizes all three themes and resets appearance', () => {
    const { preferences } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dawn' } })
    expect(document.querySelector('.freya-v2')).toHaveAttribute('data-theme', 'dawn')
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'vessel' } })
    fireEvent.change(screen.getByLabelText('Density'), { target: { value: 'compact' } })
    expect(preferences.getSnapshot()).toMatchObject({ theme: 'vessel', density: 'compact' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }))
    expect(document.querySelector('.freya-v2')).toHaveAttribute('data-theme', 'abyss')
  })
  it('preserves a draft and selected workspace across App and immersive modes', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Ask Freya'), { target: { value: 'My next idea' } })
    navigate('Mission')
    fireEvent.click(screen.getByRole('button', { name: 'Immersive mode' }))
    expect(screen.getByRole('dialog', { name: 'Mission' })).toBeInTheDocument()
    expect(screen.getByLabelText('Ask Freya')).toHaveValue('My next idea')
    fireEvent.click(screen.getByRole('button', { name: 'App mode' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Mission' })).toBeInTheDocument()
    expect(screen.getByLabelText('Ask Freya')).toHaveValue('My next idea')
  })
  it('pins a window, moves and resizes with keyboard controls, and restores after minimizing', () => {
    const { windows } = mount()
    navigate('Mission')
    fireEvent.click(screen.getByRole('button', { name: 'Immersive mode' }))
    const dialog = screen.getByRole('dialog', { name: 'Mission' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pin Mission' }))
    expect(windows.getSnapshot().windows[0]?.pinned).toBe(true)
    const title = screen.getByLabelText('Move Mission')
    const previous = windows.boundsFor('mission')
    fireEvent.keyDown(title, { key: 'ArrowRight' })
    expect(windows.boundsFor('mission')?.x).toBe((previous?.x ?? 0) + 10)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize Mission' }), { key: 'ArrowDown' })
    expect(windows.boundsFor('mission')?.height).toBe((previous?.height ?? 0) + 10)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Minimize Mission' }))
    expect(screen.queryByRole('dialog', { name: 'Mission' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore Mission window' }))
    expect(screen.getByRole('dialog', { name: 'Mission' })).toBeInTheDocument()
  })
  it('filters conversations, pins a chat and preserves the reply draft across mode changes', () => {
    mount(); navigate('Relay')
    fireEvent.click(screen.getByRole('button', { name: 'Pin conversation with Jordan Kim' }))
    expect(screen.getByRole('button', { name: 'Unpin conversation with Jordan Kim' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Preview reply'), { target: { value: 'Draft for later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Immersive mode' }))
    expect(screen.getByLabelText('Preview reply')).toHaveValue('Draft for later')
  })
  it('explains that composing in the preview sends nothing', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Ask Freya'), { target: { value: 'Plan something' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Freya composer' }))
    expect(screen.getByRole('status')).toHaveTextContent('Preview only. Your message has not been sent.')
  })
  it('follows the focused immersive window when returning to App mode', () => {
    mount(); navigate('Mission')
    fireEvent.click(screen.getByRole('button', { name: 'Immersive mode' }))
    navigate('World')
    fireEvent.focus(screen.getByLabelText('Move Mission'))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mission')
    fireEvent.click(screen.getByRole('button', { name: 'App mode' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mission')
  })
  it('opens restored immersive layouts at their active workspace', () => {
    const preferences = new PreferencesStore(); preferences.update({ mode: 'immersive' })
    const windows = new WindowsStore({ width: 1200, height: 800 }); windows.open('relay')
    render(<App preferences={preferences} windows={windows} adapter={createPreviewAdapter()} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Relay')
  })
  it('keeps World list mode and its inspected connection independent', () => {
    mount(); navigate('World')
    fireEvent.click(screen.getByRole('button', { name: 'Show list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sarah Chen · People' }))
    expect(screen.getByRole('button', { name: 'Show graph' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sarah Chen' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show graph' }))
    expect(screen.getByRole('heading', { name: 'Sarah Chen' })).toBeInTheDocument()
  })
  it('keeps Relay drafts and preview replies inside their own conversation', () => {
    mount(); navigate('Relay')
    fireEvent.change(screen.getByLabelText('Preview reply'), { target: { value: 'Jordan draft' } })
    fireEvent.click(screen.getByRole('button', { name: /Design Studio.*Creative review tomorrow/ }))
    expect(screen.getByLabelText('Preview reply')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: /Jordan Kim.*Product launch alignment/ }))
    expect(screen.getByLabelText('Preview reply')).toHaveValue('Jordan draft')
    fireEvent.click(screen.getByRole('button', { name: 'Add preview reply' }))
    fireEvent.click(screen.getByRole('button', { name: /Design Studio.*Creative review tomorrow/ }))
    expect(screen.queryByText('Jordan draft')).not.toBeInTheDocument()
  })
  it('hides chosen Home panels and restores them when resetting appearance', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Focus' }))
    expect(screen.queryByRole('region', { name: 'Current focus' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }))
    expect(screen.getByRole('region', { name: 'Current focus' })).toBeInTheDocument()
  })
})
