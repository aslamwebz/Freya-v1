#!/usr/bin/env node
/**
 * Install or update the Freya desktop and Start Menu shortcuts.
 *
 * The shortcut points at this working copy, not at an installed copy. That is the
 * deliberate trade: there is nothing to keep in sync but the directory itself, and a
 * `git pull` followed by `npm run build:desktop` followed by this script keeps the
 * shortcut up to date without ever installing software.
 *
 * Idempotent: re-running replaces both .lnk files in place and rewrites their fields
 * from the current values of the working copy, so a build that renamed an icon or
 * moved the repo leaves no stale shortcut behind.
 *
 * Does not require administrator rights. Windows shortcuts are user-scope, and both
 * the Desktop and the Start Menu Programs entry live in the current user's profile.
 *
 * Usage:
 *   node scripts/install-shortcut.mjs                  # desktop + Start Menu
 *   node scripts/install-shortcut.mjs --no-start-menu  # desktop only
 *   node scripts/install-shortcut.mjs --no-desktop     # Start Menu only
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
const noDesktop = argv.includes('--no-desktop')
const noStartMenu = argv.includes('--no-start-menu')
const showHelp = argv.includes('--help') || argv.includes('-h')

if (showHelp) {
  process.stdout.write(
    'Usage: node scripts/install-shortcut.mjs [--no-start-menu] [--no-desktop]\n',
  )
  process.exit(0)
}

const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainBundle = join(ROOT, 'dist-electron', 'main.cjs')

if (!existsSync(electron)) {
  throw new Error(`Freya's dependencies are not installed. Run 'npm install' in ${ROOT} first.`)
}
if (!existsSync(mainBundle)) {
  throw new Error(`Freya has not been built. Run 'npm run build:desktop' in ${ROOT} first.`)
}

const icoCandidates = [
  join(ROOT, 'build', 'icon.ico'),
  join(ROOT, 'electron', 'icon.ico'),
  join(ROOT, 'icon.ico'),
]
const iconPath = icoCandidates.find((candidate) => existsSync(candidate))
const iconLocation = iconPath ? `${iconPath},0` : `${electron},0`

function targetFor(scope) {
  if (scope === 'desktop') {
    return join(os.homedir(), 'Desktop', 'Freya.lnk')
  }
  if (scope === 'start-menu') {
    const appData = process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming')
    return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Freya.lnk')
  }
  throw new Error(`unknown scope: ${scope}`)
}

function writeShortcut(path) {
  // WScript.Shell is a Windows-only COM object. Anything else raises immediately
  // and the caller tells the operator what is wrong.
  const script = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$link = $ws.CreateShortcut('${path.replace(/'/g, "''")}')`,
    `$link.TargetPath = '${(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe').replace(/'/g, "''")}'`,
    `$link.Arguments = '/c ""${join(ROOT, "FreyaDebug.cmd").replace(/'/g, "''")}""'`,
    `$link.WorkingDirectory = '${ROOT.replace(/'/g, "''")}'`,
    `$link.IconLocation = '${iconLocation.replace(/'/g, "''")}'`,
    `$link.Description = 'Freya'`,
    `$link.WindowStyle = 1`,
    `$link.Save()`,
  ].join('; ')

  execSync(`powershell -NoProfile -NonInteractive -Command "${script}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.stdout.write(`wrote ${path}\n`)
}

const scopes = []
if (!noDesktop) scopes.push('desktop')
if (!noStartMenu) scopes.push('start-menu')

if (scopes.length === 0) {
  process.stderr.write('Refusing to install nothing. Pass --help to see options.\n')
  process.exit(2)
}

for (const scope of scopes) {
  const path = targetFor(scope)
  writeShortcut(path)
}

process.stdout.write(
  '\nShortcuts point at this working copy. If you move the repository, re-run this script.\n',
)
