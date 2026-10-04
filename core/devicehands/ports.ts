import type {
  DeviceHandsEventType,
  DeviceHandsPayload,
  DeviceHandsSurface,
} from './types'
import type { TerminalCommand } from './commands'
import type { TransferTarget } from './transfer'
import type { DeviceOutcome } from './verification'

/**
 * The entire outside world this phase can see.
 *
 * Read what is *not* here first, because in this file the omissions are the design:
 *
 *   - **No authority port.** Nothing here takes a capability, a grant, a permission, a
 *     budget or a token. There is no `checkCapability`, no `mintGrant`, no
 *     `widenLimit`. A port that could be *asked* whether something is allowed would
 *     create a second answer to a question Guard already answers, and this phase's
 *     claim that it cannot widen authority would then rest on a method rather than on
 *     an absence.
 *
 *   - **No image port.** No `captureScreen`, no `screenshot`, no `getImage`, no
 *     `render`, no `pdf`. There is no field anywhere in this file whose type can carry
 *     pixels, and no request or outcome that has an image in it. That is stronger than
 *     "we do not call it": there is nothing to call it with. `./assertions` scans this
 *     file for the vocabulary and fails the build if one appears.
 *
 *   - **No credential port.** No `readKeyring`, no `getSecret`, no `readVault`, no
 *     `listCredentials`. Core's Vault and keyring are not reachable from here, and
 *     neither is the OS keychain: the file paths this phase does pass have already been
 *     refused by the credential-store patterns in `./paths`, and there is no port that
 *     resolves a *name* to a secret.
 *
 *   - **No physical-world port.** No camera, microphone, sensor, location, robot or
 *     smart-home anything. PLAN.md §8 keeps the physical world as a separate,
 *     owner-designed phase, and this file is the reason that is still true.
 *
 *   - **No clock, no timer, no self-scheduling.** `now()` is a read the runtime asks
 *     for; there is no `schedule`, no `arm`, no `every`. A phase that can drive a
 *     terminal and a browser and cannot set a timer is a phase that only ever acts
 *     when a person or a Core wake asks it to.
 *
 *   - **No cognition port.** Nothing here calls a model, and nothing here accepts model
 *     output as an instruction.
 *
 * What *is* here is: a clock, an id source, a journal, the STOP ALL latch, a read of
 * the grants Core holds and of the owner's approval decisions, and six narrow
 * bounded-effect ports whose results are closed outcomes rather than prose.
 */
export interface DeviceHandsPorts {
  /** ISO instant, injected. This phase has no clock of its own and never reads one. */
  now(): string
  /** A fresh id. Injected so the phase cannot widen its own id vocabulary. */
  newId(): string

  /**
   * Append one journal entry. Durable before it resolves.
   *
   * Every derived fact here comes from these entries and nothing else, so a refused
   * append must fail loudly — there is no in-memory state to fall back on that would
   * not be lost on the next restart, and a runtime whose journal lost an entry would
   * come back believing an action never happened.
   */
  append(type: DeviceHandsEventType, payload: DeviceHandsPayload): Promise<void>
  /** The whole durable journal, in sequence order. Read once, when the phase opens. */
  replay(): Promise<readonly { readonly type: string; readonly recordedAt?: string; readonly payload?: unknown }[]>

  /**
   * The STOP ALL latch, read fresh at the gate and again before the effect.
   *
   * A callback and not a value, deliberately: copying the latch in would let this phase
   * act on a reading that stopped being true, which is the same bug as a STOP ALL
   * checked before an `await`.
   */
  stopAllActive(): boolean
  /** Whether the journal can be believed. False refuses every new action. */
  journalTrustworthy(): boolean
  /** Whether the phase is switched on at all. Off refuses everything, probes included. */
  enabled(): boolean

  /**
   * The grants Core holds for this principal.
   *
   * A *read*, and the reason is the absence of a write: nothing here can issue,
   * extend or revoke a grant. The Guard and the Governor mint grants; this phase
   * consults them and can refuse.
   */
  activeGrant(principalId: string, scope: string): GrantFact | null

  /** Ask the owner. Returns the owner's decision; this phase never decides one. */
  requestOwnerApproval(request: DeviceHandsApprovalAsk): Promise<DeviceHandsApprovalAnswer>
  /** Whether an approval is still unspent and unrevoked, per Core's own record. */
  approvalStillValid(approvalId: string): boolean

