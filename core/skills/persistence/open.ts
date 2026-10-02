import { EncryptedSkillStore } from './encrypted-store'
import { EphemeralSkillStore } from './ephemeral-store'
import { isSkillPersistenceError } from './errors'
import type { SkillPersistencePort } from './port'

/**
 * CHOOSING A SKILL STORE.
 *
 * The whole of the decision, in one function, so it can be read in one place: a 32-byte
 * key from the host gets the encrypted store; anything else gets the ephemeral one.
 *
 * ## Why a failure to *open* does not fall back
 *
 * If a key is present and the file is unreadable, the honest answer is a **degraded
 * encrypted store**, not the ephemeral one. Falling back would report `mode:
 * 'ephemeral'` for a store whose file exists, and a surface would say "Freya will not
 * remember" when the truth is "the file is damaged and Freya stopped trusting it" —
 * two different problems with two different fixes, one of which is data loss.
 *
 * So the caller gets the exception, the runtime records a fault in its own words, and
 * the Core keeps serving from the journal's metadata with an explicitly degraded
 * store. Bodies are then unavailable, which means nothing can be planned into a Run
 * — which is the correct outcome when the procedures themselves cannot be read.
 */
export async function openSkillPersistence(options: {
  path: string
  key: Uint8Array | null
}): Promise<SkillPersistencePort> {
  if (options.key === null) return new EphemeralSkillStore()
  try {
    return await EncryptedSkillStore.open({ path: options.path, key: options.key })
  } catch (error) {
    if (isSkillPersistenceError(error)) throw error
    throw error
  }
}