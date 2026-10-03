/**
 * THE CAPABILITY REGISTRY — what this build routes, explicitly.
 *
 * The registry is the single source of truth for the closed set of capability
 * kinds, the actions each accepts, and the bounded shape of each action's
 * input. It is a pure data structure: no I/O, no clock, no model, no
 * execution. Looking up a capability does not authorise it.
 *
 * ## What is deliberately enforced
 *
 * - **Kinds are closed.** A kind outside {@link PHASE25_CAPABILITY_KINDS} is
 *   unknown, and an unknown kind is refused rather than guessed at.
 * - **Actions are a closed vocabulary per kind.** An action outside a kind's
 *   registration is unsupported.
 * - **Input is exact and bounded.** An action accepts exactly its declared
 *   fields, each of the declared type, within the code-owned byte, field,
 *   depth and per-field ceilings. A request cannot widen its own bound.
 *
 * ## What is deliberately absent
 *
 * No execution of any kind. The registry names actions; no executor in this
 * build implements them.
 */

import {
  BROWSER_ACTIONS,
  CLIPBOARD_ACTIONS,
  DOWNLOAD_ACTIONS,
  PHASE25_CAPABILITY_KINDS,
  PHASE25_LIMITS,
  TERMINAL_ACTIONS,
  UPLOAD_ACTIONS,
  instantMs,
  isSensesId,
  type CapabilityActionRegistration,
  type CapabilityRegistration,
  type Phase25CapabilityKind,
} from './types'

/* ------------------------------------------------------------ field rules */

type FieldRule = (value: unknown) => boolean

const boundedString = (value: unknown, max: number): boolean =>
  typeof value === 'string' && value.length <= max

const nonEmptyBounded = (value: unknown, max: number): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max

const boundedInteger = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const

/**
 * The closed rules for every input field name the registry declares.
 *
 * A field name that has no rule cannot be validated, so an action declaring it
 * would be a build error; {@link validateInput} fails closed on such a field.
 */
const FIELD_RULES: Readonly<Record<string, FieldRule>> = Object.freeze({
  url: (value) =>
    nonEmptyBounded(value, PHASE25_LIMITS.maxUrlChars) &&
    /^https?:\/\//i.test((value as string).trim()),
  selector: (value) => nonEmptyBounded(value, PHASE25_LIMITS.maxSelectorChars),
  text: (value) => boundedString(value, PHASE25_LIMITS.maxInputBytes),
  value: (value) => boundedString(value, PHASE25_LIMITS.maxInputBytes),
  direction: (value) =>
    typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value),
  amount: (value) => boundedInteger(value, 0, PHASE25_LIMITS.maxScrollAmount),
  command: (value) => nonEmptyBounded(value, PHASE25_LIMITS.maxCommandChars),
  maxOutputBytes: (value) => boundedInteger(value, 1, PHASE25_LIMITS.maxOutputBytes),
  commandId: (value) => isSensesId(value),
  downloadId: (value) => isSensesId(value),
  uploadId: (value) => isSensesId(value),
  content: (value) => boundedString(value, PHASE25_LIMITS.maxClipboardWriteChars),
  destination: (value) => nonEmptyBounded(value, PHASE25_LIMITS.maxUrlChars),
  source: (value) => nonEmptyBounded(value, PHASE25_LIMITS.maxUrlChars),
})

/* ------------------------------------------------------------- the table */

