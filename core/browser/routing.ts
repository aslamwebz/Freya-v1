import {
  BROWSER_COMMAND_MODE,
  AUTHENTICATED_ONLY_COMMANDS,
  PUBLIC_ONLY_COMMANDS,
  isBrowserCommand,
  type BrowserCommand,
  type BrowserEscalationReason,
  type BrowserMode,
  type BrowserRefusalCode,
  type BrowserTarget,
} from './types'

/**
 * Routing: which of the two browsers an intent should run against, and when the other one
 * is the honest answer.
 *
 * ## Why a router exists at all
 *
 * `docs/BROWSER-ROADMAP.md` promised this shape before either browser existed: *"One
 * intent type. One policy point. One service. Two possible execution targets."* The
 * point of the abstraction is that the decision about **which browser** is made in one
 * place, from facts, and that it is a *routing* decision rather than an *authority*
 * decision — routing never says yes to anything.
 *
 * ## What routing will not do
 *
 * Four refusals, each a real thing this module could plausibly have done and deliberately
 * does not:
 *
 *   1. **It will not fall back silently.** If the public browser cannot open a page, that
 *      is a refusal, not a cue to open it in the person's Chrome instead. A silent
 *      fallback would move Freya from a context with no credentials into one with every
 *      credential, without anybody deciding that.
 *   2. **It will not auto-escalate by default.** Escalation to the authenticated target is
 *      *proposed*, as data, and only when the owner has turned `autoEscalate` on. Even
 *      then it is a proposal: the caller receives it and decides, because the whole
 *      difference between the two browsers is a decision somebody should make on purpose.
 *   3. **It will not read a page to decide.** {@link classifyAuthenticationNeed} reads an
 *      *observation that already exists* — counts and status codes from a read that was
 *      already authorised. It performs no I/O, so "route" can never become "fetch".
 *   4. **It cannot grant.** Every route it returns still reaches Device Hands.
 */

/* ------------------------------------------------------------------ the intent */

/**
 * One request, target named or not.
 *
 * `target: 'auto'` is the only value that is not a real target, and it resolves to the
 * *public* browser. There is no default that reaches the authenticated one, because
 * "use the person's browser unless told otherwise" is the wrong default for a system that
 * has one specifically in order not to.
 */
export type RequestedTarget = BrowserTarget | 'auto'

export interface BrowserIntent {
  readonly command: BrowserCommand
  readonly target: RequestedTarget
  /** The Freya Browser session, for commands that touch a page. */
  readonly sessionId: string | null
  readonly url: string | null
  /** An element reference from a previous description. */
  readonly ref: string | null
  readonly text: string | null
}

/* ----------------------------------------------------------------- the context */

export interface AuthenticatedContext {
  /** A token on the record. Not the same as a live connection. */
  readonly paired: boolean
  /** A connected, authenticated extension session. */
  readonly live: boolean
  /** The tab the owner has shared, if any. Actions need one; reads of a shared page need one. */
  readonly sharedTabId: number | null
}

export interface SessionContext {
  readonly exists: boolean
  readonly target: BrowserTarget
  readonly open: boolean
}

export interface RoutingContext {
  /** The Freya Browser is activated and can open a window. */
  readonly publicAvailable: boolean
  readonly authenticated: AuthenticatedContext
  readonly session: SessionContext | null
  /**
   * What the public browser last observed, when it observed anything. This is the *only*
   * input to escalation, and it is an observation rather than a prediction.
   */
  readonly observed: AuthNeedObservation | null
  /**
   * Whether the owner has allowed the router to *propose* the authenticated target when a
   * page appears to need a session. Off by default, and it never applies the route.
   */
  readonly autoEscalate: boolean
}

/* --------------------------------------------------------------- the decision */

export interface RouteEscalation {
  readonly to: BrowserTarget
  readonly reason: BrowserEscalationReason
  /** Why, in a sentence, from the observation rather than from a guess. */
  readonly detail: string
}

