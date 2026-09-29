import { describe, expect, it, vi } from 'vitest'
import { SurfaceManager, type SurfaceEvent } from '../../src/core/surfaces/manager'
import { surfaceTypes } from '../../src/core/surfaces/types'

const FRAME = { width: 1600, height: 1000 }

function makeManager() {
  const events: SurfaceEvent[] = []
  const manager = new SurfaceManager({
    frame: FRAME,
    onEvent: (event) => events.push(event),
    now: () => 1_700_000_000_000,
  })
  return { manager, events }
}

describe('SurfaceManager — lifecycle', () => {
  it('creates a surface with the descriptor default size, inside the frame', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'search' })

    expect(manager.surfaces).toHaveLength(1)
    expect(surface.type).toBe('search')
    expect(surface.title).toBe(surfaceTypes.search.title)
    expect(surface.layout.width).toBe(surfaceTypes.search.width)
    expect(surface.layout.height).toBe(surfaceTypes.search.height)
    expect(surface.layout.x).toBeGreaterThanOrEqual(0)
    expect(surface.layout.y).toBeGreaterThanOrEqual(0)
  })

  it('assigns a unique id per surface and cascades new ones so they do not stack', () => {
    const { manager } = makeManager()
    const first = manager.open({ type: 'chat' })
    const second = manager.open({ type: 'search' })

    expect(first.id).not.toBe(second.id)
    expect(second.layout.x).toBeGreaterThan(first.layout.x)
  })

  it('closes a surface and removes it from the workspace', () => {
    const { manager, events } = makeManager()
    const surface = manager.open({ type: 'chat' })

    expect(manager.close(surface.id)).toBe(true)
    expect(manager.surfaces).toHaveLength(0)
    expect(manager.get(surface.id)).toBeUndefined()
    expect(events.map((e) => e.type)).toContain('surface.closed')
  })

  it('closing an unknown surface is a no-op', () => {
    const { manager } = makeManager()
    expect(manager.close('nope')).toBe(false)
  })

  it('re-opening the same id focuses the existing surface instead of duplicating it', () => {
    const { manager } = makeManager()
    const first = manager.open({ type: 'chat' })
    const again = manager.open({ type: 'chat', id: first.id })

    expect(manager.surfaces).toHaveLength(1)
    expect(again.id).toBe(first.id)
  })
})

describe('SurfaceManager — focus and z-order', () => {
  it('focusing a surface raises it above every other surface', () => {
    const { manager, events } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })

    expect(manager.focused?.id).toBe(search.id)
    expect(search.layout.z).toBeGreaterThan(chat.layout.z)

    manager.focus(chat.id)

    expect(manager.focused?.id).toBe(chat.id)
    expect(manager.get(chat.id)?.layout.z).toBeGreaterThan(manager.get(search.id)?.layout.z ?? 0)
    expect(events.filter((e) => e.type === 'surface.focused')).toHaveLength(3)
  })

  it('does not re-raise a surface that is already on top', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const z = chat.layout.z
    manager.focus(chat.id)
    expect(chat.layout.z).toBe(z)
  })

  it('focusing a minimised surface restores it', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })
    manager.minimize(chat.id)

    manager.focus(chat.id)

    expect(manager.get(chat.id)?.layout.minimized).toBe(false)
    expect(manager.focused?.id).toBe(chat.id)
    expect(manager.get(search.id)?.layout.z).toBeLessThan(manager.get(chat.id)?.layout.z ?? 0)
  })

  it('cycle walks the stack in both directions', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })
    const harness = manager.open({ type: 'harness' })

    // Insertion order is chat, search, harness. Forward wraps at the end.
    expect(manager.cycle(1)).toBe(chat.id)
    expect(manager.cycle(1)).toBe(search.id)
    expect(manager.cycle(1)).toBe(harness.id)
    expect(manager.cycle(-1)).toBe(search.id)
    expect(manager.focused?.id).toBe(search.id)
  })
})

