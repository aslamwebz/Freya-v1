#!/usr/bin/env node
/** Compatibility command; delegates all lifecycle and readiness to FreyaDebug.cmd's supervisor. */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const DEFAULT_CDP_PORT = 9234

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, profile: null, build: true, display: process.env.FREYA_DISPLAY ?? '1' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--port' && i + 1 < argv.length) { out.port = Number(argv[++i]); continue }
    if (a.startsWith('--port=')) { out.port = Number(a.slice('--port='.length)); continue }
    if (a === '--profile' && i + 1 < argv.length) { out.profile = argv[++i]; continue }
    if (a.startsWith('--profile=')) { out.profile = a.slice('--profile='.length); continue }
    if (a === '--display' && i + 1 < argv.length) { out.display = argv[++i]; continue }
    if (a.startsWith('--display=')) { out.display = a.slice('--display='.length); continue }
    if (a === '--no-build') { out.build = false; continue }
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    console.error(`[dev:kilo] invalid --port: ${out.port}`)
    process.exit(2)
  }
  return out
}

const { port, profile, build, display } = parseArgs(process.argv.slice(2))
const child = spawn(process.execPath, [join(ROOT, 'scripts', 'debug-stack.mjs'),
  ...(profile ? ['--profile=' + resolve(profile)] : []), ...(build ? [] : ['--no-build'])], {
  cwd: ROOT, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, FREYA_CDP_PORT: String(port), FREYA_DISPLAY: String(display) },
})
child.on('exit', code => process.exit(code ?? 1))
