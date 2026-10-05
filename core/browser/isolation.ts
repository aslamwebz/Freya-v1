import { isPrivateOrLocalHost, checkBridgePageUrl, truncateUtf8, utf8Bytes } from '../browserext'
import { assertPublicUrl } from '../research/url-policy'

/**
 * Public browser isolation.
 *
 * The embedded Freya Browser is allowed to be a *real* browser: it renders scripts,
 * because a client-rendered page that yields nothing is not a browser. What it is not
 * allowed to be is a browser that knows anything about the person using it. That is the
 * whole safety argument, and this file is where it is made structural:
 *
 *   1. **A non-persistent partition.** `freya-public-<id>`, never `persist:`-prefixed, so
 *      Electron keeps it in memory and nothing is written to the profile on disk. There
 *      is no path from this window to Freya's own storage, to the owner's Chrome profile,
 *      or to a session that outlives the process.
 *   2. **An empty one.** Cleared on acquire and again on release, so a partition whose
 *      previous close was interrupted cannot hand its cookies to the next session.
 *   3. **A URL policy it does not own.** {@link assertPublicBrowserUrl} composes the
 *      Phase 5 research URL policy with the Phase 43 extension page policy, so the
 *      public browser refuses exactly what both of those refuse, rather than having a
 *      third answer.
 *   4. **No credentials, in or out.** {@link assertCredentialFree} is the function a
 *      handoff must pass, and it looks at keys *and* values because a field called
 *      `sessionHeader` carrying a cookie is the same leak as a field called `cookies`.
 *
 * ## What is deliberately not here
 *
 * No reference to Electron, no window, no session object. This module is pure policy and
 * is audited for impurity the way `core/devicehands` audits its own. The window that
 * enforces these rules lives in `electron/browser/freyaWindow.ts`, and it cannot reach
 * this file's constants without importing them — which is the mechanism that keeps the
 * two from drifting.
 */

/* --------------------------------------------------------------- the partition */

/**
 * The prefix of every Freya Browser session partition.
 *
 * `freya-public-` and not `persist:freya-`. The distinction is the whole design: a
 * `persist:` partition is written to `userData` and survives a restart, which is what
 * makes a browser *remember* you. A browser Freya opens on the owner's behalf must not
 * remember them on the owner's disk.
 */
export const PUBLIC_BROWSER_PARTITION_PREFIX = 'freya-public-'

/** The prefix that would make a partition durable. Named so it can be refused by name. */
export const PERSISTENT_PARTITION_PREFIX = 'persist:'

/** A session id shaped for use inside a partition name. */
const SESSION_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/

export type IsolationReading =
  | { readonly ok: true; readonly partition: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * The partition name for one public session.
 *
 * Refuses rather than repairs. A session id that is not already a safe token does not
 * get its punctuation stripped, because the two results are different partitions and the
 * caller is holding the first id.
 */
export function publicBrowserPartition(sessionId: string): IsolationReading {
  if (typeof sessionId !== 'string' || !SESSION_ID_SHAPE.test(sessionId)) {
    return {
      ok: false,
      code: 'request-malformed',
      reason:
        'A public browser session id must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit. The id is used to name an isolated session partition, so it is a token rather than a name.',
    }
  }
  const partition = `${PUBLIC_BROWSER_PARTITION_PREFIX}${sessionId}`
  const checked = assertNonPersistentPartition(partition)
  if (!checked.ok) return checked
  return { ok: true, partition }
}

/**
 * Whether a partition name is one this build is willing to hand a page.
 *
 * The rule is a single check with a single reason, and it is exported separately because
 * the window factory calls it on every lease: a partition that is `persist:`-prefixed,
 * empty, or contains a path separator is refused here rather than passed to Electron.
 */
export function assertNonPersistentPartition(name: string): IsolationReading {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    return { ok: false, code: 'request-malformed', reason: 'A session partition must be a short, non-empty name.' }
  }
  // Case-insensitive on purpose. Electron's own prefix is lower-case, so `PERSIST:` would not
  // actually persist — but a name that only *looks* durable is exactly the kind of thing that
  // survives a refactor as `persist:` and then quietly starts writing to disk.
  if (name.toLowerCase().startsWith(PERSISTENT_PARTITION_PREFIX)) {
    return {
      ok: false,
      code: 'partition-persistent',
      reason:
        'That session partition is persistent, so the pages it visits would write cookies and storage to the owner\'s disk. The Freya Browser only ever uses in-memory partitions.',
    }
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return {
      ok: false,
      code: 'request-malformed',
      reason: 'A session partition name may not contain a path separator.',
    }
  }
  return { ok: true, partition: name }
}

