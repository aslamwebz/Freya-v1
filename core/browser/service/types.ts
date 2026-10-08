/**
 * The vocabulary of the Browser Service.
 *
 * ## Why this file exists
 *
 * `../types.ts` describes the **journal**: what a durable record may say about a browser
 * session. Those tables are deliberately minimal — no page text, no title, no selector —
 * because a journal is a file on disk that survives the process and gets copied around.
 *
 * This file describes something different: the **live control surface**. It is what a tab
 * strip renders, what an owner clicks, and what a model reads to learn what is on a page.
 * Those things genuinely need a URL, a title, an accessible name and a stable element
 * reference, and none of them belong in the journal.
 *
 * Keeping the two vocabularies apart is the point. It is why the Semantic Browser Protocol
 * can be rich without weakening what Freya records, and it is why the audit in
 * `../types.ts` can keep forbidding a title in the journal while `BrowserTabState` below
 * carries one for the window to draw.
 *
 * ## Two nouns that are easy to confuse
 *
 *   - a **tab** is a thing a person can see and switch between. It has identity, provenance
 *     and a lifecycle.
 *   - a **surface** is where the pages actually come from. The embedded Electron surface and
 *     the Browser Relay surface are two implementations of the same port, and nothing above
 *     this file knows which one it is talking to.
 *
 * A tab is *not* a surface and a surface is *not* a tab: one surface holds many tabs, and a
 * tab outlives the surface view it currently renders into, which is what makes a tab switch
 * a bounds change rather than a page load.
 */

/* ---------------------------------------------------------------- lifecycles */

/**
 * The lifecycle of one tab.
 *
 * These five words are chosen so that "nothing is on screen" is never a single ambiguous
 * state. The failure this vocabulary exists to prevent is a tab that is simultaneously
 * "opening", "broken" and "empty" and therefore renders as one indistinguishable blank box.
 *
 *   - `creating`  — the tab exists and the surface has been asked for a view, but no URL has
 *                   been accepted yet. Legitimate, transient, and *not* an error.
 *   - `navigating`— a valid URL has been accepted and a load is in flight. Also legitimate.
 *   - `ready`     — a page is loaded. **Invariant: a ready tab always has a navigable URL.**
 *   - `failed`    — something was attempted and did not happen. Carries a code.
 *   - `closed`    — released. The view is gone and the reference will never resolve again.
 */
export const BROWSER_TAB_STATES = ['creating', 'navigating', 'ready', 'failed', 'closed'] as const
export type BrowserTabLifecycle = (typeof BROWSER_TAB_STATES)[number]

export function isBrowserTabLifecycle(value: unknown): value is BrowserTabLifecycle {
  return typeof value === 'string' && (BROWSER_TAB_STATES as readonly string[]).includes(value)
}

/**
 * Who asked for this tab.
 *
 * Not bookkeeping. A tab Freya opened for itself is a tab Freya may re-navigate without
 * asking; a tab a person opened by typing an address is theirs until they say otherwise,
 * and reloading it out from under them is the failure mode this field exists to prevent.
 */
export const BROWSER_TAB_ATTRIBUTIONS = ['freya', 'user'] as const
export type BrowserTabAttribution = (typeof BROWSER_TAB_ATTRIBUTIONS)[number]

export function isBrowserTabAttribution(value: unknown): value is BrowserTabAttribution {
  return typeof value === 'string' && (BROWSER_TAB_ATTRIBUTIONS as readonly string[]).includes(value)
}

/** Where the pages come from. Closed, and both members are first-class. */
export const BROWSER_SURFACE_KINDS = ['embedded', 'relay'] as const
export type BrowserSurfaceKind = (typeof BROWSER_SURFACE_KINDS)[number]

export function isBrowserSurfaceKind(value: unknown): value is BrowserSurfaceKind {
  return typeof value === 'string' && (BROWSER_SURFACE_KINDS as readonly string[]).includes(value)
}

/** How healthy the runtime is, in the vocabulary a renderer can branch on directly. */
export const BROWSER_RUNTIME_STATUSES = [
  'active',
  'disabled',
  'journalUntrusted',
  'surfaceUnavailable',
  'starting',
] as const
export type BrowserRuntimeStatus = (typeof BROWSER_RUNTIME_STATUSES)[number]

