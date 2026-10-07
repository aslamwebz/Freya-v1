import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RichMessage, parseRichBlocks } from '../../../src/app/chat/RichMessage'

afterEach(cleanup)

/**
 * jsdom does not implement `navigator.clipboard`. The copy handler in
 * `RichMessage` falls back to a textarea + `execCommand('copy')`, so this
 * stub gives jsdom enough to fake the clipboard write so the button's
 * post-click state can be observed.
 */
beforeEach(() => {
  const fakeClipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: fakeClipboard, configurable: true })
})

function clipboardSpy(): ReturnType<typeof vi.fn> {
  return (globalThis.navigator as unknown as { clipboard: { writeText: ReturnType<typeof vi.fn> } }).clipboard.writeText
}

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

  it('hides the copy affordance by default so the plain text path is zero-feature', () => {
    render(<RichMessage content={'```ts\nconst x = 1\n```'} />)
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('exposes a copy button per code block and changes label after copy', async () => {
    render(<RichMessage enableCodeCopy content={'```ts\nconst x = 1\n```'} />)
    const button = screen.getByRole('button', { name: /copy/i })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    // The clipboard write is async; wait for the label to settle.
    await screen.findByRole('button', { name: /copied/i })
    expect(clipboardSpy()).toHaveBeenCalledWith('const x = 1')
  })

  it('labels the code block with the language it was declared in', () => {
    render(<RichMessage enableCodeCopy content={'```python\nprint("hi")\n```'} />)
    expect(screen.getByText('python')).toBeTruthy()
  })

  it('collapses long answers behind a Show more toggle that reveals the rest', () => {
    // Three paragraphs is enough to trip the collapse: 2 visible, the rest hidden.
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${String(i + 1)}.`).join('\n\n')
    const { container } = render(<RichMessage collapseAbove={40} content={long} />)
    const toggle = screen.getByRole('button', { name: /show more/i })
    expect(toggle).toBeTruthy()
    expect(container.textContent).toContain('Paragraph 1.')
    expect(container.textContent).not.toContain('Paragraph 6.')

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /show less/i })).toBeTruthy()
    expect(container.textContent).toContain('Paragraph 6.')
  })

  it('does not collapse a streaming turn even when it would otherwise trip the threshold', () => {
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${String(i + 1)}.`).join('\n\n')
    const { container } = render(<RichMessage collapseAbove={40} streaming content={long} />)
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
    expect(container.textContent).toContain('Paragraph 6.')
  })

  it('shows a contents table only when there are two or more headings', () => {
    render(<RichMessage enableToc content={'# One\n\nbody\n'} />)
    expect(screen.queryByRole('group', { name: /jump to/i })).toBeNull()

    render(<RichMessage enableToc content={'# One\n\nbody\n\n## Two\n\nbody\n'} />)
    expect(screen.getAllByRole('button', { name: /jump to/i }).length).toBeGreaterThanOrEqual(2)
  })

  it('renders a provenance badge when counts are provided and stays silent otherwise', () => {
    const { rerender } = render(<RichMessage content="x" />)
    expect(screen.queryByLabelText(/provenance of this answer/i)).toBeNull()

    rerender(<RichMessage content="x" provenance={{ retrieved: 3, inferred: 1 }} />)
    const badge = screen.getByLabelText(/provenance of this answer/i)
    expect(badge.textContent).toContain('3')
    expect(badge.textContent).toContain('retrieved')
    expect(badge.textContent).toContain('inferred')
  })

  it('omits zero-count provenance entries so an empty source list is not advertised', () => {
    render(<RichMessage content="x" provenance={{ retrieved: 0, observed: 2 }} />)
    const badge = screen.getByLabelText(/provenance of this answer/i)
    expect(badge.textContent).not.toContain('retrieved')
    expect(badge.textContent).toContain('observed')
  })
})
