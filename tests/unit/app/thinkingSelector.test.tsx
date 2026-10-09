// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ThinkingSelector,
  THINKING_LEVEL_KEY,
} from '../../../src/app/screens/ThinkingSelector'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ThinkingSelector', () => {
  it('renders with default adaptive/auto level', () => {
    render(<ThinkingSelector />)
    const button = screen.getByRole('button', { name: /Thinking level:/ })
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('Auto')
  })

  it('opens menu and selects a new thinking level', () => {
    const onChange = vi.fn()
    render(<ThinkingSelector onChange={onChange} />)

    const button = screen.getByRole('button', { name: /Thinking level:/ })
    fireEvent.click(button)

    const deepOption = screen.getByRole('menuitemradio', { name: /Deep Extensive multi-step reasoning/ })
    expect(deepOption).toBeInTheDocument()

    fireEvent.click(deepOption)

    expect(onChange).toHaveBeenCalledWith('high')
    expect(localStorage.getItem(THINKING_LEVEL_KEY)).toBe('high')
    expect(button).toHaveTextContent('Deep')
  })

  it('respects controlled value prop', () => {
    const { rerender } = render(<ThinkingSelector value="minimal" />)
    const button = screen.getByRole('button', { name: /Thinking level:/ })
    expect(button).toHaveTextContent('Fast')

    rerender(<ThinkingSelector value="high" />)
    expect(button).toHaveTextContent('Deep')
  })
})
