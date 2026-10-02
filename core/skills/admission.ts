import type { WorkRegistry } from '../work/capability'
import type { Capability, PrincipalId } from '../protocol/core-protocol'
import {
  isEvidenceCode,
  isForbiddenSkillCapability,
  isSkillCapability,
  isSkillEvidenceKind,
  isSkillKind,
  isSkillMetricName,
  isSkillSource,
  isSkillTrustClass,
  normaliseContractEntry,
  normaliseSkillName,
  normaliseTag,
  sanitiseSkillText,
  SKILL_LIMITS,
  type EvaluationAuthor,
  type EvaluationSubjectKind,
  type SkillCommentary,
  type SkillContract,
  type SkillContractEntry,
  type SkillEvidence,
  type SkillKind,
  type SkillMetric,
  type SkillRefusalCode,
  type SkillRequiredCapabilities,
  type SkillSource,
  type SkillStepSeed,
  type SkillTrustClass,
  type SkillVerificationEvidence,
} from './types'
import { isOwnerSubmittableEvidenceKind } from './evaluation'
import { deriveSkillId, skillContentHash } from './identity'

/**
 * ADMISSION — the door untrusted text has to get through to be a procedure.
 *
 * Nothing becomes a skill here. This module turns a *request* into a validated,
 * bounded, canonical record, or refuses it with a closed code. What it refuses is the
 * interesting part, so the refusals are listed with the attack each answers.
 *
 * ## Refusals, and why
 *
 * | code                          | attack it answers |
 * | ----------------------------- | ----------------- |
 * | `invalid-skill-name`          | a name that could collide, traverse, or impersonate a protected domain |
 * | `invalid-skill-kind`          | "whatever the caller wanted" |
 * | `contract-incomplete`         | a procedure with no declared inputs/outputs/postconditions — unverifiable by construction |
 * | `forbidden-capability-required` | authority laundering through a declaration |
 * | `unknown-capability-required` | a capability outside the closed vocabulary |
 * | `capability-not-registered`   | a capability this Core has no Work capability for, so it could never execute |
 * | `step-capability-mismatch`    | a step naming a capability outside the declared requirement |
 * | `step-verifier-missing`       | a step with no way to be checked — the failure Verification-is-not-optional names |
 * | `untrusted-content`           | text a page/document/email/model supplied being admitted as a procedure |
 * | `evidence-*` (in evaluation)  | forged verification, self-awarded success |
 *
 * ## The anti-poisoning property, stated properly
 *
 * Untrusted content can reach this module in exactly one way: as **text the owner
 * pasted in**, or as a proposal Core assembled from an untrusted source. In both cases
 * the result is a `candidate` at trust class `owner-declared` or
 * `untrusted-content`, and:
 *
 * - a `candidate` is not selectable, so it cannot execute;
 * - `untrusted-content` may never execute at all, at any status (see `execution.ts`);
 * - trust is inherited by revisions and never raised (`improvement.ts`);
 * - and a revision resets to `candidate`, so "it was promoted once, therefore it is
 *   fine" is not a state any of this can reach.
 *
 * So a web page cannot become a promoted procedure. It can become a candidate the
 * owner has to look at, and if the owner promotes it that is a decision a person made
 * about a thing they were shown — which is the only honest version of "Freya learned
 * a procedure from the internet".
 */

export interface AdmissionRequest {
  /** Assigned by Core. Never read from a payload. */
  readonly source: SkillSource
  /** Assigned by Core, from the pathway the request arrived through. */
  readonly trustClass: SkillTrustClass
  /** The principal whose act this is. Assigned by Core. */
  readonly admittedBy: PrincipalId
  readonly originRef: string | null
  /** What the registry can actually execute. Read, never written. */
  readonly registry: WorkRegistry
  /** The payload, exactly as it arrived. Untrusted in full. */
  readonly payload: unknown
  /** Revising an existing skill rather than admitting a new one. */
  readonly existing?: { readonly skillId: string; readonly version: number } | null
}

export type AdmissionOutcome =
  | {
      readonly ok: true
      readonly record: AdmissionRecord
    }
  | { readonly ok: false; readonly code: SkillRefusalCode; readonly reason: string }

