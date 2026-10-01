import { expect } from 'vitest'
import type { ContextAdmission } from '../../../../core/context/types'
import {
  CONTEXT_ADAPTER_REJECTION_REASONS,
  type ContextAdapterRejectionCode,
  type ContextAdapterResult,
} from '../../../../core/context/adapters/admission'

/**
 * Shared helpers for the adapter suite.
 *
 * The theme of these tests is that an adapter is a *bouncer, not a judge*:
 * every malformed input must leave through a named door, and nothing a person
 * wrote may follow it out. Hence the canaries below: private-looking strings
 * that must never appear in a refusal or in metadata, only in the candidate
 * itself.
 */

export const CANARY = 'the settlement offer is 40k and the deadline is Friday'
export const CANARY_LABEL = 'offer-letter (final).docx'
export const CANARY_URI = 'file:///home/owner/legal/offer-letter (final).docx'

export function expectRefusal(
  result: ContextAdapterResult,
  code: ContextAdapterRejectionCode,
): void {
  if (result.ok) throw new Error(`expected refusal '${code}', got an admission`)
  expect(result.code).toBe(code)
  // The reason is verbatim from the fixed table: refusals phrase themselves,
  // they never quote the input back.
  expect(result.reason).toBe(CONTEXT_ADAPTER_REJECTION_REASONS[code])
}

export function expectAdmitted(result: ContextAdapterResult): ContextAdmission {
  if (!result.ok) {
    throw new Error(`expected an admission, refused (${result.code}): ${result.reason}`)
  }
  return result.admission
}

/**
 * Hand a runtime-negative input past the types — which is exactly the point:
 * the types describe the honest caller, the adapter must survive the other.
 */
export function mistyped<T>(input: unknown): T {
  return input as T
}
