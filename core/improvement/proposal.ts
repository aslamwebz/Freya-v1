/**
 * STAGE ONE — AN IMPROVEMENT PROPOSAL, AND ITS STAGING.
 *
 * Two constructors, and the boundaries they carry.
 *
 * ## A proposal is a claim about a cost, not a wish
 *
 * `ImprovementKind` has no member meaning "make Freya better". Every member is something
 * measurably costing her — a latency, a repeated failure, a budget overrun, a knowledge gap that
 * keeps recurring. `symptom` is bounded text and is refused whole if it is secret-shaped, and
 * `evidenceRefs` must name at least one thing the claim rests on: nothing else is a proposal.
 *
 * Confidence is capped at `medium` for **every** source including the owner. A proposal
 * generalises beyond the observation behind it, so "the owner is sure of it" is not a reason for
 * it to read as more certain than the evidence — and the ceiling is a refusal rather than a
 * silent clamp, so a caller asking for `high` is told no rather than obeyed.
 *
 * ## A proposal arrives unstaged
 *
 * `status` is assigned inside `createImprovementProposal`, absent from the input keys, so there
 * is no call shape — typed or untyped — that produces a proposal arriving `staged`, `tested` or
 * `merged`. A payload adding `status`, `mergesAt` or `restoresRevision` is refused by name.
 *
 * ## The two refusals that happen at construction
 *
 * - **A protected surface** is refused here. Refusing at merge would mean the work had already
 *   been staged against Freya's own authority or source tree.
 * - **A forbidden improvement** is refused here for the same reason, and the list includes two
 *   entries specific to this phase: nothing may write the improvement gates themselves, and
 *   nothing may disable or narrow rollback. An architecture improvement that can turn off its own
 *   brakes is not an improvement.
 *
 * ## Rollback steps are declared up front
 *
 * `rollbackSteps` is required and non-empty at construction, and `costCeiling` must be at least
 * the price of the plan's own rollback rehearsal. Both because "we would roll it back if we
 * could" is not a rollback plan: a change whose undo nobody wrote down is a change that cannot be
 * undone under pressure, which is the only time undoing matters.
 */

import { findSecretShape } from '../brain/admission'
import type { Confidence } from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import {
  IMPROVEMENT_COST_UNITS,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_RETENTION,
  STAGE_TARGETS,
  instantMs,
  isBoundedImprovementText,
  isForbiddenImprovement,
  isForbiddenImprovementFieldName,
  isImprovementKind,
  isImprovementRef,
  isImprovementSlug,
  isProtectedImprovementSurface,
  isStageTarget,
  type ImprovementKind,
  type ImprovementProposal,
  type ImprovementStatus,
  type StageExecution,
  type StageTarget,
} from './types'

export type ImprovementResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export const PROPOSAL_INPUT_KEYS: readonly string[] = [
  'proposalId',
  'kind',
  'subject',
  'symptom',
  'occurrences',
  'evidenceRefs',
  'changes',
  'requirements',
  'targets',
  'rollbackSteps',
  'costCeiling',
  'tags',
  'confidence',
  'createdAt',
]

