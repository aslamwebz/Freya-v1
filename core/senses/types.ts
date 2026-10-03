/**
 * THE SENSES DOMAIN — Phase 25's capability vocabulary.
 *
 * Digital Senses & Hands II expands what Freya can be asked to do: clipboard,
 * download and upload become routed capabilities, and browser and terminal grow
 * additional tested, bounded actions. This file is the vocabulary only — closed
 * tables, limits and shapes — with no logic, no I/O and no clock.
 *
 * ## The core invariant
 *
 * > **Hands are bounded tools, not unrestricted computer control. Capability
 * > expansion does not widen authority.**
 *
 * Every type here describes a *request*, a *record* or a *bound*. Nothing here
 * is a permission: holding a capability says nothing about whether it may be
 * used, and registering an action does not mean it can run. Authority lives in
 * Guard, Governor, STOP ALL, approvals and budgets, and this vocabulary never
 * touches any of them.
 *
 * ## What is deliberately absent
 *
 * - **No execution.** Nothing starts a browser, a terminal, a download or an
 *   upload. An admitted action stops at a typed decision; execution is a later
 *   phase.
 * - **No authority field.** No `grant`, `approve`, `bypass` or `spend`.
 * - **No free-form claim.** Inputs are validated against closed per-action
 *   field tables and code-owned ceilings; a request cannot widen its own bound.
 */

/* ------------------------------------------------------- capability kinds */

/**
 * The closed set of capability kinds.
 *
 * Phase 25 adds clipboard, download and upload. The existing browser, terminal,
 * desktop, file, shell and network kinds remain known; desktop, file, shell and
 * network are not expanded in this phase and route no actions here.
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

/* -------------------------------------------------------------- actions */

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

export const TERMINAL_ACTIONS = ['command-run', 'command-execute', 'command-cancel'] as const
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number]

export const CLIPBOARD_ACTIONS = ['clipboard-read', 'clipboard-write'] as const
export type ClipboardAction = (typeof CLIPBOARD_ACTIONS)[number]

export const DOWNLOAD_ACTIONS = ['download-start', 'download-cancel', 'download-status'] as const
export type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number]

export const UPLOAD_ACTIONS = ['upload-start', 'upload-cancel', 'upload-status'] as const
export type UploadAction = (typeof UPLOAD_ACTIONS)[number]

/* --------------------------------------------------------------- limits */

/**
 * The code-owned ceilings of Phase 25.
 *
 * A caller may *lower* a bound and may never raise one. These are facts about
 * the build, not values a request supplies.
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
  /** Maximum selector length. */
  maxSelectorChars: 1_024,
  /** Maximum command length. */
  maxCommandChars: 4_096,
  /** Maximum output capture bytes. */
  maxOutputBytes: 64 * 1024,
  /** Maximum page-scroll amount, in pixels. */
  maxScrollAmount: 100_000,
})

/* --------------------------------------------------------- registration */

export type SensesRisk = 'none' | 'routine' | 'consequential'

/**
 * A capability action registration.
 *
 * Each action has a closed set of input fields, a bounded timeout, a bounded
 * input size, a risk level and an approval flag. None of these is authority:
 * they describe the action, they do not authorise it.
 */
export interface CapabilityActionRegistration {
  readonly action: string
  readonly inputFields: readonly string[]
  readonly timeoutMs: number
  readonly maxInputBytes: number
  readonly requiresApproval: boolean
  readonly risk: SensesRisk
}

/** A capability registration: a kind and the closed actions it accepts. */
export interface CapabilityRegistration {
  readonly kind: Phase25CapabilityKind
  readonly actions: readonly CapabilityActionRegistration[]
}

/* --------------------------------------------------------- action request */

/**
 * A capability action request.
 *
 * A *request*: every field is validated against the closed tables and the
 * code-owned limits, and a refusal states its code in words.
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
 * This is *not* evidence that the action worked. It records what happened:
 * whether it completed, failed, was cancelled, or timed out.
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
 * A refusal is a *terminal* outcome: not a failure that can be retried, and
 * not a success that can be verified.
 */
export interface CapabilityActionRefusal {
  readonly actionId: string
  readonly code: string
  readonly reason: string
  readonly capabilityKind: Phase25CapabilityKind | null
  readonly refusedAt: string
  readonly terminal: true
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

/** A capability test result. */
export interface CapabilityTestResult {
  readonly testId: string
  readonly passed: boolean
  readonly actualOutcome: 'completed' | 'failed' | 'refused'
  readonly actualReason: string | null
  readonly durationMs: number
}

/* --------------------------------------------------------------- utilities */

/** Whether a string is a bounded opaque id. */
export function isSensesId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}
