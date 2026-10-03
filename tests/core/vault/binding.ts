import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { VaultBinding } from '../../../core/vault'
import { createFreyaVaultBinding } from '../../../electron/vaultBinding'

/**
 * The test binding adapter.
 *
 * The canonical Windows test path uses Freya's pinned Node 24 native binary,
 * built from SQLCipher 4.19.0 + OpenSSL 3.5.9. An explicit environment module
 * remains available for portability experiments on other platforms.
 */
export const VAULT_BINDING_ENV = 'FREYA_VAULT_BINDING_MODULE'

const require = createRequire(import.meta.url)
const moduleName = process.env[VAULT_BINDING_ENV] ?? null
const canonicalWindowsBinding = resolve(
  process.cwd(),
  'native',
  'sqlcipher',
  'win32-x64',
  'better_sqlite3-node24.node',
)

export const bindingAvailable = moduleName !== null ||
  (process.platform === 'win32' && existsSync(canonicalWindowsBinding))

export async function loadTestBinding(): Promise<VaultBinding> {
  if (moduleName === null) {
    if (process.platform === 'win32' && existsSync(canonicalWindowsBinding)) {
      return createFreyaVaultBinding(canonicalWindowsBinding)
    }
    throw new Error(`no binding module was supplied via ${VAULT_BINDING_ENV}`)
  }

  let module: Record<string, unknown>
  try {
    module = require(moduleName) as Record<string, unknown>
  } catch {
    module = (await import(/* @vite-ignore */ moduleName)) as Record<string, unknown>
  }
  const Database = (module['default'] ?? module['Database']) as VaultBinding['Database'] | undefined
  if (typeof Database !== 'function') {
    throw new Error(`the binding module ${moduleName} did not export a Database constructor`)
  }
  const setLogger = module['setLogger']
  return {
    name: moduleName,
    Database,
    ...(typeof setLogger === 'function' ? { setLogger: setLogger as VaultBinding['setLogger'] } : {}),
  }
}