export const PROPOSAL_KEYS: readonly string[] = [
  ...PROPOSAL_INPUT_KEYS,
  'costSpent',
  'status',
  'expiresAt',
  'mergedAt',
  'mergedExpiresAt',
  'restoresRevision',
  'closedAt',
  'closedReason',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Refuse-not-ignore, before the exact-key check, as everywhere else in Core. */
function forbiddenFieldNames(input: unknown, depth = 0, nodes = { seen: 0 }): readonly string[] {
  if (depth > 3 || nodes.seen > 1_024) return []
  nodes.seen += 1
  if (typeof input !== 'object' || input === null) return []
  const found: string[] = []
  for (const [name, member] of Object.entries(input as Record<string, unknown>)) {
    if (isForbiddenImprovementFieldName(name)) found.push(name)
    if (typeof member === 'object' && member !== null) {
      found.push(...forbiddenFieldNames(member, depth + 1, nodes))
    }
  }
  return found
}

function boundedList(
  value: unknown,
  max: number,
  maxChars: number,
  label: string,
  code: string,
): AcquisitionRefusal<never> | null {
  if (!Array.isArray(value) || value.length > max || !value.every((item) => isBoundedImprovementText(item, maxChars))) {
    return { ok: false, code, reason: `${label} must be at most ${max} bounded, non-empty entries` }
  }
  return null
}

type AcquisitionRefusal<T> = { readonly ok: false; readonly code: string; readonly reason: string } & { readonly value?: T }

/**
 * Construct an improvement proposal.
 *
 * Refuses rather than repairs. An `occurrences` count is bounded and non-negative, and a
 * `symptom` carrying secret-shaped text fails whole rather than being stored and redacted later.
 */
export function createImprovementProposal(input: unknown): ImprovementResult<ImprovementProposal> {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'an improvement proposal input must be an object' }
  }
  const forbidden = forbiddenFieldNames(input)
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `the proposal carries field(s) a change may not hold: [${forbidden.join(', ')}]`,
    }
  }
  if (!hasExactKeys(input, PROPOSAL_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...PROPOSAL_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `improvement proposal keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }
  if (!isBoundedImprovementText(input.proposalId, IMPROVEMENT_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'proposalId must be a non-empty bounded string' }
  }
  if (!isImprovementKind(input.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'kind is not in the closed improvement vocabulary' }
  }
  if (!isImprovementSlug(input.subject) || String(input.subject).length > IMPROVEMENT_LIMITS.maxSlugChars) {
    return {
      ok: false,
      code: 'invalid-slug',
      reason: 'subject must be a bounded code-owned slug: a description of what changes, not a path or a command',
    }
  }
  if (!isBoundedImprovementText(input.symptom, IMPROVEMENT_LIMITS.maxSummaryChars)) {
    return { ok: false, code: 'invalid-text', reason: 'symptom must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.symptom)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'invalid-text',
      reason: `the symptom is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  if (
    typeof input.occurrences !== 'number' ||
    !Number.isInteger(input.occurrences) ||
    input.occurrences < 1 ||
    input.occurrences > 1_000_000
  ) {
    return {
      ok: false,
      code: 'invalid-id',
      reason: 'occurrences must be a positive whole number: a count of what was seen, never a score',
    }
  }
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length > IMPROVEMENT_LIMITS.maxEvidenceRefs ||
    !input.evidenceRefs.every((ref) => isImprovementRef(ref))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'evidenceRefs must be bounded opaque ids: a proposal rests on something that was observed',
    }
  }
  if (input.evidenceRefs.length === 0) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'a proposal must name at least one evidence reference; nothing else is a proposal',
    }
  }
  const changes = boundedList(
    input.changes,
    IMPROVEMENT_LIMITS.maxChanges,
    IMPROVEMENT_LIMITS.maxSummaryChars,
    'changes',
    'invalid-text',
  )
  if (changes !== null) return changes
  const changeList = input.changes as readonly string[]
  if (changeList.length === 0) {
    return {
      ok: false,
      code: 'invalid-text',
      reason: 'a proposal must describe at least one change: a change to nothing is not a change',
    }
  }
  for (const change of changeList) {
    const shaped = findSecretShape(change)
    if (shaped !== null) {
      return {
        ok: false,
        code: 'invalid-text',
        reason: `a change description is secret-shaped (${shaped}) and was refused whole`,
      }
    }
  }
  if (
    !Array.isArray(input.requirements) ||
    input.requirements.length > IMPROVEMENT_LIMITS.maxRequirements ||
    !input.requirements.every((item) => isImprovementRef(item))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'requirements must be bounded opaque ids: what the change would need, never what it holds',
    }
  }
  const forbiddenRequirement = (input.requirements as readonly string[]).find((item) =>
    isForbiddenImprovement(item),
  )
  if (forbiddenRequirement !== undefined) {
    return {
      ok: false,
      code: 'forbidden-improvement',
      reason: `an improvement may never require ${forbiddenRequirement}; a change that needs it is not an improvement`,
    }
  }
  if (
    !Array.isArray(input.targets) ||
    input.targets.length > IMPROVEMENT_LIMITS.maxRequirements ||
    !input.targets.every((item) => isImprovementRef(item))
  ) {
    return { ok: false, code: 'invalid-tags', reason: 'targets must be bounded opaque labels' }
  }
  const protectedSurface = (input.targets as readonly string[]).find((item) =>
    isProtectedImprovementSurface(item),
  )
  if (protectedSurface !== undefined) {
    return {
      ok: false,
      code: 'protected-surface',
      reason: `an improvement may never target ${protectedSurface}; refusing now rather than after the work has been staged`,
    }
  }
  if (
    !Array.isArray(input.rollbackSteps) ||
    input.rollbackSteps.length === 0 ||
    input.rollbackSteps.length > IMPROVEMENT_LIMITS.maxRollbackSteps ||
    !input.rollbackSteps.every((step) => isBoundedImprovementText(step, IMPROVEMENT_LIMITS.maxReasonChars))
  ) {
    return {
      ok: false,
      code: 'invalid-text',
      reason: `rollbackSteps must be between 1 and ${IMPROVEMENT_LIMITS.maxRollbackSteps} bounded steps: an undo nobody wrote down is not an undo`,
    }
  }
  if (
    typeof input.costCeiling !== 'number' ||
    !Number.isInteger(input.costCeiling) ||
    input.costCeiling < 1 ||
    input.costCeiling > IMPROVEMENT_LIMITS.maxCostUnits
  ) {
    return {
      ok: false,
      code: 'invalid-id',
      reason: `costCeiling must be a whole number of code-owned cost units between 1 and ${IMPROVEMENT_LIMITS.maxCostUnits}`,
    }
  }
  // The rehearsal is part of the plan, so the ceiling has to be able to pay for it. Without this
  // a proposal could be constructed whose own rollback could never be rehearsed — which would
  // make `rollback-verified` unsatisfiable and quietly unmergeable rather than refused.
  if (input.costCeiling < IMPROVEMENT_COST_UNITS.perRollbackRehearsal) {
    return {
      ok: false,
      code: 'budget-exhausted',
      reason: `a ceiling of ${input.costCeiling} unit(s) cannot pay for the rollback rehearsal every change must be able to prove`,
    }
  }
  if (
    !Array.isArray(input.tags) ||
    input.tags.length > IMPROVEMENT_LIMITS.maxTagsPerRecord ||
    !input.tags.every((tag) => isImprovementRef(tag) && tag.length <= IMPROVEMENT_LIMITS.maxTagChars)
  ) {
    return { ok: false, code: 'invalid-tags', reason: 'tags must be bounded code-owned labels' }
  }
  if (
    input.confidence !== 'unknown' &&
    input.confidence !== 'low' &&
    input.confidence !== 'medium'
  ) {
    return {
      ok: false,
      code: 'invalid-confidence',
      reason: 'confidence must be unknown, low or medium: a proposal generalises, and none of these is high',
    }
  }
  const created = instantMs(input.createdAt)
  if (created === null) {
    return { ok: false, code: 'invalid-instant', reason: 'createdAt must parse as an instant' }
  }
  const expiresAt = new Date(created + IMPROVEMENT_RETENTION.maxProposalLifetimeMs).toISOString()

  return {
    ok: true,
    value: Object.freeze({
      proposalId: input.proposalId as string,
      kind: input.kind as ImprovementKind,
      subject: input.subject as string,
      symptom: input.symptom as string,
      occurrences: input.occurrences,
      evidenceRefs: Object.freeze([...(input.evidenceRefs as readonly string[])]),
      changes: Object.freeze([...changeList]),
      requirements: Object.freeze([...(input.requirements as readonly string[])]),
      targets: Object.freeze([...(input.targets as readonly string[])]),
      rollbackSteps: Object.freeze([...(input.rollbackSteps as readonly string[])]),
      costCeiling: input.costCeiling,
      costSpent: 0,
      tags: Object.freeze([...(input.tags as readonly string[])]),
      confidence: input.confidence as Confidence,
      // Assigned, never taken from the payload.
      status: 'proposed' as ImprovementStatus,
      createdAt: input.createdAt as string,
      expiresAt,
      mergedAt: null,
      mergedExpiresAt: null,
      restoresRevision: null,
      closedAt: null,
      closedReason: null,
    }),
  }
}