export type RouteReading =
  | {
      readonly ok: true
      readonly target: BrowserTarget
      readonly mode: BrowserMode
      readonly reason: string
      /** Non-null when the router believes another target should be considered. */
      readonly escalation: RouteEscalation | null
    }
  | { readonly ok: false; readonly code: BrowserRefusalCode; readonly reason: string }

/* ------------------------------------------------------- authentication need */

/**
 * What was seen, in the smallest form that can answer "does this need a person?".
 *
 * Six fields, all of them numbers or strings. No page text, no DOM, no storage: this is
 * the input to a routing decision, and a routing decision that could read a page would be
 * a fetch.
 */
export interface AuthNeedObservation {
  /** The HTTP status the public browser saw, when there was one. */
  readonly status: number | null
  /** The address requested. */
  readonly url: string
  /** The address actually landed on, which is where the answer usually is. */
  readonly finalUrl: string | null
  /** Text fields on the page. */
  readonly textFields: number
  /** Password, card and one-time-code fields. */
  readonly protectedFields: number
  /** Buttons and links whose text or name says sign in / log in. */
  readonly signInAffordances: number
  /** Bytes of readable text. A wall with no prose is a wall. */
  readonly textBytes: number
}

/**
 * Below this much readable text, a page with a sign-in affordance is treated as a wall.
 *
 * 512 bytes is roughly a paragraph. It is a judgement, so it is a named constant and a
 * table the tests can move — not a number buried in a comparison.
 */
export const LOGIN_WALL_TEXT_CEILING = 512

/** Paths that are an account or a challenge rather than a document. */
const ACCOUNT_PATH = /(?:^|[/?#])(?:login|log-in|signin|sign-in|sign_in|auth|authenticate|account|session|mfa|otp|2fa|two-factor|two_factor)(?:[/?#]|$)/i

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  } catch {
    return ''
  }
}

/**
 * The path of an address, or the whole string when it will not parse.
 *
 * Falling back to the raw string rather than to `''` matters: an address that will not
 * parse is not a document, and the branch below is a refusal.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * What a page appears to be, from an observation alone.
 *
 * Ordered most-specific first, and every branch names the number that triggered it,
 * because a routing decision that cannot be explained is a routing decision nobody will
 * trust. This function never returns `authenticated` as an answer — it returns what the
 * page *looks like*, and `./runtime` turns that into a proposal at most.
 */
export function classifyAuthenticationNeed(
  observation: AuthNeedObservation,
  sessionHosts: readonly string[] = [],
): { readonly need: BrowserEscalationReason | 'none'; readonly detail: string } {
  const host = hostOf(observation.finalUrl ?? observation.url)
  if (host !== '' && sessionHosts.some((entry) => entry.toLowerCase() === host)) {
    return {
      need: 'site-blocked',
      detail: `"${host}" is on this owner's list of sites whose content only appears for a signed-in person, so the public attempt was always going to be a wall.`,
    }
  }

  const target = observation.finalUrl ?? observation.url
  if (observation.status === 401) {
    return { need: 'session-required', detail: 'The site answered 401, which means it wants a session and the public browser has none.' }
  }
  if (observation.status === 403 || observation.status === 407) {
    return { need: 'session-required', detail: `The site answered ${String(observation.status)}, which means this page is not served to an anonymous reader.` }
  }
  if (observation.protectedFields > 0 && /one-?time|otp|two-?factor|2fa|mfa|challenge/i.test(target)) {
    return { need: 'mfa-required', detail: 'The page asked for a one-time code, and that is a challenge meant for the person holding the account.' }
  }
  if (observation.protectedFields > 0 && observation.textFields > 0 && observation.textBytes <= LOGIN_WALL_TEXT_CEILING) {
    return {
      need: 'login-required',
      detail: `The page has ${String(observation.protectedFields)} protected field(s) and only ${String(observation.textBytes)} bytes of prose, which is a sign-in form rather than a document.`,
    }
  }
  if (ACCOUNT_PATH.test(pathOf(target))) {
    return { need: 'login-required', detail: 'The page is an account or sign-in address rather than a document.' }
  }
  if (observation.signInAffordances > 0 && observation.textBytes <= LOGIN_WALL_TEXT_CEILING) {
    return {
      need: 'login-required',
      detail: 'The page offers a way to sign in and has almost no readable text, which is what a wall looks like from outside a session.',
    }
  }
  return { need: 'none', detail: 'The page read as a document, so there is nothing here that needs a person.' }
}

