import { describe, expect, it, vi } from 'vitest'
import { SurfaceManager, type SurfaceEvent } from '../../src/core/surfaces/manager'
import { surfaceTypes } from '../../src/core/surfaces/types'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '../../src/core/surfaces/geometry'

/**
 * A frame with room for a laptop-sized window. The header, the status strip and
 * the chat bar are reserved; the dashboard columns are not, because a window is
 * allowed to cover them.
 */
const FRAME = { x: 60, y: 120, width: 1476, height: 800 }

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
  it('opens every surface at least laptop-sized, inside the frame', () => {
    const { manager } = makeManager()
    const surface = manager.open({ type: 'search' })

    expect(manager.surfaces).toHaveLength(1)
    expect(surface.type).toBe('search')
    expect(surface.title).toBe(surfaceTypes.search.title)
    // The floor, not the descriptor: a 600x500 search panel is a panel
    // pretending to be a workspace.
    expect(surface.layout.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    expect(surface.layout.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
    // Still inside the frame it may be dragged within.
    expect(surface.layout.x).toBeGreaterThanOrEqual(FRAME.x)
    expect(surface.layout.y).toBeGreaterThanOrEqual(FRAME.y)
  })

  it('opens a window centred, and steps later windows away from the middle', () => {
    const { manager } = makeManager()
    const first = manager.open({ type: 'chat' })
    const second = manager.open({ type: 'search' })

    const centreX = first.layout.x + first.layout.width / 2
    const frameCentre = FRAME.x + FRAME.width / 2
    // The first window is centred on the frame.
    expect(Math.abs(centreX - frameCentre)).toBeLessThanOrEqual(2)

    // The second is distinguishable but has not walked off to one side.
    expect(second.layout.x).toBeGreaterThan(first.layout.x)
    expect(second.layout.x - first.layout.x).toBeLessThan(FRAME.width / 4)
  })

  it('caps a window at the frame when the frame is too small for the floor', () => {
    const events: SurfaceEvent[] = []
    const tiny = { x: 0, y: 0, width: 800, height: 600 }
    const manager = new SurfaceManager({
      frame: tiny,
      onEvent: (event) => events.push(event),
      now: () => 1_700_000_000_000,
    })
    const surface = manager.open({ type: 'search' })
    // A window that cannot fit must still be openable and draggable back.
    expect(surface.layout.width).toBeLessThanOrEqual(800)
    expect(surface.layout.width).toBeGreaterThan(0)
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
    expect(moved?.layout.x).toBeLessThanOrEqual(FRAME.x + FRAME.width)
    expect(moved?.layout.y).toBe(FRAME.y)
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

    manager.setFrame({ x: 186, y: 88, width: 814, height: 612 })

    for (const surface of manager.surfaces) {
      expect(surface.layout.x).toBeLessThanOrEqual(186 + 814 - 96)
      expect(surface.layout.y).toBeLessThanOrEqual(88 + 612 - 96)
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
      x: FRAME.x,
      y: FRAME.y,
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

describe('SurfaceManager — focus fallback', () => {
  it('focuses the surface underneath when the focused one is minimised', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })
    expect(manager.focused?.id).toBe(search.id)

    manager.minimize(search.id)

    expect(manager.focused?.id).toBe(chat.id)
    expect(manager.get(search.id)?.layout.minimized).toBe(true)
  })

  it('focuses the surface underneath when the focused one is closed', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })

    manager.close(search.id)

    expect(manager.focused?.id).toBe(chat.id)
  })

  it('falls back down the stack when several are minimised in turn', () => {
    const { manager } = makeManager()
    const a = manager.open({ type: 'chat' })
    const b = manager.open({ type: 'search' })
    const c = manager.open({ type: 'harness' })

    manager.minimize(c.id)
    expect(manager.focused?.id).toBe(b.id)
    manager.minimize(b.id)
    expect(manager.focused?.id).toBe(a.id)
  })

  it('reports no focus once every surface is minimised', () => {
    const { manager } = makeManager()
    manager.open({ type: 'chat' })
    manager.open({ type: 'search' })
    manager.minimize(manager.surfaces[0]!.id)
    manager.minimize(manager.surfaces[1]!.id)

    expect(manager.focused).toBeUndefined()
  })

  it('reports no focus once the last surface is closed', () => {
    const { manager } = makeManager()
    const only = manager.open({ type: 'chat' })
    manager.close(only.id)
    expect(manager.focused).toBeUndefined()
  })

  it('raises the fallback so it is genuinely on top, not merely topmost', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })
    const harness = manager.open({ type: 'harness' })

    manager.minimize(harness.id)

    const focusZ = manager.get(search.id)?.layout.z ?? 0
    expect(focusZ).toBeGreaterThan(manager.get(chat.id)?.layout.z ?? 0)
  })

  it('does not disturb focus when a background surface is minimised', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })
    expect(manager.focused?.id).toBe(search.id)

    manager.minimize(chat.id)

    expect(manager.focused?.id).toBe(search.id)
  })

  it('leaves focus alone when closing a background surface', () => {
    const { manager } = makeManager()
    const chat = manager.open({ type: 'chat' })
    const search = manager.open({ type: 'search' })

    manager.close(chat.id)

    expect(manager.focused?.id).toBe(search.id)
  })
})

