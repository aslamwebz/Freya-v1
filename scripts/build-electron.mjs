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

// The presence window's preload, also CommonJS and sandboxed.
await build({
  ...shared,
  entryPoints: ['electron/presence/preload.ts'],
  outfile: 'dist-electron/presencePreload.cjs',
  external: ['electron'],
})

// `pdfjs-dist` must stay external here. It resolves its worker relative to
// `import.meta.url`, and bundling rewrites that into the CommonJS output, so the
// first attachment read fails with `Cannot find module '.../pdf.worker.mjs'`.
// Bundling works in `vite dev` and fails only in the packaged app, which is the
// worst possible place to find out — so the dependency is resolved at runtime
// from node_modules instead.
await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
})

// Independent headless Core and Node intelligence; encrypted bindings stay in Core.
await build({ ...shared, entryPoints: ['electron/runtime-core.ts'], outfile: 'dist-electron/core.cjs', external: ['electron', 'better-sqlite3', 'pdfjs-dist'] })
await build({ ...shared, entryPoints: ['core/mind/process-runtime.ts'], outfile: 'dist-electron/freya.cjs', external: ['better-sqlite3', 'pdfjs-dist'] })
await build({ ...shared, entryPoints: ['shared/runtime/rpc.ts'], outfile: 'dist-electron/runtime-rpc.cjs' })

// NOTE: the live TEST 10 acceptance runner is deliberately NOT built here.
// It is a real Electron integration harness, not part of the product, and
// `scripts/build-chat-browser-acceptance.mjs` builds it on its own so a
// production build never ships a test-only binary.