/* ----------------------------------------------------------------- the router */

/** Commands that need an existing session to mean anything. */
const NEEDS_SESSION: readonly BrowserCommand[] = Object.freeze([
  'page.navigate',
  'page.read',
  'page.describe',
  'page.click',
  'page.type',
  'media.describe',
])

function refusal(code: BrowserRefusalCode, reason: string): RouteReading {
  return { ok: false, code, reason }
}

function unavailable(target: BrowserTarget, reason: string): RouteReading {
  return { ok: false, code: 'target-unavailable', reason: `The ${target} browser cannot run right now: ${reason}` }
}

/**
 * Decide the target for one intent.
 *
 * The order is the policy, so it is worth stating plainly:
 *
 *   1. Is the command one this build routes? If not, nothing else is considered.
 *   2. Was a target named? An explicit `public` or `authenticated` is *honoured* — this
 *      module does not second-guess a caller who asked for a specific browser. What it does
 *      do is refuse the target/command pairs that cannot exist.
 *   3. Can that target run at all? Paired-but-not-live is not live; a public browser that
 *      is not activated is not available.
 *   4. Does this command need a session, and does the session that exists match?
 *   5. Only then, is there an escalation to *propose* — never to apply.
 */
export function routeBrowserIntent(intent: unknown, context: RoutingContext): RouteReading {
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
    return refusal('request-malformed', 'A browser intent must be an object.')
  }
  const record = intent as Record<string, unknown>
  if (!isBrowserCommand(record.command)) {
    return refusal('request-malformed', `"${String(record.command)}" is not a command this build routes.`)
  }
  const command: BrowserCommand = record.command
  const mode = BROWSER_COMMAND_MODE[command]

  const requested = record.target === undefined ? 'auto' : record.target
  if (typeof requested !== 'string' || (requested !== 'auto' && requested !== 'public' && requested !== 'authenticated')) {
    return refusal('target-unknown', 'A target must be "public", "authenticated", or "auto". There is no third target and no hidden default.')
  }

  /* ---------------------------------------------------- the target is decided */

  let target: BrowserTarget
  let reason: string

  if (requested === 'auto') {
    if (AUTHENTICATED_ONLY_COMMANDS.includes(command)) {
      target = 'authenticated'
      reason = 'This command is only meaningful in the paired Chrome extension, so "auto" resolves to it.'
    } else {
      target = 'public'
      reason = 'Freya\'s own browser is the default target: it holds no credentials, so it is the one to use unless somebody says otherwise.'
    }
  } else {
    target = requested
    reason =
      requested === 'public'
        ? 'The caller named the embedded Freya Browser.'
        : 'The caller named the paired Chrome extension.'
  }

  /* ------------------------------------ pairs that cannot exist, refused here */

  if (target === 'public' && AUTHENTICATED_ONLY_COMMANDS.includes(command)) {
    return refusal(
      'handoff-target-mismatch',
      `${command} happens in the browser a handoff was offered to, so it cannot be asked of the Freya Browser. Accept the handoff in the extension instead.`,
    )
  }
  if (target === 'authenticated' && PUBLIC_ONLY_COMMANDS.includes(command)) {
    return unavailable(
      target,
      `${command} names a Freya Browser session, and there is no such thing as a Freya Browser session inside somebody else's Chrome.`,
    )
  }

  /* ------------------------------------------------------- can it run at all */

  if (target === 'public') {
    if (!context.publicAvailable) {
      return unavailable(target, 'the Freya Browser is not activated in this build, or the owner has switched it off.')
    }
  } else {
    if (!context.authenticated.paired) {
      return unavailable(target, 'no extension has ever paired with this Freya, so there is no authenticated context to use.')
    }
    if (!context.authenticated.live) {
      return unavailable(target, 'the extension is paired but not connected right now, so no page can be reached.')
    }
  }

  /* --------------------------------------------------------- session coherence */

  if (NEEDS_SESSION.includes(command)) {
    const session = context.session
    if (session === null || !session.exists) {
      return refusal('session-unknown', `${command} needs an open browser session, and there is none. A session id is not a guess.`)
    }
    if (!session.open) {
      return refusal('session-closed', 'That browser session is closed. Its page is not readable and its references are not usable.')
    }
    if (session.target !== target) {
      return refusal(
        'handoff-target-mismatch',
        `The open session is on the ${session.target} browser, and this request is for the ${target} browser. Freya does not silently move work between contexts.`,
      )
    }
  }

  /* --------------------------------------------------- escalation, proposed only */

  let escalation: RouteEscalation | null = null
  if (context.autoEscalate && target === 'public' && context.observed !== null) {
    const classified = classifyAuthenticationNeed(context.observed)
    if (classified.need !== 'none') {
      escalation = {
        to: 'authenticated',
        reason: classified.need,
        detail: classified.detail,
      }
      reason = `${reason} The page looked like it needed a person, so the authenticated target is proposed rather than used.`
    }
  }

  return { ok: true, target, mode, reason, escalation }
}

