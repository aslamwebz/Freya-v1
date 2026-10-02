import { createHash } from 'node:crypto'
import {
  canonicalSkillBody,
  type SkillContract,
  type SkillKind,
  type SkillStepSeed,
} from './types'

/**
 * SKILL IDENTITY — deterministic, and derived from nothing a caller controls twice.
 *
 * ## Why identity is a hash of the name rather than a generated id
 *
 * Every other domain in Core issues ids from a factory, and that is right for
 * domains whose records are *events about things that happened*. A skill is
 * different: it is a **named reusable thing**, and two properties follow.
 *
 * 1. **Idempotent admission.** If the same owner declares `summarise-a-file`
 *    twice — after a restart, from two windows, from a retried command — it must
 *    be the *same* skill at version 2, not two skills that disagree. A generated
 *    id would make a retried command a silent duplicate, and duplicate procedures
 *    are how "which one is authoritative?" becomes unanswerable.
 * 2. **Determinism across processes.** Two Cores that admit the same name produce
 *    the same id, so a journal can be read by a test, a later phase, or a human
 *    with a script and still mean something.
 *
 * So `skillId = hash(domain ‖ normalised name)`. The normalised name is the single
 * key, which makes "no ambiguous active versions for one identity" structural rather
 * than a check somebody has to remember: the fold holds one record per `skillId`,
 * and `version` is a single number on it.
 *
 * ## Why the domain label is inside the hash
 *
 * The label is a prefix, not decoration. It means a skill id cannot be confused with
 * a context id, a work item id or anything else Core mints, and it means this
 * derivation cannot be reused to forge an id in another subsystem even if someone
 * copies the function.
 *
 * ## What is *not* here
 *
 * No clock, no randomness, no I/O. Both functions are pure, which is what lets the
 * anti-poisoning tests state "the same untrusted text admitted twice produces one
 * candidate, not two skills" as an equality rather than as a count.
 */

/**
 * This domain's own label inside every digest.
 *
 * Format, not secret. Exported so a test can reproduce a digest exactly rather than
 * asserting against the implementation's own arithmetic.
 */
export const SKILL_CRYPTO_DOMAIN = 'freya.skill.v1'

/** The bytes that separate digest inputs. A path cannot contain one; a slug cannot. */
const SEPARATOR = Buffer.from([0])

/**
 * The deterministic id for a normalised skill name.
 *
 * 16 hex characters of a SHA-256 digest: short enough to read in an activity row
 * and long enough that a collision is not a thing anyone will hit in a registry this
 * size (200 skills). It is an identifier, never a secret, and it is not derived from
 * anything private — only from the name the owner chose.
 */
export function deriveSkillId(normalisedName: string): string {
  const digest = createHash('sha256')
    .update(SKILL_CRYPTO_DOMAIN)
    .update(SEPARATOR)
    .update(normalisedName, 'utf8')
    .digest('hex')
  return `sk_${digest.slice(0, 16)}`
}

/**
 * The deterministic content hash of a skill body's semantics.
 *
 * Taken over {@link canonicalSkillBody}, which fixes key order and list order, so
 * two semantically identical bodies always hash identically — in this process, in a
 * later one, and in a test that builds the same body twice.
 *
 * This is what makes "a revision that changes nothing is not a new version"
 * detectable rather than merely discouraged: a proposal whose body hashes to the
 * current version's hash is refused with `identical-revision`, so an improvement loop
 * cannot manufacture versions out of no change and flood the history.
 *
 * It is a change detector, **not** a security control. The digest is unkeyed, so it
 * proves two bodies look the same; it does not prove who wrote either. Authorship is
 * the provenance record's job and the journal's.
 */
export function skillContentHash(body: {
  readonly name: string
  readonly kind: SkillKind
  readonly summary: string
  readonly contract: SkillContract
  readonly steps: readonly SkillStepSeed[]
  readonly requiredCapabilities: readonly string[]
  readonly applicability: readonly string[]
}): string {
  return createHash('sha256').update(canonicalSkillBody(body), 'utf8').digest('hex').slice(0, 32)
}