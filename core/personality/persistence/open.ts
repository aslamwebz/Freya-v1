import type { PersonalityPersistencePort } from './port'
import { EncryptedPersonalityStore } from './encrypted-store'
import { EphemeralPersonalityStore } from './ephemeral-store'
import { PersonalityPersistenceError, isPersonalityPersistenceError } from './errors'

/**
 * OPENING PERSONALITY PERSISTENCE, WITHOUT TAKING CORE DOWN.
 *
 * The one entry point an integration is expected to call. It has one job beyond
 * constructing a port, and the job is **not throwing for anything a machine can
 * do to it**: a missing key, a key of the wrong length, an unreadable file, a
 * directory that is not a directory, a disk that is full — every one of those
 * produces an ephemeral port with the reason in words.
 *
 * ## Why the failure is a value here
 *
 * Personality data is not load-bearing for Core's safety systems. Nothing else
 * can be broken by losing it: it holds no authority, no budget, no stop, no
 * decision. So the worst possible behaviour for a personality-storage fault
 * would be to refuse to start — that would hand a disk error the power to take
 * down missions, cognition and conversation with it.
 *
 * The cost of degrading instead is that a person's relationship data does not
 * survive the restart. That cost is real, bounded, and *stated*: `mode`,
 * `durable` and `durabilityReason` all say so, and no plaintext is written in
 * its place.
 */

/** Why no Personality key means no Personality storage. */
export const NO_PERSONALITY_KEY_REASON =
  'personality data is held in this process only: this machine has no secure Personality key, so nothing is written to disk'

export interface OpenPersonalityPersistenceOptions {
  /** Where the encrypted store lives. Ignored entirely when there is no key. */
  readonly path: string
  /**
   * The Personality domain's own 32-byte key, or null.
   *
   * Null means no secure storage on this machine. The Personality key is not
   * the Context key, the Brain key, the conversation key or the Mission key,
   * and supplying one of those here is refused by the domain separation rather
   * than accepted as a substitute.
   */
  readonly key: Uint8Array | null
}

export async function openPersonalityPersistence(
  options: OpenPersonalityPersistenceOptions,
): Promise<PersonalityPersistencePort> {
  if (options.key === null) return new EphemeralPersonalityStore({ durabilityReason: NO_PERSONALITY_KEY_REASON })
  try {
    return await EncryptedPersonalityStore.open({
      path: options.path,
      key: options.key,
    })
  } catch (error) {
    return new EphemeralPersonalityStore({
      durabilityReason: `personality data is held in this process only: ${reason(error)}`,
    })
  }
}

/**
 * The sentence a surface shows for a fault that stopped persistence.
 */
export function personalityPersistenceFaultReason(error: unknown): string {
  if (isPersonalityPersistenceError(error)) {
    return `personality data is not being kept: ${error.message}`
  }
  return `personality data is not being kept: ${reason(error)}`
}

function reason(error: unknown): string {
  if (error instanceof PersonalityPersistenceError) return error.message
  if (error instanceof Error) return error.message
  return 'the secure store could not be opened'
}