function action(
  name: string,
  inputFields: readonly string[],
  timeoutMs: number,
  risk: CapabilityActionRegistration['risk'],
  requiresApproval: boolean,
): CapabilityActionRegistration {
  return Object.freeze({
    action: name,
    inputFields,
    timeoutMs,
    maxInputBytes: PHASE25_LIMITS.maxInputBytes,
    requiresApproval,
    risk,
  })
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

/**
 * The explicit registry: capability kind → its closed actions.
 *
 * The five Phase 25 kinds route actions. The four existing kinds are known but
 * not expanded in this phase and route nothing here, so naming one fails
 * honestly rather than silently.
 */
export const CAPABILITY_REGISTRY: ReadonlyMap<Phase25CapabilityKind, CapabilityRegistration> =
  new Map<Phase25CapabilityKind, CapabilityRegistration>([
    [
      'browser',
      Object.freeze({
        kind: 'browser',
        actions: [
          action('navigate', ['url'], 30 * SECOND, 'routine', false),
          action('click', ['selector'], 10 * SECOND, 'routine', false),
          action('type', ['selector', 'text'], 10 * SECOND, 'routine', false),
          action('read', ['selector'], 10 * SECOND, 'none', false),
          action('form-fill', ['selector', 'value'], 10 * SECOND, 'routine', false),
          action('element-click', ['selector'], 10 * SECOND, 'routine', false),
          action('page-scroll', ['direction', 'amount'], 5 * SECOND, 'none', false),
          action('content-extract', ['selector'], 10 * SECOND, 'none', false),
        ],
      }),
    ],
    [
      'terminal',
      Object.freeze({
        kind: 'terminal',
        actions: [
          action('command-run', ['command'], 60 * SECOND, 'consequential', true),
          action('command-execute', ['command', 'maxOutputBytes'], 60 * SECOND, 'consequential', true),
          action('command-cancel', ['commandId'], 5 * SECOND, 'none', false),
        ],
      }),
    ],
    [
      'clipboard',
      Object.freeze({
        kind: 'clipboard',
        actions: [
          action('clipboard-read', [], 5 * SECOND, 'none', false),
          action('clipboard-write', ['content'], 5 * SECOND, 'routine', false),
        ],
      }),
    ],
    [
      'download',
      Object.freeze({
        kind: 'download',
        actions: [
          action('download-start', ['url', 'destination'], 5 * MINUTE, 'consequential', true),
          action('download-cancel', ['downloadId'], 5 * SECOND, 'none', false),
          action('download-status', ['downloadId'], 5 * SECOND, 'none', false),
        ],
      }),
    ],
    [
      'upload',
      Object.freeze({
        kind: 'upload',
        actions: [
          action('upload-start', ['source', 'destination'], 5 * MINUTE, 'consequential', true),
          action('upload-cancel', ['uploadId'], 5 * SECOND, 'none', false),
          action('upload-status', ['uploadId'], 5 * SECOND, 'none', false),
        ],
      }),
    ],
    // Known kinds that Phase 25 does not expand: registered so naming one is an
    // honest `action_unsupported` rather than a quiet `capability_unknown`.
    ['desktop', Object.freeze({ kind: 'desktop', actions: [] })],
    ['file', Object.freeze({ kind: 'file', actions: [] })],
    ['shell', Object.freeze({ kind: 'shell', actions: [] })],
    ['network', Object.freeze({ kind: 'network', actions: [] })],
  ])

/** Every kind the registry knows, in declaration order. */
export const REGISTERED_CAPABILITY_KINDS: readonly Phase25CapabilityKind[] =
  PHASE25_CAPABILITY_KINDS

/* ------------------------------------------------------------ operations */

/**
 * Look up a capability kind.
 *
 * Returns `null` for a kind this build does not know. Pure: the same kind
 * always resolves the same way.
 */
export function capabilityRegistration(
  kind: Phase25CapabilityKind,
): CapabilityRegistration | null {
  return CAPABILITY_REGISTRY.get(kind) ?? null
}

/** Look up a single action registration, or `null` when it is unsupported. */
export function actionRegistration(
  kind: Phase25CapabilityKind,
  action: string,
): CapabilityActionRegistration | null {
  const registration = capabilityRegistration(kind)
  if (registration === null) return null
  return registration.actions.find((entry) => entry.action === action) ?? null
}

/** Whether a kind accepts an action. */
export function validateAction(kind: Phase25CapabilityKind, action: string): boolean {
  return actionRegistration(kind, action) !== null
}

/** The risk level of an action, or `null` when the action is unsupported. */
export function getRisk(kind: Phase25CapabilityKind, action: string): string | null {
  return actionRegistration(kind, action)?.risk ?? null
}

/** Whether an action requires approval, or `false` when it is unsupported. */
export function requiresApproval(kind: Phase25CapabilityKind, action: string): boolean {
  return actionRegistration(kind, action)?.requiresApproval ?? false
}

/** The bounded timeout for an action, or `null` when it is unsupported. */
export function actionTimeoutMs(kind: Phase25CapabilityKind, action: string): number | null {
  return actionRegistration(kind, action)?.timeoutMs ?? null
}

/** The result of validating an action's input. */
export type InputValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate an action's input against its closed field table.
 *
 * The input must have exactly the declared fields, each of the declared type,
 * within the code-owned field, byte and depth ceilings. Garbage fails closed;
 * it is never repaired into something that would pass.
 */
export function validateInput(
  kind: Phase25CapabilityKind,
  action: string,
  input: unknown,
): InputValidation {
  const registration = actionRegistration(kind, action)
  if (registration === null) {
    return { ok: false, reason: 'that capability does not accept that action' }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'the action input is not an object' }
  }
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length > PHASE25_LIMITS.maxInputFields) {
    return { ok: false, reason: 'the action input has too many fields' }
  }
  const expected = new Set(registration.inputFields)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return { ok: false, reason: 'the action input does not match the expected fields' }
  }
  for (const field of registration.inputFields) {
    const rule = FIELD_RULES[field]
    if (rule === undefined) {
      return { ok: false, reason: `the field ${field} has no validation rule` }
    }
    if (!rule(record[field])) {
      return { ok: false, reason: `the field ${field} is not valid` }
    }
  }
  const serialised = safeSerialise(record)
  const limit = Math.min(registration.maxInputBytes, PHASE25_LIMITS.maxInputBytes)
  if (serialised === null || serialised.length > limit) {
    return { ok: false, reason: 'the action input is larger than the bound' }
  }
  if (inputDepth(record) > PHASE25_LIMITS.maxInputDepth) {
    return { ok: false, reason: 'the action input is deeper than the bound' }
  }
  return { ok: true }
}

