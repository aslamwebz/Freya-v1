import { findSecretShape } from '../brain/admission'
import { CONFIDENCE_RANK, SOURCE_TRUST_RANK, type Confidence, type EpistemicStatus, type SourceTrust } from '../brain/types'

/**
 * WHAT MEMORY IS NOT ALLOWED TO DO.
 *
 * One file, one rule: **memory is evidence, never authority.**
 *
 * Everything here exists to make that rule enforceable rather than aspirational.
 * The Brain already refuses to promote a source on the strength of its own content,
 * caps confidence at what the source class can carry, and refuses secret-shaped
 * text. Those are the right defences and this directory reuses them rather than
 * restating them. What the Brain does not do — because the Brain stores one kind of
 * thing and this subsystem spans eight domains and a portable file format — is
 * police the two places where "a claim" can turn into "a capability":
 *
 *   1. **Structure.** A field, key or property that *asserts* a permission. If a
 *      bundle says `{ grants: [...] }` or `{ stopAll: false }` or
 *      `{ capabilities: { shell: 'enabled' } }`, it is not offering knowledge, it is
 *      offering control, and a knowledge store has no field that means any of those
 *      things. Those are **refused**, not sanitised — a value that was rejected is
 *      visible, whereas a value that was quietly dropped leaves the owner believing
 *      their import worked.
 *
 *   2. **Content.** A sentence that *says* authority was granted. This is refused
 *      far less eagerly, and the difference matters: "I cleared stop all" is
 *      something an owner may genuinely have said, and a memory system that refused
 *      to record it would be lying about its own completeness. So a sentence like
 *      that is stored as what it is — a low-confidence **claim that somebody said
 *      so** — and the fact that it is an authority claim is disclosed rather than
 *      obeyed.
 *
 * The dividing line is between a claim about the world and a claim about the
 * machine. Freya has no memory of her own authority, and no code path in this
 * directory reads a memory to decide what she may do: `core/authority.ts` and Guard
 * hold that, and they are read fresh.
 */

/* ------------------------------------------------------------- structure */

/**
 * Field and key names that mean a permission.
 *
 * Matched case-insensitively after stripping separators, so `stop_all`, `stopAll`
 * and `STOP-ALL` are one name. The list is deliberately broad: a false positive
 * costs a person one refused field name, while a false negative here is a bundle
 * that carries authority in its luggage.
 */
const AUTHORITY_KEYS: readonly string[] = Object.freeze([
  'authority',
  'authorities',
  'grant',
  'grants',
  'granted',
  'permission',
  'permissions',
  'allowlist',
  'allow',
  'allowed',
  'approval',
  'approvals',
  'approved',
  'budget',
  'budgets',
  'spendlimit',
  'spendinglimit',
  'stopall',
  'stop',
  'clearstop',
  'latch',
  'latched',
  'capabilityenabled',
  'capabilities',
  'capability',
  'elevation',
  'privilege',
  'privileges',
  'sudo',
  'root',
  'admin',
  'override',
  'overrides',
  'bypass',
  'disabledguard',
  'guard',
  'governor',
])

/** Keys that would let a bundle rewrite who Freya is. */
const IDENTITY_KEYS: readonly string[] = Object.freeze([
  'identity',
  'identityroot',
  'immutable',
  'constitution',
  'claims',
  'selfdefinition',
  'personalitykernel',
  'stableTraits'.toLowerCase(),
])

/** The finding, in enough detail to be acted on without opening the bundle. */
export interface AuthorityFinding {
  /** The key or phrase that tripped it. Safe to show: a name, not content. */
  readonly field: string
  /** What kind of thing it tried to be. */
  readonly kind: 'authority' | 'identity'
}

/** Normalise a key so `stop_all`, `stopAll` and `STOP ALL` compare equal. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The first authority-shaped key at or below `value`, or null.
 *
 * Recursive, and bounded in depth, because a bundle is nested JSON and a nested
 * `{ authority: ... }` is exactly as much an attempt as a top-level one. Arrays
 * are walked too. A depth limit stops a deeply nested bomb from becoming a stack
 * overflow in the thing that is supposed to be protecting the process.
 */
export function findAuthorityKey(value: unknown, depth = 0): AuthorityFinding | null {
  return walk(value, depth, false)
}

