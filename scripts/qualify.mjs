#!/usr/bin/env node
/**
 * The Phase 49 qualification runner.
 *
 * It does four things, in this order:
 *
 *   1. **Measure the build.** It starts a real Core against a real temporary directory
 *      and reads the activation controller's own projection. Nothing about the
 *      capability inventory is assumed or re-derived here.
 *   2. **Execute every declared gate.** Real processes, real exit codes, real time.
 *   3. **Derive one verdict** with `core/qualification/verdict.ts`.
 *   4. **Write two reports** — canonical JSON and readable Markdown — from that one
 *      verdict object.
 *
 * The constraint that shapes all of it:
 *
 * > A gate that did not run is not a gate that passed.
 *
 * So no path in this file produces `pass` without a process having exited zero. A gate
 * whose tool is missing is `unavailable`. A gate whose prerequisites failed is
 * `blocked`. A gate nobody reached is `not-run`. All three are non-passes, and the
 * verdict module — not this file — decides what that means.
 *
 * `.mjs` only because this file needs `node:child_process`. Every decision it makes
 * comes from the TypeScript under `core/qualification/`, bundled by
 * `scripts/qualification-entry.mjs`, which the tests read directly. There is no
 * gate logic here that the test suite cannot reach.
 *
 * Usage:
 *   node scripts/qualify.mjs                    every gate; writes release/
 *   node scripts/qualify.mjs --only=stop-all    one gate and what it needs
 *   node scripts/qualify.mjs --format=json      canonical report to stdout only
 *   node scripts/qualify.mjs --no-write         do not touch release/
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { qualification } from './qualification-entry.mjs'

const {
  RELEASE_GATES,
  buildInventoryFromProjection,
  canonicalReportJson,
  inventorySummary,
  qualify,
  qualificationMarkdown,
  startLiveQualification,
} = qualification

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null
const format = argv.find((arg) => arg.startsWith('--format='))?.slice('--format='.length) ?? 'text'
const shouldWrite = !argv.includes('--no-write')

/** A gate that overruns this is a failed gate. It is never an unmeasured pass. */
const GATE_TIMEOUT_MS = 20 * 60 * 1000

/** Bounded output kept per gate: enough to diagnose, not enough to drown the report. */
const MAX_OUTPUT_LINES = 40

function portable(path) {
  return path.split(sep).join('/')
}

/**
 * The command to spawn, as this platform can actually start it.
 *
 * Every gate is declared as `npm run <script>` because that is the command a person
 * runs, and the report should name it rather than a paraphrase. On POSIX that spawns
 * directly with `shell: false`. On Windows `npm` on `PATH` is a `.cmd` shim, which
 * `CreateProcess` cannot start at all, so the fixed `cmd.exe /d /s /c` is used
 * explicitly.
 *
 * That is a shell, so it is worth being plain about why it is safe here: every gate
 * argv is a constant in `core/qualification/gates.ts`, and the only runner input that
 * reaches a command is `--only`, which *selects* a gate by id and can never construct
 * or alter one. There is no interpolated path, no environment value and no user string
 * in any gate command. `/d` skips `AutoRun`, so a machine-local registry hook cannot
 * inject anything either.
 */
function spawnCommand(command) {
  if (process.platform !== 'win32') return { file: command[0], args: command.slice(1) }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/c', command.map(quoteForCmd).join(' ')] }
}

function quoteForCmd(argument) {
  if (/^[\w./:@-]+$/.test(argument)) return argument
  return `"${argument.replace(/"/g, '""')}"`
}

function boundedOutput(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  if (lines.length <= MAX_OUTPUT_LINES) return lines
  const dropped = lines.length - MAX_OUTPUT_LINES
  return [...lines.slice(dropped), `... ${String(dropped)} earlier line(s) omitted`]
}

/**
 * What is missing on this machine that would stop a gate from meaning anything.
 *
 * Checked before the gate runs, so the report can say "the Electron binary is not
 * installed here, so the end-to-end run measured nothing" instead of dressing a spawn
 * failure up as a test failure. Both are non-passes; only the first one is honest about
 * why.
 */
