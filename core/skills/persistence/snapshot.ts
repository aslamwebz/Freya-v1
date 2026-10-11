import {
  isForbiddenSkillCapability,
  isRef,
  isSkillCapability,
  isSkillKind,
  isSkillSource,
  isSkillStatus,
  isSkillTrustClass,
  isSkillVerificationState,
  SKILL_LIMITS,
  SKILL_RETIREMENT_REASONS,
  type SkillContract,
  type SkillContractEntry,
  type SkillKind,
  type SkillRecord,
  type SkillRetirementReason,
  type SkillSource,
  type SkillStatus,
  type SkillStepSeed,
  type SkillTrustClass,
  type SkillVerificationState,
} from '../types'
import { SkillPersistenceError } from './errors'
import { SKILL_SNAPSHOT_VERSION, type SkillSnapshot } from './port'
import type { Capability } from '../../../shared/contracts/capabilities'

/**
 * SKILL SNAPSHOT CODEC — validate on the way in *and* on the way out.
 *
 * The point of decoding on read is that a record which **authenticates** but is still
 * illegal must be refused. Authentication proves the bytes came from a process that
 * held this domain's key; it does not prove the record is one this build is willing
 * to execute. So the same predicates run in both directions, and a record that fails
 * either is a fault, not a value.
 *
 * This matters most for the three fields that carry consequences:
 *
 * - `requiredCapabilities` is checked against the closed `Capability` vocabulary *and*
 *   against the forbidden list, so a stored body cannot reintroduce capability
 *   laundering by being written before a rule was tightened.
 * - `status` is checked against the closed status table, so a body cannot disagree
 *   with the journal in a way that makes execution think it is promoted.
 * - `trustClass` is checked, so a body cannot claim `code-owned` when the journal
 *   recorded `untrusted-content`.
 */

/** The widest a serialised skill body may be. */
export const MAX_SKILL_BODY_BYTES = SKILL_LIMITS.maxSkillBodyBytes

/** The widest a whole snapshot may be. */
export const MAX_SKILL_SNAPSHOT_BYTES = SKILL_LIMITS.maxSnapshotBytes

/**
 * The widest one serialised record may be.
 *
 * A quarter of the snapshot bound, so a registry can never be brought to its limit by
 * one procedure: the per-record bound is what stops a single oversized body from
 * making every other record's write fail.
 */
export const MAX_SKILL_RECORD_BYTES = Math.floor(MAX_SKILL_SNAPSHOT_BYTES / 8)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function decodeEntries(raw: unknown, max: number): readonly SkillContractEntry[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null
  const entries: SkillContractEntry[] = []
  for (const item of raw) {
    if (!isObject(item)) return null
    const name = item.name
    const description = item.description
    if (!isNonEmptyString(name, SKILL_LIMITS.maxNameChars)) return null
    if (typeof description !== 'string' || description.length > SKILL_LIMITS.maxEntryChars) return null
    entries.push({ name, description })
  }
  return entries
}

function decodeContract(raw: unknown): SkillContract | null {
  if (!isObject(raw)) return null
  if (!onlyKeys(raw, ['inputs', 'outputs', 'preconditions', 'postconditions'])) return null
  const max = SKILL_LIMITS.maxContractEntries
  const inputs = decodeEntries(raw.inputs, max)
  const outputs = decodeEntries(raw.outputs, max)
  const preconditions = decodeEntries(raw.preconditions, max)
  const postconditions = decodeEntries(raw.postconditions, max)
  if (inputs === null || outputs === null || preconditions === null || postconditions === null) return null
  return { inputs, outputs, preconditions, postconditions }
}

function decodeSteps(raw: unknown): readonly SkillStepSeed[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SKILL_LIMITS.maxSteps) return null
  const steps: SkillStepSeed[] = []
  for (const item of raw) {
    if (!isObject(item)) return null
    if (!onlyKeys(item, ['key', 'capability', 'verifier'])) return null
    if (!isNonEmptyString(item.key, 64)) return null
    if (!isNonEmptyString(item.capability, SKILL_LIMITS.maxRefChars)) return null
    if (!isNonEmptyString(item.verifier, SKILL_LIMITS.maxRefChars)) return null
    steps.push({ key: item.key, capability: item.capability, verifier: item.verifier })
  }
  return steps
}