/* ------------------------------------------------------------ internals */

function safeSerialise(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** The maximum nesting depth of a JSON-like value. Cyclic values count as 1. */
export function inputDepth(value: unknown, seen: Set<object> = new Set()): number {
  if (typeof value !== 'object' || value === null) return 0
  if (seen.has(value)) return 1
  seen.add(value)
  let deepest = 0
  for (const member of Array.isArray(value) ? value : Object.values(value)) {
    deepest = Math.max(deepest, inputDepth(member, seen))
  }
  return 1 + deepest
}

/**
 * The declared action lists, checked against the registry.
 *
 * Every action named in a kind's closed action list must be registered. An
 * empty result means the registry and the vocabulary agree.
 */
export function unregisteredActions(): readonly {
  readonly kind: Phase25CapabilityKind
  readonly action: string
}[] {
  const declared: readonly [Phase25CapabilityKind, readonly string[]][] = [
    ['browser', BROWSER_ACTIONS],
    ['terminal', TERMINAL_ACTIONS],
    ['clipboard', CLIPBOARD_ACTIONS],
    ['download', DOWNLOAD_ACTIONS],
    ['upload', UPLOAD_ACTIONS],
  ]
  const missing: { kind: Phase25CapabilityKind; action: string }[] = []
  for (const [kind, actions] of declared) {
    for (const action of actions) {
      if (!validateAction(kind, action)) missing.push({ kind, action })
    }
  }
  return missing
}

/** Whether a value has the shape of the registry map. */
export function isCapabilityRegistry(value: unknown): value is ReadonlyMap<Phase25CapabilityKind, CapabilityRegistration> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

/** The instant a value parses to, or `null`. Re-exported for callers. */
export { instantMs }
