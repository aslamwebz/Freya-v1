/**
 * Phase 51 — Dual Browser Runtime: the whole phase, as one barrel.
 *
 * ## What this is
 *
 * Two browsers, one authority.
 *
 *   - **`public`** — the embedded Freya Browser. A window Freya owns, in a session
 *     partition with no credentials in it, for public reading, research, previews and
 *     agent-controlled work that needs no person. It is allowed to be a real browser: it
 *     renders scripts, because a client-rendered page that yields nothing is not a
 *     browser. What it is not allowed to be is a browser that knows anything about the
 *     person using it.
 *   - **`authenticated`** — the Manifest V3 Chrome extension Phase 43 shipped, with the
 *     person's own logins, their own MFA and their own complex-site state.
 *
 * And a routing and handoff layer between them that carries a URL, a reason and a title —
 * and nothing else, ever.
 *
 * ## The rule everything else follows from
 *
 * **Both targets go through the Phase 35 Device Hands runtime.** `page.navigate` here and
 * `page.navigate` in the Phase 43 bridge are the same `browser.navigate` action key, with
 * the same grant from the same source and the same ten gates. Choosing a browser changes
 * *where* a page opens. It does not change *whether* Freya may, and this phase has no
 * second gate chain, no shadow policy and no path to a page that does not go through it.
 *
 * ## What is not wired into a composition root
 *
 * This barrel exports a runtime, a routing policy, an isolation policy, a snapshot/ref
 * policy, a handoff ledger and an honest recovery report. It does not open a window. The
 * Electron side — the window, the partition, the permission denials, the download
 * cancellation — is `electron/browser`, and it imports this folder rather than the other
 * way round, so the pure half cannot reach a browser.
 */

export {
  BROWSER_TARGETS,
  BROWSER_MODES,
  BROWSER_COMMANDS,
  BROWSER_COMMAND_ACTION,
  BROWSER_COMMAND_MODE,
  PUBLIC_ONLY_COMMANDS,
  AUTHENTICATED_ONLY_COMMANDS,
  BROWSER_PAGE_STATES,
  BROWSER_SESSION_STATES,
  BROWSER_HANDOFF_STATES,
  BROWSER_ESCALATION_REASONS,
  BROWSER_LIMITS,
  BROWSER_REFUSAL_CODES,
  BROWSER_REFUSAL_REASONS,
  BROWSER_EVENT_TYPES,
  BROWSER_EVENT_TYPE_SET,
  BROWSER_PAYLOAD_KEYS,
  FORBIDDEN_BROWSER_PAYLOAD_KEYS,
  FORBIDDEN_BROWSER_PAYLOAD_VALUES,
  browserPayloadIsValid,
  auditBrowserTables,
  isBrowserTarget,
  isBrowserMode,
  isBrowserCommand,
  isBrowserPageState,
  isBrowserHandoffState,
  isBrowserEscalationReason,
  isBrowserRefusalCode,
  isBrowserEventType,
  type BrowserTarget,
  type BrowserMode,
  type BrowserCommand,
  type BrowserPageState,
  type BrowserSessionState,
  type BrowserHandoffState,
  type BrowserEscalationReason,
  type BrowserLimits,
  type BrowserRefusalCode,
  type BrowserEventType,
} from './types'

export {
  PUBLIC_BROWSER_PARTITION_PREFIX,
  PERSISTENT_PARTITION_PREFIX,
  PUBLIC_BROWSER_POOL_SIZE,
  PUBLIC_BROWSER_DENIED_PERMISSIONS,
  PUBLIC_BROWSER_DENIED_SCHEMES,
  PUBLIC_BROWSER_ALLOWED_SCHEMES,
  CREDENTIAL_SHAPED_KEYS,
  CREDENTIAL_VALUE_PATTERNS,
  HANDOFF_CONTEXT_KEYS,
  publicBrowserPartition,
  assertNonPersistentPartition,
  assertPublicBrowserUrl,
  assertCredentialFree,
  boundHandoffText,
  auditPublicIsolation,
  bytesOf,
  type IsolationReading,
  type PublicUrlOptions,
  type PublicUrlReading,
  type CredentialReading,
} from './isolation'

export {
  ELEMENT_KINDS,
  MAX_HREF_CHARS,
  mintRef,
  describePage,
  RefTable,
  auditRefMinting,
  isElementKind,
  type ElementKind,
  type PageElement,
  type PageSnapshot,
  type DescribeReading,
  type ResolveReading,
} from './refs'

export {
  LOGIN_WALL_TEXT_CEILING,
  classifyAuthenticationNeed,
  routeBrowserIntent,
  auditRoutingDefaults,
  type AuthNeedObservation,
  type AuthenticatedContext,
  type BrowserIntent,
  type RequestedTarget,
  type RouteEscalation,
  type RouteReading,
  type RoutingContext,
  type SessionContext,
} from './routing'

export {
  createHandoffEnvelope,
  verifyHandoffEnvelope,
  foldHandoffs,
  settleUnfinished,
  uncertainTransition,
  isHandoffTransition,
  auditHandoffLedger,
  EMPTY_HANDOFF_LEDGER,
  type HandoffContext,
  type HandoffEnvelope,
  type HandoffLedgerState,
  type HandoffRecord,
  type HandoffReading,
  type HandoffTransition,
  type VerifyReading,
} from './handoff'

export {
  normaliseMediaOffer,
  MediaOfferLog,
  auditMediaOffers,
  type MediaOffer,
  type MediaReading,
  type RawMediaObservation,
} from './media'

export {
  foldBrowserState,
  browserProjection,
  isBrowserFoldEntry,
  liveSessionCount,
  openHandoffCount,
  pageIdFor,
  EMPTY_BROWSER_STATE,
  MAX_LIVE_SESSIONS,
  type BrowserProjection,
  type BrowserRuntimeState,
  type SessionState,
} from './state'

export {
  browserRecoveryReport,
  recoveryNeedsAttention,
  nextSessionId,
  type BrowserRecoveryReport,
  type UncertainEffect,
} from './recovery'

export {
  createDualBrowserRuntime,
  observationOf,
  type AuthorityVerdict,
  type BrowserActionContext,
  type BrowserAdapterPort,
  type BrowserAuthenticatedPort,
  type BrowserAuthorityPort,
  type BrowserJournalPort,
  type BrowserObservation,
  type BrowserPayload,
  type BrowserRequest,
  type BrowserResult,
  type BrowserSessionPort,
  type DualBrowserRuntime,
  type DualBrowserRuntimeOptions,
} from './runtime'