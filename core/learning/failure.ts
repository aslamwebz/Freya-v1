export type FailureCategory =
  | 'execution_error'
  | 'verification_failure'
  | 'authorization_denied'
  | 'resource_exhausted'
  | 'unknown_failure'

export interface StructuredFailure {
  readonly category: FailureCategory
  readonly cause: string
  readonly capability?: string
  readonly verifier?: string
  readonly details?: Record<string, unknown>
  readonly advisedCorrection: string
}

/**
 * Classifies a step or execution failure into a structured failure record.
 * Enforces Phase 3C.1:
 * - Distinguishes capability execution, verification, and authorization failures.
 * - Never treats capability or verification failures as system corruption.
 * - Formulates actionable advice for corrective replanning.
 */
export function categorizeFailure(
  failure: unknown,
  stepContext?: { readonly capability?: string; readonly verifier?: string; readonly input?: Record<string, unknown> },
): StructuredFailure {
  let cause = 'Unknown step failure'
  let rawReason = ''
  let rawCategory: string | undefined

  if (typeof failure === 'string') {
    cause = failure.slice(0, 300)
    rawReason = failure.toLowerCase()
  } else if (typeof failure === 'object' && failure !== null) {
    const f = failure as Record<string, unknown>
    if (typeof f.reason === 'string') {
      cause = f.reason.slice(0, 300)
      rawReason = f.reason.toLowerCase()
    } else if (typeof f.message === 'string') {
      cause = f.message.slice(0, 300)
      rawReason = f.message.toLowerCase()
    } else if (typeof f.error === 'string') {
      cause = f.error.slice(0, 300)
      rawReason = f.error.toLowerCase()
    }
    if (typeof f.category === 'string') {
      rawCategory = f.category
    }
  }

  let category: FailureCategory = 'unknown_failure'
  let advisedCorrection = 'Select an alternative approach or different parameters.'

  if (rawCategory === 'authorization_denied' || rawReason.includes('permission') || rawReason.includes('unauthorized') || rawReason.includes('denied')) {
    category = 'authorization_denied'
    advisedCorrection = 'Do not request actions requiring unauthorized capabilities; request user grant or use permitted capabilities.'
  } else if (
    rawCategory === 'verification_failure' ||
    stepContext?.verifier ||
    rawReason.includes('verifier') ||
    rawReason.includes('verification') ||
    rawReason.includes('missing') ||
    rawReason.includes('not found') ||
    rawReason.includes('did not match') ||
    rawReason.includes('source')
  ) {
    category = 'verification_failure'
    advisedCorrection = 'The observation failed verifier criteria. Select an alternative path, query, or target rather than repeating this check.'
  } else if (
    rawCategory === 'execution_error' ||
    rawReason.includes('timeout') ||
    rawReason.includes('network') ||
    rawReason.includes('connection') ||
    rawReason.includes('exit code') ||
    rawReason.includes('error')
  ) {
    category = 'execution_error'
    advisedCorrection = 'The capability failed during runtime execution. Adjust input format, verify environmental prerequisites, or try a fallback capability.'
  } else if (rawReason.includes('budget') || rawReason.includes('deadline') || rawReason.includes('limit')) {
    category = 'resource_exhausted'
    advisedCorrection = 'The task approached resource limits. Consolidate operations into fewer steps.'
  }

  return {
    category,
    cause,
    capability: stepContext?.capability,
    verifier: stepContext?.verifier,
    advisedCorrection,
  }
}

/**
 * Formats structured failure into explicit replanning instructions.
 * Enforces Phase 3C.2:
 * "The previous step failed because: <reason>. Propose an alternative approach that does not repeat this failure."
 */
export function formatCorrectiveAdvice(structured: StructuredFailure): string {
  return (
    `CORRECTIVE REPLANNING REQUIRED:\n` +
    `The previous step failed (${structured.category}). Cause: ${structured.cause}\n` +
    `Correction: ${structured.advisedCorrection} Do not repeat this identical action.`
  )
}

function objectsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).sort()
  const keysB = Object.keys(objB).sort()
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false
    if (!objectsEqual(objA[k], objB[k])) return false
  }
  return true
}

/**
 * Determines whether a newly proposed plan repeats the exact action of the failed step.
 * Phase 3C.2 invariant: new plan MUST differ from the failed plan.
 */
export function isPlanRepeatingFailure(
  proposedSteps: readonly { readonly capability: string; readonly input: Record<string, unknown> }[],
  failedStep: { readonly capability: string; readonly input: Record<string, unknown> } | undefined,
): boolean {
  if (!failedStep || proposedSteps.length === 0) return false

  for (const step of proposedSteps) {
    if (step.capability === failedStep.capability) {
      if (step.capability === 'filesystem.inspect') {
        if (typeof step.input.path === 'string' && step.input.path === failedStep.input.path) {
          return true
        }
      } else if (step.capability === 'research.search') {
        if (typeof step.input.query === 'string' && step.input.query === failedStep.input.query) {
          return true
        }
      } else if (objectsEqual(step.input, failedStep.input)) {
        return true
      }
    }
  }

  return false
}
