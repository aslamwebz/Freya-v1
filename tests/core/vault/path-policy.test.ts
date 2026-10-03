// @vitest-environment node
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultVaultDeniedPaths, isVaultPathDenied, vaultPaths } from '../../../core/vault'

describe('Vault path policy', () => {
  it('builds the canonical per-user layout without touching real AppData', () => {
    const root = join('C:', 'Users', 'example', 'AppData', 'Roaming')
    const paths = vaultPaths(root)
    expect(paths.vaultDir).toBe(join(root, 'Freya', 'vault'))
    expect(paths.vaultFile).toBe(join(root, 'Freya', 'vault', 'freya.db'))
    expect(paths.backupDir).toBe(join(root, 'Freya', 'vault', 'backups'))
    expect(defaultVaultDeniedPaths(paths)).toEqual([paths.vaultDir])
  })

  it('denies the Vault directory, its database and its backups', () => {
    const paths = vaultPaths(join('C:', 'tmp', 'freya-userdata'))
    const denied = defaultVaultDeniedPaths(paths)
    expect(isVaultPathDenied(paths.vaultDir, denied)).toBe(true)
    expect(isVaultPathDenied(paths.vaultFile, denied)).toBe(true)
    expect(isVaultPathDenied(paths.backupDir, denied)).toBe(true)
    expect(isVaultPathDenied(join(paths.backupDir, 'freya.backup.db'), denied)).toBe(true)
  })

  it('does not deny a sibling whose name merely shares a prefix', () => {
    const paths = vaultPaths(join('C:', 'tmp', 'freya-userdata'))
    const denied = defaultVaultDeniedPaths(paths)
    expect(isVaultPathDenied(`${paths.vaultDir}-notes`, denied)).toBe(false)
    expect(isVaultPathDenied(join(resolve(paths.vaultDir, '..'), 'ordinary.txt'), denied)).toBe(false)
  })

  it('does not deny unrelated paths', () => {
    const denied = defaultVaultDeniedPaths(vaultPaths(join('C:', 'tmp', 'freya-userdata')))
    expect(isVaultPathDenied(join('C:', 'tmp', 'downloads', 'report.pdf'), denied)).toBe(false)
  })
})
