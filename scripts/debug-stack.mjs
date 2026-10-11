import { existsSync } from 'node:fs'
import { requireSelectedProfile, formatHeartbeat, redactRuntimeOutput } from './launcher-policy.mjs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { runtimeAddresses } from './runtime-addresses.mjs'

const root = resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const profileFlag = args.find(arg => arg.startsWith('--profile='))
const profile = resolve(profileFlag?.slice('--profile='.length) ?? process.env.FREYA_PROFILE ?? join(root, '.kilo', 'freya-debug-profile'))
const command = args.filter(arg => !arg.startsWith('--'))
const stateFile = join(profile, '.runtime', 'debug-stack.json')
console.log(`[supervisor] selected profile: ${profile}`)
try { requireSelectedProfile(existsSync(join(profile, 'core-events.jsonl')) || existsSync(join(profile, 'vault', 'freya.db')), args.includes('--initialize-profile') || process.env.FREYA_RUNTIME_TEST_PROFILE === '1' && process.env.FREYA_E2E === '1') }
catch (error) { console.error(`[supervisor] ${error.message}`); process.exit(1) }
if (!args.includes('--no-build') && !command.length) {
  const build = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' })
  const code = await new Promise(resolve => { build.once('error', () => resolve(1)); build.once('exit', resolve) })
  if (code !== 0) process.exit(code ?? 1)
}
const { connectRpc, listenRpc, observeHealth } = require('../dist-electron/runtime-rpc.cjs')
const addresses = runtimeAddresses(profile)
let existing
try { existing = JSON.parse(await readFile(stateFile, 'utf8')) } catch { /* First launch or stale descriptor. */ }
if (existing) {
  let peer
  try {
    peer = await connectRpc(addresses.supervisor, existing.supervisorToken)
    const op = command[0] ?? 'start', component = command[1] ?? 'superapp'
    console.log(await peer.call(`supervisor.${op}`, { component }))
    peer.close(); process.exit(0)
  } catch (error) {
    peer?.close()
    if (command.length) { console.error('[supervisor] existing supervisor is unavailable:', error.message); process.exit(1) }
  }
} else if (command.length) { console.error('[supervisor] no running stack for this profile'); process.exit(1) }

await mkdir(join(profile, '.runtime'), { recursive: true })
const secret = () => randomBytes(32).toString('hex')
const ownerToken = secret(), intelligenceToken = secret(), supervisorToken = secret()
const base = { ...process.env, FREYA_RUNTIME_PROFILE: profile, FREYA_CORE_OWNER_ENDPOINT: addresses.core,
  FREYA_CORE_INTELLIGENCE_ENDPOINT: addresses.intelligence, FREYA_INTELLIGENCE_HEALTH_ENDPOINT: addresses.freya, FREYA_SUPERAPP_HEALTH_ENDPOINT: addresses.superapp }
delete base.ELECTRON_RUN_AS_NODE
for (const name of ['FREYA_OWNER_TOKEN', 'FREYA_INTELLIGENCE_TOKEN', 'FREYA_INTELLIGENCE_HEALTH_TOKEN', 'FREYA_SUPERVISOR_TOKEN']) delete base[name]
const envs = {
  core: { ...base, FREYA_OWNER_TOKEN: ownerToken, FREYA_INTELLIGENCE_TOKEN: intelligenceToken, FREYA_SUPERVISOR_TOKEN: supervisorToken },
  freya: { ...base, FREYA_INTELLIGENCE_TOKEN: intelligenceToken },
  superapp: { ...base, FREYA_OWNER_TOKEN: ownerToken, FREYA_INTELLIGENCE_HEALTH_TOKEN: intelligenceToken, FREYA_DEV_USER_DATA: profile },
}
const children = new Map(), intentionallyStopped = new Set()
let shuttingDown = false
let saving = Promise.resolve()
const saveState = () => saving = saving.catch(() => {}).then(async () => {
  await writeFile(`${stateFile}.pending`, JSON.stringify({ supervisorPid: process.pid, supervisorToken, ownerToken,
    intelligenceToken, addresses, components: Object.fromEntries([...children].map(([name, child]) => [name, child.pid])) }, null, 2), { mode: 0o600 })
  await rename(`${stateFile}.pending`, stateFile)
})

