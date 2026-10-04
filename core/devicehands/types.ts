/**
 * Phase 35 — Device Hands: the closed vocabularies.
 *
 * **Status:** self-contained runtime slice. Not wired into a composition root, not
 * reachable from a renderer, no UI. See `./README.md`.
 *
 * Everything in this file is data: closed tables, frozen ceilings and an absolute
 * deny list. There is no clock read, no journal write, no port call and no
 * `node:fs` import anywhere below `./ports`, and the reason is not tidiness.
 *
 * The claim Phase 35 exists to make is:
 *
 * > Freya may drive a browser, a terminal, the clipboard and a file transfer — and
 * > can reach the Vault, the keyring, the screen, the camera or any other physical
 * > surface through none of them, by no sequence of requests, and without ever
 * > widening her own authority.
 *
 * That claim is only worth something if the code that *decides* those questions has
 * no way to perform them. So the design inverts Phase 33's lesson: the deny list is
 * code-owned and unremovable, the four surfaces each have a **closed action
 * vocabulary that contains no member capable of capture**, and the port surface has
 * no method that could carry an image.
 *
 * Three tables here are load-bearing in a way the rest are not:
 *
 *   - {@link FORBIDDEN_DEVICE_HANDS_ACTIONS} is the absolute, code-owned deny list.
 *     Owner policy is *unioned* with it and nothing anywhere can remove an entry.
 *   - {@link DEVICE_HANDS_LIMITS} is frozen and can only be narrowed.
 *   - {@link DEVICE_HANDS_PAYLOAD_KEYS} is the per-event key table that both the
 *     validator and the fold are checked against, so they cannot drift apart.
 */

/* ------------------------------------------------------------------ helpers */

function isClosed<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
}

/* ----------------------------------------------------------------- surfaces */

/**
 * The four surfaces Phase 35 routes. There are four, and the number is the point.
 *
 * A capability kind is a *domain of action*, not a feature list, so the honest way
 * to add one later is to add a name here and a closed action vocabulary below it —
 * never to widen an existing surface with a new action. Each surface has exactly one
 * job and one boundary:
 *
 * | surface    | what it may do                                   | what it may never do |
 * | ---------- | ------------------------------------------------ | --------------------- |
 * | `browser`  | open an allowlisted URL, read its text, act on it | capture any pixel, image, frame or PDF render |
 * | `terminal` | run one allowlisted program with bounded args   | read the Vault, the keyring, a credential store |
 * | `clipboard`| read, write or clear the owner's own buffer      | move a secret in or out silently |
 * | `transfer` | fetch or send a text/document file, bounded      | move an image, an executable, or a credential file |
 *
 * Note what is *absent*, because the absence is the guarantee: there is no `camera`,
 * `microphone`, `sensor`, `location`, `display`, `window`, `keyboard`, `robot` or
 * `iot` surface, and there is no `senses` hook. Phase 35 adds no physical-world
 * capability of any kind; PLAN.md §8 keeps that a separate, owner-designed phase.
 */
export const DEVICE_HANDS_SURFACES = ['browser', 'terminal', 'clipboard', 'transfer'] as const
export type DeviceHandsSurface = (typeof DEVICE_HANDS_SURFACES)[number]
export const isDeviceHandsSurface = isClosed(DEVICE_HANDS_SURFACES)

/**
 * The closed action vocabulary of each surface.
 *
 * Four entries for the browser, one for the terminal, three for the clipboard, two
 * for transfer. A request naming an action outside its surface's list is refused as
 * `action-unknown` — never passed through as free text, because free text becomes
 * "whatever the port does with it".
 *
 * The browser has `read-text` and **no** `capture-*`, `screenshot`, `render`,
 * `pdf`, `image`, `pixel`, `frame` or `dom-screenshot`. That omission is asserted in
 * `./assertions` against {@link DEVICE_HANDS_BANNED_ACTION_WORDS}, so it cannot be
 * undone by adding a convenient entry later.
 */
export const DEVICE_HANDS_SURFACE_ACTIONS: Readonly<Record<DeviceHandsSurface, readonly string[]>> =
  Object.freeze({
    browser: ['navigate', 'read-text', 'click', 'type-text'],
    terminal: ['run'],
    clipboard: ['read', 'write', 'clear'],
    transfer: ['download', 'upload'],
  })

type ActionsOf<S extends DeviceHandsSurface> = (typeof DEVICE_HANDS_SURFACE_ACTIONS)[S][number]

/**
 * Every routable action, as `surface.action`.
 *
 * A template-literal union rather than `string`, which is what lets
 * {@link DEVICE_HANDS_CONSEQUENCE} be a *total* table: add an action above and the
 * compiler refuses to build until it has been classified. A consequence table with
 * a hole in it is a hole in the approval decision.
 */