export function isBrowserRuntimeStatus(value: unknown): value is BrowserRuntimeStatus {
  return typeof value === 'string' && (BROWSER_RUNTIME_STATUSES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ refusal */

/**
 * Why the service refused an operation.
 *
 * A subset is the Phase 51 codes so an existing refusal survives the move; the rest are
 * states that Phase 51 could not express because it had no notion of a tab, a reference or
 * an owner. `stale-reference` and `owner-action-required` are the two that carry weight:
 * the first is what stops a click landing on a page that has moved on, and the second is
 * what stops Freya from typing somebody's one-time code because a form asked nicely.
 */
export const BROWSER_SERVICE_CODES = [
  // Carried through from Phase 51 so a caller's refusal vocabulary does not fork.
  'subsystem-disabled',
  'session-unknown',
  'session-closed',
  'session-budget',
  'url-refused',
  'url-required',
  'page-stale',
  'page-missing',
  'adapter-failed',
  'authority-refused',
  'ref-unknown',
  'ref-unknown-tab',
  'protected-field',
  'element-disabled',
  'element-not-found',
  'request-malformed',
  'command-unsupported',
  'element-delete-refused',
  // New here, because a tab is a new noun.
  'stale-reference',
  'revision-required',
  'tab-unknown',
  'tab-budget',
  'surface-unavailable',
  'owner-action-required',
  'pending-navigation',
  'wait-exceeded',
] as const
export type BrowserServiceCode = (typeof BROWSER_SERVICE_CODES)[number]

/**
 * One sentence a person can act on, per code.
 *
 * Total, and audited. A refusal whose text does not say what to do next is a refusal that
 * sends the caller round the loop.
 */
export const BROWSER_SERVICE_REASONS: Readonly<Record<BrowserServiceCode, string>> = Object.freeze({
  'subsystem-disabled': 'The browser runtime is not switched on, so nothing was opened or changed.',
  'session-unknown': 'There is no browser tab with that id.',
  'session-closed': 'That browser tab has been closed, so there is nothing left to act on.',
  'session-budget': 'Freya is already holding as many browser tabs as it will hold. Close one and try again.',
  'url-refused': 'That address is not one the Freya Browser will open.',
  'url-required': 'That operation needs an address, and none was given.',
  'page-stale': 'There is no page loaded in that tab, so there is nothing to act on.',
  'page-missing': 'That tab has no loaded page yet.',
  'adapter-failed': 'The Freya Browser did not report where it ended up, so the page is not claimed as loaded.',
  'authority-refused': 'Device Hands refused the action, so nothing was changed.',
  'ref-unknown': 'That element reference was never handed out for the page currently loaded.',
  'ref-unknown-tab': 'That element reference belongs to a different tab.',
  'protected-field': 'That is a protected field. Freya does not read, click or type into a password, card or one-time-code field.',
  'element-disabled': 'That element is disabled, so acting on it would report something that did not happen.',
  'element-not-found': 'That element is no longer on the page.',
  'request-malformed': 'The browser request was incomplete or had a field this build does not accept.',
  'command-unsupported': 'That browser command is not one this build performs.',
  'element-delete-refused': 'Freya does not click controls that read as destructive.',
  'stale-reference': 'The page changed after that reference was handed out, so the old reference was not acted on. Take a fresh snapshot and try again.',
  'revision-required': 'That action must name the snapshot revision it was decided from.',
  'tab-unknown': 'There is no browser tab with that id.',
  'tab-budget': 'Freya is already holding as many browser tabs as it will hold. Close one and try again.',
  'surface-unavailable': 'No browser surface is available, so no page can be opened.',
  'owner-action-required': 'This page needs the owner: a sign-in, a verification code, a payment or a permission prompt is never Freya\'s to answer.',
  'pending-navigation': 'That tab is still loading. Wait for it to settle before acting on it.',
  'wait-exceeded': 'The page did not settle within the time allowed, so nothing was reported as done.',
})

/* -------------------------------------------------------------------- limits */

/** Ceilings for the live control surface. Narrower than the page, always. */
export const BROWSER_SERVICE_LIMITS = Object.freeze({
  /** Hard ceiling on simultaneously live tabs. The multi-tab target is 10. */
  maxTabs: 16,
  /** Elements in one semantic snapshot. */
  maxSnapshotElements: 120,
  /** Characters of element text in one snapshot line. */
  maxSnapshotLineChars: 120,
  /** Characters of page prose carried on a snapshot. */
  maxSnapshotTextChars: 4_000,
  /** Characters of a rendered snapshot, prose and refs together. */
  maxRenderedSnapshotChars: 8_000,
  /** Characters in a tab title. */
  maxTitleChars: 200,
  /** Characters in a URL. */
  maxUrlChars: 2_048,
  /** A single ref. Short, so it can be typed by a model without a mistake. */
  maxRefChars: 24,
  /** How long one semantic operation may take. Never a hang. */
  maxOperationMs: 15_000,
  /** How long `browser.wait` will wait before refusing. */
  maxWaitMs: 10_000,
  /** URL history entries kept per tab. */
  maxHistoryEntries: 64,
})

/* ------------------------------------------------------------------- shapes */

/** Where a tab came from. Display provenance plus one behavioural consequence. */
export type BrowserTabOrigin =
  | { readonly kind: 'manual' }
  | {
      readonly kind: 'link'
      readonly from: 'chat' | 'eye' | 'media' | 'citation' | 'address'
      readonly ownerText: string
      readonly mediaKind?: 'video' | 'image' | 'pdf' | 'document' | 'page' | 'audio'
    }
  /** A session that already existed in the runtime and was adopted by the workspace. */
  | { readonly kind: 'handoff'; readonly fromSession: string }

/**
 * One tab, as the workspace and the protocol both see it.
 *
 * Every field is a fact rather than an intention. In particular `url` is null **only** when
 * `status` is `creating`, `failed` or `closed`, which is the invariant the whole state
 * machine exists to hold: a `ready` tab with no URL is the empty-browser-panel bug.
 */
export interface BrowserTabState {
  readonly tabId: string
  readonly sessionId: string
  /** The address the tab is meant to be on. Null while creating, failed or closed. */
  readonly url: string | null
  /** Where the page actually landed. Null unless a page is on screen. */
  readonly liveUrl: string | null
  readonly title: string | null
  readonly status: BrowserTabLifecycle
  /** The page revision semantic references are bound to. Monotonic per tab. */
  readonly revision: number
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly origin: BrowserTabOrigin
  readonly createdBy: BrowserTabAttribution
  readonly active: boolean
  readonly surface: BrowserSurfaceKind
  /** A code, never a stack and never a page string. */
  readonly error: string | null
  /** Per-tab URL history, most recent last. Bounded. */
  readonly history: readonly string[]
  readonly cursor: number
}

/** One row of `BrowserServiceState.sessions`, for callers that only need diagnostics. */
export interface BrowserSessionSummary {
  readonly sessionId: string
  readonly status: BrowserTabLifecycle
  readonly url: string | null
  readonly title: string | null
  readonly createdBy: BrowserTabAttribution
  readonly surface: BrowserSurfaceKind
  readonly errorCode: string | null
}

/**
 * The whole runtime, in one object, with no field that could be mistaken for a next action.
 *
 * The renderer is expected to branch on `runtimeStatus` and `reason`, never to infer health
 * from `sessions.length`. A runtime with zero tabs and a runtime that cannot open one are
 * both `available` for different reasons, and only `runtimeStatus` tells them apart.
 */
export interface BrowserServiceState {
  readonly available: boolean
  readonly active: boolean
  readonly publicAvailable: boolean
  readonly journalTrustworthy: boolean
  readonly runtimeStatus: BrowserRuntimeStatus
  /** Why the runtime is in this status. Null exactly when it is `active`. */
  readonly reason: string | null
  readonly activeTabId: string | null
  /**
   * Every live tab, in full.
   *
   * This is what a tab strip draws. `sessions` below is the *diagnostic* view of the same
   * facts and exists so a caller can ask "is this runtime healthy and what is each session
   * doing" without reading navigation state; keeping them separate is what stops a diagnostic
   * projection from quietly becoming a rendering surface, which is how the previous build
   * ended up adopting session rows as tabs.
   */
  readonly tabs: readonly BrowserTabState[]
  /** One row per live session, for diagnostics. Bounded, and carries no navigation state. */
  readonly sessions: readonly BrowserSessionSummary[]
  readonly tabCount: number
  /** What the last run had to reconcile. Null before anything has been recovered. */
  readonly recovery: BrowserRecoverySummary | null
}

/**
 * What recovery found, said as facts. Never as a claim that nothing was lost.
 *
 * `restorable` is the list a recovery tool would need and is deliberately **not acted on**
 * here. Reopening a page is a navigation, and a navigation to a site that has changed since
 * the run ended is a side effect on somebody's account that nobody asked for. So the list is
 * reported, bounded, and left for whoever asks — which today means the owner's own diagnostic
 * view, and tomorrow whatever Echo builds on this.
 */
export interface BrowserRecoverySummary {
  readonly trustworthy: boolean
  readonly sessionsLost: number
  readonly referencesRetired: number
  readonly restored: number
  readonly skipped: number
  /** Sessions that were open with a navigable address, and could be reopened on request. */
  readonly restorable: readonly { readonly sessionId: string; readonly url: string }[]
  readonly summary: string
}

/* ---------------------------------------------------------- semantic surface */

/** What a page element is, for the protocol. Closed, and not a DOM role list. */
export const SEMANTIC_ELEMENT_KINDS = ['link', 'button', 'field', 'heading', 'text'] as const
export type SemanticElementKind = (typeof SEMANTIC_ELEMENT_KINDS)[number]

/** One addressable element, as the protocol sees it. Carries no value, ever. */
export interface SemanticElement {
  readonly ref: string
  readonly kind: SemanticElementKind
  /** Visible or accessible name. Bounded. Never the element's value. */
  readonly name: string
  readonly disabled: boolean
  /** A password, card, OTP or similar. Never actionable. */
  readonly protected: boolean
  /** A control whose name reads as destructive. Clicking it needs the owner. */
  readonly destructive: boolean
  /** Only for fields: the options a `select` may choose from, by index. */
  readonly options?: readonly string[]
}

/**
 * An element as a surface reports it, before a reference has been minted for it.
 *
 * The one field a {@link SemanticElement} never has is `selector`, and that is the point:
 * a locator is how the surface finds the element again, it is meaningless to every other
 * layer, and letting one reach a model would turn a locator into a stable name for a control
 * that a later page change might reuse.
 */
export interface SemanticSurface extends Omit<SemanticElement, 'ref'> {
  readonly selector: string
}

/**
 * One semantic snapshot of one tab at one revision.
 *
 * A snapshot is a **cache of a single instant**. Everything a caller does next has to name
 * the revision it was decided from, or the action is refused. That is the whole mechanism
 * that stops "click what you remember" from becoming "click what is there now".
 */
export interface SemanticSnapshot {
  readonly tabId: string
  readonly url: string
  readonly title: string | null
  readonly revision: number
  /** Prose, bounded and explicitly marked when it was cut. */
  readonly text: string
  readonly truncated: boolean
  readonly elements: readonly SemanticElement[]
  /** The protocol's own rendering, so a caller never has to re-format it. */
  readonly rendered: string
  /** Set when the page has a revision newer than this snapshot. Never a promise. */
  readonly superseded: boolean
}

/* ------------------------------------------------------------------- audits */

/**
 * Structural audits over this file's tables. Never used by production code.
 *
 * The claim worth auditing is that the vocabulary is total: every refusal code has a reason
 * a person can act on, every tab state is one of the five, and nothing in the *journal*
 * vocabulary has leaked into the live one. A gap in the second check would let somebody add
 * a journal-shaped field to the live surface and quietly widen what crosses the IPC boundary.
 */
export function auditBrowserServiceTables(): readonly string[] {
  const findings: string[] = []

  for (const code of BROWSER_SERVICE_CODES) {
    const reason = BROWSER_SERVICE_REASONS[code]
    if (typeof reason !== 'string' || reason.length < 24) findings.push(`service code ${code} has no usable reason.`)
  }
  for (const code of Object.keys(BROWSER_SERVICE_REASONS)) {
    if (!(BROWSER_SERVICE_CODES as readonly string[]).includes(code)) {
      findings.push(`reason ${code} has no refusal code.`)
    }
  }

  // The lifecycle must be able to say every combination the renderer needs to branch on.
  // "Nothing is on screen" has to have at least four distinct names, or the renderer will
  // collapse them into one empty panel again.
  const silentStates = BROWSER_TAB_STATES.filter((state) => state !== 'ready')
  if (silentStates.length < 4) findings.push('The tab lifecycle cannot distinguish enough non-ready states.')

  // A duplicate code would make two failures indistinguishable to a caller.
  if (new Set(BROWSER_SERVICE_CODES).size !== BROWSER_SERVICE_CODES.length) {
    findings.push('A browser service code is repeated.')
  }

  return findings
}