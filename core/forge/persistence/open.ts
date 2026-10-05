import { EphemeralForgeStore } from './ephemeral-store'
import { EncryptedForgeStore } from './encrypted-store'
import type { ForgePersistencePort } from './port'

/**
 * Choosing a Forge store.
 *
 * One branch, and the branch is about the key. With a key, an encrypted store in
 * the path Core was given; without one, the ephemeral store, which holds bodies in
 * memory and reports that they will not survive a restart.
 *
 * There is no third option on purpose. A "plaintext because the key was missing"
 * store is how a private program ends up in a synced folder, so the missing key
 * costs durability and never costs confidentiality.
 */
export function openForgePersistence(options: {
  readonly path: string
  readonly key: Uint8Array | null
}): ForgePersistencePort {
  if (options.key === null) return new EphemeralForgeStore()
  return new EncryptedForgeStore({ path: options.path, key: options.key })
}
