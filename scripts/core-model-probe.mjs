/**
 * Bundles and runs the live provider probe.
 *
 * The probe has to execute the *real* Core — the same Governor and the same
 * Gateway Freya uses — rather than re-implementing a call, or it would only
 * prove that a side channel works. Core is written as ordinary TypeScript with
 * extensionless relative imports, so it is bundled with the same esbuild the
 * Electron build already uses, and the bundle is what runs.
 *
 * Run it with `npm run core:model-probe`. It refuses to make a call without an
 * explicit live flag, and it is not part of `verify`, `test`, boot, or CI.
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const out = join(await mkdtemp(join(tmpdir(), 'freya-probe-build-')), 'probe.mjs')

await build({
  entryPoints: [join(ROOT, 'scripts', 'core-model-probe.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'warning',
})

try {
  await import(pathToFileURL(out).href)
} finally {
  await rm(out, { recursive: true, force: true })
}
