/**
 * THE CONTEXT PERSISTENCE PORT.
 *
 * The narrow seam between the Context domain and whatever holds it across a
 * restart. It is deliberately the smallest vocabulary that can be honest about
 * durability: a snapshot of retained records goes in, a snapshot comes out, and
 * the port states in words whether that snapshot will still be there tomorrow.
 *
 * ## Why a port and not a store
 *
 * The Context domain is synchronous, clock-free and reachable from code that
 * must never be able to touch a disk (`core/context/`). Persistence is the
 * opposite: it is asynchronous, it is seeded with a key from outside Core, and
 * it fails in ways a domain store has no vocabulary for. So the two meet here,
 * in one file with no logic in it, and the domain never learns that persistence
 * exists. `core/context/persistence/store.ts` is the one place that knows both.
 *
 * It is also the whole of what an integration is allowed to assume. Whoever
 * wires this into Core (issue #27, which owns `core/index.ts`) is given these
 * five members and a health report, and nothing else: no path, no key, no
 * cipher, no file layout and no way to write a record that did not come from
 * the domain.
 *
 * ## What the port deliberately cannot express
 *
 * - **No authority.** Nothing here grants, checks or widens anything. A
 *   snapshot is *photographs somebody already shared*, and a record that has
 *   been durably stored is still not a permission — the strongest statement
 *   this port can make is that a photograph survived a restart (Constitution
 *   C3: knowledge never implies permission). There is no field here a caller
 *   could read as a capability, which is the same rule `ContextItem` keeps.
 * - **No query language.** A snapshot in, a snapshot out. There is no
 *   `getByScope`, no `findByProvenance` and no `query(sql)`, so a caller cannot
 *   reach content except by asking the domain, which is the only component
 *   that enforces scope.
 * - **No journal.** A `context.*` event does not exist, and none is created
 *   here. Recovery reads one encrypted file and nothing else; no activity row,
 *   no envelope, no event id is minted by writing context down.
 * - **No clock.** Every instant in a snapshot is a field of a record the domain
 *   already stamped. The port reads no clock, so "did this expire while we were
 *   down?" is answered by the domain on the first observation, not guessed here.
 */

import type { ContextItem } from '../types'
import type { ContextPersistenceErrorCode } from './errors'

/**
 * The snapshot format this build reads and writes.
 *
 * A version number rather than a bare array, because a file with no version in
 * it cannot be refused *specifically* — it can only be refused as "unrecognised",
 * which sends somebody looking for damage that is not there. A future format is
 * `corrupt`, not guessed at.
 */
export const CONTEXT_SNAPSHOT_VERSION = 1

/**
 * Everything the Context domain retains, as one value.
 *
 * `records` holds live items *and* tombstones, which is the whole point: a
 * revocation that leaves no record cannot be answered `revoked` after a restart,
 * it degrades into "there is nothing here", and a person who took something back
 * would find it silently return. Recovery is only truthful if what was destroyed
 * and why is remembered.
 *
 * It does **not** hold the active scope. A scope is where somebody shared
 * something; the *current* scope is live session state, and restoring it would
 * point "here" at a conversation that is no longer happening (see
 * `setActiveScope` in `store.ts`).
 */
export interface ContextSnapshot {
  readonly v: typeof CONTEXT_SNAPSHOT_VERSION
  readonly records: readonly ContextItem[]
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
export type ContextSnapshotLoad =
  | { readonly ok: true; readonly snapshot: ContextSnapshot }
  | {
      readonly ok: false
      readonly code: ContextPersistenceErrorCode
      readonly reason: string
    }

/**
 * The port itself: five members, all of them about durability.
 *
 * `durable` and `durabilityReason` answer "does this survive a restart?", which
 * is a property of the *mechanism* — no key, no file, no write path at all.
 * `faultReason` answers "can this be trusted right now?", which is a property of
 * the *bytes* — a record that failed authentication, a file that is not this
 * format, a store that has been closed. The two are separate because conflating
 * them is how a store ends up reporting `durable: true` while every read is
 * failing: degradation was tracked, it was just never read by anything.
 *
 * A non-null `faultReason` makes the port refuse to serve and refuse to write,
 * and that refusal is load-bearing rather than cautious — see
 * `encrypted-store.ts`.
 */
export interface ContextPersistencePort {
  /** What this port actually is. Never a guess, never optimistic. */
  readonly mode: 'encrypted' | 'ephemeral'
  /** Whether a commit through this port is still there after a restart. */
  readonly durable: boolean
  /** Why nothing survives a restart, in words. Null when it does survive. */
  readonly durabilityReason: string | null
  /** Why this port cannot be trusted right now. Null when it can. */
  readonly faultReason: string | null
  /** Recover the retained snapshot, or refuse in words. */
  load(): Promise<ContextSnapshotLoad>
  /** Write the whole snapshot. There is no partial write and no append. */
  commit(snapshot: ContextSnapshot): Promise<void>
  /** Release the port. After this it serves nothing and writes nothing. */
  close(): Promise<void>
}

/**
 * What a person or a surface is told about durability.
 *
 * `reason` is the single sentence to show; `faultReason` is there so a caller can
 * tell "we chose not to persist" from "persistence is broken", which are
 * different problems with different fixes — the first needs a secure key, the
 * second needs a working disk. `retained` is zero when the store could not be
 * believed, which is the honest count rather than a count of what survived.
 */
export interface ContextPersistenceHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  /** Whether context is safe across a restart *right now*. */
  readonly durable: boolean
  /** One sentence for a person. Null when durable and healthy. */
  readonly reason: string | null
  /** Non-null only when the bytes could not be believed. */
  readonly faultReason: string | null
  /** Records held: live items and tombstones together. */
  readonly retained: number
}