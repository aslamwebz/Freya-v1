import {
  BROWSER_SERVICE_LIMITS,
  isSemanticBrowserOp,
  type BrowserTabOrigin,
  type SemanticBrowserRequest,
} from '../../core/browser/service'

/**
 * Rebuild one Semantic Browser Protocol request from an untrusted value.
 *
 * ## Why the renderer gets its own normaliser rather than the shared one
 *
 * The renderer bridge and the Core bridge reach the same service, and a field that is safe
 * for Core is not automatically safe for a window. The difference is *who is asking*:
 *
 *   - a `tabId` from Core may name any tab, because Core is the runtime's own caller;
 *   - a `ref` is never accepted from the renderer at all. References are minted by a snapshot
 *     the renderer itself asked for, and the only thing the renderer is allowed to send back
 *     is one it received. Accepting an arbitrary reference string would mean accepting a
 *     locator the caller chose, which is precisely the "guessed coordinates" failure the
 *     protocol exists to prevent.
 *
 * So this normaliser accepts `ref` only in the reference shape, refuses `createdBy` other
 * than `user` (a window asking for a tab is the owner asking for a tab, never Freya asking on
 * their behalf), and bounds everything.
 */

export type SemanticRequestReading =
  | { readonly ok: true; readonly request: SemanticBrowserRequest }
  | { readonly ok: false; readonly reason: string }

const REF = /^r[1-9][0-9]{0,5}$/
const TAB = /^[A-Za-z0-9_-]{1,64}$/

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** An optional tab id: absent, null or a bounded id. Anything else is refused. */
function tabId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' && TAB.test(value) ? value : null
}

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point < 32 || point === 127) return null
  }
  return value
}

function origin(value: unknown): BrowserTabOrigin | undefined {
  const row = object(value)
  if (row === null) return { kind: 'manual' }
  if (row.kind === 'handoff') return { kind: 'manual' }
  if (row.kind === 'link') {
    const from = row.from
    const allowed = from === 'chat' || from === 'eye' || from === 'media' || from === 'citation' || from === 'address'
    return {
      kind: 'link',
      from: allowed ? from : 'chat',
      ownerText: typeof row.ownerText === 'string' ? row.ownerText.slice(0, 80) : 'owner',
    }
  }
  return { kind: 'manual' }
}

/**
 * Rebuild the request, or refuse with a sentence the renderer can show.
 *
 * Note what is *not* here: there is no field for a selector, a locator, a cookie, a header,
 * a principal or a context. Each of those would be a way for a window to aim the browser at
 * something the reference discipline exists to prevent.
 */