/**
 * Close a proposal with a named reason. A proposal cannot simply stop being a proposal.
 */
export function closeImprovementProposal(
  proposal: ImprovementProposal,
  decision: { now: string; to: 'rejected' | 'expired' | 'rolled-back' | 'merged'; reason: string },
): ImprovementResult<ImprovementProposal> {
  if (decision.now === undefined || instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the closure instant must parse as an instant' }
  }
  const closes: Record<string, readonly string[]> = {
    rejected: [
      'owner-rejected-this-proposal',
      'tests-failed',
      'red-team-found-something',
      'review-rejected-the-change',
      'rollback-unverified-so-refused',
    ],
    expired: ['aged-out-past-retention'],
    'rolled-back': ['rollback-completed'],
    merged: ['change-merged'],
  }
  const allowed = closes[decision.to]
  if (allowed === undefined) {
    return { ok: false, code: 'invalid-closed-reason', reason: `${decision.to} is not a closing status` }
  }
  if (!allowed.includes(decision.reason)) {
    return {
      ok: false,
      code: 'invalid-closed-reason',
      reason: `a ${decision.to} proposal cannot carry the reason ${decision.reason}`,
    }
  }
  if (decision.to === 'rolled-back' && proposal.restoresRevision === null) {
    return {
      ok: false,
      code: 'nothing-to-roll-back',
      reason: 'no revision was recorded for this change, so there is nothing a rollback could restore',
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...proposal,
      status: decision.to as ImprovementStatus,
      closedAt: decision.now,
      closedReason: decision.reason as ImprovementProposal['closedReason'],
    }),
  }
}

/**
 * A description of how a change would be carried out.
 *
 * `appliedBy` is **hard-set** to `'owner'` and there is no parameter for it, so nothing in this
 * system can describe a change that a machine would apply. That is the phase's headline claim,
 * expressed as a type rather than as a promise in a comment: a self-merge is not prevented here,
 * it is *unrepresentable*.
 */
export function describeStage(input: {
  target: StageTarget
  summary: string
  breadth: number
}): StageExecution {
  return Object.freeze({
    target: input.target,
    summary: input.summary,
    breadth: input.breadth,
    appliedBy: 'owner' as const,
  })
}

/**
 * The stage targets a proposal may name, checked against the closed table.
 *
 * Kept as a function rather than an inline check so a caller cannot pass a target the domain has
 * never heard of, and so widening the vocabulary is a visible line in a diff.
 */
export function isKnownStageTarget(value: unknown): value is StageTarget {
  return isStageTarget(value) && (STAGE_TARGETS as readonly string[]).includes(value)
}