export type DeviceHandsActionKey = `${DeviceHandsSurface}.${ActionsOf<DeviceHandsSurface>}`

/** Is this a `surface.action` pair this build routes? */
export function isDeviceHandsActionKey(value: unknown): value is DeviceHandsActionKey {
  if (typeof value !== 'string') return false
  const index = value.indexOf('.')
  if (index <= 0) return false
  const surface = value.slice(0, index)
  const action = value.slice(index + 1)
  if (!isDeviceHandsSurface(surface)) return false
  return (DEVICE_HANDS_SURFACE_ACTIONS[surface] as readonly string[]).includes(action)
}

/** The fully-qualified key for a surface/action pair, or null when unroutable. */
export function deviceHandsActionKey(
  surface: unknown,
  action: unknown,
): DeviceHandsActionKey | null {
  if (!isDeviceHandsSurface(surface) || typeof action !== 'string') return null
  const key = `${surface}.${action}` as DeviceHandsActionKey
  return isDeviceHandsActionKey(key) ? key : null
}

/**
 * Words that may never appear in a routed action name.
 *
 * This is the *positive* form of "Phase 35 has no screenshot capability": rather
 * than trusting a reviewer to notice a new action called `capture-frame`, the audit
 * refuses any routed action whose name contains one of these. It covers the physical
 * world (`camera`, `microphone`, `sensor`, `location`, `robot`, `iot`) and the two
 * protected stores (`vault`, `keyring`, `credential`) as well as capture.
 */
export const DEVICE_HANDS_BANNED_ACTION_WORDS: readonly string[] = Object.freeze([
  'screenshot',
  'screen-shot',
  'capture',
  'snapshot',
  'record',
  'pixel',
  'frame',
  'image',
  'photo',
  'camera',
  'microphone',
  'webcam',
  'screen',
  'display',
  'monitor',
  'render-pdf',
  'pdf',
  'camera-roll',
  'sensor',
  'location',
  'gps',
  'robot',
  'actuator',
  'iot',
  'smart-home',
  'vault',
  'keyring',
  'keychain',
  'credential',
  'secret',
  'password',
  'token',
])

/* ------------------------------------------------------------- consequence */

/**
 * What each action does to the world, code-owned.
 *
 * Three classes, ordered from least to most consequential, so "is this consequential"
 * is a table lookup rather than a judgement call. Note the mapping is *derived*, not
 * declared by the caller: `terminal.run` is `executes` because a program runs, not
 * because the request said so.
 *
 * `executes` covers the two things that reach outside the machine in a way that
 * cannot be undone by deleting a file: running a program, and moving bytes off it.
 */
export const DEVICE_HANDS_CONSEQUENCE_CLASSES = ['reads', 'writes', 'executes'] as const
export type DeviceHandsConsequenceClass = (typeof DEVICE_HANDS_CONSEQUENCE_CLASSES)[number]
export const isDeviceHandsConsequenceClass = isClosed(DEVICE_HANDS_CONSEQUENCE_CLASSES)

export const DEVICE_HANDS_CONSEQUENCE: Readonly<
  Record<DeviceHandsActionKey, DeviceHandsConsequenceClass>
> = Object.freeze({
  'browser.navigate': 'writes',
  'browser.read-text': 'reads',
  'browser.click': 'executes',
  'browser.type-text': 'executes',
  'terminal.run': 'executes',
  'clipboard.read': 'reads',
  'clipboard.write': 'writes',
  'clipboard.clear': 'writes',
  'transfer.download': 'writes',
  'transfer.upload': 'executes',
})

/**
 * Actions that may not proceed without an owner approval already granted.
 *
 * Everything except two. The two exceptions are the only actions in this phase that
 * both (a) stay inside an allowlist this code owns and (b) have no effect a person
 * outside the machine could observe:
 *
 *   - `browser.navigate` — the host must already be on an allowlisted host;
 *   - `browser.read-text` — text out of a page the owner is already looking at;
 *   - `transfer.download` — the destination must be inside an allowlisted root, the
 *     type must be allowlisted, and no image may be moved.
 *
 * Everything else needs a person to have said yes first: `browser.click` and
 * `browser.type-text` act on a third party, `terminal.run` runs a program,
 * `clipboard.read` reads a cross-application buffer that routinely holds the thing
 * the owner just copied, and `clipboard.write` / `clipboard.clear` destroy whatever
 * was there.
 *
 * Derived, so a new action is approval-requiring until somebody deliberately argues
 * it into the exception list below.
 */
export const DEVICE_HANDS_ACTIONS_WITHOUT_APPROVAL: readonly DeviceHandsActionKey[] = Object.freeze([
  'browser.navigate',
  'browser.read-text',
  'transfer.download',
])

export function deviceHandsApprovalRequired(action: DeviceHandsActionKey): boolean {
  return !DEVICE_HANDS_ACTIONS_WITHOUT_APPROVAL.includes(action)
}