/**
 * How many public partitions the host will hold at once.
 *
 * One per live session, and {@link BROWSER_LIMITS_MAX} caps the sessions, so this is the
 * second of two independent bounds rather than the only one.
 */
export const PUBLIC_BROWSER_POOL_SIZE = 2

/* ------------------------------------------------------------- permissions */

/**
 * The permissions a page in the Freya Browser is refused, all of them, with no exception.
 *
 * `core/devicehands` refuses a whole *surface* of authority — there is no camera action,
 * no microphone action — and this is the same rule applied to the browser: a permission
 * is authority, and this browser holds none of it. The list is closed so that a caller
 * cannot pass "well, not *that* one" as a configuration: the handler in
 * `electron/browser/freyaWindow.ts` answers `false` to everything, and this table exists
 * so a test can assert that it has not quietly grown a carve-out.
 */
export const PUBLIC_BROWSER_DENIED_PERMISSIONS: readonly string[] = Object.freeze([
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'pointerLock',
  'fullscreen',
  'openExternal',
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'audioCapture',
  'videoCapture',
  'window-management',
  'idle-detection',
  'storage-access',
])

/** Schemes a page may never be navigated to, by Freya or by itself. */
export const PUBLIC_BROWSER_DENIED_SCHEMES: readonly string[] = Object.freeze([
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'view-source:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'ftp:',
  'ws:',
  'wss:',
  'intent:',
  'shell:',
])

/* ------------------------------------------------------------------- URLs */

/**
 * The scheme list a public navigation may use. Two, and they are the same two the Phase 5
 * research transport and the Phase 43 bridge both allow.
 */
export const PUBLIC_BROWSER_ALLOWED_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:'])

export interface PublicUrlOptions {
  /** The owner's host allowlist. Empty means "no host is allowlisted". */
  readonly allowedHosts?: readonly string[]
  /** Whether a private or loopback host may be opened. Off unless the owner said so. */
  readonly allowPrivateHosts?: boolean
}

export type PublicUrlReading =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly code: 'url-refused'; readonly reason: string }

/**
 * Decide whether the Freya Browser may open this address.
 *
 * Three existing policies composed rather than three new ones:
 *
 *   - {@link assertPublicUrl} — the Phase 5 rule: http/https, no userinfo, no port, no
 *     loopback, no reserved address, no bare or `.local` host.
 *   - {@link checkBridgePageUrl} — the Phase 43 rule: the same shape again, plus the
 *     owner's host allowlist. Composed *after* `assertPublicUrl` so a host that is
 *     private is refused by the first and one that is merely unlisted by the second, and
 *     the refusal names which of the two it was.
 *   - {@link PUBLIC_BROWSER_DENIED_SCHEMES} — the internal schemes a page could use to
 *     reach the machine, redundant with the two above and kept because redundant refusal
 *     is cheaper than a clever bypass.
 *
 * The returned `url` is the *normalised* href, never the string that was passed in, so a
 * caller that reads a stale field cannot act on a different address than the one checked.
 */