/** The canonical, validated record. Its content is private; its identity is not. */
export interface AdmissionRecord {
  readonly skillId: string
  readonly name: string
  readonly kind: SkillKind
  readonly contentHash: string
  readonly summary: string
  readonly contract: SkillContract
  readonly steps: readonly SkillStepSeed[]
  readonly requiredCapabilities: readonly Capability[]
  readonly applicability: readonly string[]
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: PrincipalId
  readonly originRef: string | null
  readonly version: number
}

function refuse(code: SkillRefusalCode, reason: string): AdmissionOutcome {
  return { ok: false, code, reason }
}

/**
 * Validate and canonicalise one admission request.
 *
 * Refuses rather than repairs, everywhere. A payload that arrives with a missing
 * field, an unknown kind, a forbidden capability or an oversized list is a bad
 * request, and quietly dropping the offending element would produce a record that
 * looks valid and is scoped smaller than its author believed — which is invisible in
 * review and is exactly how a capability quietly fails to be checked.
 */
export function admitSkill(request: AdmissionRequest): AdmissionOutcome {
  const { payload } = request
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return refuse('invalid-skill-name', 'a skill request must be an object')
  }
  const raw = payload as Record<string, unknown>

  const name = normaliseSkillName(raw.name)
  if (name === null) {
    return refuse(
      'invalid-skill-name',
      'a skill name is lower-case letters, digits and single dashes, at most 64 characters',
    )
  }

  if (!isSkillKind(raw.kind)) {
    return refuse('invalid-skill-kind', 'a skill kind must be procedure, template, plan or tool-sequence')
  }
  const kind = raw.kind

  const summary = sanitiseSkillText(raw.summary, SKILL_LIMITS.maxSummaryChars)
  if (summary.length === 0) {
    return refuse('contract-incomplete', 'a skill needs a summary, bounded to 400 characters')
  }

  const contract = parseContract(raw.contract)
  if (!contract.ok) return refuse(contract.code, contract.reason)

  const applicability = parseApplicability(raw.applicability)
  if (!applicability.ok) return refuse(applicability.code, applicability.reason)

  const required = parseRequiredCapabilities(raw.requiredCapabilities)
  if (!required.ok) return refuse(required.code, required.reason)
  const requiredCapabilities = required.value

  const steps = parseSteps(raw.steps)
  if (!steps.ok) return refuse(steps.code, steps.reason)

  // Capability laundering: a forbidden capability is refused whatever else is right,
  // and it is refused *before* the registry lookup so the refusal names the policy
  // rather than a missing registration.
  for (const capability of requiredCapabilities) {
    if (isForbiddenSkillCapability(capability)) {
      return refuse(
        'forbidden-capability-required',
        `${capability} decides whether Freya may act, so no reusable procedure may require it`,
      )
    }
  }
  for (const step of steps.value) {
    if (isForbiddenSkillCapability(step.capability as Capability)) {
      return refuse(
        'forbidden-capability-required',
        `step ${step.key} names ${step.capability}, which decides whether Freya may act`,
      )
    }
  }

  // A skill that requires a Guard capability this Core cannot execute is a skill that
  // can never run. Refusing it at admission keeps the registry free of entries that are
  // promises nobody can keep.
  //
  // The check is against what *some registered Work capability declares*, not against
  // a capability name: `requiredCapabilities` holds Guard vocabulary entries
  // (`work.execute`, `search.web`), while the registry is keyed by implementation name
  // (`test.record`, a future Searcher capability). Comparing the two directly would
  // refuse every skill in this build for the wrong reason.
  const executable = new Set<string>()
  for (const name of request.registry.names()) {
    const registered = request.registry.capability(name)
    if (registered !== undefined) executable.add(registered.capability)
  }
  for (const capability of requiredCapabilities) {
    if (!executable.has(capability)) {
      return refuse(
        'capability-not-registered',
        `this Core has no registered capability that needs ${capability}, so nothing could execute it`,
      )
    }
  }

  // Every step must name a verifier. This is the check behind "verification is not
  // optional", applied one layer earlier than Work applies it: a skill that reaches
  // Work with an unverifiable step would produce a Step that closes on an Action.
  for (const step of steps.value) {
    if (typeof step.verifier !== 'string' || step.verifier.length === 0) {
      return refuse(
        'step-verifier-missing',
        `step ${step.key} names no verifier, so nothing could ever close it`,
      )
    }
    if (!request.registry.verifierNames().includes(step.verifier)) {
      return refuse(
        'step-verifier-missing',
        `this Core has no verifier called ${step.verifier}, so nothing could ever close step ${step.key}`,
      )
    }
    if (!request.registry.has(step.capability)) {
      return refuse(
        'capability-not-registered',
        `step ${step.key} names ${step.capability}, which this Core has not registered`,
      )
    }
  }

  const body = {
    name,
    kind,
    summary,
    contract: contract.value,
    steps: steps.value,
    requiredCapabilities: requiredCapabilities as readonly string[],
    applicability: applicability.value,
  }

  const skillId = request.existing?.skillId ?? deriveSkillId(name)
  const version = request.existing === null || request.existing === undefined ? 1 : request.existing.version + 1

  return {
    ok: true,
    record: {
      ...body,
      kind,
      skillId,
      contentHash: skillContentHash(body),
      version,
      source: request.source,
      trustClass: request.trustClass,
      admittedBy: request.admittedBy,
      originRef: request.originRef,
      requiredCapabilities: requiredCapabilities as readonly Capability[],
    },
  }
}

