#!/usr/bin/env node
/**
 * Launch Freya on a chosen display.
 *
 *   node scripts/launch.mjs              platform decides
 *   node scripts/launch.mjs 1            primary monitor
 *   node scripts/launch.mjs 2            first secondary monitor
 *
 * Why a script rather than `FREYA_DISPLAY=2 electron .`: that form works in a
 * POSIX shell and silently does nothing in `cmd.exe`, and on Windows it does
 * nothing *quietly* — which is worse than failing, because the app opens on the
 * wrong screen and you only find out by looking at it. One code path for every
 * platform.
 *
 * Uses human display numbering: 1 is primary, 2 is the first secondary, 3 is
 * the next secondary, and so on. This matches `--freya-display=N` in
 * `electron/main.ts`.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'


const DISPLAY = process.argv[2] ?? process.env.FREYA_DISPLAY ?? '1'
if (DISPLAY !== '' && (!Number.isInteger(Number(DISPLAY)) || Number(DISPLAY) < 0)) {
  console.error(`display must be a non-negative integer, got: ${DISPLAY}`)
  process.exit(2)
}

const args = [join(process.cwd(), 'scripts', 'debug-stack.mjs'), '--no-build', ...process.argv.slice(3)]

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: DISPLAY === '' ? process.env : { ...process.env, FREYA_DISPLAY: DISPLAY },
})

child.on('exit', (code, signal) => {
  // A quit is a signal to the parent process, not a failure to launch.
  process.exit(signal ? 0 : (code ?? 0))
})
