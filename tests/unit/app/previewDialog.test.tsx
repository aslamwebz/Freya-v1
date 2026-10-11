// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PreviewDialog } from '../../../src/app/chat/PreviewDialog'

afterEach(cleanup)

function SavedSearchPreview() {
  const [videoOpen, setVideoOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(true)
  return libraryOpen ? <PreviewDialog label="Saved searches" onClose={() => setLibraryOpen(false)}>
    <div>
      <button data-dialog-close onClick={() => setLibraryOpen(false)}>Close saved searches</button>
      <button onClick={() => setVideoOpen(true)}>Preview video</button>
      {videoOpen ? <PreviewDialog label="Video" onClose={() => setVideoOpen(false)}><button data-dialog-close onClick={() => setVideoOpen(false)}>Close video</button></PreviewDialog> : null}
    </div>
  </PreviewDialog> : null
}

it('closes only the top video preview on Escape and returns focus to its saved-search card', () => {
  render(<SavedSearchPreview />)
  const trigger = screen.getByRole('button', { name: 'Preview video' })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Close video' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Video' })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Saved searches' })).toBeInTheDocument()
  expect(trigger).toHaveFocus()
  fireEvent.keyDown(trigger, { key: 'Tab' })
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close saved searches' })).toHaveFocus()
})
