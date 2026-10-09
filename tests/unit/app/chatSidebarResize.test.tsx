import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ChatSidebarResize } from '../../../src/app/chat/ChatSidebarResize'

afterEach(cleanup)
function Sidebar({ max = 360 }: { max?: number }) {
  const [width, setWidth] = useState(216)
  return <ChatSidebarResize width={width} max={max} onChange={setWidth} />
}
it('resizes by keyboard and clamps to practical bounds', () => {
  render(<Sidebar />)
  const handle = screen.getByRole('separator', { name: 'Resize conversation sidebar' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle).toHaveAttribute('aria-valuenow', '232')
  fireEvent.keyDown(handle, { key: 'End' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle).toHaveAttribute('aria-valuenow', '360')
  fireEvent.keyDown(handle, { key: 'Home' })
  fireEvent.keyDown(handle, { key: 'ArrowLeft' })
  expect(handle).toHaveAttribute('aria-valuenow', '192')
})
it('keeps the sidebar within the available narrow-window width', () => {
  render(<Sidebar max={240} />)
  const handle = screen.getByRole('separator')
  fireEvent.keyDown(handle, { key: 'End' })
  expect(handle).toHaveAttribute('aria-valuenow', '240')
})
