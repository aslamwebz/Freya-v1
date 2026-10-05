import type { ForgePersistencePort, ForgeSnapshotLoad } from './port'
import type { ForgeStoredPackage } from '../engine'

/**
 * THE EPHEMERAL FORGE STORE.
 *
 * Holds bodies in this process and says so. The refusal is the point: a Core with
 * no store must report `durable: false` with a sentence explaining what that means
 * for a package, rather than reporting zero persistence while behaving as though a
 * restart would keep everything.
 */
export class EphemeralForgeStore implements ForgePersistencePort {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly durabilityReason =
    'this Core holds Forge package bodies in this process only, so a restart forgets every program'
  faultReason: string | null = null
  private packages: readonly ForgeStoredPackage[] = []

  async load(): Promise<ForgeSnapshotLoad> {
    return { ok: true, packages: this.packages }
  }

  async commit(packages: readonly ForgeStoredPackage[]): Promise<void> {
    this.packages = packages
  }

  async close(): Promise<void> {
    this.packages = []
  }
}
