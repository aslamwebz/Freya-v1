import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve('.'), require = createRequire(import.meta.url)
const { connectRpc } = require('../dist-electron/runtime-rpc.cjs')
await mkdir(join(root, '.kilo'), { recursive: true })
const profile = await mkdtemp(join(root, '.kilo', 'supervisor-acceptance-'))
const env = { ...process.env, FREYA_E2E: '1', FREYA_RUNTIME_TEST_PROFILE: '1', FREYA_DEV_PROVIDER: 'echo', FREYA_CDP_PORT: '0' }
const child = spawn(process.platform === 'win32' ? process.env.ComSpec : process.execPath,
  process.platform === 'win32' ? ['/d', '/c', 'FreyaDebug.cmd', '--no-build', `--profile=${profile}`] : ['scripts/debug-stack.mjs', '--no-build', `--profile=${profile}`],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data) })
const wait = async (read, accepts, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    try { value = await read(); if (accepts(value)) return value } catch (error) { value = error.message }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
const descriptor = () => readFile(join(profile, '.runtime', 'debug-stack.json'), 'utf8').then(JSON.parse)
let client
try {
  const state = await wait(descriptor, value => value.components?.core && value.components?.freya && value.components?.superapp, 'launcher component PIDs')
  client = await connectRpc(state.addresses.supervisor, state.supervisorToken)
  // Do not request status: this evidence must come from the real 60-second interval.
  await wait(() => output, value => value.includes('HEARTBEAT HEALTH OK'), 'automatic 60-second readiness report', 70_000)
  const original = await descriptor()
  await client.call('supervisor.stop', { component: 'superapp' })
  const hidden = await descriptor()
  assert.equal(hidden.components.core, original.components.core); assert.equal(hidden.components.freya, original.components.freya)
  assert.equal(hidden.components.superapp, undefined)
  const checks = await client.call('supervisor.status')
  assert.equal(checks.find(value => value.component === 'superapp').lifecycle, 'unavailable')
  await client.call('supervisor.start', { component: 'superapp' })
  await wait(() => client.call('supervisor.status'), values => values.every(value => value.lifecycle === 'ready'), 'UI reopened')
  const reopened = await descriptor()
  assert.notEqual(reopened.components.superapp, original.components.superapp)
  await client.call('supervisor.restart', { component: 'freya' })
  await wait(() => client.call('supervisor.status'), values => values.every(value => value.lifecycle === 'ready'), 'Freya restart')
  const restarted = await descriptor()
  assert.notEqual(restarted.components.freya, original.components.freya)
  assert.equal(restarted.components.core, original.components.core); assert.equal(restarted.components.superapp, reopened.components.superapp)
  console.log('PASS FreyaDebug.cmd launches and supervises real independent processes; automatic health and degraded status are truthful')
} finally {
  if (client?.connected) { await client.call('supervisor.shutdown').catch(() => {}); client.close() }
  const deadline = Date.now() + 15_000
  while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  if (child.exitCode === null) child.kill()
}
assert.equal(child.exitCode, 0, 'explicit full-stack shutdown should exit cleanly')
console.log(`PASS explicit full-stack shutdown; isolated profile=${profile}`)
