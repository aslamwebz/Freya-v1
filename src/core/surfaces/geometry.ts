import type { SurfaceLayout } from './types'

export interface Frame {
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

/** A surface must keep at least this much of itself reachable on screen. */
const KEEP_VISIBLE = 96

export function clampPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  frame: Frame,
): { x: number; y: number } {
  return {
    x: round(Math.min(Math.max(position.x, KEEP_VISIBLE - size.width), frame.width - KEEP_VISIBLE)),
    y: round(Math.min(Math.max(position.y, 0), frame.height - KEEP_VISIBLE)),
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
  const step = 34
  const base = { x: 96 + (index % 6) * step, y: 84 + (index % 6) * step }
  return clampPosition(base, size, frame)
}

export function round(value: number): number {
  return Math.round(value)
}
