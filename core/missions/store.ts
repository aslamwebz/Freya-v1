import type { MissionContent } from './types'

/**
 * THE MISSION CONTENT STORE.
 *
 * A Mission's *content* — its title, its intent, its success criteria — is the most
 * private text Freya will ever hold. People write things here like "find me
 * another job" and "help me handle my house move". So it is stored apart from
 * everything else, under its own key, and it is the only part of a Mission that is
 * encrypted.
 *
 * ## Why this exists when the journal already holds the metadata
 *
 * The `mission.*` journal records ids, statuses, counts, timestamps and closed
 * reason codes. That is enough to reconstruct *that* a Mission existed and how it
 * ended, and not one byte of what it was for. That split is the property: the
 * journal can be backed up, copied to another machine, and read while debugging
 * without any of it being anybody's business.
 *
 * So this store holds content and the journal holds history, and neither can
 * reconstruct the other.
 *
 * ## No query language
 *
 * There is no `query(sql)` and no way to reach content other than by a Mission id
 * the caller was already given. A generic read surface over the most private text
 * in the system would make "read the store" and "read everything" the same
 * capability.
 */

export type MissionContentResult =
  | { readonly ok: true; readonly value: MissionContent }
  | { readonly ok: false; readonly code: MissionStoreErrorCode; readonly reason: string }

export type MissionStoreErrorCode =
  | 'unavailable'
  | 'unauthenticated'
  | 'degraded'
  | 'not_found'
  | 'too_large'
  | 'invalid'
  | 'write_failed'

/**
 * A Mission-store failure.
 *
 * A Mission-content fault is **not** a security event: it cannot grant cognition,
 * clear a stop or widen a budget, and it does not lock Freya out either. The
 * Mission is reported as degraded and everything else carries on — losing a Mission
 * is recoverable, refusing to answer is not something a disk error gets to decide.
 */
export class MissionStoreError extends Error {
  constructor(
    readonly code: MissionStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MissionStoreError'
  }
}

export interface MissionStoreHealth {
  readonly health: 'healthy' | 'degraded' | 'unavailable'
  readonly reason: string | null
}

export interface MissionStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: 'encrypted' | 'ephemeral'
  /** False whenever the content cannot survive a restart. */
  readonly durable: boolean
  /** Null when there is no fault. */
  readonly faultReason: string | null

  write(content: MissionContent): Promise<MissionContent>
  read(missionId: string): Promise<MissionContentResult>
  remove(missionId: string): Promise<boolean>
  health(): MissionStoreHealth
  close(): Promise<void>
}