function output(stream, name) {
  let buffer = ''
  stream.on('data', chunk => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, newline).trimEnd(); buffer = buffer.slice(newline + 1); if (line) console.log(`[${new Date().toISOString()}] [${name}] ${redactRuntimeOutput(line, [ownerToken, intelligenceToken, supervisorToken, ...Object.entries(base).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value)])}`) }
  })
}
function start(name) {
  if (!['core', 'freya', 'superapp'].includes(name)) throw new Error('component must be core, freya or superapp')
  if (children.has(name)) return `${name} is already running`
  intentionallyStopped.delete(name)
  const binary = name === 'freya' ? process.execPath : require('electron')
  const argv = name === 'core' ? [join(root, 'dist-electron/core.cjs')] : name === 'freya' ? [join(root, 'dist-electron/freya.cjs')]
    : [root, '--dev', `--remote-debugging-port=${process.env.FREYA_CDP_PORT ?? '9234'}`, '--remote-debugging-address=127.0.0.1']
  const child = spawn(binary, argv, { cwd: root, env: envs[name], stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  children.set(name, child); output(child.stdout, name); output(child.stderr, name)
  child.on('error', error => console.error(`[${name}] launch failed: ${error.message}`))
  child.on('exit', (code, signal) => {
    if (children.get(name) === child) children.delete(name)
    console.log(`[${name}] exited (${signal ?? code}); other components remain running`)
    void saveState()
    if (!shuttingDown && !intentionallyStopped.has(name) && name !== 'superapp') setTimeout(() => { start(name) }, 1_000)
  })
  void saveState()
  console.log(`[${new Date().toISOString()}] [supervisor] ${name} starting pid=${child.pid}`)
  return `${name} started`
}
async function stop(name) {
  if (!['core', 'freya', 'superapp'].includes(name)) throw new Error('component must be core, freya or superapp')
  intentionallyStopped.add(name)
  const child = children.get(name)
  if (!child) return `${name} is already stopped`
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    const endpoint = name === 'core' ? addresses.core : addresses[name], token = name === 'freya' ? intelligenceToken : ownerToken
    const peer = await connectRpc(endpoint, token)
    try { await peer.call(name === 'core' ? 'runtime.shutdown' : 'runtime.quit', { token: supervisorToken }, 5_000) } finally { peer.close() }
  } catch { child.kill() }
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill() }, 8_000)
  await exited; clearTimeout(timer); await saveState()
  return `${name} stopped`
}
async function status() {
  const checks = await Promise.all(['core', 'freya', 'superapp'].map(async name => {
    let peer
    try {
      peer = await connectRpc(addresses[name], name === 'freya' ? intelligenceToken : ownerToken)
      const health = await peer.call('runtime.health', null, 5_000)
      if (health.component !== name || health.pid !== children.get(name)?.pid) throw new Error('readiness reply belongs to a different process instance')
      if (Math.abs(Date.now() - Date.parse(health.checkedAt)) > 10_000) throw new Error('readiness reply is stale')
      if (name === 'core' && (!health.lastProgressAt || Date.now() - Date.parse(health.lastProgressAt) > 40_000)) throw new Error('Core 30-second heartbeat is stale')
      return observeHealth(name, children.get(name)?.pid ?? null, health)
    } catch (error) { return observeHealth(name, children.get(name)?.pid ?? null, null) }
    finally { peer?.close() }
  }))
  console.log(formatHeartbeat(checks, new Date().toISOString()))
  return checks
}
async function shutdown() {
  shuttingDown = true
  clearInterval(healthTimer)
  for (const name of ['superapp', 'freya', 'core']) await stop(name)
  await supervisor.close(); console.log('[supervisor] explicit full-stack shutdown complete')
  process.exit(0)
}
async function handle(op, component) {
  if (op === 'status') return status()
  if (op === 'start' || op === 'open') { const result = start(component ?? 'superapp'); await saving; return result }
  if (op === 'stop' && component === 'all' || op === 'shutdown') { setTimeout(() => { void shutdown() }, 50); return 'full-stack shutdown requested' }
  if (op === 'stop') return stop(component)
  if (op === 'restart') { await stop(component); const result = start(component); await saving; return result }
  throw new Error('commands: status, restart core|freya|superapp, start superapp, stop core|freya|superapp, stop all')
}
const supervisor = await listenRpc(addresses.supervisor, supervisorToken, peer => peer.handle((method, value) => {
  if (!method.startsWith('supervisor.')) throw new Error('unknown supervisor operation')
  return handle(method.slice('supervisor.'.length), value?.component)
}))
await saveState()
start('core'); start('freya'); start('superapp')
let reporting = false
const report = async () => { if (reporting) return; reporting = true; try { await status() } finally { reporting = false } }
const healthTimer = setInterval(() => { void report() }, 30_000)
void report()
console.log(`[supervisor] isolated profile: ${profile}`)
console.log('[supervisor] Commands: status; restart core|freya|superapp; start superapp; stop all')
const input = createInterface({ input: process.stdin, output: process.stdout })
input.on('line', line => { const [op, component] = line.trim().split(/\s+/); if (op) void handle(op, component).then(result => console.log(result)).catch(error => console.error(error.message)) })
process.on('SIGINT', () => { console.log('[supervisor] Use "stop all" for an explicit full-stack shutdown') })
