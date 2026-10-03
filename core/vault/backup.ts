import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { VaultError } from './errors'
import { assertVaultKey, type VaultKeyProvider } from './key-provider'
import { readCipherVersion, requireBinding, type NativeConnection, type VaultBinding } from './binding'

/**
 * ENCRYPTED BACKUP AND RESTORE.
 *
 * A backup produced by `Vault.backupTo` is a full SQLCipher copy encrypted with the
 * same key. Restore is therefore a *verified* operation: the backup is opened with
 * the key and read before a single byte is moved, so a wrong-key, corrupt or
 * plaintext file is refused rather than copied over the live Vault.
 *
 * The restore is atomic from the caller's point of view: bytes are staged in a
 * sibling temp file and renamed into place. The caller must have closed the live
 * Vault first; restoring over an open database is a caller error and is not
 * defended against here.
 */

export interface VaultRestoreOptions {
  readonly backupPath: string
  readonly livePath: string
  readonly keyProvider: VaultKeyProvider
  /** The selected SQLCipher-capable binding, injected by the host. */
  readonly binding?: VaultBinding
}

/**
 * Prove an encrypted database opens with the supplied key, then close it.
 *
 * Shared by restore so that the "is this actually an encrypted database I can read?"
 * question has exactly one answer in the codebase.
 */
export async function verifyEncryptedDatabase(
  path: string,
  key: Uint8Array,
  binding: VaultBinding | undefined,
): Promise<string> {
  assertVaultKey(key)
  const keyHex = Buffer.from(key).toString('hex')
  const { Database } = requireBinding(binding)
  let connection: NativeConnection
  try {
    connection = new Database(path)
  } catch {
    throw new VaultError('restore_failed', 'the encrypted backup could not be opened')
  }
  try {
    const version = readCipherVersion(connection)
    if (version === null) {
      throw new VaultError('not_encrypted', 'the file is not a SQLCipher database')
    }
    connection.pragma(`key = "x'${keyHex}'"`)
    const statement = connection.prepare('SELECT count(*) AS n FROM sqlite_master')
    try {
      statement.get()
    } finally {
      statement.close()
    }
    return version
  } catch (error) {
    if (error instanceof VaultError) throw error
    throw new VaultError('restore_failed', 'the encrypted backup could not be read with the supplied key')
  } finally {
    try {
      connection.close()
    } catch {
      // Closing a connection that is already gone is not a caller-visible failure.
    }
  }
}

/**
 * Replace the live Vault with an encrypted backup.
 *
 * The backup is verified first; only then is it staged and renamed into place. A
 * failure at any point leaves the existing live file untouched.
 */
export async function restoreEncryptedVault(options: VaultRestoreOptions): Promise<void> {
  const keyResult = await options.keyProvider.load()
  if (keyResult.key === null) {
    throw new VaultError(
      'key_unavailable',
      keyResult.reason ?? 'no Vault key is available, so the backup cannot be restored',
    )
  }
  try {
    assertVaultKey(keyResult.key)
  } catch {
    throw new VaultError('key_invalid', 'the Vault key is not a 256-bit key and will not be used')
  }

  await verifyEncryptedDatabase(options.backupPath, keyResult.key, options.binding)

  const staging = `${options.livePath}.restore-${randomBytes(6).toString('hex')}.tmp`
  try {
    await mkdir(dirname(options.livePath), { recursive: true })
    await copyFile(options.backupPath, staging)
    await replaceFile(staging, options.livePath)
  } catch (error) {
    try {
      await rm(staging, { force: true })
    } catch {
      // A leftover temp file is not worth masking the restore failure.
    }
    if (error instanceof VaultError) throw error
    throw new VaultError('restore_failed', 'the encrypted backup could not be restored')
  }
}

/** Rename over an existing file, tolerating Windows' refusal to replace. */
async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    await rm(to, { force: true })
    await rename(from, to)
  }
}
