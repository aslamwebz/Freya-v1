import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalComposer } from '../../../src/app/screens/GlobalComposer'

afterEach(cleanup)

function input(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Ask Freya' }) as HTMLInputElement
}

describe('GlobalComposer', () => {
  it('keeps the draft when Core does not accept the send', async () => {
    const onSend = vi.fn(async () => false)

    render(
      <GlobalComposer
        generating={false}
        notice=""
        defaultModel={null}
        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.change(input(), { target: { value: 'do not lose me' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Freya composer' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('do not lose me'))
    expect(input().value).toBe('do not lose me')
  })

  it('clears the draft only after Core accepts the send', async () => {
    const onSend = vi.fn(async () => true)

    render(
      <GlobalComposer
        generating={false}
        notice=""
        defaultModel={null}
        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.change(input(), { target: { value: 'hello freya' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Freya composer' }))

    await waitFor(() => expect(input().value).toBe(''))
    expect(onSend).toHaveBeenCalledWith('hello freya')
  })

  it('turns the send control into a real stop-response control while generating', () => {
    const onStopResponse = vi.fn()

    render(
      <GlobalComposer
        generating
        notice=""
        defaultModel={null}
        onSend={vi.fn(async () => true)}
        onStopResponse={onStopResponse}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }))
    expect(onStopResponse).toHaveBeenCalledTimes(1)
  })
})
