#!/usr/bin/env node
/**
 * Development launcher that exposes the real Freya Electron app to Kilo over
 * a localhost-only Chrome DevTools Protocol port, optionally on an isolated
 * profile so a second instance can run alongside an existing one.
 *
 *   npm run dev:kilo
 *     -> default. Builds, launches on CDP 127.0.0.1:9222 against the owner's
 *        real userData (single-instance guard active).
 *
 *   node scripts/dev-kilo.mjs --port=9223 --profile=.kilo/acceptance-profile
 *     -> builds, launches on CDP 127.0.0.1:9223 against an ISOLATED profile.
 *        Sets FREYA_DEV_USER_DATA=<abs path> so Electron's app.getPath('userData')
 *        resolves to the chosen directory, and sets FREYA_DEV_ALLOW_MULTI_INSTANCE=1
 *        so the single-instance guard yields and both instances run side by side.
 *        No FREYA_E2E / no fixture providers / no E2E test keys: the .env file is
 *        the single source of truth for provider credentials and the isolated
 *        instance reads it exactly as the primary instance does.
 *
 *   --port=N       CDP port (default 9222). Bound to 127.0.0.1 only.
 *   --profile=PATH Absolute or relative path to the isolated userData directory.
 *                 Created if missing. Required for an isolated run.
 *   --no-build    Skip the renderer + main rebuild (faster iteration when the
 *                 dist artefacts are unchanged).
 *
 * What this is NOT for:
 *   - Production. The packaged build and `npm start` never see these flags.
 *   - Remote debugging. The CDP socket is bound to 127.0.0.1 only.
 *
 * If the requested CDP port is already in use, Electron will exit non-zero.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const CDP_HOST = '127.0.0.1'
const DEFAULT_CDP_PORT = 9222

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, profile: null, build: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--port' && i + 1 < argv.length) { out.port = Number(argv[++i]); continue }
    if (a.startsWith('--port=')) { out.port = Number(a.slice('--port='.length)); continue }
    if (a === '--profile' && i + 1 < argv.length) { out.profile = argv[++i]; continue }
    if (a.startsWith('--profile=')) { out.profile = a.slice('--profile='.length); continue }
    if (a === '--no-build') { out.build = false; continue }
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    console.error(`[dev:kilo] invalid --port: ${out.port}`)
    process.exit(2)
  }
  return out
}

const { port, profile, build } = parseArgs(process.argv.slice(2))

const absoluteProfile = profile === null ? null : resolve(profile)
if (absoluteProfile !== null) mkdirSync(absoluteProfile, { recursive: true })

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    console.error(`[dev:kilo] "${command} ${args.join(' ')}" failed with code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

if (build) {
  console.log('[dev:kilo] building renderer + main (same artefacts as `npm start`)…')
  run(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])
  run(process.execPath, [join(ROOT, 'scripts', 'build-electron.mjs')])
} else {
  console.log('[dev:kilo] skipping build (--no-build)')
}

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
  `--remote-debugging-port=${String(port)}`,
  `--remote-debugging-address=${CDP_HOST}`,
]

const env = { ...process.env }
if (absoluteProfile !== null) {
  env.FREYA_DEV_USER_DATA = absoluteProfile
  // Dev-only parallel-instance bypass. NOT the E2E gate, so no fixture
  // providers, fake research or E2E keys are injected. Honoured only when
  // --dev is also in argv (set by this launcher).
  env.FREYA_DEV_ALLOW_MULTI_INSTANCE = '1'
  console.log(`[dev:kilo] launching isolated Electron on CDP ${CDP_HOST}:${port} with userData=${absoluteProfile}`)
} else {
  console.log(`[dev:kilo] launching Electron with CDP on ${CDP_HOST}:${port} (owner's profile)`)
}

const child = spawn(electronPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
  env,
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
    if (absoluteProfile !== null) {
      console.error('[dev:kilo] Electron exited non-zero. CDP ' + port + ' may already be in use.')
    } else {
      console.error('[dev:kilo] Electron exited non-zero. If Freya is already running, close it first — only one instance owns the profile.')
    }
  }
  shutdown(code ?? 0)
})