/* ------------------------------------------------------------------- gates */

/**
 * The gates every action must pass, in the one order they may be evaluated.
 *
 * An ordered tuple walked by a `for` loop in `./gates`, so "no gate is ever skipped"
 * is a property of the iteration rather than of how carefully nine `if`s were
 * remembered. The decision reports `evaluated` and `remaining`, which makes the
 * ordering *testable*: a request that passes everything evaluates all ten; one that
 * fails gate *k* evaluates exactly 1..k and names *k*.
 *
 * The order is not arbitrary.
 *
 *   1. `journal-trustworthy` first, because an unreadable record is not a place to
 *      start acting.
 *   2. `stop-all` second, because a system told to stop owes nothing else an
 *      explanation, and no port or host may override the latch.
 *   3. `enabled` third — the switch, before any work.
 *   4. `replay` fourth — an id already seen is refused *before* it can consume a
 *      budget slot, which is what makes idempotence real rather than a duplicate that
 *      happens to be harmless.
 *   5. `surface` and `grant` — is this a thing that exists, under a live grant?
 *   6. `deadline`, `budget` — the time and count bounds, before the expensive
 *      structural work.
 *   7. `policy` — the surface's own path/command/clipboard/transfer rules.
 *   8. `approval` **last**, because Freya must never interrupt a person to
 *      authorize work it was never going to be allowed to do.
 */
export const DEVICE_HANDS_GATES = [
  'journal-trustworthy',
  'stop-all',
  'enabled',
  'replay',
  'surface',
  'grant',
  'deadline',
  'budget',
  'policy',
  'approval',
] as const
export type DeviceHandsGate = (typeof DEVICE_HANDS_GATES)[number]
export const isDeviceHandsGate = isClosed(DEVICE_HANDS_GATES)

/**
 * The gates a *probe* passes, which are deliberately not the gates an action passes.
 *
 * Three absolute gates and one routing gate, and that is the entire list. There is no
 * grant gate, no approval gate and no budget gate — and their absence is the structural
 * half of "a successful probe may not itself grant broader authority": there is nothing
 * in this pipeline that *could* produce authority, so nothing it skips matters.
 *
 * A probe needs no grant because the question it answers is operational, not
 * permission: "does this machine have a clipboard at all?" is exactly the question
 * somebody asks *before* they have any authority. What a probe may never do is grow,
 * and the companion guarantee is the shape of its result —
 * {@link DeviceHandsProbeOutcome} has no field capable of holding a permission.
 */
export const DEVICE_HANDS_PROBE_GATES = [
  'journal-trustworthy',
  'stop-all',
  'enabled',
  'surface',
] as const
export type DeviceHandsProbeGate = (typeof DEVICE_HANDS_PROBE_GATES)[number]
export const isDeviceHandsProbeGate = isClosed(DEVICE_HANDS_PROBE_GATES)

/* ------------------------------------------------------------ refusal codes */

/**
 * Every refusal in Phase 35 is one of these.
 *
 * Closed, because a refusal code a caller can invent is decoration. Each has exactly
 * one owner in the pipeline, and each carries a sentence a person can act on in
 * {@link DEVICE_HANDS_REFUSAL_REASONS}.
 *
 * The credential and Vault codes are separate from the generic path codes on purpose:
 * "that path is outside the allowlist" and "that path is the Vault" are different
 * facts, and an audit trail that collapsed them would make the second one invisible.
 */
export const DEVICE_HANDS_REFUSAL_CODES = [
  // lifecycle / infrastructure
  'subsystem-disabled',
  'journal-untrustworthy',
  'stop-all-latched',
  'policy-missing',
  'policy-mismatch',
  'replay-detected',
  // shape
  'surface-unknown',
  'action-unknown',
  'request-malformed',
  // grant
  'grant-missing',
  'grant-revoked',
  'grant-expired',
  'grant-surface-mismatch',
  'grant-action-mismatch',
  // bounds
  'deadline-expired',
  'budget-exceeded',
  'action-count-exceeded',
  'transfer-count-exceeded',
  'transfer-byte-ceiling',
  // absolute denials
  'forbidden-action',
  'vault-path-denied',
  'credential-store-denied',
  'capture-denied',
  'physical-world-denied',
  'authority-widening-refused',
  // paths and urls
  'path-malformed',
  'path-traversal',
  'path-outside-allowlist',
  'path-denied',
  'url-scheme-not-allowed',
  'url-host-not-allowed',
  'url-carries-credential',
  // terminal
  'command-not-allowed',
  'command-argument-unsafe',
  'command-argument-count-exceeded',
  'command-argument-invalid',
  'command-working-directory-denied',
  'environment-variable-not-allowed',
  'environment-variable-denied',
  // clipboard
  'clipboard-too-large',
  'clipboard-binary-content',
  'clipboard-credential-content',
  // transfer
  'media-type-not-allowed',
  'media-type-mismatch',
  'file-name-invalid',
  'file-too-large',
  // approval
  'approval-required',
  'approval-missing',
  'approval-not-granted',
  'approval-subject-mismatch',
  'approval-expired',
  'approval-revoked',
  'approval-not-owners',
  // execution truthfulness
  'verification-missing',
  'verification-failed',
  'claim-not-evidence',
  'port-reported-failure',
  'execution-failed',
  'action-cancelled',
  'action-timed-out',
  'interrupted-by-restart',
  // probing
  'probe-refused',
] as const
export type DeviceHandsRefusalCode = (typeof DEVICE_HANDS_REFUSAL_CODES)[number]
export const isDeviceHandsRefusalCode = isClosed(DEVICE_HANDS_REFUSAL_CODES)

