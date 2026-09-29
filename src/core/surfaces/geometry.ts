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

/** Windows may not shrink below their type's minimum, nor grow past the frame. */
export function clampSize(
  size: { width: number; height: number },
  min: { width: number; height: number },
  frame: Frame,
): { width: number; height: number } {
  return {
    width: round(Math.min(Math.max(size.width, min.width), Math.max(min.width, frame.width))),
    height: round(Math.min(Math.max(size.height, min.height), Math.max(min.height, frame.height))),
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
 * Where a newly opened surface goes: a cascade, so a second window never
 * lands exactly on top of the first.
 */
export function cascadePosition(
  index: number,
  size: { width: number; height: number },
  frame: Frame,
): { x: number; y: number } {
  const step = 46
  const slot = index % 6
  return clampPosition(
    { x: frame.x + 24 + slot * step, y: frame.y + 20 + slot * 34 },
    size,
    frame,
  )
}

export function round(value: number): number {
  return Math.round(value)
}
