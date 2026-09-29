import { SURFACE_TYPES, type SurfaceLayout, type SurfaceType } from './types'
import type { PersistedSurface } from './surfaces/manager'
import { isPresenceState, type PresenceState } from './presence'

export const WORKSPACE_SCHEMA = 1

export interface WorkspaceSnapshot {
  schema: number
  surfaces: PersistedSurface[]
  presence: PresenceState
  nav: string
  savedAt: number
}

export const WORKSPACE_STORAGE_KEY = 'freya.workspace.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function num(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback
}

function bool(value: unknown): boolean {
  return value === true
}

function isSurfaceType(value: unknown): value is SurfaceType {
  return typeof value === 'string' && (SURFACE_TYPES as readonly string[]).includes(value)
}

function parseContext(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && key.length <= 64) out[key] = entry.slice(0, 256)
  }
  return out
}

function parseLayout(value: unknown): SurfaceLayout | null {
  if (!isRecord(value)) return null
  const width = num(value.width, 0)
  const height = num(value.height, 0)
  if (width <= 0 || height <= 0) return null
  const restore = isRecord(value.restoreBounds)
    ? {
        x: num(value.restoreBounds.x, 0),
        y: num(value.restoreBounds.y, 0),
        width: num(value.restoreBounds.width, width),
        height: num(value.restoreBounds.height, height),
      }
    : null
  return {
    x: num(value.x, 0),
    y: num(value.y, 0),
    width,
    height,
    minimized: bool(value.minimized),
    maximized: false,
    pinned: bool(value.pinned),
    z: num(value.z, 0),
    restoreBounds: restore,
  }
}

/**
 * Parse an untrusted workspace file.
 *
 * Every field is checked. A corrupt or hand-edited file yields `null` and the
 * shell opens with defaults — it must never be able to prevent launch, and it
 * must never be able to inject a surface type the shell does not know.
 */
export function parseWorkspace(raw: unknown): WorkspaceSnapshot | null {
  if (!isRecord(raw)) return null
  if (num(raw.schema, 0) !== WORKSPACE_SCHEMA) return null
  if (!Array.isArray(raw.surfaces)) return null

  const surfaces: PersistedSurface[] = []
  for (const entry of raw.surfaces) {
    if (!isRecord(entry)) continue
    if (typeof entry.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(entry.id)) continue
    if (!isSurfaceType(entry.type)) continue
    if (surfaces.some((s) => s.id === entry.id)) continue
    const layout = parseLayout(entry.layout)
    if (!layout) continue
    surfaces.push({
      id: entry.id,
      type: entry.type,
      title: typeof entry.title === 'string' ? entry.title.slice(0, 80) : '',
      context: parseContext(entry.context),
      layout,
    })
    if (surfaces.length >= 32) break
  }

  return {
    schema: WORKSPACE_SCHEMA,
    surfaces,
    presence: isPresenceState(raw.presence) ? raw.presence : 'idle',
    nav: typeof raw.nav === 'string' ? raw.nav.slice(0, 32) : 'home',
    savedAt: num(raw.savedAt, Date.now()),
  }
}

export function emptyWorkspace(): WorkspaceSnapshot {
  return { schema: WORKSPACE_SCHEMA, surfaces: [], presence: 'idle', nav: 'home', savedAt: Date.now() }
}