/** Why a code is a refusal, in words a person can act on. */
export const DEVICE_HANDS_REFUSAL_REASONS: Readonly<Record<DeviceHandsRefusalCode, string>> =
  Object.freeze({
    'subsystem-disabled': 'Device Hands is switched off, so every action is refused',
    'journal-untrustworthy':
      'the action journal cannot be believed, so nothing new is acted on',
    'stop-all-latched': 'STOP ALL is latched, so nothing runs',
    'policy-missing': 'no surface policy is loaded, so no path or command can be judged',
    'policy-mismatch': 'the loaded surface policy is not the one that was journaled',
    'replay-detected': 'that action id has already been used, and a retry is a new id',
    'surface-unknown': 'that surface is not one this build routes',
    'action-unknown': 'that surface does not accept that action',
    'request-malformed': 'the request is not well-formed, and it was not repaired',
    'grant-missing': 'no active grant covers this action',
    'grant-revoked': 'the grant covering this action was revoked',
    'grant-expired': 'the grant covering this action has expired',
    'grant-surface-mismatch': 'the grant covers a different surface',
    'grant-action-mismatch': 'the grant covers a different action on that surface',
    'deadline-expired': 'the deadline for this action has passed',
    'budget-exceeded': 'the bounded budget for Device Hands is exhausted',
    'action-count-exceeded': 'the action ceiling for this session is reached',
    'transfer-count-exceeded': 'the transfer ceiling for this session is reached',
    'transfer-byte-ceiling': 'the transfer would move more bytes than the ceiling allows',
    'forbidden-action': 'that action is forbidden outright and no setting can permit it',
    'vault-path-denied': 'that path is inside Freya protected state, which is never reachable',
    'credential-store-denied': 'that path is an operating-system credential store',
    'capture-denied': 'Phase 35 has no screen, window or image capture capability',
    'physical-world-denied': 'Phase 35 has no camera, sensor or physical-world capability',
    'authority-widening-refused': 'nothing in this phase can widen an existing authority',
    'path-malformed': 'that path is not a path this build can read',
    'path-traversal': 'that path tries to leave its directory by traversal',
    'path-outside-allowlist': 'that path is outside every directory this grant permits',
    'path-denied': 'that path is inside a directory this build denies outright',
    'url-scheme-not-allowed': 'only http and https are routable, and nothing else is',
    'url-host-not-allowed': 'that host is not on the allowlist for this grant',
    'url-carries-credential': 'a URL carrying a username or password is refused',
    'command-not-allowed': 'that program is not on the command allowlist',
    'command-argument-unsafe':
      'that argument contains a shell metacharacter, and arguments are never parsed by a shell',
    'command-argument-count-exceeded': 'that command has more arguments than the ceiling allows',
    'command-argument-invalid': 'that argument is not a value this build can pass',
    'command-working-directory-denied':
      'that working directory is not inside a permitted root',
    'environment-variable-not-allowed':
      'that environment variable is not on the allowlist, and the environment is not inherited',
    'environment-variable-denied': 'that environment variable names credential material',
    'clipboard-too-large': 'that clipboard content is larger than the ceiling allows',
    'clipboard-binary-content': 'that clipboard content is binary, and Phase 35 moves no binary',
    'clipboard-credential-content':
      'that clipboard content looks like a credential, so it was neither returned nor recorded',
    'media-type-not-allowed': 'that media type is not on the transfer allowlist',
    'media-type-mismatch': 'that file name and that media type do not agree',
    'file-name-invalid': 'that file name is not a name this build will create',
    'file-too-large': 'that file is larger than the transfer ceiling allows',
    'approval-required': 'that action needs the owner to approve it first',
    'approval-missing': 'no approval covers that exact action',
    'approval-not-granted': 'the owner did not grant that approval',
    'approval-subject-mismatch': 'that approval was given for a different action',
    'approval-expired': 'that approval has expired',
    'approval-revoked': 'that approval was revoked',
    'approval-not-owners': 'that decision did not come from the owner, so it is a denial',
    'verification-missing': 'no verification result exists, so this is not complete',
    'verification-failed': 'verification did not pass, so this is not complete',
    'claim-not-evidence': 'the only evidence is the action\'s own claim about itself',
    'port-reported-failure': 'the surface reported that it did not do the thing',
    'execution-failed': 'the action was attempted and did not succeed',
    'action-cancelled': 'the action was cancelled before it settled',
    'action-timed-out': 'the action ran past its deadline',
    'interrupted-by-restart':
      'the process ended before this action settled, so what happened is unknown rather than assumed',
    'probe-refused': 'a probe may test a capability but may never grant one',
  })

