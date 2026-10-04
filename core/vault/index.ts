export { Vault, type VaultHealth, type VaultOpenOptions, type VaultTransaction, type VaultRunResult } from './vault'
export { VaultError, type VaultErrorCode } from './errors'
export {
  StaticVaultKeyProvider,
  VAULT_KEY_BYTES,
  assertVaultKey,
  type VaultKeyProvider,
  type VaultKeyResult,
} from './key-provider'
export {
  VAULT_SCHEMA_VERSION,
  VAULT_MIGRATIONS,
  applyMigrations,
  readUserVersion,
  type VaultMigration,
  type VaultMigrationContext,
} from './schema'
export { verifyEncryptedDatabase, restoreEncryptedVault, type VaultRestoreOptions } from './backup'
export type { VaultBinding, NativeConnection, NativeStatement } from './binding'
export {
  vaultPaths,
  defaultVaultDeniedPaths,
  isVaultPathDenied,
  type VaultPaths,
} from './path-policy'
export { VaultMissionStore, MAX_VAULT_MISSION_BYTES } from './repositories/mission-store'
export { VaultWorldStore } from './repositories/world-store'
export {
  VaultResearchSessionStore,
  MAX_VAULT_SEARCH_SESSION_BYTES,
} from './repositories/research-session-store'
