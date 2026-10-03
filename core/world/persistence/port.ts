import type { WorldEvidenceRecord } from '../types'
import type { WorldPersistenceErrorCode } from './errors'

/**
 * THE WORLD PERSISTENCE PORT.
 *
 * The narrow seam between the world model and whatever holds its evidence across
 * a restart. Deliberately the smallest vocabulary that can be honest about
 * durability: a snapshot of evidence records goes in, a snapshot comes out, and
 * the port states in words whether that snapshot will still be there tomorrow.
 *
 * ## Why evidence about the world is encrypted at all
 *
 * A world model is a map of the owner's life: who they work with, which projects
 * they care about, where they are. The Constitution protects habits, memories,
 * relationships and private inferences as private by default, and a durable graph
 * of a person's world is all of those at once. So the ledger is encrypted at rest,
 * in the one place durable state is allowed to be encrypted.
 *
 * ## Where the bytes live now
 *
 * `PLAN.md` §4 makes one per-user SQLCipher `freya.db` the canonical structured
 * store and its Step E rebases this phase onto it with "no new custom durable store".
 * The bespoke per-domain AES-256-GCM file this port used to describe is gone: the
 * durable implementation is `core/vault/repositories/world-store.ts`, a repository
 * over versioned tables in that single database, and the encryption is SQLCipher's
 * page encryption under the one Vault key.
 *
 * The separation is deliberate, and it is why the adaptation was small: **this port
 * is the only thing in Phase 22 that knows how bytes are stored.** The ontology, the
 * identity rules, the admission rules, the fold, the self model and the projection
 * contract are all written against these five members, so moving storage is a new
 * class implementing this interface — not a rewrite of the phase.
 *
 * The properties `PLAN.md` asks for hold here: no plaintext fallback, no dual write,
 * no Freya- or model-controlled migration, a closed versioned schema constant, and a
 * wrong key or a damaged ledger that fails closed rather than degrading into
 * something readable.
 *
 * ## What the port deliberately cannot express
 *
 * - **No authority.** Nothing here grants, checks or widens anything. Evidence
 *   that survived a restart is still a claim, and the strongest statement this
 *   port can make is that a claim survived (C3: knowledge never implies
 *   permission). There is no field here a caller could read as a capability.
 * - **No query language.** A snapshot in, a snapshot out. No `getByEntity`, no
 *   `findConflicts`, no `query(sql)`, so a caller cannot reach a record except by
 *   asking the engine, which is the only component that knows the folding rules.
 * - **No append and no delete.** The retained set is small, bounded and
 *   *replaced*. A withdrawal that left no record would degrade into "there is
 *   nothing here" after a restart, and a withdrawn claim would quietly come back
 *   — which is precisely the failure the withdrawal path exists to prevent.
 * - **No clock.** Every instant is a field of a record the domain already stamped.
 */
export const WORLD_SNAPSHOT_VERSION = 1

/** Everything the world model retains, as one value. */
export interface WorldSnapshot {
  readonly v: typeof WORLD_SNAPSHOT_VERSION
  /** Retained evidence records, in replay order. */
  readonly records: readonly WorldEvidenceRecord[]
  /** The highest sequence retained, so a recovery can tell what it has. */
  readonly sequence: number
}

/**
 * What a recovery attempt produced.
 *
 * A refusal is a value, not an exception, because "the file could not be believed"
 * is a *state* the caller has to survive: it goes on holding an empty, explicitly
 * degraded world rather than crashing. There is no third answer where some records
 * were returned, because a store whose contents depend on which records an
 * attacker chose to damage is not a store.
 */
export type WorldSnapshotLoad =
  | { readonly ok: true; readonly snapshot: WorldSnapshot }
  | { readonly ok: false; readonly code: WorldPersistenceErrorCode; readonly reason: string }

/**
 * The port: five members, all of them about durability.
 *
 * `durable`/`durabilityReason` answer "does this survive a restart?", which is a
 * property of the *mechanism*. `faultReason` answers "can this be trusted right
 * now?", which is a property of the *bytes*. The two are separate because
 * conflating them is how a store ends up reporting `durable: true` while every
 * read is failing.
 */
export interface WorldPersistencePort {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly durabilityReason: string | null
  readonly faultReason: string | null
  load(): Promise<WorldSnapshotLoad>
  commit(snapshot: WorldSnapshot): Promise<void>
  close(): Promise<void>
}

/** What a person or a surface is told about durability. */
export interface WorldPersistenceHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly reason: string | null
  readonly faultReason: string | null
  readonly retained: number
}