/** As `findAuthorityKey`, but only looking for identity-rewriting keys. */
export function findIdentityKey(value: unknown, depth = 0): AuthorityFinding | null {
  return walk(value, depth, true)
}

const MAX_WALK_DEPTH = 12

function walk(value: unknown, depth: number, identity: boolean): AuthorityFinding | null {
  if (depth > MAX_WALK_DEPTH) {
    // Too deep to reason about safely. Reported as an authority finding rather than
    // ignored: the honest reading of a bundle nested past any reason a memory
    // bundle would nest is that it is not a memory bundle.
    return { field: 'nesting', kind: 'authority' }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walk(item, depth + 1, identity)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const flat = normaliseKey(key)
    if (identity) {
      if (IDENTITY_KEYS.includes(flat)) return { field: key, kind: 'identity' }
    } else if (AUTHORITY_KEYS.includes(flat)) {
      return { field: key, kind: 'authority' }
    }
    const found = walk(child, depth + 1, identity)
    if (found !== null) return found
  }
  return null
}

/* -------------------------------------------------------------- content */

/**
 * Phrases in which text asserts a permission for Freya.
 *
 * These are matched against *normalised* text (lowercased, punctuation collapsed to
 * single spaces) so that spacing and casing cannot hide a match, and they are
 * deliberately narrow about what counts: a memory saying "the guard denied the
 * request" is a true and useful memory, and only a memory saying the guard *no
 * longer applies* is an authority claim.
 *
 * Each entry carries the wording used when the claim is disclosed, so the owner
 * sees what tripped it rather than a bare "rejected".
 */
