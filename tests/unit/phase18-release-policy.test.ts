import { describe, expect, it } from 'vitest'
import {
  ALLOWED_INSTALL_SCRIPT_PACKAGES,
  inspectCoreBoundary,
  inspectLockfile,
  inspectPerformance,
  PERFORMANCE_BUDGETS,
} from '../../scripts/release-policy.mjs'

type TestLockPackage = {
  version?: string
  resolved?: string
  integrity?: string
  hasInstallScript?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type TestLock = { lockfileVersion: number; packages: Record<string, TestLockPackage> }

function packagePair() {
  const pkg = { dependencies: { react: '^19.1.0' }, devDependencies: { esbuild: '^0.28.2' } }
  const lock: TestLock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
      'node_modules/react': {
        version: '19.1.1',
        resolved: 'https://registry.npmjs.org/react/-/react-19.1.1.tgz',
        integrity: 'sha512-test',
      },
      'node_modules/esbuild': {
        version: '0.28.2',
        resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz',
        integrity: 'sha512-test',
        hasInstallScript: true,
      },
    },
  }
  return { pkg, lock }
}

describe('Phase 18 release policy', () => {
  it('accepts a registry-only integrity-pinned lock with the explicit install-script allowlist', () => {
    const { pkg, lock } = packagePair()
    expect(ALLOWED_INSTALL_SCRIPT_PACKAGES.has('node_modules/esbuild')).toBe(true)
    expect(ALLOWED_INSTALL_SCRIPT_PACKAGES.has('node_modules/better-sqlite3')).toBe(true)
    expect(inspectLockfile(pkg, lock)).toEqual([])
  })

  it('rejects git/file/alternate-registry dependency sources', () => {
    const { pkg, lock } = packagePair()
    lock.packages['node_modules/react']!.resolved = 'git+https://example.invalid/react.git'
    expect(inspectLockfile(pkg, lock).join('\n')).toContain('not pinned to the npm registry')
  })

  it('rejects missing integrity and unapproved install scripts', () => {
    const { pkg, lock } = packagePair()
    delete lock.packages['node_modules/react']!.integrity
    lock.packages['node_modules/react']!.hasInstallScript = true
    const result = inspectLockfile(pkg, lock).join('\n')
    expect(result).toContain('missing a sha512 integrity hash')
    expect(result).toContain('unapproved install script')
  })

  it('rejects lock/package drift', () => {
    const { pkg, lock } = packagePair()
    lock.packages['']!.dependencies = { react: '^18.0.0' }
    expect(inspectLockfile(pkg, lock).join('\n')).toContain('does not match package-lock root')
  })

  it('keeps Core service-separable from Electron and renderer code', () => {
    expect(inspectCoreBoundary([{ path: 'core/a.ts', source: "import { randomUUID } from 'node:crypto'" }])).toEqual([])
    const failures = inspectCoreBoundary([
      { path: 'core/bad-electron.ts', source: "import { ipcMain } from 'electron'" },
      { path: 'core/bad-ui.ts', source: "import React from 'react'" },
    ]).join('\n')
    expect(failures).toContain('Electron runtime import')
    expect(failures).toContain('React/UI import')
  })

  it('enforces every performance ceiling', () => {
    const within = Object.fromEntries(Object.entries(PERFORMANCE_BUDGETS).map(([key, value]) => [key, value]))
    expect(inspectPerformance(within)).toEqual([])
    expect(inspectPerformance({ ...within, mainBytes: PERFORMANCE_BUDGETS.mainBytes + 1 })[0]).toContain('mainBytes exceeds budget')
  })
})
