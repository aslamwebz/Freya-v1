// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModeSelector } from '../../../src/app/screens/ModeSelector'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('composer mode menu', () => {
  it('stays within a narrow viewport when opened beside attachments', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.tagName === 'UL'
        ? { x: 0, y: 0, left: 0, top: 0, right: 340, bottom: 200, width: 340, height: 200 }
        : { x: 5, y: 210, left: 5, top: 210, right: 35, bottom: 240, width: 30, height: 30 }) as DOMRect
    })
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 250)
    render(<ModeSelector mode="chat" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mode: Chat' }))
    const menu = screen.getByRole('menu', { name: 'Freya mode' })
    expect(menu.style.position).toBe('fixed')
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(304)
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8)
  })

  it('focuses the current choice and closes on Escape or an outside click', () => {
    render(<><ModeSelector mode="chat" onChange={() => {}} /><button>Outside</button></>)
    const trigger = screen.getByRole('button', { name: 'Mode: Chat' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: /Chat Conversation/ })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('moves through choices with the keyboard and selects once', () => {
    const onChange = vi.fn()
    render(<ModeSelector mode="chat" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mode: Chat' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    const research = screen.getByRole('menuitemradio', { name: /Deep Research/ })
    expect(research).toHaveFocus()
    fireEvent.click(research)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('deep-research')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('focuses an already-selected Eye choice instead of the first menu option', () => {
    render(<ModeSelector mode="eye" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: "Mode: Freya's Eye" }))
    expect(screen.getByRole('menuitemradio', { name: /Freya's Eye/ })).toHaveFocus()
  })
})
