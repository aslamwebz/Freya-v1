import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichMessage, parseRichBlocks } from '../../../src/app/chat/RichMessage'

afterEach(cleanup)

describe('RichMessage', () => {
  it('renders the supported rich subset as real nodes without interpreting HTML', () => {
    render(<RichMessage content={'# Heading\n\n**bold** and `code`\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>danger()</script>'} />)

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('<script>danger()</script>')).toBeTruthy()
  })

  it('keeps web links inside the Freya action seam', () => {
    const open = vi.fn()
    const { rerender } = render(<RichMessage content="[Docs](https://example.com/path)" />)

    const disabled = screen.getByRole('button', { name: 'Docs' })
    expect(disabled).toBeDisabled()

    rerender(<RichMessage content="[Docs](https://example.com/path)" onOpenLink={open} />)
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))
    expect(open).toHaveBeenCalledWith('https://example.com/path')
  })

  it('does not turn non-web schemes into clickable actions', () => {
    render(<RichMessage content="[bad](javascript:alert(1))" />)
    expect(screen.queryByRole('button', { name: 'bad' })).toBeNull()
    expect(screen.getByText('[bad](javascript:alert(1))')).toBeTruthy()
  })

  it('keeps fenced code verbatim', () => {
    const blocks = parseRichBlocks('```ts\nconst x = "<tag>"\n```')
    expect(blocks).toEqual([{ kind: 'code', language: 'ts', text: 'const x = "<tag>"' }])
  })
})
