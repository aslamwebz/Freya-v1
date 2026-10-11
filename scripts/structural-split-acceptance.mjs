import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron } from 'playwright-core'
import { createServer } from 'node:http'
/* global window -- evaluated inside the actual renderer by Playwright */

const require = createRequire(import.meta.url)
const { connectRpc } = require('../dist-electron/runtime-rpc.cjs')
const root = resolve('.'), id = randomUUID(), token = () => randomBytes(32).toString('hex')
await mkdir(join(root, '.kilo'), { recursive: true })
const profile = await mkdtemp(join(root, '.kilo', 'split-acceptance-'))
const address = name => process.platform === 'win32' ? `\\\\.\\pipe\\freya-${name}-${id}` : join(profile, `${name}.sock`)
const ownerToken = token(), intelligenceToken = token(), supervisorToken = token()
const common = { ...process.env, FREYA_RUNTIME_PROFILE: profile, FREYA_E2E: '1', FREYA_RUNTIME_TEST_PROFILE: '1', FREYA_DEV_PROVIDER: 'echo',
  FREYA_CORE_OWNER_ENDPOINT: address('owner'), FREYA_CORE_INTELLIGENCE_ENDPOINT: address('intelligence'),
  FREYA_INTELLIGENCE_HEALTH_ENDPOINT: address('freya-health'), FREYA_SUPERAPP_HEALTH_ENDPOINT: address('ui-health') }
const coreEnv = { ...common, FREYA_OWNER_TOKEN: ownerToken, FREYA_INTELLIGENCE_TOKEN: intelligenceToken, FREYA_SUPERVISOR_TOKEN: supervisorToken }
const freyaEnv = { ...common, FREYA_INTELLIGENCE_TOKEN: intelligenceToken }
const uiEnv = { ...common, FREYA_OWNER_TOKEN: ownerToken, FREYA_INTELLIGENCE_HEALTH_TOKEN: intelligenceToken, FREYA_DEV_USER_DATA: profile }
let core, freya, ui, page
const children = []
const web = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Split browser acceptance</title><main><h1>Actual embedded browser</h1><p>BROWSER_SPLIT_EVIDENCE</p></main>') })
await new Promise(resolve => web.listen(0, '127.0.0.1', resolve))
const browserUrl = `http://127.0.0.1:${web.address().port}/`
const launch = (name, file, env, electron = false) => {
  const child = spawn(electron ? require('electron') : process.execPath, [file], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => process.stdout.write(`[${name}] ${data}`))
  child.stderr.on('data', data => process.stderr.write(`[${name}] ${data}`))
  children.push(child); return child
}
const waitUntil = async (read, predicate, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { last = await read(); if (predicate(last)) return last } catch (error) { last = error.message }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}
const health = async (endpoint, auth) => {
  const client = await connectRpc(endpoint, auth)
  try { return await client.call('runtime.health', null, 5_000) } finally { client.close() }
}
const openUi = async () => {
  ui = await _electron.launch({ executablePath: require('electron'), args: ['.', '--dev'], env: uiEnv, cwd: root, timeout: 30_000 })
  page = await ui.firstWindow()
  await page.waitForFunction(() => typeof window.freyaHost?.coreSubmit === 'function', { timeout: 30_000 })
  await waitUntil(() => health(address('ui-health'), ownerToken), value => value.lifecycle === 'ready', 'Superapp readiness')
}
const submit = (command, payload) => page.evaluate(({ command, payload }) => window.freyaHost.coreSubmit(command, payload), { command, payload })
const browser = request => page.evaluate(request => window.freyaHost.browserCommand(request), request)
const kill = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = new Promise(resolve => child.once('exit', resolve))
  child.kill(); await exit
}

