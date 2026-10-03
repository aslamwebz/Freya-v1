import { join, resolve, sep } from 'node:path'

/**
 * VAULT PATH DENIAL.
 *
 * PLAN.md §8 makes the Vault directory, keyring/secrets paths and protected backups
 * **hard-denied to Browser/Terminal/Hands even when broader machine access is added
 * later**. Digital Hands has no filesystem capability yet, so today this is the
 * boundary that will be consulted the moment one is added: a single, testable
 * predicate that answers "is this path inside protected Freya state?".
 *
 * It is intentionally in `core/` and imports nothing platform-specific, so the same
 * rule protects Windows, macOS and Linux.
 */

export interface VaultPaths {
  /** `<user-data>/Freya/vault` — the protected directory. */
  readonly vaultDir: string
  /** `<user-data>/Freya/vault/freya.db` — the canonical encrypted database. */
  readonly vaultFile: string
  /** `<user-data>/Freya/vault/backups` — encrypted backups only. */
  readonly backupDir: string
}

/**
 * The canonical per-user Vault layout.
 *
 * `userDataRoot` is the OS application-data root (Electron's `app.getPath('appData')`),
 * never a repository path. Tests pass a repository-local temp root instead, and the
 * production keyring never appears here.
 */
export function vaultPaths(userDataRoot: string): VaultPaths {
  const vaultDir = join(userDataRoot, 'Freya', 'vault')
  return {
    vaultDir,
    vaultFile: join(vaultDir, 'freya.db'),
    backupDir: join(vaultDir, 'backups'),
  }
}

/** The paths that are denied to Digital Hands by default. */
export function defaultVaultDeniedPaths(paths: VaultPaths): readonly string[] {
  return Object.freeze([paths.vaultDir])
}

/**
 * Whether `candidate` is inside any denied root.
 *
 * Comparison is on resolved absolute paths with a separator boundary, so
 * `/vault-notes` is not mistaken for `/vault`, and it is case-insensitive on
 * Windows where the filesystem is.
 */
export function isVaultPathDenied(candidate: string, denied: readonly string[]): boolean {
  const normalized = normalize(candidate)
  return denied.some((root) => isWithin(normalized, normalize(root)))
}

function normalize(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(child: string, root: string): boolean {
  if (child === root) return true
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return child.startsWith(prefix)
}