function blockers(command) {
  if (command === null) return ['this gate declares no command, so there is no evidence to collect']
  const missing = []
  const [program, , script] = command

  if (program === 'npm' && typeof script === 'string') {
    let manifest = {}
    try {
      manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    } catch (error) {
      missing.push(`package.json could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Object.keys(manifest).length > 0 && !(script in (manifest.scripts ?? {}))) {
      missing.push(`npm script "${script}" is not declared in package.json`)
    }
  }

  if (command.includes('test:e2e') && !existsSync(join(root, 'node_modules', 'electron', 'dist'))) {
    missing.push('the Electron binary is not installed (node_modules/electron/dist is absent)')
  }
  if (script === 'release:check') {
    if (!existsSync(join(root, 'dist-electron', 'main.cjs'))) {
      missing.push('the host artifact dist-electron/main.cjs is absent, so its budget cannot be measured')
    }
    if (!existsSync(join(root, 'dist', 'assets'))) {
      missing.push('the renderer bundle dist/assets is absent, so its budgets cannot be measured')
    }
  }
  return missing
}

function runGate(declaration) {
  const started = Date.now()
  const command = declaration.command

  if (command === null) {
    return {
      id: declaration.id,
      state: 'not-run',
      command: null,
      exitCode: null,
      durationMs: 0,
      detail: 'this gate declares no command, so there is no evidence to collect',
      output: [],
    }
  }

  const missing = blockers(command)
  if (missing.length > 0) {
    return {
      id: declaration.id,
      state: 'unavailable',
      command,
      exitCode: null,
      durationMs: Date.now() - started,
      detail: `cannot be executed on this machine: ${missing.join('; ')}. Nothing was measured.`,
      output: [],
    }
  }

  const { file, args } = spawnCommand(command)
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS,
    // `shell: false` on purpose: a gate command is a declaration, executed as written
    // rather than re-parsed by a shell that could expand something the catalogue never
    // said.
    shell: false,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
    maxBuffer: 64 * 1024 * 1024,
  })

  const durationMs = Date.now() - started
  const output = [...boundedOutput(result.stdout), ...boundedOutput(result.stderr)]

  if (result.error) {
    return {
      id: declaration.id,
      state: 'unavailable',
      command,
      exitCode: null,
      durationMs,
      detail: `could not be started on this machine: ${result.error.code ?? result.error.message}. Nothing was measured.`,
      output: [...output, result.error.message],
    }
  }

  if (result.signal) {
    return {
      id: declaration.id,
      state: 'fail',
      command,
      exitCode: null,
      durationMs,
      detail: `was terminated by ${result.signal} after ${String(durationMs)}ms, so it never finished`,
      output,
    }
  }

  const exitCode = result.status ?? null
  if (exitCode === 0) {
    return {
      id: declaration.id,
      state: 'pass',
      command,
      exitCode,
      durationMs,
      detail: `executed and exited zero in ${String(durationMs)}ms`,
      output,
    }
  }
  return {
    id: declaration.id,
    state: 'fail',
    command,
    exitCode,
    durationMs,
    detail: `exited ${String(exitCode)} after ${String(durationMs)}ms`,
    output,
  }
}

/**
 * Which registry ids have their implementation physically present in this tree.
 *
 * The registry's `module` field is a human-readable list of paths, so presence means
 * "at least one of them exists". This is the only build-level fact the inventory takes
 * from outside Core, because only the build can know whether its files shipped.
 */
function modulePresence() {
  const { orderedRegistry } = qualification
  const present = new Set()
  for (const descriptor of orderedRegistry()) {
    const paths = descriptor.module
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    const any = paths.some((relativePath) => existsSync(join(root, ...relativePath.split(/[\\/]/))))
    if (any) present.add(descriptor.id)
  }
  return present
}

async function measureBuild() {
  const dataPath = join(await mkdtemp(join(tmpdir(), 'freya-qualify-')), 'journal')
  const live = await startLiveQualification({
    dataPath,
    environment: {
      providerCredentialInEnv: false,
      liveModelRequested: false,
      keyringAvailable: false,
      platform: `${process.platform}-${process.arch}`,
    },
  })
  const inventory = buildInventoryFromProjection(live.projection, {
    presentModules: [...modulePresence()],
  })
  const summary = inventorySummary(inventory)
  await live.stop()
  await rm(dirname(dataPath), { recursive: true, force: true })
  return { inventory, summary }
}

async function main() {
  const { inventory, summary } = await measureBuild()

  const known = new Set(RELEASE_GATES.map((declaration) => declaration.id))
  if (only !== null && !known.has(only)) {
    console.error(`No release gate matches --only=${only}. Known gates:`)
    for (const id of known) console.error(`  - ${id}`)
    process.exit(2)
  }

  // `--only` runs the named gate and everything it transitively needs. Everything else
  // is still recorded, as `not-run`, because a partial run reported as a whole one is
  // the exact failure this phase exists to catch.
  const selected = only === null ? null : prerequisiteClosure(only)

  const results = []
  for (const declaration of RELEASE_GATES) {
    const prerequisites = declaration.requires
      .map((id) => results.find((result) => result.id === id))
      .filter((result) => result === undefined || result.state !== 'pass')
      .map((result) => (result === undefined ? 'an undecided prerequisite' : result.id))

    if (selected !== null && !selected.has(declaration.id)) {
      results.push({
        id: declaration.id,
        state: 'not-run',
        command: declaration.command,
        exitCode: null,
        durationMs: 0,
        detail: `not selected by --only=${only}; a gate nobody ran is not a gate that passed`,
        output: [],
      })
      continue
    }
    if (prerequisites.length > 0) {
      results.push({
        id: declaration.id,
        state: 'blocked',
        command: declaration.command,
        exitCode: null,
        durationMs: 0,
        detail: `not run: ${prerequisites.join(', ')} did not pass, so this gate measured nothing`,
        output: [],
      })
      continue
    }

    const result = runGate(declaration)
    results.push(result)
    if (format !== 'json') {
      console.log(`[${result.state === 'pass' ? 'PASS' : result.state.toUpperCase()}] ${declaration.id} — ${result.detail}`)
    }
  }

  const report = qualify({ results, inventory, generatedAt: new Date().toISOString(), revision: revision() })

  if (format === 'json') {
    process.stdout.write(canonicalReportJson(report))
  } else {
    printSummary(report, summary)
  }

  if (shouldWrite) {
    const jsonPath = join(root, 'release', 'release-qualification.json')
    const mdPath = join(root, 'release', 'release-qualification.md')
    await mkdir(dirname(jsonPath), { recursive: true })
    await writeFile(jsonPath, canonicalReportJson(report), 'utf8')
    await writeFile(mdPath, qualificationMarkdown(report), 'utf8')
    console.log('')
    console.log(`Report written: ${portable(relative(root, jsonPath))}`)
    console.log(`Report written: ${portable(relative(root, mdPath))}`)
  }

  process.exit(report.verdict === 'ship' ? 0 : 1)
}

/** The named gate plus every prerequisite it transitively needs. */
function prerequisiteClosure(id) {
  const byId = new Map(RELEASE_GATES.map((declaration) => [declaration.id, declaration]))
  const closure = new Set()
  const walk = (current) => {
    if (closure.has(current)) return
    closure.add(current)
    for (const required of byId.get(current)?.requires ?? []) walk(required)
  }
  walk(id)
  return closure
}

function revision() {
  try {
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false })
      .stdout.trim()
  } catch {
    return 'unknown'
  }
}

function printSummary(report, summary) {
  console.log('')
  console.log('Release qualification')
  console.log('=====================')
  console.log(`Capabilities: ${summary}`)
  console.log('')
  for (const gate of report.gates) {
    console.log(`  ${gate.state.padEnd(12)} ${gate.id.padEnd(30)} ${gate.title}`)
  }
  console.log('')
  if (report.verdict === 'ship') {
    console.log('Verdict: ship')
    return
  }
  console.log('Verdict: no-ship')
  for (const reason of report.reasons) console.log(`  - [${reason.kind}] ${reason.subject}: ${reason.detail}`)
}

await main()