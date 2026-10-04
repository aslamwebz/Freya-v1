import {
  BROWSER_BRIDGE_LIMITS,
  isBrowserProtectedFieldKind,
  type BrowserBridgeRefusalCode,
  type BrowserProtectedFieldKind,
} from './types'

/**
 * The page boundaries, as pure predicates.
 *
 * This is the Core-owned half of "the extension cannot reach a page Freya must not
 * touch". The extension enforces the same rules in its content script for speed, and
 * the host re-checks here — because a rule that lives only in the client is a rule a
 * compromised client can ignore, and a rule that lives only in the host is a rule that
 * runs after the page has already been read.
 *
 * Two principles are load-bearing:
 *
 *   - **Fail closed.** An unsupported scheme, an unparsable URL, a private or
 *     link-local host, a non-top frame, a cross-origin frame and a protected field are
 *     all refusals. There is no "allow by default" branch.
 *   - **A page cannot impersonate the extension.** Nothing here trusts the *page*; the
 *     origin checks in the transport do. This module decides what a page may be *read
 *     or acted on*, not who is asking.
 */

/* -------------------------------------------------------------- page URLs */

/** Only `http:` and `https:` are ever acted on. Everything else is refused. */
export const BROWSER_BRIDGE_ALLOWED_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:'])

/**
 * Schemes that name browser internals or local resources.
 *
 * Listed separately from "not http/https" so the refusal can say *why*: a `chrome://`
 * page is a different fact from an `ftp://` page, and a person reading an audit should
 * be able to tell them apart.
 */
export const BROWSER_BRIDGE_INTERNAL_SCHEMES: readonly string[] = Object.freeze([
  'chrome:',
  'chrome-extension:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'about:',
  'devtools:',
  'view-source:',
  'file:',
  'filesystem:',
  'data:',
  'blob:',
  'javascript:',
  'ws:',
  'wss:',
  'ftp:',
  'ftps:',
])

export interface BridgeUrlOptions {
  /**
   * Whether private, loopback and link-local hosts are permitted.
   *
   * Default false, and the default is the point: a bridge that reached a router admin
   * page or a development server on `localhost` because nobody said not to would be a
   * browser-control stack with a hole in it. A host may set this only for a narrow,
   * owner-declared development session.
   */
  readonly allowPrivateHosts?: boolean
  /** Extra hosts the owner has explicitly allowed, lower-case, no port. */
  readonly allowedHosts?: readonly string[]
}

export type BridgeUrlReading =
  | { readonly ok: true; readonly url: string; readonly host: string; readonly origin: string }
  | { readonly ok: false; readonly code: BrowserBridgeRefusalCode; readonly reason: string }

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0]
}

/**
 * Whether a host is loopback, private, link-local or otherwise not on the public web.
 *
 * Over-matches a little on purpose (a bare single-label name is treated as internal),
 * because the cost of refusing a public page is one refusal and the cost of allowing a
 * router admin page is a different kind of failure entirely.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '' || lower === 'localhost') return true
  if (lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true
  }
  if (!lower.includes('.') && !lower.includes(':')) return true
  const v4 = parseIpv4(lower)
  if (v4 !== null) {
    const [a, b] = v4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true
  }
  return false
}

/**
 * Judge a page URL.
 *
 * Order matters: unparsable first (so a caller cannot smuggle a shape past the scheme
 * check), then scheme, then credentials-in-URL, then the host. A URL carrying a username
 * or password is refused rather than stripped, because stripping it would hide that
 * somebody sent one.
 */
export function checkBridgePageUrl(candidate: unknown, options: BridgeUrlOptions = {}): BridgeUrlReading {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2048) {
    return {
      ok: false,
      code: 'payload-invalid',
      reason: 'A page URL must be a non-empty string of at most 2048 characters.',
    }
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return {
      ok: false,
      code: 'payload-invalid',
      reason: 'That is not a URL this bridge can parse, and it was not repaired into one.',
    }
  }
  if (BROWSER_BRIDGE_INTERNAL_SCHEMES.includes(parsed.protocol)) {
    return {
      ok: false,
      code: 'sensitive-url',
      reason: `The scheme "${parsed.protocol}" names a browser-internal or local resource, which the bridge never reads or acts on.`,
    }
  }
  if (!BROWSER_BRIDGE_ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return {
      ok: false,
      code: 'sensitive-url',
      reason: `The scheme "${parsed.protocol}" is not routable. Only ${BROWSER_BRIDGE_ALLOWED_SCHEMES.join(' and ')} are.`,
    }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      code: 'sensitive-url',
      reason: 'That URL carries a username or password in it. A credential in a URL is refused rather than stripped, because stripping it would hide that somebody sent one.',
    }
  }
  const host = parsed.hostname.toLowerCase()
  if (host === '') {
    return { ok: false, code: 'sensitive-url', reason: 'That URL has no host.' }
  }
  if (!options.allowPrivateHosts && isPrivateOrLocalHost(host)) {
    return {
      ok: false,
      code: 'sensitive-url',
      reason: `"${host}" is a loopback, private or link-local host. The bridge does not reach a local service unless the owner has explicitly enabled it for a development session.`,
    }
  }
  const allow = options.allowedHosts
  if (allow !== undefined && allow.length > 0 && !allow.includes(host)) {
    return {
      ok: false,
      code: 'sensitive-url',
      reason: `"${host}" is not one of the hosts the owner shared with this session.`,
    }
  }
  return { ok: true, url: parsed.toString(), host, origin: parsed.origin }
}

