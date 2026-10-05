import type { DeviceHandsActionKey } from '../devicehands'

/**
 * Phase 51 — Dual Browser Runtime: the closed vocabularies.
 *
 * This is the one file that says what a browser *is* in this build, and every other
 * module in `core/browser` decides only among the entries named here. The shape follows
 * `core/browserext/types.ts` and `core/devicehands/types.ts` for a reason that is not
 * stylistic: those two are the only places a browser command or a refusal code has ever
 * been allowed to be written down, and a third spelling of the same idea would be a
 * third place a reviewer has to read.
 *
 * ## The two targets
 *
 * Freya has exactly two ways to be in a page, and this file names both:
 *
 *   - `public` — the **embedded Freya Browser**. A window Freya owns, in a session
 *     partition with no credentials in it, used for public reading, research,
 *     previews and agent-controlled work that needs no person.
 *   - `authenticated` — the **Chrome extension** that Phase 43 shipped. The person's own
 *     browser, their own logins, their own MFA, their own complex-site state.
 *
 * ## What is deliberately absent
 *
 * There is no third target, no `implicit` target, no `any`, no `default` value that is
 * not spelled out, and no way to name a URL, a cookie jar, a storage bucket, a profile
 * or a browser session as a target. The whole point of a dual-browser runtime is that
 * those two cases are *different cases* with *different safety properties*, and a
 * vocabulary loose enough to hold "whichever browser" is a vocabulary that has thrown
 * the distinction away.
 *
 * **Routing decides. Nothing here grants.** Every entry below is a name for a decision
 * somebody else has already made; the authority for actually touching a page is still
 * the Phase 35 Device Hands runtime, reached through the same gates, the same grant
 * source and the same STOP ALL latch as everything else in this architecture.
 */

/* ------------------------------------------------------------------- targets */

/**
 * The two execution targets. Total, closed, and deliberately two.
 *
 * `public` is Freya's own browser and carries no credentials. `authenticated` is the
 * extension, and everything about it is the *person's* rather than Freya's. The two are
 * not interchangeable and neither is a fallback for the other: see `./routing`.
 */
export const BROWSER_TARGETS = ['public', 'authenticated'] as const
export type BrowserTarget = (typeof BROWSER_TARGETS)[number]

export function isBrowserTarget(value: unknown): value is BrowserTarget {
  return typeof value === 'string' && (BROWSER_TARGETS as readonly string[]).includes(value)
}

/**
 * What a caller is asking to be allowed to do.
 *
 * `read` is an observation: navigate, read text, describe a page. `act` is a change in
 * the world: a click, a keystroke. Both map onto Device Hands actions that already exist
 * and both are gated by the same ten gates; `act` is named separately because the routing
 * decision genuinely differs (a caller that may read publicly may still not act), and
 * because the *consequence* differs — in `core/devicehands`, `browser.click` and
 * `browser.type-text` are approval-requiring and `browser.navigate` and
 * `browser.read-text` are not.
 */
export const BROWSER_MODES = ['read', 'act'] as const
export type BrowserMode = (typeof BROWSER_MODES)[number]

