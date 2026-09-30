import type { SurfaceLayout } from './types'

/**
 * The workspace region available to surfaces.
 *
 * `x`/`y` are the top-left of that region in page coordinates, not of the
 * window. The shell reserves the header and the navigation rail, so a surface
 * can never be dragged under the command bar or over the systems list: chrome
 * stays reachable no matter how the workspace is arranged.
 */
export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Windows may not shrink below their type's minimum, nor grow past the frame —
 * unless the frame is smaller than the minimum, in which case the frame wins.
 *
 * That exception is the important one. On a display too small to hold a
 * laptop-sized window, insisting on the floor produces a window wider than the
 * space it lives in: it hangs off both edges, and half of what is on screen is
 * the dashboard behind it. A small window is a nuisance; a window you cannot see
 * is broken.
 */
export function clampSize(
  size: { width: number; height: number },
  min: { width: number; height: number },
  frame: Frame,
): { width: number; height: number } {
  const fit = (value: number, floor: number, available: number): number =>
    round(Math.min(Math.max(value, Math.min(floor, available)), available))
  return {
    width: fit(size.width, min.width, frame.width),
    height: fit(size.height, min.height, frame.height),
  }
}

/** A surface must keep at least this much of itself reachable. */
const KEEP_VISIBLE = 96

export function clampPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  frame: Frame,
): { x: number; y: number } {
  return {
    x: round(
      Math.min(Math.max(position.x, frame.x + KEEP_VISIBLE - size.width), frame.x + frame.width - KEEP_VISIBLE),
    ),
    y: round(Math.min(Math.max(position.y, frame.y), frame.y + frame.height - KEEP_VISIBLE)),
  }
}

export function clampLayout(
  layout: SurfaceLayout,
  min: { width: number; height: number },
  frame: Frame,
): SurfaceLayout {
  const size = clampSize(layout, min, frame)
  const position = clampPosition({ x: layout.x, y: layout.y }, size, frame)
  return { ...layout, ...size, ...position }
}

/**
 * The smallest window Freya opens.
 *
 * A 1366x768 laptop screen, which is the smallest display any real laptop has
 * had for a long while. Anything smaller is a panel pretending to be a
 * workspace, and content that is designed for a window ends up in a letterbox.
 *
 * It is a floor, not a fixed size: a window may be larger, and on a display
 * too small to honour it the frame wins, because a window that cannot be
 * dragged back on screen is worse than a small one.
 */
export const MIN_WINDOW_WIDTH = 1366
export const MIN_WINDOW_HEIGHT = 768

/**
 * Where a newly opened surface goes.
 *
 * Centred in the workspace, because a window that appears in a corner reads as
 * an accident. Later windows step away from the centre by a small, fixed
 * amount rather than cascading across the screen, so they stay distinguishable
 * without walking off to one side — and every one of them is draggable from
 * there.
 */
export function cascadePosition(
  index: number,
  size: { width: number; height: number },
  frame: Frame,
): { x: number; y: number } {
  const step = 34
  // Cap the offset so the fourth window is still recognisably near the middle.
  const slot = index % 4
  const centreX = frame.x + (frame.width - size.width) / 2
  const centreY = frame.y + (frame.height - size.height) / 2
  return clampPosition(
    { x: centreX + slot * step, y: centreY + slot * step * 0.6 },
    size,
    frame,
  )
}

export function round(value: number): number {
  return Math.round(value)
}
