import type { SkillRecord } from '../types'
import type { SkillPersistenceErrorCode } from './errors'

/**
 * THE SKILL PERSISTENCE PORT.
 *
 * The narrow seam between the Skill domain and whatever holds a skill body across a
 * restart. It is deliberately the smallest vocabulary that can be honest about
 * durability: a snapshot of records goes in, a snapshot comes out, and the port
 * states in words whether that snapshot will still be there tomorrow.
 *
 * ## Why a skill body is encrypted at all
 *
 * A skill body is Freya's own procedure: its inputs, its outputs, the steps it takes,
 * the capabilities it asks for and the applicability tags that decide when it runs.
 * The Constitution protects "unpublished architecture, policies, internal prompts" as
 * private by default, and a stored procedure is all three in miniature — a capability
 * map with the routes to use it already written out.
 *
 * So the journal holds only metadata (ids, counts, closed labels, measured lengths,
 * and the slug-shaped applicability tags that selection has to match on), and the
 * body lives here, under AES-256-GCM, in its own file with its own key.
 *
 * ## What the port deliberately cannot express
 *
 * - **No authority.** Nothing here grants, checks or widens anything. A stored skill
 *   that survived a restart is still not a permission; the strongest statement this
 *   port can make is that a procedure survived a restart (C3: knowledge never
 *   implies permission). There is no field here a caller could read as a capability.
 * - **No query language.** A snapshot in, a snapshot out. No `getByName`, no
 *   `findExecutable`, no `query(sql)`, so a caller cannot reach a body except by
 *   asking the engine, which is the only component that enforces status.
 * - **No append and no delete.** The retained set is small, bounded and *replaced*.
 *   A revocation that left no record would degrade into "there is nothing here" after
 *   a restart, and a retired procedure would quietly come back.
 * - **No clock.** Every instant is a field of a record the domain already stamped.
 */
export const SKILL_SNAPSHOT_VERSION = 1

/** Everything the Skill domain retains, as one value. */
export interface SkillSnapshot {
  readonly v: typeof SKILL_SNAPSHOT_VERSION
  /** One entry per retained skill, current version only. */
  readonly records: readonly SkillRecord[]
}

/**
 * What a recovery attempt produced.
 *
 * A refusal is a value, not an exception, because "the file could not be believed" is
 * a *state* the caller has to survive: it goes on holding an empty, explicitly
 * degraded store rather than crashing. There is no third answer where some records
 * were returned, because a store whose contents depend on which records an attacker
 * chose to damage is not a store.
 */
export type SkillSnapshotLoad =
  | { readonly ok: true; readonly snapshot: SkillSnapshot }
  | { readonly ok: false; readonly code: SkillPersistenceErrorCode; readonly reason: string }

/**
 * The port: five members, all of them about durability.
 *
 * `durable`/`durabilityReason` answer "does this survive a restart?", which is a
 * property of the *mechanism*. `faultReason` answers "can this be trusted right
 * now?", which is a property of the *bytes*. The two are separate because conflating
 * them is how a store ends up reporting `durable: true` while every read is failing.
 */
export interface SkillPersistencePort {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly durabilityReason: string | null
  readonly faultReason: string | null
  load(): Promise<SkillSnapshotLoad>
  commit(snapshot: SkillSnapshot): Promise<void>
  close(): Promise<void>
}

/** What a person or a surface is told about durability. */
export interface SkillPersistenceHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly reason: string | null
  readonly faultReason: string | null
  readonly retained: number
}