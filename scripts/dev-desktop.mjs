import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One-command desktop dev loop.
 *
 * The reason `Freya.exe` needs a rebuild is that it loads the compiled
 * `dist/index.html`. This script instead boots Vite (which serves `src/` directly,
 * with HMR) and points Electron at it via `FREYA_DEV_SERVER`, which
 * `electron/main.ts` already honours. Renderer edits then hot-reload on save.
 *
 * The main process is still native Node and cannot hot-reload, so this builds only
 * the main bundle once at startup (`scripts/build-electron.mjs`) — cheap, and never
 * the renderer. Re-run this script after changing `electron/**`.
 *
 * Not a production path: nothing here is involved in `npm run build` or the
 * launcher. It exists purely so the UI can be developed without a rebuild.
 */

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VITE_PORT = Number(process.env.FREYA_DEV_PORT ?? 5273)
const DEV_SERVER = `http://127.0.0.1:${VITE_PORT}`
const READY_TIMEOUT_MS = 30_000

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    console.error(`[dev:desktop] "${command} ${args.join(' ')}" failed with code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

/** Poll the dev server until it answers, or fail after the timeout. */
async function waitForVite() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await fetch(DEV_SERVER, { method: 'GET' })
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return false
}

console.log('[dev:desktop] building main process…')
run(process.execPath, [join(ROOT, 'scripts', 'build-electron.mjs')])

const vite = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'inherit', shell: false },
)

let electron = null
let shuttingDown = false

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  if (electron && !electron.killed) electron.kill()
  if (!vite.killed) vite.kill()
  process.exit(code ?? 0)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

vite.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[dev:desktop] Vite exited with code ${code}. Is port ${VITE_PORT} already in use?`)
    shutdown(code ?? 1)
  }
})

const ready = await waitForVite()
if (!ready) {
  console.error(`[dev:desktop] Vite did not answer at ${DEV_SERVER} within ${READY_TIMEOUT_MS}ms.`)
  shutdown(1)
} else {
  console.log(`[dev:desktop] Vite ready at ${DEV_SERVER}. Launching Electron…`)
  electron = spawn(require('electron'), ['.', '--dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, FREYA_DEV_SERVER: DEV_SERVER },
  })
  electron.on('exit', (code) => {
    // A non-zero here is often the single-instance guard, which happens when
    // Freya.exe is already running. Only one profile may own the app.
    if (code !== 0) {
      console.error('[dev:desktop] Electron exited. If Freya.exe is already running, close it first — only one instance owns the profile.')
    }
    shutdown(code ?? 0)
  })
}