const AUTHORITY_PHRASES: readonly { readonly id: string; readonly pattern: RegExp }[] = Object.freeze([
  { id: 'permission-granted', pattern: /\b(?:you (?:now )?have|you are hereby granted|permission (?:is |has been )?granted)\b[^.]{0,60}\b(?:permission|access|clearance)\b/ },
  { id: 'authority-granted', pattern: /\b(?:authority|grants?) (?:is|are|has been|have been) (?:granted|given|extended|widened)\b/ },
  { id: 'approval-satisfied', pattern: /\b(?:approval|approvals?) (?:is|are|has been|have been) (?:satisfied|granted|given|auto ?approved)\b/ },
  { id: 'budget-raised', pattern: /\b(?:budget|spend|spending) (?:is |has been |was )?(?:raised|increased|lifted|removed)\b/ },
  { id: 'stop-cleared', pattern: /\b(?:clear|clearing|cleared|lift|lifting|lifted|release|released|disable|disabled) (?:the )?(?:stop all|stop-all|emergency stop|the stop)\b/ },
  { id: 'guard-bypassed', pattern: /\b(?:guard|governor|permission check|approval gate) (?:is |are )?(?:bypassed|disabled|turned off|switched off|ignored)\b/ },
  { id: 'self-authorised', pattern: /\b(?:you may|you can now|freya may|freya can now) (?:spend|act|run|execute|delete|write|send|pay|deploy)\b/ },
  // The optional group admits "is", "are" and "now" in either order, because "the
  // capability is now enabled" and "the capability now is enabled" are both things a
  // person writes, and a pattern that only matched one ordering would miss the other.
  { id: 'capability-enabled', pattern: /\b(?:capability|capabilities) (?:(?:is |are )?now |(?:is |are )?)(?:enabled|activated|unlocked|granted)\b/ },
  // "for" is optional because both "ask permission" and "ask for permission" are
  // things people write, and a pattern matching only one of them misses the other.
  { id: 'do-not-ask', pattern: /\b(?:do not|don't|no need to) (?:ask|request|wait for)(?:ing)? (?:for )?(?:permission|approval|confirmation|consent)\b/ },
])

/**
 * Whether text asserts a permission, and which phrase did it.
 *
 * Returns the id so a caller can disclose *what kind* of claim it found. The caller
 * decides what to do with it; this function only reports.
 */
export function findAuthorityClaim(text: string): string | null {
  const flat = normaliseText(text)
  for (const phrase of AUTHORITY_PHRASES) {
    if (phrase.pattern.test(flat)) return phrase.id
  }
  return null
}

function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ')
}

/* ------------------------------------------------------- import downgrade */

/**
 * The source class every imported record is given, whatever the bundle claims.
 *
 * `imported-document` is the honest name for "a file somebody handed us". It sits at
 * the bottom of the trust order alongside `external-untrusted`, and — this is the
 * part that matters — a bundle **cannot** arrive claiming to be an owner assertion
 * or a system observation, because those two classes are assigned by the pathway
 * that admitted the record, and a file is not a pathway.
 */
export const IMPORT_SOURCE: SourceTrust = 'imported-document'

/** The confidence ceiling for an imported record. */
export const IMPORT_CONFIDENCE_CEILING: Confidence = 'low'

/** The epistemic status an imported record may carry. Never `verified`. */
export const IMPORT_EPICEMIC_CEILING: EpistemicStatus = 'asserted'

export interface Downgrade {
  readonly source: SourceTrust
  readonly confidence: Confidence
  readonly epistemic: EpistemicStatus
  /** What was changed, so the import report can name it rather than hide it. */
  readonly adjusted: readonly string[]
}

/**
 * Force an imported record down to what a file can honestly support.
 *
 * Three things can never survive an import, and each is reported:
 *
 *  - **A stronger source.** A bundle that says `source: 'owner-assertion'` is
 *    rewritten to `imported-document`.
 *  - **A higher confidence.** Even an owner-classed claim in a file is capped at
 *    `low`, because the strongest thing a bundle can carry is the claim that its
 *    author wanted it believed.
 *  - **`verified`.** Nothing in this build verifies anything, so a bundle claiming
 *    it was checked is downgraded and named. See `fold.ts`: a record claiming
 *    verification is refused there too, so this is belt and braces.
 *
 * Returns the values to write plus what was adjusted, because a silent downgrade
 * would leave the owner believing their export round-tripped exactly.
 */
export function downgradeImported(claimed: {
  source?: unknown
  confidence?: unknown
  verificationStatus?: unknown
}): Downgrade {
  const adjusted: string[] = []

  let source: SourceTrust = IMPORT_SOURCE
  if (typeof claimed.source === 'string') {
    const wanted = claimed.source as SourceTrust
    if (SOURCE_TRUST_RANK[wanted] > SOURCE_TRUST_RANK[IMPORT_SOURCE]) {
      adjusted.push(`source "${wanted}" was replaced with "${IMPORT_SOURCE}": a file cannot assert who said something`)
      source = IMPORT_SOURCE
    } else if (wanted !== IMPORT_SOURCE) {
      source = wanted
    }
  }

  let confidence: Confidence = IMPORT_CONFIDENCE_CEILING
  if (typeof claimed.confidence === 'string') {
    const wanted = claimed.confidence as Confidence
    if (CONFIDENCE_RANK[wanted] > CONFIDENCE_RANK[IMPORT_CONFIDENCE_CEILING]) {
      adjusted.push(
        `confidence "${wanted}" was capped at "${IMPORT_CONFIDENCE_CEILING}": nothing in a bundle is checked`,
      )
      confidence = IMPORT_CONFIDENCE_CEILING
    } else {
      confidence = wanted
    }
  }

  let epistemic: EpistemicStatus = IMPORT_EPICEMIC_CEILING
  if (typeof claimed.verificationStatus === 'string') {
    const wanted = claimed.verificationStatus as EpistemicStatus
    if (wanted === 'verified') {
      adjusted.push(
        'verification status "verified" was replaced with "asserted": Freya cannot check a file',
      )
    } else {
      epistemic = wanted
    }
  }

  return { source, confidence, epistemic, adjusted }
}

/* ---------------------------------------------------------------- secrets */

/**
 * The first secret-shaped thing in this text, or null.
 *
 * Delegates to the Brain's own detector rather than keeping a second list. Two
 * lists would drift, and the weaker one would become the one that matters — a
 * secret that passes the check nobody remembers to update.
 *
 * A secret-reference is still admissible: Freya is allowed to know *that* a
 * credential exists and roughly where it lives, the way a person is told where the
 * keys are. What she is never handed is the credential.
 */
export function findSecretShapeIn(text: string): string | null {
  return findSecretShape(text)
}