/* ------------------------------------------------------- absolute denials */

/**
 * The absolute, code-owned actions Phase 35 may never perform.
 *
 * The single most important table in the phase. Owner policy is **unioned** with
 * this list, and there is no code path, event type, payload shape or host setting
 * anywhere in Phase 35 that removes an entry. A caller supplying an empty deny list,
 * or a "permission" list, or an environment variable full of overrides, gets the
 * same answer as one supplying the full list.
 *
 * Every entry is here because it is irreversible, destroys somebody else's property,
 * exfiltrates a secret, reaches a physical-world device, or **mints authority**.
 * Phase 35 has no capability that could perform most of them; refusing them in code
 * means the refusal does not depend on that absence continuing to hold.
 */
export const FORBIDDEN_DEVICE_HANDS_ACTIONS = [
  // Freya's own protected state.
  'read-vault',
  'write-vault',
  'read-vault-backup',
  'write-vault-backup',
  'read-keyring',
  'write-keyring',
  'read-credential-store',
  'write-credential-store',
  'read-os-secure-storage',
  'read-env-secret',
  'exfiltrate-secret',
  'read-browser-profile',
  'read-cookie-store',
  // Capture. Phase 35 has none of these and will not grow one.
  'capture-screen',
  'screenshot',
  'capture-window',
  'capture-display',
  'capture-page-image',
  'record-screen',
  'render-pdf',
  'capture-frame',
  // Physical world.
  'read-camera',
  'read-microphone',
  'read-sensor',
  'read-location',
  'control-robot',
  'control-iot-device',
  'control-smart-home',
  // Authority. Nothing here mints, widens or clears anything.
  'grant-authority',
  'widen-capability',
  'widen-boundary',
  'widen-budget',
  'disable-stop-all',
  'clear-stop-all',
  'bypass-guard',
  'bypass-governor',
  'bypass-admission',
  'self-approve',
  'forge-owner-approval',
  'self-modify-policy',
  'escalate-privilege',
  'execute-downloaded-code',
  'persist-payload',
] as const
export type ForbiddenDeviceHandsAction = (typeof FORBIDDEN_DEVICE_HANDS_ACTIONS)[number]
export const isForbiddenDeviceHandsAction = isClosed(FORBIDDEN_DEVICE_HANDS_ACTIONS)

/** The deny entries grouped, so a test can iterate one concern at a time. */
export const CREDENTIAL_ACTIONS: readonly ForbiddenDeviceHandsAction[] = Object.freeze([
  'read-vault',
  'write-vault',
  'read-vault-backup',
  'write-vault-backup',
  'read-keyring',
  'write-keyring',
  'read-credential-store',
  'write-credential-store',
  'read-os-secure-storage',
  'read-env-secret',
  'exfiltrate-secret',
  'read-browser-profile',
  'read-cookie-store',
])

export const CAPTURE_ACTIONS: readonly ForbiddenDeviceHandsAction[] = Object.freeze([
  'capture-screen',
  'screenshot',
  'capture-window',
  'capture-display',
  'capture-page-image',
  'record-screen',
  'render-pdf',
  'capture-frame',
])

export const PHYSICAL_WORLD_ACTIONS: readonly ForbiddenDeviceHandsAction[] = Object.freeze([
  'read-camera',
  'read-microphone',
  'read-sensor',
  'read-location',
  'control-robot',
  'control-iot-device',
  'control-smart-home',
])

export const AUTHORITY_ACTIONS: readonly ForbiddenDeviceHandsAction[] = Object.freeze([
  'grant-authority',
  'widen-capability',
  'widen-boundary',
  'widen-budget',
  'disable-stop-all',
  'clear-stop-all',
  'bypass-guard',
  'bypass-governor',
  'bypass-admission',
  'self-approve',
  'forge-owner-approval',
  'self-modify-policy',
  'escalate-privilege',
  'execute-downloaded-code',
  'persist-payload',
])