/* ------------------------------------------------------------------ parts */

function parseContract(raw: unknown): { ok: true; value: SkillContract } | { ok: false; code: SkillRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'contract-incomplete', reason: 'a skill needs a declared contract' }
  }
  const contract = raw as Record<string, unknown>
  const lists: Record<keyof SkillContract, readonly SkillContractEntry[]> = {
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
  }
  for (const key of ['inputs', 'outputs', 'preconditions', 'postconditions'] as const) {
    const value = contract[key]
    // `preconditions` may be empty: "nothing must be true first" is a checkable
    // claim. The other three may not, because a procedure that declares nothing it
    // produces cannot be verified against anything.
    if (!Array.isArray(value)) {
      return { ok: false, code: 'contract-incomplete', reason: `the contract needs a ${key} list` }
    }
    if (value.length === 0 && key !== 'preconditions') {
      return { ok: false, code: 'contract-incomplete', reason: `the contract needs at least one ${key} entry` }
    }
    if (value.length > SKILL_LIMITS.maxContractEntries) {
      return {
        ok: false,
        code: 'contract-oversize',
        reason: `a contract list holds at most ${SKILL_LIMITS.maxContractEntries} entries`,
      }
    }
    const entries: SkillContractEntry[] = []
    for (const item of value) {
      const entry = normaliseContractEntry(item)
      if (entry === null) {
        return {
          ok: false,
          code: 'contract-incomplete',
          reason: `each ${key} entry needs a slug name and a bounded description`,
        }
      }
      entries.push(entry)
    }
    lists[key] = entries
  }
  return { ok: true, value: lists }
}

function parseApplicability(
  raw: unknown,
): { ok: true; value: readonly string[] } | { ok: false; code: SkillRefusalCode; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'contract-incomplete', reason: 'a skill needs declared applicability tags' }
  }
  if (raw.length === 0) {
    return { ok: false, code: 'contract-incomplete', reason: 'a skill with no applicability tag can never be selected' }
  }
  if (raw.length > SKILL_LIMITS.maxApplicabilityTags) {
    return {
      ok: false,
      code: 'contract-oversize',
      reason: `a skill declares at most ${SKILL_LIMITS.maxApplicabilityTags} applicability tags`,
    }
  }
  const tags: string[] = []
  for (const item of raw) {
    const tag = normaliseTag(item)
    if (tag === null) {
      return {
        ok: false,
        code: 'contract-incomplete',
        reason: 'an applicability tag is lower-case letters, digits and single dashes',
      }
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return { ok: true, value: tags }
}

function parseRequiredCapabilities(
  raw: unknown,
): { ok: true; value: readonly Capability[] } | { ok: false; code: SkillRefusalCode; reason: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'contract-incomplete',
      reason: 'a skill must declare the capabilities it will require',
    }
  }
  if (raw.length === 0) {
    return {
      ok: false,
      code: 'contract-incomplete',
      reason: 'a skill must declare at least the capability it will require; an empty list declares nothing Freya could check',
    }
  }
  if (raw.length > SKILL_LIMITS.maxRequiredCapabilities) {
    return {
      ok: false,
      code: 'contract-oversize',
      reason: `a skill requires at most ${SKILL_LIMITS.maxRequiredCapabilities} capabilities`,
    }
  }
  const capabilities: SkillRequiredCapabilities = []
  for (const item of raw) {
    if (!isSkillCapability(item)) {
      return {
        ok: false,
        code: 'unknown-capability-required',
        reason: `${String(item)} is not in the capability vocabulary`,
      }
    }
    if (capabilities.includes(item)) continue
    capabilities.push(item)
  }
  return { ok: true, value: capabilities }
}

