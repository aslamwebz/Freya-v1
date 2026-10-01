/**
 * THE HANDS VALIDATION — exact-key validation for action envelopes.
 *
 * This file provides the validation helpers that ensure an action envelope
 * matches the expected shape exactly. It is the boundary between untrusted input
 * and the typed contract: nothing that does not match the exact key set is
 * admitted.
 *
 * ## What is deliberately enforced
 *
 * - **Exact keys.** An envelope with the right fields plus an extra field is
 *   refused. A missing field is refused. The key set must match exactly.
 * - **No coercion.** A string that looks like a number is not a number. A value
 *   of the wrong type is refused, not coerced.
 * - **No repair.** A bad value is dropped, not fixed. An input with a hole cut
 *   in it looks like valid input, and the hole is where the real behaviour
 *   would have been.
 */

import type { HandsActionRequest, HandsScopedCapabilityRef } from './contract'
import { HANDS_LIMITS, isAnyHandsCapabilityKind } from './types'

/**
 * The exact keys an action envelope must have.
 *
 * A closed set. Adding a key here is a visible change to the contract, not
 * something that quietly starts accepting new fields.
 */
const ACTION_ENVELOPE_KEYS: readonly string[] = [
  'actionId',
  'capabilityRef',
  'action',
  'input',
  'timeoutMs',
  'correlationId',
]

/**
 * The exact keys a capability reference must have.
 */
const CAPABILITY_REF_KEYS: readonly string[] = ['capabilityId', 'scope']

/**
 * Whether an object has exactly the specified keys.
 *
 * Returns `true` only when the object has every key in `keys` and no others.
 * This is the exact-key check that prevents a hostile payload from smuggling
 * extra fields past validation.
 */
export function hasExactKeys(obj: object, keys: readonly string[]): boolean {
  const actual = Object.keys(obj)
  if (actual.length !== keys.length) return false
  const expected = new Set(keys)
  for (const key of actual) {
    if (!expected.has(key)) return false
  }
  return true
}

/**
 * Whether a value is a plain object (not an array, null, or primitive).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is a valid capability id.
 *
 * A non-empty string with a bounded length.
 */
function isValidCapabilityId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/**
 * Whether a value is a valid scope.
 *
 * A non-empty string with a bounded length.
 */
function isValidScope(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/**
 * Whether a value is a valid action name.
 *
 * A non-empty string with a bounded length.
 */
function isValidActionName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/**
 * Whether a value is a valid id.
 *
 * A non-empty string with a bounded length.
 */
function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/**
 * Whether a value is a valid correlation id.
 *
 * An optional string with a bounded length.
 */
function isValidCorrelationId(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'string' && value.length <= 256
}

/**
 * Whether a value is a valid timeout.
 *
 * A positive number of milliseconds, bounded by `HANDS_LIMITS.maxActionTimeoutMs`.
 */
function isValidTimeout(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= HANDS_LIMITS.maxActionTimeoutMs
  )
}

/**
 * Whether a value is a valid sanitised input.
 *
 * A plain object with bounded fields, depth and size. Primitives only.
 */
function isValidInput(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const entries = Object.entries(value)
  if (entries.length > HANDS_LIMITS.maxInputFields) return false
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) return false
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
    if (!isValidValue(raw, 1)) return false
  }
  let serialised: string
  try {
    serialised = JSON.stringify(value)
  } catch {
    return false
  }
  return serialised.length <= HANDS_LIMITS.maxInputBytes
}

function isValidValue(value: unknown, depth: number): boolean {
  if (depth > HANDS_LIMITS.maxInputDepth) return false
  if (value === null) return true
  switch (typeof value) {
    case 'string':
      return value.length <= HANDS_LIMITS.maxInputBytes
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    default:
      return false
  }
}

/**
 * The result of validating an action envelope.
 */
export type HandsValidationResult =
  | { readonly ok: true; readonly request: HandsActionRequest }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate an action envelope.
 *
 * Checks that the envelope has exactly the expected keys, that each field has
 * the correct type, and that the capability reference is valid. Returns a
 * `HandsValidationResult` that is either a valid `HandsActionRequest` or a
 * reason for refusal.
 *
 * **Exact-key validation.** An envelope with extra fields is refused. This is
 * the boundary that prevents a hostile payload from smuggling authority or
 * capability fields past validation.
 */
export function validateActionEnvelope(envelope: unknown): HandsValidationResult {
  if (!isPlainObject(envelope)) {
    return { ok: false, reason: 'action envelope must be an object' }
  }

  if (!hasExactKeys(envelope, ACTION_ENVELOPE_KEYS)) {
    const actual = Object.keys(envelope).sort()
    const expected = [...ACTION_ENVELOPE_KEYS].sort()
    return {
      ok: false,
      reason: `action envelope keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isValidId(envelope.actionId)) {
    return { ok: false, reason: 'actionId must be a non-empty string' }
  }

  const capabilityRef = validateCapabilityRef(envelope.capabilityRef)
  if (!capabilityRef.ok) {
    return { ok: false, reason: capabilityRef.reason }
  }

  if (!isValidActionName(envelope.action)) {
    return { ok: false, reason: 'action must be a non-empty string' }
  }

  if (!isValidInput(envelope.input)) {
    return { ok: false, reason: 'input is not a valid sanitised input' }
  }

  if (!isValidTimeout(envelope.timeoutMs)) {
    return { ok: false, reason: 'timeoutMs must be a positive number of milliseconds' }
  }

  if (!isValidCorrelationId(envelope.correlationId)) {
    return { ok: false, reason: 'correlationId must be a string' }
  }

  return {
    ok: true,
    request: {
      actionId: envelope.actionId as string,
      capabilityRef: capabilityRef.ref,
      action: envelope.action as string,
      input: envelope.input as Record<string, unknown>,
      timeoutMs: (envelope.timeoutMs as number | null | undefined) ?? null,
      correlationId: (envelope.correlationId as string | undefined) ?? undefined,
    },
  }
}

/**
 * Validate a capability reference.
 */
function validateCapabilityRef(value: unknown):
  | { readonly ok: true; readonly ref: HandsScopedCapabilityRef }
  | { readonly ok: false; readonly reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'capabilityRef must be an object' }
  }

  if (!hasExactKeys(value, CAPABILITY_REF_KEYS)) {
    const actual = Object.keys(value).sort()
    const expected = [...CAPABILITY_REF_KEYS].sort()
    return {
      ok: false,
      reason: `capabilityRef keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isValidCapabilityId(value.capabilityId)) {
    return { ok: false, reason: 'capabilityId must be a non-empty string' }
  }

  if (!isValidScope(value.scope)) {
    return { ok: false, reason: 'scope must be a non-empty string' }
  }

  return {
    ok: true,
    ref: {
      capabilityId: value.capabilityId,
      scope: value.scope,
    },
  }
}

/**
 * Whether a capability kind is supported by this build.
 *
 * A pure function over the closed vocabulary. A kind that is not in the
 * vocabulary is not supported.
 */
export function isSupportedCapabilityKind(kind: string): boolean {
  return isAnyHandsCapabilityKind(kind)
}