/* ----------------------------------------------------------------- limits */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * The code-owned ceilings. Frozen, with no widening function anywhere in the phase.
 *
 * Where the owner may narrow something — allowed roots, hosts, commands, env names —
 * it is validated *under* these; where Phase 35 decides the number, this table is
 * the number. The values are deliberately small: a machine-access runtime whose
 * session cap is 128 actions has a blast radius of 128 actions.
 */
export const DEVICE_HANDS_LIMITS = Object.freeze({
  /** Actions one session may record. */
  maxActionsPerSession: 128,
  /** Actions admitted and unsettled at once. */
  maxInFlightActions: 4,
  /** Transfers one session may perform. */
  maxTransfersPerSession: 32,
  /** Bytes one transfer may move. */
  maxTransferBytesPerAction: 1 * 1024 * 1024,
  /** Bytes every transfer in a session may move, cumulatively. */
  maxTransferBytesPerSession: 5 * 1024 * 1024,
  /** Bytes of clipboard content read or written in one action. */
  maxClipboardBytes: 8 * 1024,
  /** Bytes of terminal output retained for one action. */
  maxTerminalOutputBytes: 16 * 1024,
  /** Arguments one command may carry. */
  maxCommandArgs: 8,
  /** Bytes in one argument. */
  maxCommandArgBytes: 512,
  /** Bytes of page text retained for one browser read. */
  maxBrowserTextBytes: 4 * 1024,
  /** Bytes a caller may type into a page field. */
  maxTypedTextBytes: 512,
  /** Roots in one surface policy. */
  maxAllowedRoots: 8,
  /** Hosts in one surface policy. */
  maxAllowedHosts: 16,
  /** Commands in one surface policy. */
  maxAllowedCommands: 16,
  /** Environment variable names in one surface policy. */
  maxAllowedEnvNames: 8,
  /** Pending approvals. */
  maxPendingApprovals: 16,
  /** Wall-clock a single action may occupy. */
  maxActionTimeoutMs: 60_000,
  /** How long a single grant may live. */
  maxGrantTtlMs: 15 * MINUTE,
  /** How long a single approval may live. */
  maxApprovalTtlMs: HOUR,
  /** The longest string any Device Hands journal payload may carry. */
  maxPayloadTextLength: 200,
  /** Refusals retained for the owner's audit view. */
  maxRetainedRefusals: 64,
  /** Actions retained for the owner's audit view. */
  maxRetainedActions: 64,
  /** Probes retained. A probe is evidence about a capability, never a grant. */
  maxRetainedProbes: 32,
})

export type DeviceHandsLimits = typeof DEVICE_HANDS_LIMITS

/** A request to change a ceiling. Untyped, because the hostile case is the one worth testing. */
export type DeviceHandsLimitRequest = { readonly [K in keyof DeviceHandsLimits]?: unknown }

/* ------------------------------------------------------------------- states */

/**
 * An action's lifecycle. `pending → running → settled`, and `settled` is terminal.
 *
 * `interrupted` is the seventh state and it exists for restart truthfulness. An
 * action that was `running` when the process ended cannot honestly be reported as
 * completed or failed, because the runtime does not know. `interrupted` says exactly
 * that: *unknown*, and therefore treated as *not done*. Collapsing it into `failed`
 * would be a lie in one direction and into `completed` a lie in the other.
 */
export const DEVICE_HANDS_ACTION_STATES = [
  'pending',
  'running',
  'settled',
] as const
export type DeviceHandsActionState = (typeof DEVICE_HANDS_ACTION_STATES)[number]
export const isDeviceHandsActionState = isClosed(DEVICE_HANDS_ACTION_STATES)

/** How a settled action ended. */
export const DEVICE_HANDS_SETTLE_OUTCOMES = [
  'completed',
  'failed',
  'unverified',
  'refused',
  'cancelled',
  'timed-out',
  'interrupted',
] as const
export type DeviceHandsSettleOutcome = (typeof DEVICE_HANDS_SETTLE_OUTCOMES)[number]
export const isDeviceHandsSettleOutcome = isClosed(DEVICE_HANDS_SETTLE_OUTCOMES)

/** Verification verdicts. `unverified` is a first-class outcome, not an absence. */
export const DEVICE_HANDS_VERDICTS = ['passed', 'failed', 'unverified'] as const
export type DeviceHandsVerdict = (typeof DEVICE_HANDS_VERDICTS)[number]
export const isDeviceHandsVerdict = isClosed(DEVICE_HANDS_VERDICTS)

/** Approval lifecycle. */
export const DEVICE_HANDS_APPROVAL_STATES = [
  'pending',
  'granted',
  'denied',
  'revoked',
  'expired',
] as const
export type DeviceHandsApprovalState = (typeof DEVICE_HANDS_APPROVAL_STATES)[number]
export const isDeviceHandsApprovalState = isClosed(DEVICE_HANDS_APPROVAL_STATES)

