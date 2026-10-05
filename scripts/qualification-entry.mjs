#!/usr/bin/env node
/**
 * The Phase 49 qualification entry.
 *
 * The gate logic, the shipping scope and the verdict rule all live in TypeScript
 * under `core/qualification/`, because the tests must be able to prove things about
 * them without spawning a process. This file exists only to make that TypeScript
 * loadable from a plain Node CLI: it bundles the barrel with the esbuild already in
 * this repository's toolchain and imports the result.
 *
 * The bundle is cached under `node_modules/.cache/`, keyed by the source's own mtime,
 * so a second run in a clean tree costs nothing and a changed source always
 * invalidates. Nothing here decides anything.
 */

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const source = join(root, 'core', 'qualification', 'index.ts')
const cacheDir = join(root, 'node_modules', '.cache', 'freya-qualification')

async function cacheKey() {
  const parts = []
  for (const file of [
    source,
    join(root, 'core', 'qualification', 'types.ts'),
    join(root, 'core', 'qualification', 'inventory.ts'),
    join(root, 'core', 'qualification', 'gates.ts'),
    join(root, 'core', 'qualification', 'scope.ts'),
    join(root, 'core', 'qualification', 'verdict.ts'),
  ]) {
    const info = await stat(file)
    parts.push(`${file}:${String(info.mtimeMs)}:${String(info.size)}`)
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

async function loadQualification() {
  const key = await cacheKey()
  const target = join(cacheDir, `qualification-${key}.mjs`)

  if (!existsSync(target)) {
    await mkdir(cacheDir, { recursive: true })
    await build({
      entryPoints: [source],
      outfile: target,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // No minify: this runs during a release, and a readable traceback beats three
      // kilobytes.
      minify: false,
      sourcemap: 'inline',
      logLevel: 'silent',
    })
    // A stale bundle from an earlier source state must never be the one imported, so
    // anything the previous run left behind is removed.
    for (const stale of await staleBundles(cacheDir, key)) {
      await unlink(stale)
    }
  }

  return await import(pathToFileURL(target).href)
}

async function staleBundles(dir, key) {
  const entries = await readdir(dir)
  const stale = []
  for (const entry of entries) {
    if (!entry.startsWith('qualification-') || !entry.endsWith('.mjs')) continue
    if (entry === `qualification-${key}.mjs`) continue
    stale.push(join(dir, entry))
  }
  return stale
}

export const qualification = await loadQualification()