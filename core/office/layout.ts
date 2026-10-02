import {
  OFFICE_CELL,
  OFFICE_FLOOR,
  OFFICE_GAP,
  type OfficePosition,
  type OfficeZone,
} from './types'

/**
 * THE OFFICE LAYOUT.
 *
 * A deterministic placement of stations on a fixed virtual floor. The layout is
 * a pure function of how many stations a zone holds: the same counts always
 * produce the same positions, on every machine and every launch, so a window
 * that reloads sees the office exactly as it was.
 *
 * ## Why a fixed grid and not a force simulation
 *
 * A force-directed or physics layout would produce a different arrangement on
 * every run, and an arrangement that moves on its own reads as activity — which
 * is exactly the invented liveliness this domain exists to avoid. A fixed grid
 * is still, readable and honest: a station moves only when the state it
 * represents changes.
 *
 * ## The zones
 *
 * ```
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ approvals (a row across the top)                          │
 *   ├───────────────┬──────────────────────────────────────────┤
 *   │               │                                          │
 *   │  workforce    │  floor (live runs)          freya        │
 *   │  (a grid)     │  (a grid)                  (a desk)     │
 *   │               │                                          │
 *   ├───────────────┴──────────────────────────────────────────┤
 *   │ history (a timeline strip across the bottom)              │
 *   └──────────────────────────────────────────────────────────┘
 * ```
 *
 * Freya's desk is anchored at a fixed position on the right, so the centre of
 * the office is always her and never moves when other stations come and go.
 */

/** How many stations fit in one row of a grid zone. */
const FLOOR_COLUMNS = 3
const WORKFORCE_COLUMNS = 4
const APPROVAL_COLUMNS = 6

/** The origin of each zone, in virtual units. */
const ZONE_ORIGINS: Record<OfficeZone, OfficePosition> = {
  freya: { x: 0, y: 0 },
  floor: { x: 380, y: 110 },
  workforce: { x: 24, y: 110 },
  approvals: { x: 24, y: 24 },
  history: { x: 24, y: 540 },
}

/**
 * The position of the i-th station in a grid zone.
 *
 * Row-major, left to right, top to bottom. The index is bounded by the zone's
 * ceiling before this is called, so a station never falls off the floor.
 */
export function gridPosition(zone: OfficeZone, index: number): OfficePosition {
  const origin = ZONE_ORIGINS[zone]
  const columns = zone === 'floor' ? FLOOR_COLUMNS : zone === 'workforce' ? WORKFORCE_COLUMNS : APPROVAL_COLUMNS
  const column = index % columns
  const row = Math.floor(index / columns)
  return {
    x: origin.x + column * (OFFICE_CELL.width + OFFICE_GAP),
    y: origin.y + row * (OFFICE_CELL.height + OFFICE_GAP),
  }
}

/**
 * Freya's desk position.
 *
 * Fixed, and fixed at the visual centre of the floor. She is the one station
 * that is always present, so she is the one station that never moves.
 */
export function freyaPosition(): OfficePosition {
  return { x: OFFICE_FLOOR.width - OFFICE_CELL.width - 24, y: Math.round((OFFICE_FLOOR.height - OFFICE_CELL.height) / 2) }
}

/**
 * The position of the i-th history entry.
 *
 * A single row across the bottom, left to right, newest first.
 */
export function historyPosition(index: number): OfficePosition {
  const origin = ZONE_ORIGINS.history
  return {
    x: origin.x + index * (OFFICE_CELL.width + OFFICE_GAP),
    y: origin.y,
  }
}

/**
 * Whether a position is inside the office floor.
 *
 * A guard rather than an assumption. A layout that placed a station outside the
 * floor would render it clipped or overlapping the window edge, which reads as
 * a bug in the office rather than as a station a person can look at.
 */
export function isOnFloor(position: OfficePosition): boolean {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    position.x + OFFICE_CELL.width <= OFFICE_FLOOR.width &&
    position.y + OFFICE_CELL.height <= OFFICE_FLOOR.height
  )
}
