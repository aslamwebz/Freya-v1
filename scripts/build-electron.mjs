import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
}

await rm('dist-electron', { recursive: true, force: true })

// A sandboxed preload script must be CommonJS.
await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  external: ['electron'],
})

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  external: ['electron'],
})