export function assertPublicBrowserUrl(
  candidate: unknown,
  options: PublicUrlOptions = {},
): PublicUrlReading {
  if (typeof candidate !== 'string') {
    return { ok: false, code: 'url-refused', reason: 'A navigation needs a URL, and this is not a string.' }
  }
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(candidate.trim())
  if (scheme !== null && PUBLIC_BROWSER_DENIED_SCHEMES.includes(scheme[1]!.toLowerCase())) {
    return {
      ok: false,
      code: 'url-refused',
      reason: `"${scheme[1]}" is not something the Freya Browser opens. It opens http and https, and nothing that can name the machine, a file, an extension or a script.`,
    }
  }

  let normalised: URL
  if (options.allowPrivateHosts === true) {
    // Local development profile: localhost/private hosts and explicit dev ports are
    // allowed. Non-web schemes and credential-bearing URLs remain malformed inputs,
    // not permission decisions.
    try {
      normalised = new URL(candidate)
    } catch {
      return { ok: false, code: 'url-refused', reason: 'That address is not a URL Freya can parse.' }
    }
    if (
      !PUBLIC_BROWSER_ALLOWED_SCHEMES.includes(normalised.protocol) ||
      normalised.username !== '' ||
      normalised.password !== ''
    ) {
      return {
        ok: false,
        code: 'url-refused',
        reason: 'Local browser testing accepts http/https URLs, but not credential-bearing or non-web URLs.',
      }
    }
  } else {
    try {
      normalised = assertPublicUrl(candidate)
    } catch {
      return {
        ok: false,
        code: 'url-refused',
        reason:
          'That address is not one Freya opens. It must be http or https, with no userinfo, no port, and a host that is a public address rather than a loopback, private or reserved one.',
      }
    }
  }

  const host = normalised.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (isPrivateOrLocalHost(host) && options.allowPrivateHosts !== true) {
    return {
      ok: false,
      code: 'url-refused',
      reason: `"${host}" is a private or local host. The Freya Browser is for the public web; opening a private address is what the research transport exists to refuse.`,
    }
  }

  const bridge = checkBridgePageUrl(normalised.href, {
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: [...options.allowedHosts] }),
    allowPrivateHosts: options.allowPrivateHosts === true,
  })
  if (!bridge.ok) {
    return {
      ok: false,
      code: 'url-refused',
      reason: `That address was refused by the shared page policy: ${bridge.reason}`,
    }
  }

  return { ok: true, url: normalised.href, host }
}

/* ------------------------------------------------------------- credentials */

/**
 * Keys that name a credential, a session, or the contents of one browser context.
 *
 * A closed list, matched case-insensitively as a substring, because the realistic
 * failure is not a field called `cookies` — it is a field called `authHeader` or
 * `sessionStorageDump` written by somebody who did not think of this module.
 */
export const CREDENTIAL_SHAPED_KEYS: readonly string[] = Object.freeze([
  'cookie',
  'set-cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'authorization',
  'auth-header',
  'authheader',
  'bearer',
  'session',
  'sessionid',
  'localstorage',
  'indexeddb',
  'storage',
  'profilepath',
  'keyring',
  'vault',
  'otp',
  'mfa',
  'totp',
  'csrf',
  'xsrf',
  'samesite',
  'webauthn',
  'privatekey',
  'clientsecret',
  'apikey',
])

/**
 * Value shapes that are a credential even when the key is innocent.
 *
 * `__Secure-`/`__Host-` prefixed cookies and `Bearer`/`Basic` headers are matched
 * because they are syntactically unmistakable, a JWT by its three base64url segments, and a
 * **cookie jar** by two or more `name=value` pairs separated by semicolons — which is the
 * form a serialised `document.cookie` or a `Cookie:` header actually takes.
 *
 * The semicolon is what keeps this from firing on a URL's query string, which is `&`-separated.
 * This is a *refusal*, not a detector: a false positive costs a handoff and a false negative
 * costs a session, so the bar is set high on purpose.
 */
export const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /__Secure-/i,
  /__Host-/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\bBasic\s+[A-Za-z0-9+/]+=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:^|[;\s])[A-Za-z0-9_-]{2,}=[^;]*;\s*[A-Za-z0-9_-]{2,}=/,
])

/**
 * What a handoff may carry across a browser boundary.
 *
 * Four keys, all of them things a person could say out loud. Not a `Record<string, unknown>`
 * with a filter applied: a *closed* set, so a caller cannot add a fifth field by trying.
 * `note` is the only free text, it is bounded, and it is still scanned by
 * {@link assertCredentialFree} before it is allowed anywhere.
 */
export const HANDOFF_CONTEXT_KEYS: readonly string[] = Object.freeze(['title', 'note'])

export type CredentialReading =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'credential-carry-refused'; readonly reason: string }

/**
 * Refuse anything shaped like a credential crossing between browser contexts.
 *
 * Applied to a whole context object, to every key, to every value, and to the key=value
 * pair — because a leak is a leak whichever half of it is the giveaway. This is the one
 * function in the phase whose refusal is not negotiable by a caller: there is no option,
 * no flag and no owner approval that lets a cookie be carried from the person's Chrome
 * into Freya's browser, because doing so would *merge the two contexts*, and the two
 * contexts being separate is the entire reason the extension exists.
 */
