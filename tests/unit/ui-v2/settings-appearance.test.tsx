import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Settings } from '../../../src/ui-v2/workspaces/Settings'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { createViews } from '../../../src/ui-v2/workspaces/viewState'

afterEach(cleanup)

function mount() {
  const preferences = new PreferencesStore()
  const snapshot = createPreviewAdapter().getSnapshot()
  render(<Settings snapshot={snapshot} view={createViews().settings} update={() => {}} preferences={preferences} />)
  return preferences
}

describe('Settings appearance', () => {
  it('offers exactly the three themes and writes a change to the store', () => {
    const preferences = mount()
    const theme = screen.getByLabelText('Theme')
    expect(within(theme).getAllByRole('option')).toHaveLength(4)
    fireEvent.change(theme, { target: { value: 'dawn' } })
    expect(preferences.getSnapshot().theme).toBe('dawn')
  })

  it('resets appearance to the defaults', () => {
    const preferences = mount()
    fireEvent.change(screen.getByLabelText('Density'), { target: { value: 'compact' } })
    expect(preferences.getSnapshot().density).toBe('compact')
    fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }))
    expect(preferences.getSnapshot()).toMatchObject({ theme: 'abyss', density: 'comfortable' })
  })

  it('renders without an appearance store (a bare component mount)', () => {
    const snapshot = createPreviewAdapter().getSnapshot()
    render(<Settings snapshot={snapshot} view={createViews().settings} update={() => {}} />)
    expect(screen.queryByLabelText('Theme')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/api key/i)).toBeTruthy()
  })
})