/* ------------------------------------------------------------------ frames */

export interface BridgeFrameInput {
  readonly frameId: number
  readonly topFrame: boolean
  /** Whether the frame's origin equals the top frame's origin. */
  readonly sameOrigin: boolean
}

export type BridgeFrameReading =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BrowserBridgeRefusalCode; readonly reason: string }

/**
 * Only the top frame is acted on.
 *
 * A subframe is not what the owner sees, and a cross-origin subframe is a different
 * origin's content inside the page. Both are refused: `not-top-frame` for the first,
 * `cross-origin-frame` for the second. The bridge never tries to resolve an origin
 * mismatch — it fails closed.
 */
export function checkBridgeFrame(input: BridgeFrameInput): BridgeFrameReading {
  if (!input.topFrame) {
    return {
      ok: false,
      code: 'not-top-frame',
      reason: 'Only the top frame is acted on, because a subframe is not the page the owner is looking at.',
    }
  }
  if (!input.sameOrigin) {
    return {
      ok: false,
      code: 'cross-origin-frame',
      reason: 'A cross-origin frame is refused, because its content belongs to a different origin.',
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------ form fields */

/** The descriptor a content script reports about a field. Data only; no value. */
export interface BridgeFieldDescriptor {
  readonly tagName: string
  readonly type: string | null
  readonly name: string | null
  readonly id: string | null
  readonly autocomplete: string | null
  readonly placeholder: string | null
  readonly ariaLabel: string | null
}

const PROTECTED_AUTOCOMPLETE: readonly string[] = Object.freeze([
  'current-password',
  'new-password',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'one-time-code',
  'webauthn',
])

const PROTECTED_NAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /pass(word|wd|phrase)?/i,
  /\bpwd\b/i,
  /credit.?card/i,
  /card.?(number|num|no)\b/i,
  /\bcc.?(num|number|no)\b/i,
  /\bcvc\b|\bcvv\b|\bcsc\b|\bcvn\b/i,
  /security.?code/i,
  /social.?security|\bssn\b/i,
  /\botp\b|one.?time|\b2fa\b|\bmfa\b/i,
  /auth.?token|access.?token|api.?key|secret|passphrase|token/i,
])

/**
 * Classify a field as protected, or null.
 *
 * Checked in a fixed order so the *most specific* kind wins and the refusal can name it.
 * `type="hidden"` is protected because a hidden field is where a CSRF token, a session
 * id or a payment nonce lives; reading one would be reading a credential.
 */
export function classifyProtectedField(
  field: BridgeFieldDescriptor,
): BrowserProtectedFieldKind | null {
  const type = (field.type ?? '').toLowerCase()
  const autocomplete = (field.autocomplete ?? '').toLowerCase()
  const haystack = [field.name ?? '', field.id ?? '', field.placeholder ?? '', field.ariaLabel ?? '']
    .join(' ')
    .toLowerCase()

  if (type === 'password') return 'password'
  if (type === 'hidden') return 'hidden'
  for (const token of PROTECTED_AUTOCOMPLETE) {
    if (autocomplete.split(/\s+/).includes(token)) {
      if (token === 'cc-number') return 'payment-card'
      if (token === 'cc-csc') return 'payment-cvc'
      if (token.startsWith('cc-exp')) return 'payment-expiry'
      if (token === 'one-time-code') return 'one-time-code'
      if (token.includes('password')) return 'password'
      return 'authentication'
    }
  }
  for (const pattern of PROTECTED_NAME_PATTERNS) {
    if (pattern.test(haystack)) {
      if (/card|cc\.|cvc|cvv|csc|cvn|security.?code/i.test(haystack)) return 'payment-card'
      if (/pass|pwd|passphrase/i.test(haystack)) return 'password'
      if (/otp|one.?time|2fa|mfa/i.test(haystack)) return 'one-time-code'
      return 'authentication'
    }
  }
  return null
}

/** Whether a field descriptor is one the bridge will never touch. */
export function isProtectedField(field: BridgeFieldDescriptor): boolean {
  return classifyProtectedField(field) !== null
}

/** A reading of a protected-field descriptor, as a refusal. */
export function protectedFieldRefusal(
  field: BridgeFieldDescriptor,
): { readonly code: BrowserBridgeRefusalCode; readonly reason: string } | null {
  const kind = classifyProtectedField(field)
  if (kind === null) return null
  if (!isBrowserProtectedFieldKind(kind)) {
    return {
      code: 'protected-field',
      reason: 'That field is protected, and the bridge never touches a protected field.',
    }
  }
  return {
    code: 'protected-field',
    reason: `That field is a ${kind} field. The bridge never reads from or types into a password, payment, hidden or authentication field.`,
  }
}

/* -------------------------------------------------------------- text bounds */

/** Bytes of UTF-8, without allocating when the string is short. */
export function utf8Bytes(value: string): number {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** Truncate text to a byte ceiling on a code-point boundary, never mid-character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value
  let out = ''
  let bytes = 0
  for (const char of value) {
    const size = utf8Bytes(char)
    if (bytes + size > maxBytes) break
    out += char
    bytes += size
  }
  return out
}

/** The page-text ceiling, exposed so a caller cannot use a different number. */
export const BROWSER_BRIDGE_TEXT_CEILING = BROWSER_BRIDGE_LIMITS.maxPageTextBytes