function decodeCapabilities(raw: unknown): readonly Capability[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SKILL_LIMITS.maxRequiredCapabilities) return null
  const capabilities: Capability[] = []
  for (const item of raw) {
    if (!isSkillCapability(item)) return null
    // Re-checked here, not only at admission. A tightening of the forbidden list must
    // not leave already-stored bodies able to declare what is now banned.
    if (isForbiddenSkillCapability(item)) return null
    if (!capabilities.includes(item)) capabilities.push(item)
  }
  return capabilities
}

function decodeTags(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SKILL_LIMITS.maxApplicabilityTags) return null
  const tags: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > SKILL_LIMITS.maxTagChars) return null
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item)) return null
    if (!tags.includes(item)) tags.push(item)
  }
  return tags
}

/**
 * Validate one stored skill body.
 *
 * Throws `SkillPersistenceError('invalid', …)` rather than returning a partial
 * record, because the caller cannot repair it and a partial body would be a skill
 * with silently missing inputs.
 */
export function decodeSkillRecord(value: unknown): SkillRecord {
  if (!isObject(value)) throw new SkillPersistenceError('invalid', 'a skill record is not an object')
  if (
    !onlyKeys(value, [
      'skillId',
      'name',
      'kind',
      'status',
      'version',
      'verification',
      'contentHash',
      'summary',
      'contract',
      'steps',
      'requiredCapabilities',
      'applicability',
      'provenance',
      'createdAt',
      'updatedAt',
      'retiredAt',
      'retirementReason',
      'promotedAt',
    ])
  ) {
    throw new SkillPersistenceError('invalid', 'a skill record has an unrecognised shape')
  }

  if (!isRef(value.skillId)) throw new SkillPersistenceError('invalid', 'a skill record needs an id')
  if (typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.name)) {
    throw new SkillPersistenceError('invalid', 'a skill record needs a normalised name')
  }
  if (!isSkillKind(value.kind)) throw new SkillPersistenceError('invalid', 'a skill record needs a known kind')
  if (!isSkillStatus(value.status)) throw new SkillPersistenceError('invalid', 'a skill record needs a known status')
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    throw new SkillPersistenceError('invalid', 'a skill version starts at 1 and increases by one')
  }
  if (!isSkillVerificationState(value.verification)) {
    throw new SkillPersistenceError('invalid', 'a skill record needs a known verification state')
  }
  if (!isNonEmptyString(value.contentHash, 64)) {
    throw new SkillPersistenceError('invalid', 'a skill record needs a content hash')
  }
  if (typeof value.summary !== 'string' || value.summary.length > SKILL_LIMITS.maxSummaryChars) {
    throw new SkillPersistenceError('invalid', 'a skill summary is bounded')
  }
  const contract = decodeContract(value.contract)
  if (contract === null) throw new SkillPersistenceError('invalid', 'a skill record needs a valid contract')
  const steps = decodeSteps(value.steps)
  if (steps === null) throw new SkillPersistenceError('invalid', 'a skill record needs valid steps')
  const requiredCapabilities = decodeCapabilities(value.requiredCapabilities)
  if (requiredCapabilities === null) {
    throw new SkillPersistenceError('invalid', 'a skill record needs a valid capability requirement')
  }
  const applicability = decodeTags(value.applicability)
  if (applicability === null) {
    throw new SkillPersistenceError('invalid', 'a skill record needs valid applicability tags')
  }

  if (!isObject(value.provenance)) throw new SkillPersistenceError('invalid', 'a skill record needs provenance')
  const provenance = value.provenance
  if (
    !onlyKeys(provenance, ['source', 'trustClass', 'admittedBy', 'admittedAt', 'parentSkillId', 'parentVersion', 'originRef'])
  ) {
    throw new SkillPersistenceError('invalid', 'a skill record has an unrecognised provenance shape')
  }
  if (!isSkillSource(provenance.source)) throw new SkillPersistenceError('invalid', 'unknown skill source')
  if (!isSkillTrustClass(provenance.trustClass)) {
    throw new SkillPersistenceError('invalid', 'unknown skill trust class')
  }
  if (!isNonEmptyString(provenance.admittedBy, SKILL_LIMITS.maxRefChars)) {
    throw new SkillPersistenceError('invalid', 'a skill record needs an admitting principal')
  }
  if (typeof provenance.admittedAt !== 'string' || !Number.isFinite(Date.parse(provenance.admittedAt))) {
    throw new SkillPersistenceError('invalid', 'a skill record needs an admission instant')
  }
  if (!isNullableString(provenance.parentSkillId)) {
    throw new SkillPersistenceError('invalid', 'a parent skill reference is a bounded id or null')
  }
  if (
    provenance.parentVersion !== null &&
    (typeof provenance.parentVersion !== 'number' ||
      !Number.isInteger(provenance.parentVersion) ||
      provenance.parentVersion < 1)
  ) {
    throw new SkillPersistenceError('invalid', 'a parent version is a positive integer or null')
  }
  if (!isNullableString(provenance.originRef)) {
    throw new SkillPersistenceError('invalid', 'an origin reference is a bounded string or null')
  }

  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new SkillPersistenceError('invalid', 'a skill record needs a creation instant')
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new SkillPersistenceError('invalid', 'a skill record needs an update instant')
  }
  if (!isNullableString(value.retiredAt) || !isNullableString(value.promotedAt)) {
    throw new SkillPersistenceError('invalid', 'retirement and promotion instants are nullable strings')
  }
  const retirementReason = value.retirementReason
  if (retirementReason !== null && !SKILL_RETIREMENT_REASONS.includes(retirementReason as SkillRetirementReason)) {
    throw new SkillPersistenceError('invalid', 'unknown retirement reason')
  }

  return {
    skillId: value.skillId,
    name: value.name,
    kind: value.kind as SkillKind,
    status: value.status as SkillStatus,
    version: value.version,
    verification: value.verification as SkillVerificationState,
    contentHash: value.contentHash,
    summary: value.summary,
    contract,
    steps,
    requiredCapabilities,
    applicability,
    provenance: {
      source: provenance.source as SkillSource,
      trustClass: provenance.trustClass as SkillTrustClass,
      admittedBy: provenance.admittedBy,
      admittedAt: provenance.admittedAt,
      parentSkillId: provenance.parentSkillId,
      parentVersion: provenance.parentVersion,
      originRef: provenance.originRef,
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    retiredAt: value.retiredAt,
    retirementReason: retirementReason as SkillRetirementReason | null,
    promotedAt: value.promotedAt,
  }
}

