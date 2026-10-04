/**
 * Canonical digests, for binding an approval to exactly one action.
 *
 * Two properties matter and both are about *what this file is not allowed to be*.
 *
 * **It is not a security primitive.** This is two independent 32-bit FNV-1a lanes
 * over a canonical string, chosen because it is a dozen lines, has no dependency,
 * cannot be subtly wrong in the permissive direction, and is trivially re-derivable
 * in a test. It answers exactly one question: "is this the same action the owner
 * approved?" The threat there is not a chosen-prefix collision — it is an attacker
 * presenting approval *A* for action *B*, which a comparison of the canonical form
 * refuses regardless of any hash. If this ever needs to be unguessable it has to be a
 * keyed MAC computed by Core, and the seam for that is a port, not this file.
 *
 * **It is pure.** No clock, no randomness, no environment, no I/O — enforced by the
 * structural audit in `./assertions`, which reads this file's source.
 */

/** The separator. Cannot survive unescaped in a value, because values are escaped first. */
const UNIT = ' '

/** The two FNV-1a offset bases, as 32-bit words. Different bases, so the lanes differ. */
const LANE_BASES: readonly number[] = Object.freeze([0x811c_9dc5, 0x0100_0193])

/**
 * Escape one component of a canonical form.
 *
 * The separator is a space and a space in a value is escaped, so no two different
 * lists can produce the same canonical string by moving a boundary. Without this,
 * `['a b', 'c']` and `['a', 'b c']` would share a digest — which is precisely the
 * "approval for one thing presented for another" failure the digest exists to close.
 */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\s')
}

/** One FNV-1a lane over already-canonicalised text. */
function lane(text: string, basis: number): number {
  let hash = basis >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash ^ (text.charCodeAt(index) & 0xff)) >>> 0
    // 32-bit FNV-1a without a widening multiply: the shift-and-add keeps every
    // intermediate inside the 32-bit range, so no lane can depend on float rounding.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/**
 * A stable digest over ordered components.
 *
 * Components are joined in order after escaping and prefixed with their count, so
 * `['ab', 'c']` and `['a', 'bc']` cannot collide. The result is 16 lowercase hex
 * characters and is stable across processes and platforms, which is what lets a
 * digest survive a restart and lets a test assert a literal.
 */
export function canonicalDigest(components: readonly (string | number | boolean)[]): string {
  const escaped = components.map((component) => escape(String(component)))
  // The count is a component of its own so that a shorter list can never be padded
  // into a longer one.
  const canonical = [String(components.length), ...escaped].join(UNIT)
  return LANE_BASES.map((basis) => hex(lane(canonical, basis))).join('')
}

/**
 * A digest of a whole list of strings, order-sensitive.
 *
 * Separate from {@link canonicalDigest} because the *policy* digest is the one
 * compared across a restart, and it wants the count and the order to be part of the
 * answer: reordering two allowed roots changes what the policy permits, so it must
 * change the digest.
 */
export function listDigest(values: readonly string[]): string {
  return canonicalDigest(values)
}

function hex(word: number): string {
  return (word >>> 0).toString(16).padStart(8, '0')
}

/** The digest of an empty list. Returned for a policy with no roots: a refusal, not a pass. */
export const EMPTY_DIGEST = canonicalDigest([])