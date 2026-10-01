import type { ContextLimits } from '../types'
import type { ContextPersistencePort } from './port'
import { EncryptedContextStore } from './encrypted-store'
import { EphemeralContextStore } from './ephemeral-store'
import { ContextPersistenceError, isContextPersistenceError } from './errors'

/**
 * OPENING CONTEXT PERSISTENCE, WITHOUT TAKING CORE DOWN.
 *
 * The one entry point an integration is expected to call. It has one job beyond
 * constructing a port, and the job is **not throwing for anything a machine can
 * do to it**: a missing key, a key of the wrong length, an unreadable file, a
 * directory that is not a directory, a disk that is full — every one of those
 * produces an ephemeral port with the reason in words.
 *
 * ## Why the failure is a value here
 *
 * Context is the least load-bearing thing in Core. Nothing else can be broken by
 * losing it: it holds no authority, no budget, no stop, no decision. So the worst
 * possible behaviour for a context-storage fault would be to refuse to start —
 * that would hand a disk error the power to take down missions, cognition and
 * conversation with it, which is precisely "corruption takes down unrelated Core
 * systems".
 *
 * The cost of degrading instead is that a person's context does not survive the
 * restart. That cost is real, bounded, and *stated*: `mode`, `durable` and
 * `durabilityReason` all say so, and no plaintext is written in its place.
 *
 * The alternative — throwing, and letting the caller decide — is available too,
 * and is the right choice for a host that would rather refuse to run than run
 * degraded. `EncryptedContextStore.open` still throws for both, so nothing here
 * removes an option; this function is simply the one that keeps Core alive.
 */

/** Why no Context key means no Context storage, said the way a surface shows it. */
export const NO_CONTEXT_KEY_REASON =
  'context is held in this process only: this machine has no secure Context key, so nothing is written to disk'

export interface OpenContextPersistenceOptions {
  /** Where the encrypted store lives. Ignored entirely when there is no key. */
  readonly path: string
  /**
   * The Context domain's own 32-byte key, or null.
   *
   * Null means no secure storage on this machine. The Context key is not the
   * Mission key, the Brain key or the conversation key, and supplying one of
   * those here is refused by the domain separation rather than accepted as a
   * substitute — see `encrypted-store.ts`.
   */
  readonly key: Uint8Array | null
  /** Forwarded to the store and the recovery gate; may only lower the ceilings. */
  readonly limits?: Partial<ContextLimits>
}

export async function openContextPersistence(
  options: OpenContextPersistenceOptions,
): Promise<ContextPersistencePort> {
  if (options.key === null) return new EphemeralContextStore({ durabilityReason: NO_CONTEXT_KEY_REASON })
  try {
    return await EncryptedContextStore.open({
      path: options.path,
      key: options.key,
      limits: options.limits,
    })
  } catch (error) {
    return new EphemeralContextStore({
      durabilityReason: `context is held in this process only: ${reason(error)}`,
    })
  }
}

/**
 * The sentence a surface shows for a fault that stopped persistence.
 *
 * Separated from `NO_CONTEXT_KEY_REASON` because the two are different problems
 * with different fixes: one needs a secure key, the other needs a working disk.
 * Collapsing them into "persistence unavailable" would leave a person with no
 * idea which of the two to go and look at.
 */
export function contextPersistenceFaultReason(error: unknown): string {
  if (isContextPersistenceError(error)) {
    return `context is not being kept: ${error.message}`
  }
  return `context is not being kept: ${reason(error)}`
}

function reason(error: unknown): string {
  if (error instanceof ContextPersistenceError) return error.message
  if (error instanceof Error) return error.message
  return 'the secure store could not be opened'
}