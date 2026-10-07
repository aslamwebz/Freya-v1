#!/usr/bin/env node
/**
 * Development launcher that exposes the real Freya Electron app to Kilo over
 * a localhost-only Chrome DevTools Protocol port.
 *
 *   npm run dev:kilo
 *
 * What this is for:
 *   Kilo can attach to the already-running Freya renderer via Playwright MCP
 *   (configured in .kilo/kilo.json) to inspect live UI, click buttons, type
 *   into the Chat textarea, take screenshots, and verify its own UI changes
 *   after editing code.
 *
 * What this is NOT for:
 *   - Production. The packaged build and `npm start` never see these flags.
 *   - Remote debugging. The CDP socket is bound to 127.0.0.1 only; nothing
 *     outside this machine can reach it. There is no auth token, by design:
 *     the loopback address is the only network guard, and the process exits
 *     the moment this script exits.
 *
 * Behaviour:
 *   1. Builds the renderer (Vite) and the Electron main bundle, so the window
 *      loads the real `dist/` artefacts, identical to `npm start`.
 *   2. Spawns Electron with:
 *        --remote-debugging-port=9222
 *        --remote-debugging-address=127.0.0.1
 *      so the CDP endpoint is reachable at http://127.0.0.1:9222/json and the
 *      WebSocket targets listed there are the live Freya renderer pages.
 *   3. Forwards SIGINT / SIGTERM to Electron and to the build's child so
 *      Ctrl-C in this terminal closes the app cleanly.
 *
 * If Freya is already running (e.g. the user launched `npm start` earlier),
 * Electron's single-instance guard will refuse the second copy and exit non-zero.
 * Close the existing window first; the same guard applies to `dev:desktop`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const CDP_HOST = '127.0.0.1'
const CDP_PORT = 9222

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    console.error(`[dev:kilo] "${command} ${args.join(' ')}" failed with code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

console.log('[dev:kilo] building renderer + main (same artefacts as `npm start`)…')
run(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])
run(process.execPath, [join(ROOT, 'scripts', 'build-electron.mjs')])

let electronPath
try {
  electronPath = require('electron')
} catch {
  console.error('[dev:kilo] electron is not installed. Run `npm ci` first.')
  process.exit(1)
}

const args = [
  '.',
  '--dev',
  `--remote-debugging-port=${String(CDP_PORT)}`,
  `--remote-debugging-address=${CDP_HOST}`,
]

console.log(`[dev:kilo] launching Electron with CDP on ${CDP_HOST}:${CDP_PORT}…`)
const child = spawn(electronPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
  env: process.env,
})

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  if (child && !child.killed) child.kill()
  process.exit(code ?? 0)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

child.on('exit', (code) => {
  if (code !== 0 && !shuttingDown) {
    console.error('[dev:kilo] Electron exited non-zero. If Freya is already running, close it first — only one instance owns the profile.')
  }
  shutdown(code ?? 0)
})
