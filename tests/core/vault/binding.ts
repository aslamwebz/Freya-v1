import { createRequire } from 'node:module'
import type { VaultBinding } from '../../../core/vault'

/**
 * The test binding adapter.
 *
 * Binding selection is deliberately blocked pending an isolated permissive (non-
 * copyleft) Windows audit, so no binding is named in committed source and no binding
 * is a dependency. The encryption proof tests run only when a binding module is
 * supplied through the environment, and then they exercise the binding-agnostic
 * Vault API against whatever the audit selects.
 *
 *   FREYA_VAULT_BINDING_MODULE=<package> npx vitest run tests/core/vault
 *
 * The adapter expects a module exporting a `Database` constructor (default or named)
 * that answers SQLCipher's `PRAGMA cipher_version`. Any SQLCipher-capable binding
 * that meets that contract can be dropped in without touching the Vault.
 */
export const VAULT_BINDING_ENV = 'FREYA_VAULT_BINDING_MODULE'

const require = createRequire(import.meta.url)
const moduleName = process.env[VAULT_BINDING_ENV] ?? null

export const bindingAvailable = moduleName !== null

export async function loadTestBinding(): Promise<VaultBinding> {
  if (moduleName === null) throw new Error(`no binding module was supplied via ${VAULT_BINDING_ENV}`)
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