function parseSteps(
  raw: unknown,
): { ok: true; value: readonly SkillStepSeed[] } | { ok: false; code: SkillRefusalCode; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'no-steps', reason: 'a skill needs an ordered list of steps' }
  }
  if (raw.length === 0) {
    return { ok: false, code: 'no-steps', reason: 'a skill with no steps has nothing to execute' }
  }
  if (raw.length > SKILL_LIMITS.maxSteps) {
    return {
      ok: false,
      code: 'too-many-steps',
      reason: `a skill declares at most ${SKILL_LIMITS.maxSteps} steps`,
    }
  }
  const steps: SkillStepSeed[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, code: 'step-verifier-missing', reason: 'each step must be an object' }
    }
    const step = item as Record<string, unknown>
    const key = typeof step.key === 'string' ? step.key.trim() : ''
    if (key.length === 0 || key.length > 64 || !/^[A-Za-z0-9._-]+$/.test(key)) {
      return {
        ok: false,
        code: 'step-verifier-missing',
        reason: 'each step needs a stable key of letters, digits, dots, dashes or underscores',
      }
    }
    if (seen.has(key)) {
      return { ok: false, code: 'step-verifier-missing', reason: `step ${key} appears twice` }
    }
    seen.add(key)
    const capability = typeof step.capability === 'string' ? step.capability.trim() : ''
    if (capability.length === 0) {
      return { ok: false, code: 'step-verifier-missing', reason: `step ${key} names no capability` }
    }
    const verifier = typeof step.verifier === 'string' ? step.verifier.trim() : ''
    steps.push({ key, capability, verifier })
  }
  return { ok: true, value: steps }
}

/* ------------------------------------------------------------- evaluation */

/** What an evaluation request carries. Untrusted in full until validated. */
export interface EvaluationRequest {
  readonly skillId: unknown
  readonly subjectKind: unknown
  readonly subjectRef: unknown
  readonly evidence: unknown
  readonly verification: unknown
  readonly metrics: unknown
  readonly commentaryLength: unknown
  /** Who is recording it. Core fixes this; a payload never does. */
  readonly author: EvaluationAuthor
  /** True when the request arrived over the renderer command surface. */
  readonly fromCommand: boolean
}

export interface ParsedEvaluation {
  readonly skillId: string
  readonly subjectKind: EvaluationSubjectKind
  readonly subjectRef: string
  readonly evidence: readonly SkillEvidence[]
  readonly verification: readonly SkillVerificationEvidence[]
  readonly metrics: readonly SkillMetric[]
  readonly commentary: SkillCommentary | null
  readonly author: EvaluationAuthor
}

export type EvaluationParseOutcome =
  | { readonly ok: true; readonly value: ParsedEvaluation }
  | { readonly ok: false; readonly code: SkillRefusalCode; readonly reason: string }

/**
 * Validate an evaluation request.
 *
 * Three properties, all of them about forgery:
 *
 * 1. **`verification-record` may not be submitted by a caller.** A verification record
 *    is something Core's Work and Mission verifiers produce. A payload that asserts
 *    one could forge verification, so the kind is refused outright on the command
 *    path — there is no way for a window to write `passed` into the evidence a
 *    promotion decision reads.
 * 2. **`model-opinion` may not be submitted by a caller** either. Commentary is
 *    recorded as a **length** the caller supplies; the text itself is never accepted,
 *    stored or forwarded, so there is nothing to smuggle.
 * 3. **Evidence codes come from the closed table** per kind, so a payload cannot
 *    smuggle the words "the tests passed" into a field the policy reads.
 *
 * Core's own internal evaluation path sets `fromCommand: false` and may carry
 * verification records it produced itself.
 */