export function assertCredentialFree(value: unknown, where: string): CredentialReading {
  const walk = (node: unknown, path: string): CredentialReading => {
    if (node === null || node === undefined) return { ok: true }
    if (typeof node === 'string') {
      for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
        if (pattern.test(node)) {
          return {
            ok: false,
            code: 'credential-carry-refused',
            reason: `${path} ${where} looks like a credential or a session token. Browser contexts are never merged, so this is refused whatever it is called.`,
          }
        }
      }
      return { ok: true }
    }
    if (typeof node === 'number' || typeof node === 'boolean') return { ok: true }
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) {
        const reading = walk(entry, `${path}[${String(index)}]`)
        if (!reading.ok) return reading
      }
      return { ok: true }
    }
    if (typeof node === 'object') {
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        const lowered = key.toLowerCase()
        if (CREDENTIAL_SHAPED_KEYS.some((word) => lowered.includes(word))) {
          return {
            ok: false,
            code: 'credential-carry-refused',
            reason: `${path}.${key} ${where} names a credential, a session or browser storage. Nothing of the kind crosses between the Freya Browser and the paired Chrome extension.`,
          }
        }
        const reading = walk(entry, `${path}.${key}`)
        if (!reading.ok) return reading
      }
      return { ok: true }
    }
    return {
      ok: false,
      code: 'credential-carry-refused',
      reason: `${path} ${where} is a value Freya will not carry between browser contexts.`,
    }
  }
  return walk(value, 'the value')
}

/**
 * Bound a free-text handoff field.
 *
 * Truncating on a UTF-8 boundary rather than on a code unit, because a handoff note that
 * ends in half a character is a string that cannot be printed, logged or compared, and
 * the one time that matters is when somebody reads the audit.
 */
export function boundHandoffText(value: unknown, maxBytes: number): CredentialReading & { readonly text?: string } {
  if (value === null || value === undefined) return { ok: true }
  if (typeof value !== 'string') {
    return { ok: false, code: 'credential-carry-refused', reason: 'A handoff note must be text.' }
  }
  const reading = assertCredentialFree(value, 'a handoff note')
  if (!reading.ok) return reading
  return { ok: true, text: truncateUtf8(value, maxBytes) }
}

/* -------------------------------------------------------------------- audit */

/**
 * Structural audits over this module's tables. Never used by production code.
 */
export function auditPublicIsolation(): readonly string[] {
  const findings: string[] = []

  // The prefix must not be one that makes a partition durable, in any casing.
  if (PUBLIC_BROWSER_PARTITION_PREFIX.startsWith(PERSISTENT_PARTITION_PREFIX)) {
    findings.push('The public partition prefix would make every partition persistent.')
  }
  if (PUBLIC_BROWSER_PARTITION_PREFIX.includes('persist')) {
    findings.push('The public partition prefix contains the word "persist".')
  }

  // A denied permission that is also allowed would be a contradiction in a comment.
  const denied = new Set(PUBLIC_BROWSER_DENIED_PERMISSIONS)
  for (const scheme of PUBLIC_BROWSER_DENIED_SCHEMES) {
    if (PUBLIC_BROWSER_ALLOWED_SCHEMES.includes(scheme)) {
      findings.push(`${scheme} is both allowed and denied.`)
    }
  }
  if (denied.has('media')) {
    // Kept explicit: `media` covers camera and microphone, and this phase adds none of
    // either to any browser.
  } else {
    findings.push('The `media` permission is no longer denied, which would open camera and microphone.')
  }

  // A credential-shaped key that also appears in the allowed handoff context would mean
  // the two tables disagree about the same word.
  for (const key of HANDOFF_CONTEXT_KEYS) {
    const lowered = key.toLowerCase()
    if (CREDENTIAL_SHAPED_KEYS.some((word) => lowered.includes(word))) {
      findings.push(`The handoff context key "${key}" is credential-shaped.`)
    }
  }

  // Every denied scheme must actually be a scheme.
  for (const scheme of PUBLIC_BROWSER_DENIED_SCHEMES) {
    if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme)) findings.push(`${scheme} is not a URL scheme.`)
  }

  // A handoff context key must be a bare, non-empty name.
  for (const key of HANDOFF_CONTEXT_KEYS) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) findings.push(`${key} is not a bare context key.`)
  }

  return findings
}

/**
 * Bytes a string occupies, re-exported so the handoff module does not import two
 * measuring functions from two places. Delegating rather than reimplementing keeps
 * there being exactly one definition of "how long is this in UTF-8".
 */
export const bytesOf = utf8Bytes