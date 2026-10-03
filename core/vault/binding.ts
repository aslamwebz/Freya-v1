import { VaultError } from './errors'

/**
 * THE SQLCIPHER BINDING SEAM (binding-agnostic).
 *
 * The Vault does not import a native module, and it does not name one. It accepts a
 * `VaultBinding` — a small adapter around whichever SQLCipher-capable addon is
 * selected — and refuses to open without one. That is deliberate: PLAN.md §4 makes
 * the binding a canonical decision that requires a passing Windows + Electron proof,
 * and the binding selection is currently **blocked pending an isolated permissive
 * (non-copyleft) audit**. Keeping the choice out of `core/` means the architecture
 * and its tests survive a change of binding unchanged.
 *
 * The production host (Electron main) will construct the selected binding and inject
 * it. A renderer never sees this interface, never sees the module name, and never
 * sees the native handle.
 *
 * Nothing here logs a key. A failed decrypt may still surface SQLCipher's own
 * codec-level diagnostic on stderr (for example "hmac check failed for pgno=1"); that
 * text is fixed diagnostic data containing no key material, page contents or path.
 */

/** The subset of a binding's statement surface the Vault uses. */
export interface NativeStatement {
  run(params?: readonly unknown[] | Readonly<Record<string, unknown>>): { changes: number; lastInsertRowid: number }
  get(params?: readonly unknown[] | Readonly<Record<string, unknown>>): unknown
  all(params?: readonly unknown[] | Readonly<Record<string, unknown>>): unknown[]
  close(): void
}

/** The subset of a binding's connection surface the Vault uses. */
export interface NativeConnection {
  exec(sql: string): void
  pragma(source: string, options?: { readonly simple?: true }): unknown
  prepare(sql: string): NativeStatement
  close(): void
}

/**
 * A SQLCipher-capable native addon, adapted to the Vault's narrow surface.
 *
 * `name` is for diagnostics only and is never projected, logged with a key, or sent
 * to a renderer.
 */
export interface VaultBinding {
  readonly name: string
  readonly Database: new (path?: string) => NativeConnection
  /** Optional: the addon's own logger, silenced when present. */
  readonly setLogger?: (fn: (code: string, message: string) => void) => void
}

/**
 * Read the SQLCipher runtime version.
 *
 * This is the proof that a binding is real SQLCipher and not plain SQLite: a plain
 * SQLite build does not answer `PRAGMA cipher_version` at all. A non-empty answer is
 * required before the Vault will report itself as encrypted.
 */
export function readCipherVersion(connection: NativeConnection): string | null {
  let value: unknown
  try {
    value = connection.pragma('cipher_version', { simple: true })
  } catch {
    return null
  }
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Refuse to proceed without a selected binding.
 *
 * Fail closed: no binding means no Vault, never a plaintext substitute.
 */
export function requireBinding(binding: VaultBinding | undefined): VaultBinding {
  if (binding === undefined) {
    throw new VaultError(
      'binding_unavailable',
      'no SQLCipher binding has been selected for the Vault, so it cannot be opened',
    )
  }
  return binding
}
