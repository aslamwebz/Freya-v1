import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReleaseManifest,
  canonicalManifestJson,
  collectReleaseArtifacts,
} from '../../scripts/release-manifest.mjs'

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freya-release-manifest-'))
  await mkdir(join(root, 'dist', 'assets'), { recursive: true })
  await mkdir(join(root, 'dist-electron'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"freya","version":"9.9.9"}\n')
  await writeFile(join(root, 'dist', 'index.html'), 'index')
  await writeFile(join(root, 'dist', 'presence.html'), 'presence')
  await writeFile(join(root, 'dist', 'assets', 'z.js'), 'zeta')
  await writeFile(join(root, 'dist', 'assets', 'a.css'), 'alpha')
  await writeFile(join(root, 'dist-electron', 'main.cjs'), 'main')
  await writeFile(join(root, 'dist-electron', 'preload.cjs'), 'preload')
  await writeFile(join(root, 'dist-electron', 'presencePreload.cjs'), 'presence-preload')
  return root
}

describe('Phase 18 release artifact manifest', () => {
  it('hashes the distributable files in deterministic path order', async () => {
    const root = await fixtureRoot()
    try {
      const artifacts = await collectReleaseArtifacts(root)
      expect(artifacts.map((artifact) => artifact.path)).toEqual(
        [...artifacts.map((artifact) => artifact.path)].sort((a, b) => a.localeCompare(b)),
      )
      expect(artifacts).toHaveLength(8)
      expect(artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
      expect(artifacts.every((artifact) => artifact.bytes > 0)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records source state and target without adding a nondeterministic timestamp', async () => {
    const root = await fixtureRoot()
    try {
      const manifest = await buildReleaseManifest(root, {
        revision: 'abc123',
        dirty: false,
        platform: 'win32',
        arch: 'x64',
      })
      expect(manifest.app).toEqual({ name: 'freya', version: '9.9.9' })
      expect(manifest.source).toEqual({ revision: 'abc123', dirty: false })
      expect(manifest.target).toEqual({ platform: 'win32', arch: 'x64' })
      expect(canonicalManifestJson(manifest)).not.toContain('createdAt')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