export function isBrowserMode(value: unknown): value is BrowserMode {
  return typeof value === 'string' && (BROWSER_MODES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ commands */

/**
 * Every command the dual-browser runtime routes.
 *
 * Each names an *operation*, never a target and never a capability. The target is a
 * field of the request; the capability is Device Hands' business and is not visible
 * here at all.
 *
 * There is no `execute-script`, no `eval`, no `get-cookies`, no `get-storage`,
 * no `get-history`, no `screenshot`, no `download` and no `set-cookie`. The absence is
 * the guarantee, and `tests/red-team/browser` asserts every one of those absences rather
 * than trusting this sentence.
 */
export const BROWSER_COMMANDS = [
  'session.open',
  'session.close',
  'session.state',
  'page.navigate',
  'page.read',
  'page.describe',
  'page.click',
  'page.type',
  'media.describe',
  'handoff.offer',
  'handoff.accept',
  'handoff.list',
  'handoff.cancel',
] as const
export type BrowserCommand = (typeof BROWSER_COMMANDS)[number]

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  return typeof value === 'string' && (BROWSER_COMMANDS as readonly string[]).includes(value)
}

/**
 * The Device Hands action each command maps to, when it maps to one.
 *
 * **Total**, so a command cannot be added without deciding what authority it needs.
 * That is the property that stops this layer growing a route of its own: a command with
 * `null` here is an observation the host serves directly, and even those are refused by
 * the target check, the STOP ALL latch and the subsystem switch before they run.
 *
 * The mapping is the same one `core/browserext` already uses for the extension, and the
 * four browser keys are the four `DeviceHandsActionKey` browser members — so the
 * extension and the embedded browser are two *ports* onto one set of gates rather than
 * two capabilities with their own grants. `page.click` is `browser.click` for both.
 */
export const BROWSER_COMMAND_ACTION: Readonly<Record<BrowserCommand, DeviceHandsActionKey | null>> =
  Object.freeze({
    'session.open': null,
    'session.close': null,
    'session.state': null,
    'page.navigate': 'browser.navigate',
    'page.read': 'browser.read-text',
    'page.describe': 'browser.read-text',
    'page.click': 'browser.click',
    'page.type': 'browser.type-text',
    'media.describe': null,
    'handoff.offer': null,
    'handoff.accept': null,
    'handoff.list': null,
    'handoff.cancel': null,
  })

/** The mode a command belongs to. Total, for the same reason. */
export const BROWSER_COMMAND_MODE: Readonly<Record<BrowserCommand, BrowserMode>> = Object.freeze({
  'session.open': 'read',
  'session.close': 'read',
  'session.state': 'read',
  'page.navigate': 'read',
  'page.read': 'read',
  'page.describe': 'read',
  'page.click': 'act',
  'page.type': 'act',
  'media.describe': 'read',
  'handoff.offer': 'read',
  'handoff.accept': 'read',
  'handoff.list': 'read',
  'handoff.cancel': 'read',
})

/** The commands that may only be answered by the embedded Freya Browser. */
export const PUBLIC_ONLY_COMMANDS: readonly BrowserCommand[] = Object.freeze([
  'session.open',
  'session.close',
  'media.describe',
])

/**
 * The commands that make no sense without a paired extension.
 *
 * Only `handoff.accept` is in this list, and the reason is specific rather than
 * general: accepting a handoff means *opening this URL in the person's browser*, and
 * there is no such thing as opening a tab in a browser that is not there.
 */
export const AUTHENTICATED_ONLY_COMMANDS: readonly BrowserCommand[] = Object.freeze([
  'handoff.accept',
])

/* -------------------------------------------------------------- page states */

/**
 * What Freya will say about a page.
 *
 * These are the only words the runtime may use, and each is a *claim about something
 * that was observed*. There is no `unknown`, because a runtime that cannot say what a
 * page is must say so — and `absent` is what "cannot say" looks like when there is
 * nothing loaded. A page that failed to load is `failed`, not `absent`, and a closed
 * window is `closed`, not `ready`.
 */
export const BROWSER_PAGE_STATES = ['absent', 'loading', 'ready', 'failed', 'closed'] as const
export type BrowserPageState = (typeof BROWSER_PAGE_STATES)[number]

export function isBrowserPageState(value: unknown): value is BrowserPageState {
  return typeof value === 'string' && (BROWSER_PAGE_STATES as readonly string[]).includes(value)
}

/**
 * Session states. `open` means a session exists; it does not mean a window is on screen.
 */
export const BROWSER_SESSION_STATES = ['open', 'closed'] as const
export type BrowserSessionState = (typeof BROWSER_SESSION_STATES)[number]

/* ------------------------------------------------------------ handoff states */

/**
 * The lifecycle of one handoff, and the one state that carries the phase's whole
 * restart rule.
 *
 * `uncertain` is what an `open` handoff becomes when the process ends without a record
 * of whether it was consumed. It is **not** silently resolved into `consumed` and it is
 * **not** replayed: a restart reports it and waits for a person to decide again, because
 * "it probably worked" is exactly the sentence that produces a duplicated submission.
 */
export const BROWSER_HANDOFF_STATES = [
  'open',
  'consumed',
  'cancelled',
  'expired',
  'uncertain',
] as const
export type BrowserHandoffState = (typeof BROWSER_HANDOFF_STATES)[number]

export function isBrowserHandoffState(value: unknown): value is BrowserHandoffState {
  return typeof value === 'string' && (BROWSER_HANDOFF_STATES as readonly string[]).includes(value)
}

/* -------------------------------------------------------- escalation reasons */

/**
 * Why the router may propose the authenticated target.
 *
 * Closed, because "it felt like it needed a login" is not a routing rule. Each of these
 * is something a caller can point at afterwards and say whether it was true.
 *
 * `site-blocked` is the honest odd one out: it covers a site the public browser is
 * *allowed* to read but whose content only appears for a signed-in person, so the
 * public attempt is not a mistake — it is the thing that establishes the need.
 */
export const BROWSER_ESCALATION_REASONS = [
  'login-required',
  'session-required',
  'mfa-required',
  'site-blocked',
  'explicit-request',
] as const
export type BrowserEscalationReason = (typeof BROWSER_ESCALATION_REASONS)[number]

export function isBrowserEscalationReason(value: unknown): value is BrowserEscalationReason {
  return typeof value === 'string' && (BROWSER_ESCALATION_REASONS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------- limits */

/**
 * Frozen ceilings. Narrowed by the host, never widened by a request.
 *
 * Every number here is a decision someone would otherwise make by accident: how long a
 * handoff stays offerable, how many live sessions one runtime may hold, how much text a
 * described page may carry.
 */
export const BROWSER_LIMITS = Object.freeze({
  /** Live Freya Browser sessions at once. One per owner-visible window. */
  maxSessions: 2,
  /** Offered, unsettled handoffs retained at once. */
  maxOpenHandoffs: 8,
  /** How long an offered handoff stays acceptable, in milliseconds. */
  handoffTtlMs: 5 * 60_000,
  /** Elements one described page may carry. */
  maxSnapshotElements: 120,
  /** Bytes of text one described page may carry. */
  maxSnapshotTextBytes: 4 * 1024,
  /** The longest page title retained in state. */
  maxTitleChars: 200,
  /** The longest URL retained in state or in a handoff. */
  maxUrlChars: 2048,
  /** Media offers retained for one session. */
  maxMediaOffers: 8,
  /** Wall-clock a single routed command may occupy. */
  maxCommandMs: 15_000,
})

export type BrowserLimits = typeof BROWSER_LIMITS

/* ------------------------------------------------------------- refusal codes */

/**
 * Every refusal this phase produces.
 *
 * Separate from `DEVICE_HANDS_REFUSAL_CODES` on purpose. Device Hands owns the gate
 * refusals — this phase does not get to invent a second answer to "may you click this",
 * it only relays the one it was given under `authority-refused`. The codes below are the
 * refusals that happen *before* an action is ever offered to a gate: no such target, no
 * such session, a ref from a page that has since changed, a handoff carrying something
 * credential-shaped. Those are routing and lifecycle facts, and folding them into the
 * gate vocabulary would make the audit claim Device Hands said something it did not.
 */
export const BROWSER_REFUSAL_CODES = [
  'request-malformed',
  'target-unknown',
  'target-unavailable',
  'subsystem-disabled',
  'stop-all-latched',
  'budget-exceeded',
  'deadline-exceeded',
  'session-unknown',
  'session-closed',
  'page-stale',
  'ref-unknown',
  'protected-field',
  'element-disabled',
  'url-refused',
  'media-not-observed',
  'media-write-refused',
  'handoff-unknown',
  'handoff-not-offered',
  'handoff-already-settled',
  'handoff-target-mismatch',
  'handoff-expired',
  'handoff-uncertain',
  'credential-carry-refused',
  'authority-refused',
  'adapter-failed',
] as const
export type BrowserRefusalCode = (typeof BROWSER_REFUSAL_CODES)[number]

export function isBrowserRefusalCode(value: unknown): value is BrowserRefusalCode {
  return typeof value === 'string' && (BROWSER_REFUSAL_CODES as readonly string[]).includes(value)
}

/** One sentence per code, written for a person rather than for a log. */
export const BROWSER_REFUSAL_REASONS: Readonly<Record<BrowserRefusalCode, string>> = Object.freeze({
  'request-malformed': 'That request does not have the shape this build accepts. Nothing was read from it and nothing was changed.',
  'target-unknown': 'A browser target must be "public" (Freya\'s own browser) or "authenticated" (the paired Chrome extension). There is no third target and no default that was left out.',
  'target-unavailable': 'That browser target cannot run right now. Nothing was opened and nothing was sent anywhere.',
  'subsystem-disabled': 'The dual-browser runtime is switched off, so nothing was routed.',
  'stop-all-latched': 'STOP ALL is latched, so no page was opened, read, clicked or handed off.',
  'budget-exceeded': 'This runtime is already holding as many sessions or open handoffs as it will hold.',
  'deadline-exceeded': 'The command did not finish inside its bound, so its result is unknown and is not reported as a success.',
  'session-unknown': 'No such browser session. A session id is not a guess.',
  'session-closed': 'That browser session is closed. Its page is not readable and its refs are not usable.',
  'page-stale': 'That element belongs to a version of the page that has since been replaced. Describe the page again and use the ref it gives you.',
  'ref-unknown': 'That element reference was never minted by this runtime, or it has already been retired.',
  'protected-field':
    'That element is a password, payment-card, one-time-code or other protected field. Freya does not click, read or type into one in either browser, and no handoff will carry one.',
  'element-disabled': 'That element is disabled on the page, so acting on it would report something that did not happen.',
  'url-refused': 'That address is not one Freya opens: the scheme, the host or the shape of it is refused rather than repaired.',
  'media-not-observed': 'No download was observed for that reference, so there is no metadata to describe. Nothing was written to disk.',
  'media-write-refused': 'The page tried to download something. Freya reports what it was and does not write it; fetching it is a separate, gated transfer.',
  'handoff-unknown': 'No handoff by that id. A handoff id names an offer that is still waiting; a settled or forgotten one cannot be revived.',
  'handoff-not-offered': 'There is no handoff waiting to be accepted for this page.',
  'handoff-already-settled': 'That handoff was already consumed, cancelled or expired. A settled handoff is never acted on twice.',
  'handoff-target-mismatch': 'That handoff was offered to a different browser. Freya does not carry work between contexts it was not offered to.',
  'handoff-expired': 'That handoff is older than this build will act on. Offer it again if it is still wanted.',
  'handoff-uncertain': 'The last run ended before we could record whether that handoff was used. It is not being retried; decide again deliberately.',
  'credential-carry-refused':
    'That handoff carried something shaped like a credential between browser contexts. Cookies, tokens and session identifiers are never copied from one context to the other.',
  'authority-refused': 'Device Hands refused this action. Its gates are the answer, and this runtime does not have a second opinion.',
  'adapter-failed': 'The browser did not do what was asked and said so. The result is recorded as not done.',
})

/* --------------------------------------------------------------------- events */

/**
 * What the dual-browser layer records in the durable journal.
 *
 * These are the facts *this* layer owns: a session opened, a page replaced, a ref went
 * stale, a handoff was offered. Every action a page receives is **not** here — those are
 * Device Hands' `hands.*` entries, written by the runtime that owns the authority, and
 * duplicating them would be the second record this architecture is not allowed to have.
 */
export const BROWSER_EVENT_TYPES = [
  'browser.dual.session.opened',
  'browser.dual.session.closed',
  'browser.dual.page.replaced',
  'browser.dual.page.failed',
  'browser.dual.page.described',
  'browser.dual.ref.stale',
  'browser.dual.media.observed',
  'browser.dual.handoff.offered',
  'browser.dual.handoff.consumed',
  'browser.dual.handoff.settled',
  'browser.dual.handoff.uncertain',
  'browser.dual.route.decided',
  'browser.dual.refused',
] as const
export type BrowserEventType = (typeof BROWSER_EVENT_TYPES)[number]

export const BROWSER_EVENT_TYPE_SET: ReadonlySet<string> = new Set(BROWSER_EVENT_TYPES)

export function isBrowserEventType(value: unknown): value is BrowserEventType {
  return typeof value === 'string' && BROWSER_EVENT_TYPE_SET.has(value)
}

/**
 * The exact keys each event may carry. Total, so a new event cannot be added without
 * deciding what it is allowed to say.
 *
 * Note what no event has room for: page text, a title longer than
 * {@link BROWSER_LIMITS}, a cookie, a header, a selector, or anything read off a page
 * that a person would not read out loud. A journal is a record of *decisions*, and a
 * decision record that carries page content becomes a copy of the page in a file nobody
 * audited.
 */
export const BROWSER_PAYLOAD_KEYS: Readonly<Record<BrowserEventType, readonly string[]>> =
  Object.freeze({
    'browser.dual.session.opened': ['sessionId', 'target', 'at'],
    'browser.dual.session.closed': ['sessionId', 'target', 'at'],
    'browser.dual.page.replaced': ['sessionId', 'revision', 'url', 'at'],
    'browser.dual.page.failed': ['sessionId', 'revision', 'code', 'at'],
    'browser.dual.page.described': ['sessionId', 'revision', 'elements', 'readBytes', 'at'],
    'browser.dual.ref.stale': ['sessionId', 'ref', 'refRevision', 'currentRevision', 'at'],
    'browser.dual.media.observed': ['sessionId', 'mediaId', 'mediaType', 'bytes', 'at'],
    'browser.dual.handoff.offered': ['handoffId', 'from', 'to', 'reason', 'at'],
    'browser.dual.handoff.consumed': ['handoffId', 'from', 'to', 'at'],
    'browser.dual.handoff.settled': ['handoffId', 'state', 'at'],
    'browser.dual.handoff.uncertain': ['handoffId', 'at'],
    'browser.dual.route.decided': ['command', 'target', 'mode', 'reason', 'at'],
    'browser.dual.refused': ['command', 'target', 'code', 'at'],
  })

/**
 * Keys no event may ever carry, whatever the table above says.
 *
 * Matched as a substring over every key, because the failure this guards is a well-meaning
 * new field called `cookieHeader` or `tokenPreview`, not a deliberate `cookies` key that
 * somebody could see and refuse.
 */
export const FORBIDDEN_BROWSER_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  'cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'bearer',
  'session-id',
  'credential',
  'localstorage',
  'text',
  'title',
  'selector',
  'body',
  'html',
  'innertext',
  'ref-value',
])

/**
 * Value shapes no event may carry.
 *
 * **A separate, much narrower list from the key list**, and deliberately so. The key list is
 * matched against field names, where `auth` is a strong signal. Applying that same list to
 * *values* would refuse the refusal code `authority-refused`, because "authority" contains
 * "auth" — and a journal that cannot record why it refused something is a journal that hides
 * its own reasons. So values are matched only on syntax that is unmistakable.
 */
export const FORBIDDEN_BROWSER_PAYLOAD_VALUES: readonly string[] = Object.freeze([
  '__secure-',
  '__host-',
  'bearer ',
  'basic ',
  'eyjhb',
  '-----begin',
  'cookie=',
  'set-cookie',
  'password=',
  'passwd=',
  'token=',
  'authorization:',
  'private key',
])

/** Whether a payload is exactly the keys its event type allows. */
export function browserPayloadIsValid(type: string, payload: Readonly<Record<string, unknown>>): boolean {
  if (!isBrowserEventType(type)) return false
  const allowed = BROWSER_PAYLOAD_KEYS[type]
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return false
  }
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return false
    }
    if (typeof value === 'string') {
      if (value.length > BROWSER_LIMITS.maxTitleChars && key === 'url') return false
      const lowered = value.toLowerCase()
      if (FORBIDDEN_BROWSER_PAYLOAD_VALUES.some((shape) => lowered.includes(shape))) return false
    }
    const loweredKey = key.toLowerCase()
    if (FORBIDDEN_BROWSER_PAYLOAD_KEYS.some((word) => loweredKey.includes(word))) return false
  }
  return true
}