/** Validate a whole snapshot before it is written. */
export function encodeSkillSnapshot(snapshot: SkillSnapshot): SkillSnapshot {
  if (!isObject(snapshot) || snapshot.v !== SKILL_SNAPSHOT_VERSION) {
    throw new SkillPersistenceError('invalid', `the skill snapshot is not version ${SKILL_SNAPSHOT_VERSION}`)
  }
  if (!Array.isArray(snapshot.records) || snapshot.records.length > SKILL_LIMITS.maxRetainedSkills) {
    throw new SkillPersistenceError('too_large', 'the skill snapshot holds more records than the registry allows')
  }
  const seen = new Set<string>()
  for (const record of snapshot.records) {
    const decoded = decodeSkillRecord(record)
    if (seen.has(decoded.skillId)) {
      throw new SkillPersistenceError('invalid', `two skill records share the id ${decoded.skillId}`)
    }
    seen.add(decoded.skillId)
  }
  return { v: SKILL_SNAPSHOT_VERSION, records: [...snapshot.records] }
}

/** Validate a whole snapshot on the way back in. */
export function decodeSkillSnapshot(snapshot: SkillSnapshot): SkillSnapshot {
  return encodeSkillSnapshot(snapshot)
}

/** Serialised size, for the whole-snapshot bound. */
export function skillSnapshotBytes(snapshot: SkillSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
}

export function skillRecordBytes(record: SkillRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

/** An empty snapshot, for a first run. */
export function emptySkillSnapshot(): SkillSnapshot {
  return { v: SKILL_SNAPSHOT_VERSION, records: [] }
}