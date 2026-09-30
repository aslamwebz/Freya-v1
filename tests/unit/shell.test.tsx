import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { manager } from '../../src/ui/boot'
import { shellStore } from '../../src/ui/store'

/**
 * The shell boots against the browser workspace store in jsdom, which is the
 * same code path the desktop host uses minus the IPC hop.
 */

function rect(element: Element, box: Partial<DOMRect>) {
  const base = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }
  const value = { ...base, ...box } as DOMRect
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => value,
  })
}

/** jsdom has no layout engine; the drag maths reads from getBoundingClientRect. */
function stubLayout(): void {
  rect(document.documentElement, { width: 1600, height: 1000 })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1600, bottom: 1000, width: 1600, height: 1000, toJSON: () => ({}) } as DOMRect
  })
}

async function boot() {
  render(<App />)
  await screen.findByText('FREYA')
  await act(async () => {
    await Promise.resolve()
  })
}

/** jsdom has no PointerEvent; a MouseEvent carries the fields the shell reads. */
function pointer(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY })
}

function dockButton(name: RegExp) {
  const dock = screen.getByRole('toolbar', { name: /work surfaces/i })
  return within(dock).getByRole('button', { name })
}

describe('Freya shell', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    stubLayout()
    // The manager and the store are module singletons; reset both so each test
    // starts from the same workspace.
    manager.restore([])
    shellStore.dispatch({ type: 'presence.set', state: 'idle' })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
    // The presence canvas has no 2D context in jsdom.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      transform: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('boots and renders the command centre', async () => {
    await boot()

    expect(screen.getByText('FREYA')).toBeInTheDocument()
    expect(screen.getByRole('search')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: /freya systems/i })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: /work surfaces/i })).toBeInTheDocument()
    expect(screen.getByText('Current focus')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start listening/i })).toBeInTheDocument()
  })

  it('opens a surface from the dock and renders its body', async () => {
    await boot()

    await act(async () => {
      fireEvent.click(dockButton(/search/i))
    })

    expect(manager.surfaces).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/search files, vault and knowledge/i)).toBeInTheDocument()
  })

  it('gives every surface type the same window chrome without bespoke components', async () => {
    await boot()

    for (const label of [/chat/i, /harness/i]) {
      await act(async () => {
        fireEvent.click(dockButton(label))
      })
    }

    for (const title of ['Chat', 'Harness']) {
      const dialog = screen.getByRole('dialog', { name: title })
      expect(within(dialog).getByRole('button', { name: new RegExp(`Minimize ${title}`, 'i') })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: new RegExp(`Maximize ${title}`, 'i') })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: new RegExp(`Close ${title}`, 'i') })).toBeInTheDocument()
    }
  })

  it('moves a surface by dragging its title bar', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/search/i))
    })

    const surface = manager.surfaces[0]
    expect(surface).toBeDefined()
    const start = { ...(manager.get(surface?.id ?? '')?.layout ?? {}) }
    const title = screen.getByRole('dialog', { name: 'Search' }).querySelector('.surface-title') as HTMLElement

    await act(async () => {
      fireEvent(title, pointer('pointerdown', 200, 150))
      fireEvent(window, new MouseEvent('pointermove', { clientX: 460, clientY: 330 }))
      fireEvent(window, new MouseEvent('pointerup'))
    })

    const moved = manager.get(surface?.id ?? '')
    expect((moved?.layout.x ?? 0) - (start?.x ?? 0)).toBe(260)
    expect((moved?.layout.y ?? 0) - (start?.y ?? 0)).toBe(180)
  })

  it('resizes a surface from its corner handle', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/harness/i))
    })

    const surface = manager.surfaces[0]
    const dialog = screen.getByRole('dialog', { name: 'Harness' })
    const handle = dialog.querySelector('.surface-handle.edge-se')
    expect(handle).not.toBeNull()

    await act(async () => {
      fireEvent(handle as Element, pointer('pointerdown', 100, 100))
      fireEvent(window, pointer('pointermove', 300, 220))
      fireEvent(window, pointer('pointerup', 300, 220))
    })

    const resized = manager.get(surface?.id ?? '')
    const original = surface?.layout
    expect(resized?.layout.width).toBe((original?.width ?? 0) + 200)
    expect(resized?.layout.height).toBe((original?.height ?? 0) + 120)
  })

  it('raises a background surface when it is clicked', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/chat/i))
      fireEvent.click(dockButton(/search/i))
    })
    const surfaces = manager.surfaces ?? []
    const chat = surfaces.find((s) => s.type === 'chat')
    const search = surfaces.find((s) => s.type === 'search')
    expect(search?.layout.z).toBeGreaterThan(chat?.layout.z ?? 0)

    await act(async () => {
      const chatTitle = screen.getByRole('dialog', { name: 'Chat' }).querySelector('.surface-title') as HTMLElement
      fireEvent(chatTitle, pointer('pointerdown', 120, 60))
    })

    expect(manager.get(chat?.id ?? '')?.layout.z).toBeGreaterThan(
      manager.get(search?.id ?? '')?.layout.z ?? 0,
    )
  })

  it('minimises a surface without destroying it, and restores it on focus', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/chat/i))
    })
    const id = manager.surfaces[0]?.id ?? ''

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /minimize chat/i }))
    })

    expect(manager.surfaces).toHaveLength(1)
    expect(manager.get(id)?.layout.minimized).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'Chat' })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(dockButton(/chat/i))
    })

    expect(manager.get(id)?.layout.minimized).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Chat' })).toBeInTheDocument()
  })

  it('maximises to the workspace frame and restores the previous geometry', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/search/i))
    })
    const id = manager.surfaces[0]?.id ?? ''
    const original = { ...(manager.get(id)?.layout ?? {}) }

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /maximize search/i }))
    })

    expect(manager.get(id)?.layout).toMatchObject({ x: 186, y: 88, width: 1414, height: 912 })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /restore search/i }))
    })

    expect(manager.get(id)?.layout).toMatchObject({
      x: original.x,
      y: original.y,
      width: original.width,
      height: original.height,
    })
  })

  it('closes a surface and removes it from the workspace', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/search/i))
      fireEvent.click(dockButton(/harness/i))
    })
    expect(manager.surfaces).toHaveLength(2)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /close search/i }))
    })

    expect(manager.surfaces).toHaveLength(1)
    expect(manager.surfaces[0]?.type).toBe('harness')
  })

  it('routes a submitted command through the store without calling anything', async () => {
    await boot()
    const input = screen.getByLabelText(/command freya/i)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'find the vault contract' } })
      fireEvent.submit(screen.getByRole('search'))
    })

    expect(shellStore.getState().lastCommand).toBe('find the vault contract')
    expect(shellStore.getState().presence.state).toBe('working')
    expect(screen.getByText(/no model is attached/i)).toBeInTheDocument()
  })

  it('moves the mic control between idle and listening', async () => {
    await boot()
    const mic = screen.getByRole('button', { name: /start listening/i })

    await act(async () => {
      fireEvent.click(mic)
    })
    expect(screen.getByRole('button', { name: /stop listening/i })).toBeInTheDocument()
    expect(shellStore.getState().listening).toBe(true)
    expect(shellStore.getState().presence.state).toBe('listening')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop listening/i }))
    })
    expect(shellStore.getState().listening).toBe(false)
    expect(shellStore.getState().presence.state).toBe('idle')
  })

  it('switches the presence state from the demo control', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Needs you' }))
    })
    expect(shellStore.getState().presence.state).toBe('needs-user')
    expect(screen.getByText(/Freya is needs you/i)).toBeInTheDocument()
  })

  it('minimises the focused surface on Escape', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/chat/i))
    })
    const id = manager.surfaces[0]?.id ?? ''

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(manager.get(id)?.layout.minimized).toBe(true)
  })

  it('routes surface lifecycle into the shell store', async () => {
    await boot()
    // The manager is the only producer; the store is the only consumer.
    expect(shellStore.getState().surfaces).toEqual({ open: 0, minimized: 0, focused: null })

    await act(async () => {
      fireEvent.click(dockButton(/chat/i))
    })
    const chatId = manager.surfaces[0]?.id ?? ''
    expect(shellStore.getState().surfaces).toEqual({ open: 1, minimized: 0, focused: chatId })

    await act(async () => {
      fireEvent.click(dockButton(/search/i))
    })
    const searchId = manager.surfaces[1]?.id ?? ''
    expect(shellStore.getState().surfaces).toEqual({ open: 2, minimized: 0, focused: searchId })

    // Minimising the focused window must hand focus back through the same path.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /minimize search/i }))
    })
    expect(shellStore.getState().surfaces).toEqual({ open: 2, minimized: 1, focused: chatId })
    expect(screen.getByRole('dialog', { name: 'Chat' })).toHaveAttribute('data-focused', 'true')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /close chat/i }))
    })
    expect(shellStore.getState().surfaces).toEqual({ open: 1, minimized: 1, focused: null })
  })

  it('notifies store subscribers when a surface moves, with no second subscription', async () => {
    await boot()
    await act(async () => {
      fireEvent.click(dockButton(/search/i))
    })
    const id = manager.surfaces[0]?.id ?? ''
    const listener = vi.fn()
    const unsubscribe = shellStore.subscribe(listener)

    const title = screen.getByRole('dialog', { name: 'Search' }).querySelector('.surface-title') as HTMLElement
    await act(async () => {
      fireEvent(title, pointer('pointerdown', 260, 200))
      fireEvent(window, pointer('pointermove', 420, 320))
    })

    // A move does not change the summary, so the store correctly stays quiet.
    expect(listener).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent(window, pointer('pointerup', 420, 320))
    })
    unsubscribe()
    expect(manager.get(id)?.layout.x).toBeGreaterThan(0)
  })

  it('labels every dashboard panel as demo data', async () => {
    await boot()
    // Every dashboard panel plus the presence console declares its data as demo.
    expect(screen.getAllByText('Demo data').length).toBe(5)
    expect(screen.getByText('Demo')).toBeInTheDocument()
  })

  it('drives the design lab from the keyboard', async () => {
    await boot()
    const atmosphere = document.querySelector('.atmosphere')
    expect(atmosphere).toHaveAttribute('data-bg', 'space')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /design lab/i }))
    })

    await act(async () => {
      fireEvent.keyDown(window, { key: 'b' })
    })
    expect(atmosphere).toHaveAttribute('data-bg', 'grid')

    // The brain style row is only offered while the brain is the centrepiece.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Brain' }))
    })
    await act(async () => {
      // Keys 1-4 select the styles in order: current, slices, flow, glass.
      fireEvent.keyDown(window, { key: '3' })
    })
    expect(screen.getByRole('button', { name: 'B · Flow' })).toHaveAttribute('aria-pressed', 'true')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Liquid orb' }))
    })
    expect(screen.queryByRole('button', { name: 'B · Flow' })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByRole('button', { name: 'Deep space' })).not.toBeInTheDocument()
  })

  it('ignores design lab keys while the user is typing', async () => {
    await boot()
    const input = screen.getByLabelText(/command freya/i)
    const atmosphere = document.querySelector('.atmosphere')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'brainstorm backgrounds' } })
      fireEvent.keyDown(input, { key: 'b' })
    })

    expect(atmosphere).toHaveAttribute('data-bg', 'space')
    expect(input).toHaveValue('brainstorm backgrounds')
  })
})
