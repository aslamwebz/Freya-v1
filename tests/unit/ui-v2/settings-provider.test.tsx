import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Settings } from '../../../src/ui-v2/workspaces/Settings'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { createViews } from '../../../src/ui-v2/workspaces/viewState'

afterEach(cleanup)

describe('Settings provider', () => {
  it('renders the provider fields and labels preview data', () => {
    const snap = createPreviewAdapter().getSnapshot()
    render(<Settings snapshot={snap} view={createViews().settings} update={() => {}} />)
    expect(screen.getByLabelText(/base url/i)).toBeTruthy()
    expect(screen.getByLabelText(/model/i)).toBeTruthy()
    expect(screen.getByLabelText(/api key/i)).toBeTruthy()
    expect(screen.getByText(/sample provider configuration/i)).toBeInTheDocument()
  })
})
