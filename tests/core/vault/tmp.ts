import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repository-local temporary directories for Vault tests.
 *
 * PLAN Step C requires Vault tests to use repository-local temp dirs and to never
 * probe the real Windows AppData or keyring. Everything created here lives under
 * `.scratch/tmp/vault-tests`, which is gitignored, so a test can never write into a
 * user's real data area even if a path helper misbehaves.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VAULT_TEST_ROOT = join(REPO_ROOT, '.scratch', 'tmp', 'vault-tests')

export async function makeVaultTempDir(): Promise<string> {
  await mkdir(VAULT_TEST_ROOT, { recursive: true })
  return mkdtemp(join(VAULT_TEST_ROOT, 'vault-'))
}

export async function removeVaultTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