export const TERMINAL_DEVICE_HANDS_APPROVAL_STATES: readonly DeviceHandsApprovalState[] =
  Object.freeze(['granted', 'denied', 'revoked', 'expired'])

/* ------------------------------------------------------- grants and digests */

/**
 * A grant: the *scope* under which one principal may ask for one surface's actions.
 *
 * A grant is not authority by itself. It is a narrowing statement — "this principal,
 * these surfaces, these actions, until this instant" — that Guard and the Governor
 * still weigh, and that the `grant` gate checks for liveness. There is no field on
 * this record through which a grant can grant anything: no `budget`, no `authority`,
 * no `scope-wildcard`.
 */
export interface DeviceHandsGrantRecord {
  readonly grantId: string
  readonly principalId: string
  readonly scope: string
  readonly surfaces: readonly DeviceHandsSurface[]
  /** Which actions on those surfaces. A surface not named is wholly refused. */
  readonly actions: readonly DeviceHandsActionKey[]
  readonly issuedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
}

/**
 * The exact subject an approval is bound to.
 *
 * `digest` is a canonical string Core computes over everything that would change
 * what the action *does*. An approval for `terminal.run ls in /tmp` therefore does
 * not authorise `terminal.run rm in /tmp`, because the digest differs. This is the
 * most obvious approval attack and it is closed by comparing the subject rather than
 * by checking that *an* approval exists.
 */
export interface DeviceHandsApprovalSubject {
  readonly actionKey: DeviceHandsActionKey
  readonly subjectRef: string
  readonly digest: string
}

export interface DeviceHandsApprovalRecord {
  readonly approvalId: string
  readonly subject: DeviceHandsApprovalSubject
  readonly state: DeviceHandsApprovalState
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly expiresAt: string
}

/** Verification: the only thing that can close an action as done. */
export interface DeviceHandsVerificationRecord {
  readonly verificationId: string
  readonly actionId: string
  readonly verdict: DeviceHandsVerdict
  readonly reason: string
  readonly verifiedAt: string
}

/**
 * A probe outcome.
 *
 * Deliberately has **no** field that could be a grant, a capability, a permission or
 * an authority — and that is not a documentation promise, it is the reason the type
 * looks like this. `available` means "the surface answered"; it does not mean "you
 * may use it". The only thing a probe can produce is evidence, and evidence is not
 * authority. See `./probe.ts`.
 */
export interface DeviceHandsProbeOutcome {
  readonly probeId: string
  readonly surface: DeviceHandsSurface
  /** Whether the surface answered at all. NOT a grant and NOT an authorisation. */
  readonly available: boolean
  /** A closed code. Never prose from the thing that was probed. */
  readonly code: string
  readonly probedAt: string
}

/* ----------------------------------------------------------------- journal */

export interface DeviceHandsJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

/** A journal payload. Closed to flat scalars: no arrays, no nesting, no objects. */
export type DeviceHandsPayload = Readonly<Record<string, string | number | boolean | null>>

export const DEVICE_HANDS_EVENT_TYPES = [
  'hands.runtime.opened',
  'hands.policy.set',
  'hands.grant.registered',
  'hands.grant.revoked',
  'hands.approval.requested',
  'hands.approval.granted',
  'hands.approval.denied',
  'hands.approval.revoked',
  'hands.probe.performed',
  'hands.probe.refused',
  'hands.action.started',
  'hands.action.refused',
  'hands.action.cancelled',
  'hands.action.timed-out',
  'hands.action.interrupted',
  'hands.budget.checked',
  'hands.browser.performed',
  'hands.terminal.performed',
  'hands.clipboard.read',
  'hands.clipboard.written',
  'hands.clipboard.cleared',
  'hands.clipboard.credential-detected',
  'hands.transfer.completed',
  'hands.transfer.failed',
  'hands.verified',
  'hands.reconciled',
  'hands.stopped',
] as const
export type DeviceHandsEventType = (typeof DEVICE_HANDS_EVENT_TYPES)[number]
export const DEVICE_HANDS_EVENT_TYPE_SET: ReadonlySet<string> = new Set(DEVICE_HANDS_EVENT_TYPES)

/**
 * The keys each event may carry.
 *
 * Checked *against* the fold rather than in place of it, so a payload can be neither
 * narrower (an unread field that silently does nothing) nor wider (a field no rule
 * reads, which is a field something can be hidden in). An event type missing from
 * this table is a programming error and is refused by the fold.
 *
 * Note what is **not** journaled: clipboard content, page text, terminal output,
 * file contents, argument values, environment values and host names of allowlist
 * entries. What is journaled is the shape of the decision — counts, byte totals,
 * digests, closed codes. A journal is the least protected file in the system, and an
 * event that could carry the contents of the clipboard would turn it into an
 * exfiltration channel.
 */