  /**
   * Ask a surface whether it exists at all.
   *
   * The only probe port, and it returns nothing but availability. There is no port that
   * *grants* on the strength of a probe, so "the clipboard is there" cannot become
   * "you may read the clipboard".
   */
  probeSurface(request: { readonly surface: DeviceHandsSurface }): Promise<{ readonly available: boolean; readonly code: string }>

  /** Drive the browser. Text and navigation only; the request type has no image in it. */
  performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome>
  /** Run one program with a bounded argument vector. No shell, ever. */
  runTerminal(request: { readonly command: TerminalCommand }): Promise<TerminalPortOutcome>
  /** Read the clipboard. The content arrives here and is judged at the boundary. */
  readClipboard(request: { readonly actionId: string }): Promise<{ readonly text: unknown }>
  /** Put bounded text on the clipboard. */
  writeClipboard(request: { readonly actionId: string; readonly text: string }): Promise<DeviceOutcome>
  /** Empty the clipboard. */
  clearClipboard(request: { readonly actionId: string }): Promise<DeviceOutcome>
  /** Fetch one allowlisted URL to one allowlisted destination. */
  fetchDownload(request: { readonly actionId: string; readonly url: string; readonly target: TransferTarget }): Promise<TransferPortOutcome>
  /** Send one allowlisted file to one allowlisted URL. */
  sendUpload(request: { readonly actionId: string; readonly url: string; readonly target: TransferTarget }): Promise<TransferPortOutcome>

  /** Something changed that a surface might be showing. */
  onChange(): void
}

/* ------------------------------------------------------------- grant facts */

/**
 * What Core says about a grant.
 *
 * Narrower than this phase's own `DeviceHandsGrantRecord` on purpose: Core answers with
 * the liveness facts, and the *contents* of the grant — which surfaces, which action
 * keys — are read from the journal, so a host cannot present a grant that this phase's
 * own record has never seen.
 */
export interface GrantFact {
  readonly grantId: string
  readonly principalId: string
  readonly scope: string
  readonly surfaces: readonly DeviceHandsSurface[]
  readonly actions: readonly string[]
  readonly issuedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
}

/* ---------------------------------------------------------------- approvals */

/**
 * What the owner is asked.
 *
 * No `reasoning` field, and no free-text explanation. A person is being asked to
 * authorize running a program or moving a file, and a generated justification in that
 * position is the persuasion problem this phase exists to avoid. The subject digest
 * is here so the decision is bound to exactly one action body.
 */
export interface DeviceHandsApprovalAsk {
  readonly approvalId: string
  readonly actionKey: string
  readonly subjectRef: string
  readonly digest: string
  readonly expiresAt: string
}

export interface DeviceHandsApprovalAnswer {
  readonly approvalId: string
  readonly granted: boolean
  /** Who actually decided. Only `owner` counts; anything else is recorded as a denial. */
  readonly decidedBy: 'owner' | 'core' | 'surface' | 'unknown'
  readonly decidedAt: string
}

/* ------------------------------------------------------------------ effects */

export interface BrowserPortRequest {
  readonly actionId: string
  readonly url: string
  readonly selector: string | null
  readonly text: string | null
  readonly deadlineAt: string
}

export interface BrowserPortOutcome extends DeviceOutcome {
  /** Where the browser actually ended up, when it was asked to go somewhere. */
  readonly finalUrl: string | null
  /** Bytes of text the adapter read back. Never the text itself — the runtime bounds it. */
  readonly textBytes: number
}

export interface TerminalPortOutcome extends DeviceOutcome {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdoutBytes: number
  readonly stderrBytes: number
}

export interface TransferPortOutcome extends DeviceOutcome {
  /** Bytes actually moved, when the adapter can say. Never assumed from the request. */
  readonly bytes: number
  readonly mediaType: string | null
}

/* ------------------------------------------------------------------ refusal */

/** One recorded refusal, kept for the owner's audit view. */
export interface DeviceHandsRefusalRecord {
  readonly actionId: string
  readonly actionKey: string
  readonly gate: string
  readonly code: string
  readonly reason: string
  readonly at: string
}

/** One recorded action, kept for the owner's audit view. */
export interface DeviceHandsActionRecord {
  readonly actionId: string
  readonly actionKey: string
  readonly state: string
  readonly verdict: string
}