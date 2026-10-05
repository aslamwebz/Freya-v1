import { stat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ALLOWED_INSTALL_SCRIPT_PACKAGES = new Set([
  'node_modules/better-sqlite3',
  'node_modules/esbuild',
  'node_modules/fsevents',
])

export const PERFORMANCE_BUDGETS = Object.freeze({
  // Phases 20–31 moved durable Vault, Context, Life, learning, acquisition and
  // long-horizon assembly into the Electron host. The Phase 18 main/preload ceilings
  // no longer describe the canonical Phase 31 binary. These bounds retain only
  // modest headroom over the measured Phase 31 artifacts (~1.76MB / ~109KB), so
  // future growth still has to be explained rather than silently accumulating.
  //
  // Phase 42 Device Hands is the next explained growth: activating Phase 35 in the
  // main process bundles its runtime — the ten-gate pipeline, the fold, the four
  // surface policies and the host adapters — into `main.cjs`, measured at ~2.10MB.
  // The bound keeps modest headroom over that, and the host stays unminified on
  // purpose so its security-critical source can be audited in the shipped artifact.
  //
  // Raised from 2.1MB for the Phase 43 browser-extension host, which mounts against
  // the Phase 42 Device Hands seam and so lands in the main process rather than in a
  // separate bundle. Phase 50 then added persistent Eye sessions and bounded parallel
  // Deep Research. Phase 44 adds the connector engine/runtime and host composition;
  // CI measures the reconciled main.cjs at 2,237,259 bytes. Keep only narrow,
  // explicit headroom over that measured artifact rather than absorbing future growth.
  mainBytes: 2_250_000,
  // Phase 44 adds connector projection/commands to the preload bridge, and
  // Phase 45 adds the bounded Voice command/capability/playback channel. The
  // completed Voice branch measured the combined preload near this ceiling.
  preloadBytes: 135_000,
  presencePreloadBytes: 50_000,
  largestRendererJsBytes: 650_000,
  // Phase 19 added the ui-v2 shell: a finished design with ~1.9MB of webp imagery and
  // the three.js presence stage. The old 1.5MB ceiling predated that surface, so the
  // budget tracks the shipped design with headroom for its next iteration rather than
  // forcing the concept art out to satisfy a number that never accounted for it.
  // The App Mode / persistent-board merge pushed the measured total to ~3.57MB.
  // Phase 45 adds the voice runtime, platform speech adapter, recognition feature
  // detection and settings surface across both renderer entry paths; its completed
  // branch measured the resulting ceiling at ~3.70MB.
  rendererTotalBytes: 3_700_000,
})

export function inspectLockfile(pkg, lock) {
  const failures = []
  if (lock.lockfileVersion !== 3) failures.push('package-lock.json must use lockfileVersion 3')
  if (!lock.packages || typeof lock.packages !== 'object') failures.push('package-lock.json has no packages map')

  const root = lock.packages?.['']
  if (!root) failures.push('package-lock.json has no root package entry')

  for (const section of ['dependencies', 'devDependencies']) {
    const expected = pkg[section] ?? {}
    const locked = root?.[section] ?? {}
    if (JSON.stringify(expected) !== JSON.stringify(locked)) {
      failures.push(`package.json ${section} does not match package-lock root`)
    }
  }

  for (const [name, meta] of Object.entries(lock.packages ?? {})) {
    if (!name || !meta || typeof meta !== 'object') continue
    if (meta.resolved !== undefined) {
      if (typeof meta.resolved !== 'string' || !meta.resolved.startsWith('https://registry.npmjs.org/')) {
        failures.push(`${name} is not pinned to the npm registry: ${String(meta.resolved)}`)
      }
      if (typeof meta.integrity !== 'string' || !meta.integrity.startsWith('sha512-')) {
        failures.push(`${name} is missing a sha512 integrity hash`)
      }
    }
    if (meta.hasInstallScript === true && !ALLOWED_INSTALL_SCRIPT_PACKAGES.has(name)) {
      failures.push(`${name} has an unapproved install script`)
    }
  }
  return failures
}

export function inspectCoreBoundary(files) {
  const failures = []
  const forbidden = [
    { pattern: /from\s+['"]electron['"]|require\(['"]electron['"]\)/, reason: 'Electron runtime import' },
    { pattern: /from\s+['"]react(?:\/[^'"]*)?['"]|require\(['"]react(?:\/[^'"]*)?['"]\)/, reason: 'React/UI import' },
    { pattern: /from\s+['"][^'"]*(?:^|\/)electron\//m, reason: 'electron/ source import' },
    { pattern: /from\s+['"][^'"]*(?:^|\/)src\//m, reason: 'renderer src/ import' },
    { pattern: /\b(?:BrowserWindow|ipcMain|ipcRenderer|contextBridge)\b/, reason: 'Electron API symbol' },
  ]
  for (const file of files) {
    for (const rule of forbidden) {
      if (rule.pattern.test(file.source)) failures.push(`${file.path}: ${rule.reason} crosses the Core boundary`)
    }
  }
  return failures
}

export async function coreSourceFiles(root) {
  const base = join(root, 'core')
  const output = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && path.endsWith('.ts')) {
        output.push({ path: path.slice(root.length + 1), source: await readFile(path, 'utf8') })
      }
    }
  }
  await walk(base)
  return output
}

export async function artifactMeasurements(root) {
  const main = (await stat(join(root, 'dist-electron', 'main.cjs'))).size
  const preload = (await stat(join(root, 'dist-electron', 'preload.cjs'))).size
  const presencePreload = (await stat(join(root, 'dist-electron', 'presencePreload.cjs'))).size
  const assetsDir = join(root, 'dist', 'assets')
  const files = await readdir(assetsDir, { withFileTypes: true })
  const jsSizes = []
  let total = 0
  for (const file of files) {
    if (!file.isFile()) continue
    const size = (await stat(join(assetsDir, file.name))).size
    total += size
    if (file.name.endsWith('.js')) jsSizes.push(size)
  }
  return {
    mainBytes: main,
    preloadBytes: preload,
    presencePreloadBytes: presencePreload,
    largestRendererJsBytes: jsSizes.length ? Math.max(...jsSizes) : 0,
    rendererTotalBytes: total,
  }
}

export function inspectPerformance(measured, budgets = PERFORMANCE_BUDGETS) {
  const failures = []
  for (const [key, limit] of Object.entries(budgets)) {
    const actual = measured[key]
    if (!Number.isFinite(actual)) failures.push(`${key} was not measured`)
    else if (actual > limit) failures.push(`${key} exceeds budget: ${actual} > ${limit}`)
  }
  return failures
}