export const DEVICE_HANDS_PAYLOAD_KEYS: Readonly<Record<DeviceHandsEventType, readonly string[]>> =
  Object.freeze({
    'hands.runtime.opened': ['at', 'recoveredActions'],
    'hands.policy.set': ['policyDigest', 'rootCount', 'hostCount', 'commandCount', 'envCount', 'at'],
    'hands.grant.registered': [
      'grantId',
      'principalId',
      'scope',
      'surfaces',
      'actions',
      'issuedAt',
      'expiresAt',
    ],
    'hands.grant.revoked': ['grantId', 'principalId', 'at'],
    'hands.approval.requested': ['approvalId', 'actionKey', 'subjectRef', 'digest', 'expiresAt', 'at'],
    'hands.approval.granted': ['approvalId', 'actionKey', 'subjectRef', 'digest', 'decidedAt'],
    'hands.approval.denied': ['approvalId', 'actionKey', 'decidedAt'],
    'hands.approval.revoked': ['approvalId', 'actionKey', 'at'],
    'hands.probe.performed': ['probeId', 'surface', 'available', 'code', 'at'],
    'hands.probe.refused': ['surface', 'code', 'reason', 'at'],
    'hands.action.started': [
      'actionId',
      'actionKey',
      'surface',
      'principalId',
      'grantId',
      'deadlineAt',
      'at',
    ],
    'hands.action.refused': ['actionId', 'actionKey', 'gate', 'code', 'reason', 'at'],
    'hands.action.cancelled': ['actionId', 'actionKey', 'reason', 'at'],
    'hands.action.timed-out': ['actionId', 'actionKey', 'at'],
    'hands.action.interrupted': ['actionId', 'actionKey', 'code', 'at'],
    'hands.budget.checked': ['actionId', 'actionsThisSession', 'maxActions', 'bytesThisSession', 'maxBytes'],
    'hands.browser.performed': ['actionId', 'actionKey', 'url', 'holds', 'code', 'textBytes', 'at'],
    'hands.terminal.performed': [
      'actionId',
      'command',
      'exitCode',
      'timedOut',
      'stdoutBytes',
      'stderrBytes',
      'at',
    ],
    'hands.clipboard.read': ['actionId', 'bytes', 'at'],
    'hands.clipboard.written': ['actionId', 'bytes', 'at'],
    'hands.clipboard.cleared': ['actionId', 'at'],
    'hands.clipboard.credential-detected': ['actionId', 'direction', 'bytes', 'at'],
    'hands.transfer.completed': [
      'actionId',
      'direction',
      'mediaType',
      'bytes',
      'destinationRef',
      'verificationId',
      'at',
    ],
    'hands.transfer.failed': ['actionId', 'direction', 'code', 'reason', 'at'],
    'hands.verified': ['verificationId', 'actionId', 'result', 'reason', 'at'],
    'hands.reconciled': ['actionId', 'from', 'to', 'code', 'at'],
    'hands.stopped': ['code', 'at'],
  })

/**
 * Payload keys refused outright wherever they appear.
 *
 * Authority in Freya is minted by the Guard and the Governor and by nothing else. A
 * journal entry shaped like a capability, a grant, a verdict or an owner signature is
 * not a new field, it is an escalation attempt — and the durable journal is the last
 * place in the system where one should be able to appear.
 *
 * The `image` / `screenshot` / `capture` names are in this list for the same reason:
 * a payload that could carry a frame is a payload that could smuggle a capture past a
 * runtime that has no capture capability.
 */
export const FORBIDDEN_DEVICE_HANDS_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'capability',
  'capabilities',
  'capabilityId',
  'grant',
  'grants',
  'authority',
  'authorities',
  'permission',
  'permissions',
  'privilege',
  'scope-wildcard',
  'budget',
  'allow',
  'allowed',
  // `verdict` is forbidden *by name* even though `hands.verified` records one — the
  // verifier's result is journalled as `result`, and a payload carrying a field called
  // `verdict` is a payload asserting its own conclusion, which is exactly the shape a
  // hand-edited journal takes.
  'verdict',
  'approved',
  'approvedBy',
  'ownerSignature',
  'signed',
  'token',
  'credential',
  'credentials',
  'secret',
  'apiKey',
  'privateKey',
  'password',
  'passphrase',
  'keyring',
  'vault',
  'image',
  'imageDataUrl',
  'screenshot',
  'capture',
  'captureData',
  'frame',
  'pixels',
  'clipboardContent',
  'fileContent',
  'fileBytes',
  'environmentValues',
  'commandLine',
  'argumentValues',
  'stdoutText',
  'stderrText',
  'pageText',
  'override',
  'overrides',
  'policyOverride',
  'limitOverride',
  'rootsOverride',
  'hostsOverride',
  'commandsOverride',
  'envOverride',
  'grantOverride',
  'root',
  'roots',
  'hosts',
  'commands',
  'envNames',
])