describe('SurfaceManager — the event summary', () => {
  it('reports open, minimised and focused counts on every event', () => {
    const { manager, events } = makeManager()
    const chat = manager.open({ type: 'chat' })
    manager.open({ type: 'search' })

    expect(events[0]?.summary).toEqual({ open: 1, minimized: 0, focused: 'chat-1' })
    expect(manager.summary()).toEqual({ open: 2, minimized: 0, focused: 'search-2' })

    manager.minimize('search-2')
    const latest = events[events.length - 1]
    expect(latest?.summary).toEqual({ open: 2, minimized: 1, focused: 'chat-1' })

    manager.close(chat.id)
    expect(events[events.length - 1]?.summary).toEqual({ open: 1, minimized: 1, focused: null })
  })

  it('reports the summary after a fallback handover', () => {
    const { manager, events } = makeManager()
    manager.open({ type: 'chat' })
    manager.open({ type: 'search' })
    manager.minimize('search-2')

    const handover = events.filter((e) => e.type === 'surface.focused')
    expect(handover[handover.length - 1]?.summary).toEqual({
      open: 2,
      minimized: 1,
      focused: 'chat-1',
    })
  })

  it('carries the summary on geometry events too, so nothing needs a second subscription', () => {
    const { manager, events } = makeManager()
    const surface = manager.open({ type: 'chat' })
    manager.move(surface.id, 300, 200)

    const moved = events.find((e) => e.type === 'surface.moved')
    expect(moved?.summary).toEqual({ open: 1, minimized: 0, focused: surface.id })
  })
  it('announces a restored list so the shell cannot keep a stale summary', () => {
    const { manager, events } = makeManager()
    manager.open({ type: 'chat' })
    const saved = manager.serialize()
    events.length = 0

    const restored = new SurfaceManager({ frame: FRAME, onEvent: (e) => events.push(e) })
    restored.restore(saved)

    const announcement = events.filter((e) => e.type === 'surface.restored')
    expect(announcement).toHaveLength(1)
    expect(announcement[0]?.summary).toEqual({ open: 1, minimized: 0, focused: 'chat-1' })
  })

  it('reports an emptied workspace when restored from an empty snapshot', () => {
    const { manager } = makeManager()
    manager.open({ type: 'chat' })
    manager.restore([])
    expect(manager.summary()).toEqual({ open: 0, minimized: 0, focused: null })
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

    const restored = new SurfaceManager({ frame: { x: 186, y: 88, width: 838, height: 592 } })
    restored.restore(saved)

    const layout = restored.get(surface.id)?.layout
    expect(layout?.x).toBeLessThanOrEqual(186 + 838 - 96)
    expect(layout?.y).toBeLessThanOrEqual(88 + 592 - 96)
    expect(layout?.width).toBeLessThanOrEqual(838)
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

describe('SurfaceManager — instance policy', () => {
  it('does not duplicate a singleton when it is opened again', () => {
    const { manager } = makeManager()
    const first = manager.open({ type: 'security' })
    const second = manager.open({ type: 'security' })

    expect(second.id).toBe(first.id)
    expect(manager.surfaces).toHaveLength(1)
  })

  it('raises and restores a minimised singleton rather than opening a second one', () => {
    const { manager } = makeManager()
    const first = manager.open({ type: 'security' })
    manager.minimize(first.id)
    expect(manager.get(first.id)?.layout.minimized).toBe(true)

    manager.open({ type: 'security' })

    expect(manager.surfaces).toHaveLength(1)
    expect(manager.get(first.id)?.layout.minimized).toBe(false)
  })

  it('focuses a singleton that is open but behind another window', () => {
    const { manager } = makeManager()
    const security = manager.open({ type: 'security' })
    manager.open({ type: 'search' })
    expect(manager.focused?.type).toBe('search')

    manager.open({ type: 'security' })

    expect(manager.focused?.id).toBe(security.id)
    expect(manager.surfaces).toHaveLength(2)
  })

  it('allows one window per key for a keyed type', () => {
    const { manager } = makeManager()
    expect(surfaceTypes.mission.instance).toEqual({ keyedBy: 'missionId' })

    const first = manager.open({ type: 'mission', context: { missionId: 'm-1' } })
    const again = manager.open({ type: 'mission', context: { missionId: 'm-1' } })
    expect(again.id).toBe(first.id)
    expect(manager.surfaces).toHaveLength(1)

    const other = manager.open({ type: 'mission', context: { missionId: 'm-2' } })
    expect(other.id).not.toBe(first.id)
    expect(manager.surfaces).toHaveLength(2)
  })

  it('treats a keyed type with no key as a singleton, because two of them would be indistinguishable', () => {
    const { manager } = makeManager()
    const first = manager.open({ type: 'mission' })
    const again = manager.open({ type: 'mission' })
    expect(again.id).toBe(first.id)
    expect(manager.surfaces).toHaveLength(1)
  })

  it('declares an instance policy for every surface type', () => {
    // A new type that forgets this would fall back to duplicating, so the
    // invariant is checked over the whole vocabulary rather than spot-checked.
    for (const descriptor of Object.values(surfaceTypes)) {
      expect(
        descriptor.instance === 'singleton' || typeof descriptor.instance.keyedBy === 'string',
        `${descriptor.type} has no instance policy`,
      ).toBe(true)
    }
  })

  it('reopens by explicit id even when the type would be keyed', () => {
    const { manager } = makeManager()
    const saved = manager.open({ type: 'harness', context: { sessionId: 's-1' } })
    manager.close(saved.id)
    const restored = manager.open({ type: 'harness', id: saved.id, context: { sessionId: 's-1' } })
    expect(restored.id).toBe(saved.id)
    expect(manager.surfaces).toHaveLength(1)
  })

  it('restores a saved layout without duplicating entries', () => {
    const { manager } = makeManager()
    manager.open({ type: 'security' })
    manager.open({ type: 'mission', context: { missionId: 'm-1' } })
    manager.open({ type: 'mission', context: { missionId: 'm-2' } })
    const saved = manager.serialize()

    manager.restore(saved)

    expect(manager.surfaces).toHaveLength(3)
    // And re-opening a restored mission still finds its own window.
    const m1 = manager.open({ type: 'mission', context: { missionId: 'm-1' } })
    expect(manager.surfaces).toHaveLength(3)
    expect(manager.get(m1.id)?.context.missionId).toBe('m-1')
  })
})