describe('SurfaceManager — geometry', () => {
  it('moves a surface and keeps it reachable inside the frame', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'chat' })

    manager.move(surface.id, 400, 300)
    expect(manager.get(surface.id)?.layout).toMatchObject({ x: 400, y: 300 })

    manager.move(surface.id, 99_999, -50)
    const moved = manager.get(surface.id)
    expect(moved?.layout.x).toBeLessThanOrEqual(FRAME.width)
    expect(moved?.layout.y).toBe(0)
  })

  it('resizes within the type minimum and never below it', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'search' })

    manager.resize(surface.id, 10_000, 10_000)
    expect(manager.get(surface.id)?.layout.width).toBe(FRAME.width)

    manager.resize(surface.id, 10, 10)
    expect(manager.get(surface.id)?.layout).toMatchObject({
      width: surfaceTypes.search.minWidth,
      height: surfaceTypes.search.minHeight,
    })
  })

  it('clamps every surface back into view when the frame shrinks', () => {
    const { manager } = makeManager()
    const a = manager.open({ type: 'chat' })
    const b = manager.open({ type: 'search' })
    manager.move(a.id, 1200, 700)

    manager.setFrame({ width: 1000, height: 700 })

    for (const surface of manager.surfaces) {
      expect(surface.layout.x).toBeLessThanOrEqual(1000 - 96)
      expect(surface.layout.y).toBeLessThanOrEqual(700 - 96)
    }
    expect(manager.get(b.id)).toBeDefined()
  })
})

describe('SurfaceManager — window state', () => {
  it('minimise preserves the surface and its geometry', () => {
    const { manager, events } = makeManager()
    const surface = manager.open({ type: 'harness' })
    manager.move(surface.id, 200, 180)
    const before = { ...(manager.get(surface.id)?.layout ?? surface.layout) }

    expect(manager.minimize(surface.id)).toBe(true)

    const after = manager.get(surface.id)
    expect(after).toBeDefined()
    expect(after?.state).toBe('minimized')
    expect(after?.layout.minimized).toBe(true)
    expect(after?.layout.x).toBe(before.x)
    expect(after?.layout.y).toBe(before.y)
    expect(after?.layout.width).toBe(before.width)
    expect(after?.layout.z).toBe(before.z)
    expect(events.map((e) => e.type)).toContain('surface.state.changed')
  })

  it('minimising twice is idempotent', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'chat' })
    manager.minimize(surface.id)
    expect(manager.minimize(surface.id)).toBe(false)
  })

  it('maximise fills the frame and remembers the geometry to return to', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'chat' })
    manager.move(surface.id, 150, 170)
    const original = { x: 150, y: 170, width: surface.layout.width, height: surface.layout.height }

    manager.maximize(surface.id)

    expect(manager.get(surface.id)?.layout).toMatchObject({
      x: 0,
      y: 0,
      width: FRAME.width,
      height: FRAME.height,
      maximized: true,
    })

    manager.unmaximize(surface.id)

    expect(manager.get(surface.id)?.layout).toMatchObject({ ...original, maximized: false })
  })

  it('pins a surface without changing its geometry', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'chat' })
    const before = { x: surface.layout.x, y: surface.layout.y }

    manager.togglePin(surface.id)

    expect(manager.get(surface.id)?.layout.pinned).toBe(true)
    expect(manager.get(surface.id)?.layout).toMatchObject(before)
  })
})

describe('SurfaceManager — serialisation', () => {
  it('round-trips a workspace, preserving ids, geometry and pinned state', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })
    manager.move(search.id, 260, 190)
    manager.resize(search.id, 700, 480)
    manager.togglePin(chat.id)
    manager.minimize(chat.id)

    const saved = manager.serialize()

    const restored = new SurfaceManager({ frame: FRAME })
    restored.restore(saved)

    expect(restored.surfaces.map((s) => s.id)).toEqual([chat.id, search.id])
    const restoredSearch = restored.get(search.id)
    expect(restoredSearch?.layout).toMatchObject({ x: 260, y: 190, width: 700, height: 480 })
    expect(restored.get(chat.id)?.layout.pinned).toBe(true)
    expect(restored.get(chat.id)?.layout.minimized).toBe(true)
  })

  it('re-clamps a layout saved on a larger display', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'work' })
    manager.move(surface.id, 1400, 900)
    manager.resize(surface.id, 900, 700)
    const saved = manager.serialize()

    const restored = new SurfaceManager({ frame: { width: 1024, height: 680 } })
    restored.restore(saved)

    const layout = restored.get(surface.id)?.layout
    expect(layout?.x).toBeLessThanOrEqual(1024 - 96)
    expect(layout?.y).toBeLessThanOrEqual(680 - 96)
    expect(layout?.width).toBeLessThanOrEqual(1024)
  })

  it('notifies subscribers on every mutation and stops after unsubscribe', () => {
    const { manager } = makeManager()
    const listener = vi.fn()
    const unsubscribe = manager.subscribe(listener)

    const surface = manager.open({ type: 'chat' })
    expect(listener).toHaveBeenCalledTimes(1)

    manager.move(surface.id, 200, 200)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    manager.close(surface.id)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
