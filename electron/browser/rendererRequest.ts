import {
  BROWSER_COMMANDS,
  BROWSER_LIMITS,
  BROWSER_TARGETS,
  type BrowserProjection,
  type BrowserRequest,
} from '../../core/browser'
import { DEVICE_HANDS_LIMITS } from '../../core/devicehands'

export interface BrowserBridgeState {
  readonly available: boolean
  readonly active: boolean
  readonly reason: string | null
  readonly publicAvailable: boolean
  readonly extensionPaired: boolean
  readonly extensionLive: boolean
  readonly journalTrustworthy: boolean
  readonly summary: string
  readonly sessions: BrowserProjection['sessions']
  readonly handoffs: readonly { readonly handoffId: string; readonly state: string }[]
  readonly described: number
  readonly staleRefs: number
  readonly mediaObserved: number
  readonly refusals: number
}

export type BrowserRequestReading =
  | { readonly ok: true; readonly request: BrowserRequest }
  | { readonly ok: false; readonly reason: string }

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  max: number,
  required = false,
): string | undefined | null {
  const value = record[key]
  if (value === undefined) return required ? null : undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  return value
}

function targetField(record: Record<string, unknown>): BrowserRequest['target'] | null {
  const value = record.target
  if (value === undefined) return 'auto'
  if (value === 'auto') return value
  return (BROWSER_TARGETS as readonly string[]).includes(String(value))
    ? value as BrowserRequest['target']
    : null
}

/**
 * Rebuild one renderer-originated browser request from the fields its command owns.
 *
 * Unknown fields are never forwarded. In particular there is no context field on
 * this renderer bridge: carrying arbitrary context across browser targets is precisely
 * how credentials leak, and the owner-facing UI needs no such power.
 */
export function normaliseRendererBrowserRequest(value: unknown): BrowserRequestReading {
  const record = object(value)
  if (record === null) return { ok: false, reason: 'a browser request must be an object' }

  const command = record.command
  if (typeof command !== 'string' || !(BROWSER_COMMANDS as readonly string[]).includes(command)) {
    return { ok: false, reason: 'that is not a browser command this build exposes to the window' }
  }

  const target = targetField(record)
  if (target === null) return { ok: false, reason: 'browser target must be public, authenticated, or auto' }

  const sessionId = stringField(record, 'sessionId', 128)
  const url = stringField(record, 'url', BROWSER_LIMITS.maxUrlChars)
  const ref = stringField(record, 'ref', 64)
  const handoffId = stringField(record, 'handoffId', 128)
  const reason = stringField(record, 'reason', 200)
  const mediaId = stringField(record, 'mediaId', 128)

  if (
    sessionId === null ||
    url === null ||
    ref === null ||
    handoffId === null ||
    reason === null ||
    mediaId === null
  ) {
    return { ok: false, reason: 'one of the browser request fields is invalid or too large' }
  }

  const base = { command: command as BrowserRequest['command'], target } as const

  switch (command) {
    case 'session.open':
      return { ok: true, request: base }
    case 'session.close':
    case 'session.state':
      if (sessionId === undefined) return { ok: false, reason: 'this browser command needs a session id' }
      return { ok: true, request: { ...base, sessionId } }
    case 'page.navigate':
      if (sessionId === undefined || url === undefined) {
        return { ok: false, reason: 'navigation needs a browser session and URL' }
      }
      return { ok: true, request: { ...base, sessionId, url } }
    case 'page.read':
    case 'page.describe':
      if (sessionId === undefined) return { ok: false, reason: 'this page command needs a browser session' }
      return { ok: true, request: { ...base, sessionId } }
    case 'page.click':
      if (sessionId === undefined || ref === undefined) {
        return { ok: false, reason: 'clicking needs a browser session and a reference Freya just described' }
      }
      return { ok: true, request: { ...base, sessionId, ref } }
    case 'page.type': {
      if (sessionId === undefined || ref === undefined) {
        return { ok: false, reason: 'typing needs a browser session and a reference Freya just described' }
      }
      const text = stringField(record, 'text', DEVICE_HANDS_LIMITS.maxTypedTextBytes, true)
      if (text === null || text === undefined) return { ok: false, reason: 'typed text is missing or too large' }
      if (new TextEncoder().encode(text).length > DEVICE_HANDS_LIMITS.maxTypedTextBytes) {
        return { ok: false, reason: 'typed text exceeds the Device Hands byte ceiling' }
      }
      return { ok: true, request: { ...base, sessionId, ref, text } }
    }
    case 'media.describe':
      if (sessionId === undefined || mediaId === undefined) {
        return { ok: false, reason: 'media description needs a browser session and observed media id' }
      }
      return { ok: true, request: { ...base, sessionId, mediaId } }
    case 'handoff.offer':
      if (sessionId === undefined && url === undefined) {
        return { ok: false, reason: 'a browser handoff needs the current session or an explicit URL' }
      }
      return {
        ok: true,
        request: {
          ...base,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(url === undefined ? {} : { url }),
          ...(reason === undefined ? {} : { reason }),
        },
      }
    case 'handoff.accept':
    case 'handoff.cancel':
      if (handoffId === undefined) return { ok: false, reason: 'this handoff command needs a handoff id' }
      return { ok: true, request: { ...base, handoffId } }
    case 'handoff.list':
      return { ok: true, request: base }
    default:
      return { ok: false, reason: 'that browser command is not renderer reachable' }
  }
}


export interface BrowserDockRequest {
  sessionId: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
}

/** Clamp native views to this window; remote pages cannot request a view. */
export function normaliseBrowserDockRequest(value: unknown, viewport: { width: number; height: number }): BrowserDockRequest | null {
  const row = object(value)
  if (!row) return null
  if (row.sessionId === null && row.bounds === null) return { sessionId: null, bounds: null }
  if (typeof row.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.sessionId)) return null
  const rect = object(row.bounds)
  if (!rect || !['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))) return null
  const x = Math.max(0, Math.min(viewport.width, Math.round(rect.x as number)))
  const y = Math.max(0, Math.min(viewport.height, Math.round(rect.y as number)))
  const width = Math.max(0, Math.min(viewport.width - x, Math.round(rect.width as number)))
  const height = Math.max(0, Math.min(viewport.height - y, Math.round(rect.height as number)))
  return { sessionId: row.sessionId, bounds: width > 0 && height > 0 ? { x, y, width, height } : null }
}