/* -------------------------------------------------------------------- audits */

/**
 * Structural audits over the tables above. Never used by production code.
 *
 * The point is that the claims in this file's comments are the kind a change can
 * quietly undo, and an audit that a test fails on is cheaper than a reviewer noticing.
 */
export function auditBrowserTables(): readonly string[] {
  const findings: string[] = []

  // Every command is classified, and every classification is a real action key or null.
  for (const command of BROWSER_COMMANDS) {
    if (!(command in BROWSER_COMMAND_ACTION)) findings.push(`${command} has no action mapping.`)
    if (!(command in BROWSER_COMMAND_MODE)) findings.push(`${command} has no mode mapping.`)
  }
  for (const key of Object.keys(BROWSER_COMMAND_ACTION)) {
    if (!(BROWSER_COMMANDS as readonly string[]).includes(key)) {
      findings.push(`${key} is mapped but is not a routed command.`)
    }
  }

  // An `act` command must be an approval-requiring Device Hands action. This is the
  // check that keeps `act` meaning "changes the world" rather than meaning "whatever
  // somebody typed into the mode field".
  for (const command of BROWSER_COMMANDS) {
    if (BROWSER_COMMAND_MODE[command] !== 'act') continue
    const action = BROWSER_COMMAND_ACTION[command]
    if (action !== 'browser.click' && action !== 'browser.type-text') {
      findings.push(`${command} is an act but maps to ${String(action)}.`)
    }
  }

  // A read command must never map to an action that writes.
  for (const command of BROWSER_COMMANDS) {
    if (BROWSER_COMMAND_MODE[command] !== 'read') continue
    const action = BROWSER_COMMAND_ACTION[command]
    if (action === 'browser.click' || action === 'browser.type-text') {
      findings.push(`${command} is a read but maps to ${action}.`)
    }
  }

  // No banned word may appear in a routed command or a refusal code. Reusing the Phase 35
  // list is the point: this phase is not allowed to invent a synonym for "screenshot".
  const banned = [
    'screenshot',
    'capture',
    'cookie',
    'storage',
    'history',
    'profile',
    'password',
    'token',
    'eval',
    'script',
    'download',
    'keyring',
    'vault',
  ]
  for (const command of BROWSER_COMMANDS) {
    for (const word of banned) {
      if (command.toLowerCase().includes(word)) findings.push(`${command} contains "${word}".`)
    }
  }
  for (const code of BROWSER_REFUSAL_CODES) {
    for (const word of ['cookie', 'password', 'token', 'keyring', 'vault', 'screenshot']) {
      if (code.toLowerCase().includes(word)) findings.push(`refusal code ${code} contains "${word}".`)
    }
  }

  // Every event type has payload keys, and no payload key is itself forbidden.
  for (const type of BROWSER_EVENT_TYPES) {
    const keys = BROWSER_PAYLOAD_KEYS[type]
    if (keys === undefined || keys.length === 0) findings.push(`${type} has no payload keys.`)
    if (keys === undefined) continue
    for (const key of keys) {
      const lowered = key.toLowerCase()
      if (FORBIDDEN_BROWSER_PAYLOAD_KEYS.some((word) => lowered.includes(word))) {
        findings.push(`${type} may carry "${key}", which is a forbidden payload key.`)
      }
    }
    for (const key of BROWSER_PAYLOAD_KEYS[type]) {
      if (!BROWSER_PAYLOAD_KEYS[type].includes(key)) findings.push(`${type} repeats "${key}".`)
    }
  }
  for (const key of Object.keys(BROWSER_PAYLOAD_KEYS)) {
    if (!(BROWSER_EVENT_TYPES as readonly string[]).includes(key)) {
      findings.push(`${key} has payload keys but is not an event type.`)
    }
  }

  // Every refusal code has a sentence a person can act on.
  for (const code of BROWSER_REFUSAL_CODES) {
    const reason = BROWSER_REFUSAL_REASONS[code]
    if (typeof reason !== 'string' || reason.length < 20) {
      findings.push(`refusal code ${code} has no usable reason.`)
    }
  }
  for (const code of Object.keys(BROWSER_REFUSAL_REASONS)) {
    if (!(BROWSER_REFUSAL_CODES as readonly string[]).includes(code)) {
      findings.push(`reason ${code} has no refusal code.`)
    }
  }

  return findings
}