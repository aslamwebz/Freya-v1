/**
 * THE PERSONALITY PERSISTENCE PORT.
 *
 * The narrow seam between the Personality & Relationship domain and whatever
 * holds it across a restart. It is deliberately the smallest vocabulary that
 * can be honest about durability: a snapshot of retained items goes in, a
 * snapshot comes out, and the port states in words whether that snapshot will
 * still be there tomorrow.
 *
 * ## Why a port and not a store
 *
 * The Personality domain is synchronous, clock-free and reachable from code
 * that must never be able to touch a disk. Persistence is the opposite: it is
 * asynchronous, it is seeded with a key from outside Core, and it fails in ways
 * a domain store has no vocabulary for. So the two meet here, in one file
 * with no logic in it, and the domain never learns that persistence exists.
 *
 * It is also the whole of what an integration is allowed to assume. Whoever
 * wires this into Core is given these five members and a health report, and
 * nothing else: no path, no key, no cipher, no file layout and no way to write
 * a record that did not come from the domain.
 *
 * ## What the port deliberately cannot express
 *
 * - **No authority.** Nothing here grants, checks or widens anything. A
 *   relationship item is *data about a person*, and a record that has been
 *   durably stored is still not a permission — the strongest statement this
 *   port can make is that a record survived a restart.
 * - **No query language.** A snapshot in, a snapshot out. There is no
 *   `getByKind`, no `findByTag` and no `query(sql)`, so a caller cannot
 *   reach content except by asking the domain, which is the only component
 *   that enforces scope.
 * - **No journal.** No activity row, no envelope, no event id is minted by
 *   writing personality data down. Recovery reads one encrypted file and
 *   nothing else.
 * - **No clock.** Every instant in a snapshot is a field of a record the
 *   domain already stamped. The port reads no clock.
 */

import type { CueUsageLedger, RelationshipItem } from '../types'
import type { PersonalityPersistenceErrorCode } from './errors'

/**
 * The snapshot format this build reads and writes.
 *
 * A version number rather than a bare object, because a file with no version
 * in it cannot be refused *specifically* — it can only be refused as
 * "unrecognised", which sends somebody looking for damage that is not there.
 */
export const PERSONALITY_SNAPSHOT_VERSION = 1

/**
 * Everything the Personality domain retains, as one value.
 *
 * `items` holds live items *and* tombstones, which is the whole point: a
 * retirement that leaves no record cannot be answered `retired` after a
 * restart, it degrades into "there is nothing here", and a person who took
 * something back would find it silently return. Recovery is only truthful if
 * what was destroyed and why is remembered.
 *
 * `ledger` holds the anti-repetition cue usage metadata — hashes, kinds,
 * instants and counts. No conversation text, ever.
 */
export interface PersonalitySnapshot {
  readonly v: typeof PERSONALITY_SNAPSHOT_VERSION
  readonly items: readonly RelationshipItem[]
  readonly ledger: CueUsageLedger
}

/**
 * What a recovery attempt produced.
 *
 * A refusal is a value, not an exception, because "the file could not be
 * believed" is a *state* the caller has to survive: it must go on holding an
 * empty, explicitly degraded store rather than crashing. There is no third
 * answer where some records were returned, because a store whose contents
 * depend on which records an attacker chose to damage is not a store.
 */
export type PersonalitySnapshotLoad =
  | { readonly ok: true; readonly snapshot: PersonalitySnapshot }
  | {
      readonly ok: false
      readonly code: PersonalityPersistenceErrorCode
      readonly reason: string
    }

/**
 * The port itself: five members, all of them about durability.
 *
 * `durable` and `durabilityReason` answer "does this survive a restart?",
 * which is a property of the *mechanism* — no key, no file, no write path.
 * `faultReason` answers "can this be trusted right now?", which is a property
 * of the *bytes* — a record that failed authentication, a file that is not
 * this format, a store that has been closed.
 */
export interface PersonalityPersistencePort {
  /** What this port actually is. Never a guess, never optimistic. */
  readonly mode: 'encrypted' | 'ephemeral'
  /** Whether a commit through this port is still there after a restart. */
  readonly durable: boolean
  /** Why nothing survives a restart, in words. Null when it does survive. */
  readonly durabilityReason: string | null
  /** Why this port cannot be trusted right now. Null when it can. */
  readonly faultReason: string | null
  /** Recover the retained snapshot, or refuse in words. */
  load(): Promise<PersonalitySnapshotLoad>
  /** Write the whole snapshot. There is no partial write and no append. */
  commit(snapshot: PersonalitySnapshot): Promise<void>
  /** Release the port. After this it serves nothing and writes nothing. */
  close(): Promise<void>
}

/**
 * What a person or a surface is told about durability.
 *
 * `reason` is the single sentence to show; `faultReason` is there so a caller
 * can tell "we chose not to persist" from "persistence is broken", which are
 * different problems with different fixes.
 */
export interface PersonalityPersistenceHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  /** Whether personality data is safe across a restart *right now*. */
  readonly durable: boolean
  /** One sentence for a person. Null when durable and healthy. */
  readonly reason: string | null
  /** Non-null only when the bytes could not be believed. */
  readonly faultReason: string | null
  /** Items held: live items and tombstones together. */
  readonly retained: number
}
