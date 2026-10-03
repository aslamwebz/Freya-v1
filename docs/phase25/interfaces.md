/**
 * Phase 25 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 25's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- capabilities */

/**
 * The closed set of capability kinds.
 *
 * Phase 25 adds clipboard, download, and upload as routed capabilities.
 * The existing browser, terminal, desktop, file, shell, and network
 * capabilities remain.
 */
export const PHASE25_CAPABILITY_KINDS = [
  'browser',
  'terminal',
  'clipboard',
  'download',
  'upload',
  'desktop',
  'file',
  'shell',
  'network',
] as const
export type Phase25CapabilityKind = (typeof PHASE25_CAPABILITY_KINDS)[number]

export function isPhase25CapabilityKind(value: unknown): value is Phase25CapabilityKind {
  return typeof value === 'string' && (PHASE25_CAPABILITY_KINDS as readonly string[]).includes(value)
}

/**
 * The closed set of browser actions.
 *
 * Phase 25 adds form-fill, element-click, page-scroll, and content-extract.
 */
export const BROWSER_ACTIONS = [
  'navigate',
  'click',
  'type',
  'read',
  'form-fill',
  'element-click',
  'page-scroll',
  'content-extract',
] as const
export type BrowserAction = (typeof BROWSER_ACTIONS)[number]

/**
 * The closed set of terminal actions.
 *
 * Phase 25 adds command-execute and command-cancel.
 */
export const TERMINAL_ACTIONS = [
  'command-run',
  'command-execute',
  'command-cancel',
] as const
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number]

/**
 * The closed set of clipboard actions.
 */
 export const CLIPBOARD_ACTIONS = [
  'clipboard-read',
  'clipboard-write',
] as const
export type ClipboardAction = (typeof CLIPBOARD_ACTIONS)[number]

/**
 * The closed set of download actions.
 */
export const DOWNLOAD_ACTIONS = [
  'download-start',
  'download-cancel',
  'download-status',
] as const
export type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number]

/**
 * The closed set of upload actions.
 */
export const UPLOAD_ACTIONS = [
  'upload-start',
  'upload-cancel',
  'upload-status',
] as const
export type UploadAction = (typeof UPLOAD_ACTIONS)[number]

/* --------------------------------------------------------- action request */

/**
 * A capability action request.
 *
 * This is a *request*: every field is validated against the closed tables and
 * the code-owned limits, and a refusal states its code in words.
 */
export interface CapabilityActionRequest {
  readonly actionId: string
  readonly capabilityKind: Phase25CapabilityKind
  readonly action: string
  readonly input: Record<string, unknown>
  readonly timeoutMs?: number | null
  readonly correlationId?: string
}

/* ---------------------------------------------------------- action result */

/**
 * The result of a capability action that was attempted.
 *
 * This is *not* evidence that the action worked. It is a record of what
 * happened: whether it completed, failed, was cancelled, or timed out.
 */
export interface CapabilityActionResult {
  readonly actionId: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  readonly startedAt: string
  readonly settledAt: string | null
  readonly durationMs: number | null
  readonly reason: string | null
  readonly observationIds: readonly string[]
}

/* ------------------------------------------------------ observation record */

/**
 * Evidence about what happened during a capability action.
 *
 * An Observation is *not* a conclusion. It is a bounded record that something
 * was observed.
 */
export interface CapabilityObservationRecord {
  readonly observationId: string
  readonly actionId: string
  readonly kind: 'result' | 'exit' | 'change' | 'failure' | 'input'
  readonly summary: string
  readonly data: Record<string, unknown>
  readonly recordedAt: string
}

/* ---------------------------------------------------- verification result */

/**
 * Whether the intent was satisfied.
 *
 * This is the *only* thing that can close an action as verified.
 */
export interface CapabilityVerificationResult {
  readonly verificationId: string
  readonly actionId: string
  readonly status: 'requested' | 'passed' | 'failed'
  readonly reason: string | null
  readonly verdictAt: string | null
}

/* ------------------------------------------------------------- refusal */

/**
 * Why a capability action was refused.
 *
 * A refusal is a *terminal* outcome: it is not a failure that can be retried,
 * and it is not a success that can be verified.
 */
export interface CapabilityActionRefusal {
  readonly actionId: string
  readonly code: string
  readonly reason: string
  readonly capabilityKind: Phase25CapabilityKind | null
  readonly refusedAt: string
}

/* ------------------------------------------------------------- limits */

/**
 * The ceilings of Phase 25 capabilities.
 *
 * Code-owned and unraisable. A caller may lower a ceiling and may never
 * raise one.
 */
export const PHASE25_LIMITS = Object.freeze({
  /** Maximum input bytes for any capability action. */
  maxInputBytes: 8_192,
  /** Maximum depth of a sanitised input value. */
  maxInputDepth: 4,
  /** Maximum fields in one sanitised input value. */
  maxInputFields: 32,
  /** Maximum wall-clock milliseconds a single action may occupy. */
  maxActionTimeoutMs: 5 * 60_000,
  /** Maximum observations a single action may produce. */
  maxObservationsPerAction: 8,
  /** Maximum verifications a single action may request. */
  maxVerificationsPerAction: 4,
  /** Maximum actions a single session may record. */
  maxActions: 256,
  /** Maximum retained action records. */
  maxRetainedActions: 512,
  /** Maximum characters in a clipboard read. */
  maxClipboardReadChars: 10_000,
  /** Maximum characters in a clipboard write. */
  maxClipboardWriteChars: 10_000,
  /** Maximum download size in bytes. */
  maxDownloadBytes: 100 * 1024 * 1024,
  /** Maximum upload size in bytes. */
  maxUploadBytes: 100 * 1024 * 1024,
  /** Maximum URL length. */
  maxUrlChars: 2_048,
  /** Maximum command length. */
  maxCommandChars: 4_096,
  /** Maximum output capture bytes. */
  maxOutputBytes: 64 * 1024,
})

/* ------------------------------------------------------------- registry */

/**
 * A capability registration.
 *
 * Each capability kind has a set of supported actions, and each action has
 * a set of supported input fields.
 */
export interface CapabilityRegistration {
  readonly kind: Phase25CapabilityKind
  readonly actions: readonly CapabilityActionRegistration[]
}

/**
 * A capability action registration.
 */
export interface CapabilityActionRegistration {
  readonly action: string
  readonly inputFields: readonly string[]
  readonly timeoutMs: number
  readonly maxInputBytes: number
  readonly requiresApproval: boolean
  readonly risk: 'none' | 'routine' | 'consequential'
}

/* ------------------------------------------------------------- testing */

/**
 * A capability test case.
 *
 * Deterministic: same inputs = same outputs. No wall-clock, no external
 * services, no model calls.
 */
export interface CapabilityTestCase {
  readonly testId: string
  readonly capabilityKind: Phase25CapabilityKind
  readonly action: string
  readonly input: Record<string, unknown>
  readonly expectedOutcome: 'completed' | 'failed' | 'refused'
  readonly expectedReason?: string
}

/**
 * A capability test result.
 */
export interface CapabilityTestResult {
  readonly testId: string
  readonly passed: boolean
  readonly actualOutcome: string
  readonly actualReason: string | null
  readonly durationMs: number
}
