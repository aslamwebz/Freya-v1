import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const FIXED_ARTIFACTS = [
  'package.json',
  'dist/index.html',
  'dist/presence.html',
  'dist-electron/main.cjs',
  'dist-electron/preload.cjs',
  'dist-electron/presencePreload.cjs',
]

function portable(path) {
  return path.split(sep).join('/')
}

export async function sha256File(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

async function rendererAssets(root) {
  const dir = join(root, 'dist', 'assets')
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join('dist', 'assets', entry.name))
    .sort((a, b) => a.localeCompare(b))
}

export async function collectReleaseArtifacts(root) {
  const candidates = [...FIXED_ARTIFACTS, ...(await rendererAssets(root))]
  const artifacts = []
  for (const item of candidates) {
    const absolute = join(root, item)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`release artifact is not a file: ${item}`)
    artifacts.push({
      path: portable(relative(root, absolute)),
      bytes: info.size,
      sha256: await sha256File(absolute),
    })
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path))
}

export function canonicalManifestJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export async function buildReleaseManifest(root, metadata) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  return {
    schemaVersion: 1,
    app: { name: pkg.name, version: pkg.version },
    source: {
      revision: metadata.revision,
      dirty: metadata.dirty,
    },
    target: {
      platform: metadata.platform,
      arch: metadata.arch,
    },
    artifacts: await collectReleaseArtifacts(root),
  }
}

function gitValue(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

export function sourceMetadata(root) {
  return {
    revision: gitValue(root, ['rev-parse', 'HEAD']),
    dirty: gitValue(root, ['status', '--porcelain']).length > 0,
    platform: process.platform,
    arch: process.arch,
  }
}

async function main() {
  const root = resolve(process.cwd())
  const manifest = await buildReleaseManifest(root, sourceMetadata(root))
  const output = join(root, 'release', 'release-manifest.json')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, canonicalManifestJson(manifest), 'utf8')
  console.log(`Release manifest written: ${portable(relative(root, output))}`)
  console.log(`Artifacts: ${manifest.artifacts.length}`)
  console.log(`Source: ${manifest.source.revision}${manifest.source.dirty ? ' (dirty)' : ''}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