export function parseEvaluationRequest(
  request: EvaluationRequest,
  now: string,
): EvaluationParseOutcome {
  const { skillId, subjectKind, subjectRef, evidence, verification, metrics, commentaryLength } = request

  if (typeof skillId !== 'string' || skillId.trim().length === 0 || skillId.length > SKILL_LIMITS.maxRefChars) {
    return { ok: false, code: 'no-such-skill', reason: 'an evaluation names the skill it is about' }
  }
  if (
    typeof subjectKind !== 'string' ||
    !['trial-run', 'mission', 'verification', 'owner-report'].includes(subjectKind)
  ) {
    return {
      ok: false,
      code: 'invalid-skill-kind',
      reason: `an evaluation subject kind must be one of trial-run, mission, verification, owner-report`,
    }
  }
  if (
    typeof subjectRef !== 'string' ||
    subjectRef.trim().length === 0 ||
    subjectRef.length > SKILL_LIMITS.maxRefChars ||
    !/^[A-Za-z0-9._:-]+$/.test(subjectRef)
  ) {
    return { ok: false, code: 'no-such-skill', reason: 'an evaluation subject must be a bounded id' }
  }

  const parsedEvidence: SkillEvidence[] = []
  if (evidence !== undefined && evidence !== null) {
    if (!Array.isArray(evidence)) {
      return { ok: false, code: 'evidence-missing', reason: 'evidence must be a list' }
    }
    if (evidence.length > SKILL_LIMITS.maxEvidenceItems) {
      return {
        ok: false,
        code: 'evidence-missing',
        reason: `one evaluation carries at most ${SKILL_LIMITS.maxEvidenceItems} evidence items`,
      }
    }
    for (const item of evidence) {
      const parsed = parseEvidenceItem(item, request.fromCommand, now)
      if (!parsed.ok) return parsed
      parsedEvidence.push(parsed.value)
    }
  }

  const parsedVerification: SkillVerificationEvidence[] = []
  if (request.fromCommand) {
    if (verification !== undefined && verification !== null) {
      return {
        ok: false,
        code: 'evidence-self-reported',
        reason: 'a verification record is something Core produces; a caller may not submit one',
      }
    }
  } else if (verification !== undefined && verification !== null) {
    if (!Array.isArray(verification)) {
      return { ok: false, code: 'evidence-self-reported', reason: 'verification must be a list' }
    }
    if (verification.length > SKILL_LIMITS.maxVerificationItems) {
      return {
        ok: false,
        code: 'evidence-self-reported',
        reason: `one evaluation carries at most ${SKILL_LIMITS.maxVerificationItems} verification records`,
      }
    }
    for (const item of verification) {
      const parsed = parseVerificationItem(item, now)
      if (!parsed.ok) return parsed
      parsedVerification.push(parsed.value)
    }
  }

  const parsedMetrics: SkillMetric[] = []
  if (metrics !== undefined && metrics !== null) {
    if (!Array.isArray(metrics)) {
      return { ok: false, code: 'evidence-missing', reason: 'metrics must be a list' }
    }
    if (metrics.length > SKILL_LIMITS.maxMetrics) {
      return {
        ok: false,
        code: 'evidence-missing',
        reason: `one evaluation carries at most ${SKILL_LIMITS.maxMetrics} metrics`,
      }
    }
    for (const item of metrics) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return { ok: false, code: 'evidence-missing', reason: 'each metric must be an object' }
      }
      const metric = item as Record<string, unknown>
      if (!isSkillMetricName(metric.name)) {
        return { ok: false, code: 'evidence-missing', reason: `${String(metric.name)} is not a metric Freya records` }
      }
      if (
        typeof metric.value !== 'number' ||
        !Number.isInteger(metric.value) ||
        metric.value < 0 ||
        metric.value > 1_000_000_000
      ) {
        return { ok: false, code: 'evidence-missing', reason: 'a metric is a non-negative integer' }
      }
      parsedMetrics.push({ name: metric.name, value: metric.value })
    }
  }

  let commentary: SkillCommentary | null = null
  if (commentaryLength !== undefined && commentaryLength !== null) {
    if (typeof commentaryLength !== 'number' || !Number.isInteger(commentaryLength) || commentaryLength < 0) {
      return { ok: false, code: 'evidence-missing', reason: 'commentary is recorded as a character count' }
    }
    if (commentaryLength > SKILL_LIMITS.maxCommentaryChars) {
      return {
        ok: false,
        code: 'evidence-missing',
        reason: `commentary is measured up to ${SKILL_LIMITS.maxCommentaryChars} characters`,
      }
    }
    commentary = { source: 'model', chars: commentaryLength }
  }

  return {
    ok: true,
    value: {
      skillId: skillId.trim(),
      subjectKind: subjectKind as EvaluationSubjectKind,
      subjectRef: subjectRef.trim(),
      evidence: parsedEvidence,
      verification: parsedVerification,
      metrics: parsedMetrics,
      commentary,
      author: request.author,
    },
  }
}