/* -------------------------------------------------------------------- audits */

/**
 * Structural audits over this module. Never used by production code.
 *
 * The property worth auditing is that the *default* is the credential-free target. If a
 * future edit made `auto` resolve to `authenticated`, every unlabelled intent in Freya
 * would start running in the owner's logged-in browser and nothing would fail — the tests
 * would still pass, because they all pass a target explicitly. So the default is asserted
 * against the table rather than trusted.
 */
export function auditRoutingDefaults(): readonly string[] {
  const findings: string[] = []
  const context: RoutingContext = {
    publicAvailable: true,
    authenticated: { paired: false, live: false, sharedTabId: null },
    session: { exists: true, open: true, target: 'public' },
    observed: null,
    autoEscalate: false,
  }

  for (const command of ['page.navigate', 'page.read', 'page.describe', 'page.click'] as BrowserCommand[]) {
    const reading = routeBrowserIntent({ command, target: 'auto', sessionId: 's1' }, context)
    if (reading.ok) {
      if (reading.target !== 'public') findings.push(`auto routed ${command} to ${reading.target}.`)
    } else {
      findings.push(`auto could not route ${command}: ${reading.reason}`)
    }
  }

  // A named target is honoured and never replaced by the other one.
  const named = routeBrowserIntent({ command: 'page.navigate', target: 'public', sessionId: 's1' }, {
    ...context,
    publicAvailable: false,
  })
  if (named.ok) findings.push('A named unavailable target was routed anyway.')
  if (!named.ok && named.code !== 'target-unavailable') findings.push(`An unavailable target refused with ${named.code}.`)

  const fallback = routeBrowserIntent({ command: 'page.navigate', target: 'public', sessionId: 's1' }, {
    ...context,
    publicAvailable: false,
    authenticated: { paired: true, live: true, sharedTabId: 7 },
  })
  if (fallback.ok || fallback.code !== 'target-unavailable') {
    findings.push('An unavailable public browser silently fell back to the authenticated one.')
  }

  // A credential-free session that already exists must not drag the route to the other
  // browser, and an open session on the other target must be refused rather than closed.
  const mismatched = routeBrowserIntent({ command: 'page.read', target: 'public', sessionId: 's1' }, {
    ...context,
    session: { exists: true, open: true, target: 'authenticated' },
  })
  if (mismatched.ok || mismatched.code !== 'handoff-target-mismatch') {
    findings.push('A session on the other target was not refused.')
  }

  return findings
}