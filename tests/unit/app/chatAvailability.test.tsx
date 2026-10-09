import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Chats } from '../../../src/app/chat/Chats'
import { resetConversationMirror } from '../../../src/platform/conversationClient'

afterEach(() => { cleanup(); resetConversationMirror() })
it('shows an unavailable conversation with retry instead of claiming readiness without Core', async () => {
  render(<Chats researchView={null} browserOpen={false} browserPercent={52} onBrowserPercentChange={() => {}} browserRequestedUrl={null} onBrowserOpenUrl={() => {}} onBrowserRequestedUrlHandled={() => {}} onBrowserClose={() => {}} />)
  await waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument())
  expect(screen.queryByText('Ready')).toBeNull()
  expect(screen.queryByText('Ready when you are.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Retry connection' })).toBeInTheDocument()
})