try {
  core = launch('Core', join(root, 'dist-electron/core.cjs'), coreEnv, true)
  const initialCore = await waitUntil(() => health(address('owner'), ownerToken), value => value.lifecycle === 'ready', 'Core startup')
  freya = launch('Freya', join(root, 'dist-electron/freya.cjs'), freyaEnv)
  await waitUntil(() => health(address('freya-health'), intelligenceToken), value => value.lifecycle === 'ready', 'Freya startup')
  await openUi()
  const initialUiPid = ui.process().pid, initialFreyaPid = freya.pid
  assert.equal(initialCore.pid, core.pid)
  assert.equal(new Set([core.pid, freya.pid, initialUiPid]).size, 3)
  const created = await submit('conversation.create', { title: 'Process split acceptance' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const conversationId = created.conversation.conversation.conversationId
  const marker = `PRIVATE_SPLIT_MARKER_${randomUUID()}`
  const answer = await submit('conversation.turn.submit', { conversationId, text: marker })
  assert.equal(answer.conversation?.turn.outcome, 'completed', JSON.stringify(answer))
  assert.ok(answer.conversation.turn.assistantMessage.content.includes(marker))
  console.log(`PASS real renderer → Freya Mind/provider → Core encryption/admission; PIDs ${core.pid}/${freya.pid}/${initialUiPid}`)

  const opened = await browser({ op: 'open', url: browserUrl })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const snapshot = await browser({ op: 'snapshot', tabId: opened.data.tabId })
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
  assert.ok(JSON.stringify(snapshot).includes('BROWSER_SPLIT_EVIDENCE'), JSON.stringify(snapshot))
  const voices = await submit('voice.tts.voice.read')
  assert.equal(voices.ok, true, JSON.stringify(voices))
  assert.ok(Array.isArray(voices.voice.voices))
  console.log(`PASS real embedded browser through Core Device Hands admission and shared journal; live voice discovery (${voices.voice.voices.length} installed voices)`)
  const mission = await submit('mission.create', { title: 'Process split mission', intent: 'Preserve this mission across independent component restarts.' })
  assert.equal(mission.ok, true, JSON.stringify(mission))
  const missionId = mission.mission.missionId
  const catalogue = await page.evaluate(() => window.freyaHost.coreTools())
  assert.equal(catalogue.health, 'ready')
  for (const name of ['mission_manage', 'goal_manage', 'reminder_manage', 'system_inspect']) assert.ok(catalogue.tools.some(tool => tool.name === name), `missing existing tool ${name}`)
  const skills = await page.evaluate(() => window.freyaHost.coreSkills())
  assert.equal(skills.persistence.mode, 'encrypted')
  const workforce = await page.evaluate(() => window.freyaHost.coreWorkforce())
  assert.ok(Array.isArray(workforce.workers))
  console.log(`PASS existing missions, encrypted skills, tool catalogue and real agent projection (${workforce.workers.length} workers)`)

  await kill(freya)
  assert.equal((await health(address('owner'), ownerToken)).pid, initialCore.pid)
  assert.equal(ui.process().pid, initialUiPid)
  const schedule = await submit('attention.schedule.register', { kind: 'reminder', text: 'Process recovery reminder', dueAt: new Date().toISOString() })
  assert.equal(schedule.ok, true, JSON.stringify(schedule))
  const disconnected = await health(address('owner'), ownerToken)
  await waitUntil(() => health(address('owner'), ownerToken), value => value.lastProgressAt > disconnected.lastProgressAt, 'independent 30-second Core heartbeat', 35_000)
  assert.equal((await page.evaluate(() => window.freyaHost.coreAttention())).schedules[0].status, 'pending')
  freya = launch('Freya', join(root, 'dist-electron/freya.cjs'), freyaEnv)
  await waitUntil(() => health(address('freya-health'), intelligenceToken), value => value.lifecycle === 'ready', 'Freya restart')
  assert.notEqual(freya.pid, initialFreyaPid)
  const afterFreya = await submit('conversation.read', { conversationId })
  assert.equal(afterFreya.conversation.messages.length, 2)
  await waitUntil(() => page.evaluate(() => window.freyaHost.coreAttention()), value => value.schedules[0]?.status === 'fired', 'retained reminder reconciliation')
  assert.equal((await page.evaluate(() => window.freyaHost.coreAttention())).schedules[0].repeats, 1)
  console.log('PASS Freya restart preserves Core, Superapp and encrypted chat')
  console.log('PASS Core heartbeat survives Freya outage; due reminder is retained and fires once on reconnection')

  const freyaPid = freya.pid
  await ui.evaluate(({ app }) => { app.quit() }); await ui.close(); ui = null
  assert.equal((await health(address('owner'), ownerToken)).pid, initialCore.pid)
  assert.equal((await health(address('freya-health'), intelligenceToken)).pid, freyaPid)
  await openUi()
  const secondUiPid = ui.process().pid
  assert.notEqual(secondUiPid, initialUiPid)
  console.log('PASS Superapp quit and reopen leave Core and Freya running')

  await kill(core)
  core = launch('Core', join(root, 'dist-electron/core.cjs'), coreEnv, true)
  await waitUntil(() => health(address('owner'), ownerToken), value => value.lifecycle === 'ready', 'Core restart')
  await waitUntil(() => health(address('ui-health'), ownerToken), value => value.lifecycle === 'ready', 'clients reconnected after Core restart')
  assert.notEqual(core.pid, initialCore.pid)
  assert.equal(freya.pid, freyaPid); assert.equal(ui.process().pid, secondUiPid)
  const restored = await submit('conversation.read', { conversationId })
  assert.equal(restored.conversation.messages.length, 2)
  assert.ok(restored.conversation.messages[0].content.includes(marker))
  const restoredMission = await submit('mission.read', { missionId })
  assert.equal(restoredMission.ok, true, JSON.stringify(restoredMission))
  const journal = await readFile(join(profile, 'core-events.jsonl'), 'utf8')
  assert.ok(!journal.includes(marker), 'private chat content must not be journaled')
  assert.equal(journal.split('\n').filter(line => line.includes('"type":"model.request.started"')).length, 1, 'restarts must not replay inference')
  assert.equal((await submit('security.stopAll')).ok, true)
  const stoppedBrowser = await browser({ op: 'open', url: browserUrl })
  assert.equal(stoppedBrowser.ok, false, 'STOP ALL must refuse native browser navigation')
  const denied = await submit('conversation.turn.submit', { conversationId, text: 'This request must not contact a provider' })
  assert.notEqual(denied.conversation?.turn.outcome, 'completed')
  console.log('PASS Core restart recovers encrypted chat without repeating inference; STOP ALL prevents a new provider call')
  console.log(`EVIDENCE profile=${profile}; Core=${core.pid}; Freya=${freya.pid}; Superapp=${ui.process().pid}`)
} finally {
  if (ui) await ui.close().catch(() => {})
  for (const child of children) await kill(child)
  web.closeAllConnections()
  await new Promise(resolve => web.close(resolve))
}
