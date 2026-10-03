/**
 * THE VAULT KEY PROVIDER BOUNDARY.
 *
 * The Vault never generates, derives, persists, logs or formats its key. It asks a
 * provider for exactly one random 256-bit key and holds the bytes in memory only for
 * as long as the connection is open. The provider is the seam where the production
 * OS protection (Windows DPAPI / OS keyring) will live, and it is deliberately an
 * interface rather than an Electron import: `core/` must not know that Electron
 * exists.
 *
 * ## Production shape (later wiring, not this step)
 *
 * The Electron main process will implement this interface over the existing
 * `electron/keyring.ts` `safeStorage`-wrapped secrets: unwrap one `vault` domain
 * secret and return its 32 bytes. That implementation stays in `electron/`, is
 * injected into Core, and never crosses the preload boundary. The renderer and the
 * Digital Hands receive neither the key, nor the Vault handle, nor the Vault path.
 *
 * ## Fail closed
 *
 * `key: null` is a real, reachable state and means the Vault does **not** open.
 * There is no plaintext fallback, no ephemeral substitute and no "generate a new
 * key beside the data" path: a weaker store silently standing in for an encrypted
 * one is the failure a person can never detect.
 */

export const VAULT_KEY_BYTES = 32

export interface VaultKeyResult {
  /** The 32-byte Vault key, or null when none is available. Never a substitute. */
  readonly key: Uint8Array | null
  /** Why there is no key, in words a person can act on. Null when there is one. */
  readonly reason: string | null
}

export interface VaultKeyProvider {
  load(): Promise<VaultKeyResult>
}

/**
 * A fixed key provider for tests and explicit injection.
 *
 * It copies the bytes on every load so a caller cannot mutate the provider's key by
 * mutating the returned array, and it never turns a missing key into a generated
 * one.
 */
export class StaticVaultKeyProvider implements VaultKeyProvider {
  constructor(
    private readonly key: Uint8Array | null,
    private readonly reason: string | null = null,
  ) {}

  async load(): Promise<VaultKeyResult> {
    if (this.key === null) return { key: null, reason: this.reason ?? 'no Vault key was supplied' }
    return { key: new Uint8Array(this.key), reason: null }
  }
}

/** Refuse a key that is not exactly 256 bits, before any file is created. */
export function assertVaultKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== VAULT_KEY_BYTES) {
    throw new Error(`the Vault key must be exactly ${VAULT_KEY_BYTES} bytes`)
  }
}
