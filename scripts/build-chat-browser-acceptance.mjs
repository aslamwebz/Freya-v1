import { build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The live TEST 10 acceptance runner, built on its own.
 *
 * It exists as a separate script so `build:main` — and therefore any production
 * or release build — never contains a test-only binary. A real Freya Browser needs
 * `BrowserWindow`, so this cannot run under Vitest, but it is not part of the
 * product either.
 *
 * `pdfjs-dist` stays external for the same reason it does in the main bundle: it
 * resolves its worker relative to `import.meta.url`, which bundling rewrites.
 *
 * Run it with `npm run test:chat-browser`, which builds then executes.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

await build({
  entryPoints: [`${ROOT}/electron/acceptance-native-browser.ts`],
  outfile: `${ROOT}/dist-electron/acceptance-native-browser.cjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
})
