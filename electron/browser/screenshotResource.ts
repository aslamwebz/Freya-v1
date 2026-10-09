import type { Session } from 'electron'

/**
 * A tiny store for screenshot bytes the surface has just captured, served over a
 * custom `freya-browser://` protocol to the renderer.
 *
 * The store is the simplest thing that works: a single PNG per session, replaced
 * on every capture, and dropped when the session is closed. There is no fan-out
 * cache, no cross-session retention, and no expiry timer — the surface that
 * produced the bytes owns their lifetime, and the renderer fetches them as
 * soon as it has the URL.
 *
 * The protocol handler that lives next to this store serves one URL shape:
 *   `freya-browser://screenshot/{sessionId}/{revision}.png`
 * Any other path is a 403, including method other than GET, because the bytes
 * are bound to a specific session and revision and a more permissive handler
 * is how a leak starts.
 */
export interface ScreenshotResource {
  /** Register the protocol handler on the given session. Idempotent. */
  register(session: Session): void
  /**
   * Stash the bytes for a session, replacing any previous screenshot for that
   * session. `revision` is the surface's own counter so a later capture with
   * a different revision overwrites the previous one.
   */
  store(sessionId: string, revision: number, png: Buffer, contentType: string): void
  /** Forget the bytes for a session. Called when the session closes. */
  drop(sessionId: string): void
}

const SCHEME = 'freya-browser'
const PATH_PREFIX = 'screenshot/'

/**
 * Factory: one resource per Electron session. Calling it on the session the
 * Freya Browser uses means the renderer can `<img src="freya-browser://...">`
 * the screenshot bytes; calling it on a different session means a different
 * scope, and the protocol is not shared.
 */
export function createScreenshotResource(): ScreenshotResource {
  /** sessionId+revision → png bytes. Bounded at one entry per sessionId (latest revision wins). */
  const entries = new Map<string, { readonly png: Buffer; readonly contentType: string; readonly revision: number }>()

  function key(sessionId: string, revision: number): string {
    return `${sessionId}|${String(revision)}`
  }

  return {
    register(session) {
      // The protocol lives on the *Electron session* the renderer's webContents
      // fetches from. The Freya Browser session is `freya-public-<id>` per tab;
      // the renderer that shows chat surfaces reads from the default session
      // unless we wire it up there too. So we register on the session this
      // function was handed and trust the caller to pass the right one.
      session.protocol.handle(SCHEME, (request) => {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        let parsed: URL
        try { parsed = new URL(request.url) } catch { return new Response(null, { status: 403 }) }
        if (parsed.protocol !== `${SCHEME}:`) return new Response(null, { status: 403 })
        if (parsed.hostname !== '') return new Response(null, { status: 403 })
        const path = parsed.pathname.replace(/^\/+/, '')
        if (!path.startsWith(PATH_PREFIX)) return new Response(null, { status: 403 })
        const tail = path.slice(PATH_PREFIX.length)
        const match = /^([^/]+)\/(\d+)\.png$/.exec(tail)
        if (match === null) return new Response(null, { status: 403 })
        const sessionId = match[1] ?? ''
        const revision = Number(match[2] ?? '0')
        if (sessionId === '' || !Number.isFinite(revision)) return new Response(null, { status: 403 })
        const entry = entries.get(key(sessionId, revision))
        if (entry === undefined) return new Response(null, { status: 404 })
        // Cache headers: a screenshot is a point-in-time capture, but the
        // renderer may ask for the same one many times (the model re-asks). A
        // private, short-lived cache is honest: the surface invalidates by
        // stashing a new revision.
        // The Response body type is `BodyInit`, whose lib.dom.d.ts definition
        // does not include the Node `Buffer` we store. We hand it the bytes as
        // an `ArrayBuffer` slice, which both typings agree on.
        const ab = entry.png.buffer instanceof ArrayBuffer
          ? entry.png.buffer.slice(entry.png.byteOffset, entry.png.byteOffset + entry.png.byteLength)
          : (new Uint8Array(entry.png).slice().buffer)
        return new Response(ab, {
          status: 200,
          headers: {
            'content-type': entry.contentType,
            'content-length': String(entry.png.byteLength),
            'cache-control': 'private, max-age=10',
            'x-content-type-options': 'nosniff',
          },
        })
      })
    },
    store(sessionId, revision, png, contentType) {
      // Drop every prior revision for this session, so an old URL cannot be
      // served by a stale entry. The renderer is expected to ask for the
      // current revision only; the new `mediaUrl` it just received names it.
      for (const k of [...entries.keys()]) {
        if (k.startsWith(`${sessionId}|`)) entries.delete(k)
      }
      entries.set(key(sessionId, revision), { png, contentType, revision })
    },
    drop(sessionId) {
      for (const k of [...entries.keys()]) {
        if (k.startsWith(`${sessionId}|`)) entries.delete(k)
      }
    },
  }
}