export function normaliseSemanticBrowserRequest(value: unknown): SemanticRequestReading {
  const row = object(value)
  if (row === null) return { ok: false, reason: 'A browser request must be an object.' }
  if (!isSemanticBrowserOp(row.op)) return { ok: false, reason: 'That is not a browser operation this build performs.' }

  const tab = tabId(row.tabId)
  if (tab === null) return { ok: false, reason: 'That browser tab id is not one this build hands out.' }

  const withTab = <T extends object>(rest: T): T & { readonly tabId?: string } =>
    tab === undefined ? rest : ({ ...rest, tabId: tab } as T & { readonly tabId?: string })

  switch (row.op) {
    case 'tabs':
      return { ok: true, request: { op: 'tabs' } }

    case 'open': {
      // Owner-created blank tabs explicitly send null URLs. A missing URL is
      // safe for Open: the service creates a real pending tab. Navigation below
      // still requires a valid and nonempty address.
      const url = row.url === null ? undefined : text(row.url, BROWSER_SERVICE_LIMITS.maxUrlChars)
      if (url === null) return { ok: false, reason: 'That address is too long or contains control characters.' }
      const activate = row.activate === undefined ? true : row.activate === true
      return {
        ok: true,
        request: {
          op: 'open',
          ...(url === undefined ? {} : { url }),
          origin: origin(row.origin),
          // A window asking for a tab is the owner asking. There is no path from here to
          // `createdBy: 'freya'`, so a tab the owner did not ask for cannot be attributed to
          // them, and a Freya-initiated tab cannot be laundered through the renderer.
          createdBy: 'user',
          activate,
        },
      }
    }

    case 'close':
      return { ok: true, request: withTab({ op: 'close' }) }

    case 'activate': {
      if (typeof row.tabId !== 'string' || !TAB.test(row.tabId)) {
        return { ok: false, reason: 'Switching tabs needs the id of the tab to switch to.' }
      }
      return { ok: true, request: { op: 'activate', tabId: row.tabId } }
    }

    case 'navigate': {
      const url = text(row.url, BROWSER_SERVICE_LIMITS.maxUrlChars)
      if (url === undefined || url === null) return { ok: false, reason: 'Navigation needs an address.' }
      return { ok: true, request: withTab({ op: 'navigate', url }) }
    }

    case 'snapshot':
      return { ok: true, request: withTab({ op: 'snapshot' }) }

    case 'screenshot':
      return { ok: true, request: withTab({ op: 'screenshot' }) }

    case 'click':
    case 'type':
    case 'select': {
      if (typeof row.ref !== 'string' || !REF.test(row.ref)) {
        return { ok: false, reason: 'That is not an element reference a snapshot handed out. Take a snapshot and use a reference from it.' }
      }
      if (typeof row.revision !== 'number' || !Number.isInteger(row.revision) || row.revision < 1) {
        return { ok: false, reason: 'That action must name the snapshot revision it was decided from.' }
      }
      if (row.op === 'click') return { ok: true, request: withTab({ op: 'click', ref: row.ref, revision: row.revision }) }
      if (row.op === 'select') {
        if (typeof row.index !== 'number' || !Number.isInteger(row.index) || row.index < 0 || row.index > 63) {
          return { ok: false, reason: 'Choosing an option needs an index the snapshot listed.' }
        }
        return { ok: true, request: withTab({ op: 'select', ref: row.ref, revision: row.revision, index: row.index }) }
      }
      const typed = text(row.text, 4_096)
      if (typed === null || typed === undefined) return { ok: false, reason: 'Typing needs text to type.' }
      return { ok: true, request: withTab({ op: 'type', ref: row.ref, revision: row.revision, text: typed }) }
    }

    case 'scroll': {
      const to = row.to
      if (to !== 'top' && to !== 'bottom' && (typeof to !== 'number' || !Number.isFinite(to))) {
        return { ok: false, reason: 'Scrolling needs a direction or an amount.' }
      }
      return { ok: true, request: withTab({ op: 'scroll', to: to as 'top' | 'bottom' | number }) }
    }

    case 'back':
    case 'forward':
    case 'reload':
      return { ok: true, request: withTab({ op: row.op }) }

    case 'wait': {
      const settleMs = row.settleMs === undefined ? 2_000 : row.settleMs
      if (typeof settleMs !== 'number' || !Number.isFinite(settleMs) || settleMs < 0) {
        return { ok: false, reason: 'Waiting needs how long to wait for.' }
      }
      const until = text(row.until, 200)
      if (until === null) return { ok: false, reason: 'That wait condition is too long or contains control characters.' }
      return {
        ok: true,
        request: withTab({
          op: 'wait',
          settleMs: Math.min(Math.round(settleMs), BROWSER_SERVICE_LIMITS.maxWaitMs),
          ...(until === undefined ? {} : { until }),
        }),
      }
    }

    /* istanbul ignore next -- the operation list is closed and exhaustively handled above. */
    default:
      return { ok: false, reason: 'That is not a browser operation this build performs.' }
  }
}

/**
 * Audit the normaliser against the protocol's own shapes.
 *
 * The claim worth checking is that the renderer cannot reach an act without naming a
 * reference *and* a revision. If either check were dropped, the revision discipline would
 * still hold in Core and be absent in the window, which is the wrong way round for the one
 * surface a person is looking at.
 */
export function auditSemanticBrowserRequestNormaliser(): readonly string[] {
  const findings: string[] = []
  const click = normaliseSemanticBrowserRequest({ op: 'click', ref: 'r1', revision: 4 })
  if (!click.ok) findings.push('A well-formed renderer click was refused.')
  if (click.ok && click.request.op !== 'click') findings.push('A renderer click became another operation.')
  if (normaliseSemanticBrowserRequest({ op: 'click', ref: 'r1' }).ok) findings.push('A renderer click with no revision was accepted.')
  if (normaliseSemanticBrowserRequest({ op: 'click', revision: 4 }).ok) findings.push('A renderer click with no reference was accepted.')
  if (normaliseSemanticBrowserRequest({ op: 'click', ref: '#continue', revision: 4 }).ok) {
    findings.push('A renderer click with a selector instead of a reference was accepted.')
  }
  if (normaliseSemanticBrowserRequest({ op: 'open', url: 'javascript:alert(1)' }).ok) {
    findings.push('A renderer open with a script scheme was accepted for the URL policy to reject later.')
  }
  const opened = normaliseSemanticBrowserRequest({ op: 'open', url: 'https://example.com/' })
  if (opened.ok && opened.request.op === 'open' && opened.request.createdBy !== 'user') {
    findings.push('A renderer open was attributed to something other than the owner.')
  }
  return findings
}