function parseEvidenceItem(
  raw: unknown,
  fromCommand: boolean,
  now: string,
): { ok: true; value: SkillEvidence } | { ok: false; code: SkillRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'evidence-missing', reason: 'each evidence item must be an object' }
  }
  const item = raw as Record<string, unknown>
  if (!isSkillEvidenceKind(item.kind)) {
    return { ok: false, code: 'evidence-missing', reason: `${String(item.kind)} is not an evidence kind` }
  }
  if (fromCommand && !isOwnerSubmittableEvidenceKind(item.kind)) {
    if (item.kind === 'verification-record') {
      return {
        ok: false,
        code: 'evidence-self-reported',
        reason: 'a verification record is something Core produces; a caller may not submit one',
      }
    }
    return {
      ok: false,
      code: 'evidence-self-reported',
      reason: 'model opinion cannot be submitted as evidence; commentary is recorded as a length only',
    }
  }
  if (!isEvidenceCode(item.kind, item.code)) {
    return {
      ok: false,
      code: 'evidence-missing',
      reason: `${String(item.code)} is not a code for ${item.kind}`,
    }
  }
  if (typeof item.count !== 'number' || !Number.isInteger(item.count) || item.count < 0 || item.count > 1_000_000) {
    return { ok: false, code: 'evidence-missing', reason: 'evidence is counted with a non-negative integer' }
  }
  if (item.count === 0 && item.kind !== 'model-opinion') {
    return { ok: false, code: 'evidence-missing', reason: 'zero evidence is not evidence; omit it instead' }
  }
  const at = typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)) ? item.at : now
  return { ok: true, value: { kind: item.kind, code: item.code as string, count: item.count, at } }
}

function parseVerificationItem(
  raw: unknown,
  now: string,
): { ok: true; value: SkillVerificationEvidence } | { ok: false; code: SkillRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'evidence-self-reported', reason: 'each verification record must be an object' }
  }
  const item = raw as Record<string, unknown>
  if (
    typeof item.verificationId !== 'string' ||
    item.verificationId.length === 0 ||
    item.verificationId.length > SKILL_LIMITS.maxRefChars ||
    typeof item.verifier !== 'string' ||
    item.verifier.length === 0 ||
    item.verifier.length > SKILL_LIMITS.maxRefChars
  ) {
    return { ok: false, code: 'evidence-self-reported', reason: 'a verification record needs an id and a verifier' }
  }
  if (item.verdict !== 'passed' && item.verdict !== 'failed') {
    return { ok: false, code: 'evidence-self-reported', reason: 'a verification record is passed or failed' }
  }
  const at = typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)) ? item.at : now
  return {
    ok: true,
    value: {
      verificationId: item.verificationId,
      verifier: item.verifier,
      verdict: item.verdict,
      at,
    },
  }
}

/** Re-exported so callers validate a source with the same predicate admission uses. */
export { isSkillSource, isSkillTrustClass }