import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron } from 'playwright-core'
import { createServer } from 'node:http'
import { acquireAcceptanceProcesses } from './acceptance-processes.mjs'
/* global window -- evaluated inside the actual renderer by Playwright */

const require = createRequire(import.meta.url)
const live = process.argv.includes('--live')
const tools = process.argv.includes('--tools')
const { connectRpc } = require('../dist-electron/runtime-rpc.cjs')
const root = resolve('.'), id = randomUUID(), token = () => randomBytes(32).toString('hex')
await mkdir(join(root, '.kilo'), { recursive: true })
const processes = await acquireAcceptanceProcesses(join(root, '.kilo'), live ? 300_000 : 180_000)
const profile = await mkdtemp(join(root, '.kilo', 'split-acceptance-'))
const address = name => process.platform === 'win32' ? `\\\\.\\pipe\\freya-${name}-${id}` : join(profile, `${name}.sock`)
const ownerToken = token(), intelligenceToken = token(), supervisorToken = token()
const common = { ...process.env, FREYA_RUNTIME_PROFILE: profile, FREYA_E2E: '1', FREYA_RUNTIME_TEST_PROFILE: live || tools ? '0' : '1', FREYA_DEV_PROVIDER: live || tools ? '' : 'echo',
  FREYA_CORE_OWNER_ENDPOINT: address('owner'), FREYA_CORE_INTELLIGENCE_ENDPOINT: address('intelligence'),
  FREYA_INTELLIGENCE_HEALTH_ENDPOINT: address('freya-health'), FREYA_SUPERAPP_HEALTH_ENDPOINT: address('ui-health') }
const coreEnv = { ...common, FREYA_OWNER_TOKEN: ownerToken, FREYA_INTELLIGENCE_TOKEN: intelligenceToken, FREYA_SUPERVISOR_TOKEN: supervisorToken }
const freyaEnv = { ...common, FREYA_INTELLIGENCE_TOKEN: intelligenceToken }
const uiEnv = { ...common, FREYA_OWNER_TOKEN: ownerToken, FREYA_INTELLIGENCE_HEALTH_TOKEN: intelligenceToken, FREYA_DEV_USER_DATA: profile }
let core, freya, ui, page
let freyaOutput = '', toolExecutions = 0
const web = createServer(async (request, response) => {
  if (tools && request.url === '/v1/chat/completions') {
    let body = ''; for await (const chunk of request) body += chunk
    const { messages } = JSON.parse(body)
    const texts = messages.map(message => message.content).filter(content => typeof content === 'string')
    const marker = texts.join('\n').match(/PRIVATE_SPLIT_MARKER_[a-z0-9-]+/i)?.[0]
    const requested = texts.some(text => text.includes('MAKE_SPLIT_CHART'))
    let content = marker ?? 'Ready.'
    if (requested) {
      content = toolExecutions++ === 0 ? 'FREYA_TOOL_CALL\n' + JSON.stringify({ tool: 'make_chart', title: 'Split chart', kind: 'bar', unit: 'count', points: JSON.stringify([{ label: 'A', value: 1 }, { label: 'B', value: 2 }]) }) + '\nFREYA_TOOL_CALL_END' : 'Chart ready.'
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20 } }))
    return
  }
  response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Split browser acceptance</title><main><h1>Actual embedded browser</h1><p>BROWSER_SPLIT_EVIDENCE</p></main>')
})
await new Promise(resolve => web.listen(0, '127.0.0.1', resolve))
const browserUrl = `http://127.0.0.1:${web.address().port}/`
if (tools) for (const env of [coreEnv, uiEnv]) Object.assign(env, { FREYA_ALLOW_LIVE_MODEL: '1', MINIMAX_API_KEY: '', NANOGPT_API_KEY: '', OPENAI_API_KEY: '', LOCAL_MODEL_BASE_URL: `${browserUrl}v1`, LOCAL_MODEL_MODEL: 'split-tools-fixture' })
const launch = (name, file, env, electron = false) => {
  const child = spawn(electron ? require('electron') : process.execPath, [file], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { if (name === 'Freya') freyaOutput = (freyaOutput + data).slice(-1_000_000); process.stdout.write(`[${name}] ${data}`) })
  child.stderr.on('data', data => process.stderr.write(`[${name}] ${data}`))
  return processes.track(child)
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
  processes.track(ui.process())
  page = await ui.firstWindow()
  await page.waitForFunction(() => typeof window.freyaHost?.coreSubmit === 'function', { timeout: 30_000 })
  await waitUntil(() => health(address('ui-health'), ownerToken), value => value.lifecycle === 'ready', 'Superapp readiness')
}
const submit = (command, payload) => page.evaluate(({ command, payload }) => window.freyaHost.coreSubmit(command, payload), { command, payload })
const browser = request => page.evaluate(request => window.freyaHost.browserCommand(request), request)
const kill = processes.stop

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
  if (tools) assert.equal((await submit('model.select', { providerId: 'local', model: 'split-tools-fixture' })).ok, true)
  const conversationId = created.conversation.conversation.conversationId
  const marker = `PRIVATE_SPLIT_MARKER_${randomUUID()}`
  const answer = await submit('conversation.turn.submit', { conversationId, text: live ? `Reply with only the following text: ${marker}` : marker })
  assert.equal(answer.conversation?.turn.outcome, 'completed', JSON.stringify(answer))
  if (live) assert.ok(answer.conversation.turn.assistantMessage.content.trim().length > 0)
  else assert.ok(answer.conversation.turn.assistantMessage.content.includes(marker))
  if (live) {
    assert.ok(!['fake', 'slow-echo', 'fixture-research'].includes(answer.conversation.turn.providerId))
    assert.ok((await readFile(join(profile, 'core-events.jsonl.keyring.json'), 'utf8')).includes('attention'))
    console.log(`PASS real configured LLM response from ${answer.conversation.turn.providerId}; OS-protected keyring and encrypted storage`)
  }
  console.log(`PASS real renderer → Freya Mind/provider → Core encryption/admission; PIDs ${core.pid}/${freya.pid}/${initialUiPid}`)
  const memoryText = `SPLIT_MEMORY_${randomUUID()}`
  const memory = await submit('brain.memory.write', { kind: 'semantic', subject: 'Split memory', content: memoryText, confidence: 'high', sensitivity: 'personal' })
  assert.equal(memory.brain?.memory?.status, 'admitted', JSON.stringify(memory))
  const recalled = await submit('brain.recall', { query: memoryText })
  assert.ok(recalled.brain.recall.items.some(item => item.content === memoryText), JSON.stringify(recalled))
  assert.ok(freyaOutput.includes(`memory writeMemory completed; pid=${freya.pid}`))
  assert.ok(freyaOutput.includes(`memory recall completed; pid=${freya.pid}`))
  console.log(`PASS existing memory admission and recall execute in Freya pid=${freya.pid}; encrypted persistence belongs to Core`)

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
  assert.ok(freyaOutput.includes(`Mission create completed; pid=${freya.pid}`), 'the real Mission engine must execute inside Freya')
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
  assert.ok(freyaOutput.includes(`Mission detail completed; pid=${freya.pid}`), 'the restarted Freya must read the persisted Mission')
  const journal = await readFile(join(profile, 'core-events.jsonl'), 'utf8')
  assert.ok(!journal.includes(marker), 'private chat content must not be journaled')
  assert.ok(!journal.includes(memoryText), 'private memory content must not be journaled')
  const restoredMemory = await submit('brain.recall', { query: memoryText })
  assert.ok(restoredMemory.brain.recall.items.some(item => item.content === memoryText), JSON.stringify(restoredMemory))
  assert.ok(freyaOutput.includes(`memory recall completed; pid=${freya.pid}`))
  console.log('PASS encrypted memory survives both Core and Freya restarts and is recalled by the restarted Freya engine')
  assert.equal(journal.split('\n').filter(line => line.includes('"type":"model.request.started"')).length, 1, 'restarts must not replay inference')
  if (tools) {
    const chart = await submit('conversation.turn.submit', { conversationId, text: 'MAKE_SPLIT_CHART: chart A=1 and B=2', intent: { webSearch: true } })
    assert.equal(chart.conversation?.turn.outcome, 'completed', JSON.stringify(chart))
    const chartRecord = await submit('conversation.read', { conversationId })
    assert.ok(chartRecord.conversation.messages.some(message => message.charts?.some(item => item.title === 'Split chart')), JSON.stringify(chartRecord))
    assert.ok(freyaOutput.includes(`tool make_chart completed; pid=${freya.pid}`), 'the real tool body must execute in the separate Freya process')
    assert.equal(toolExecutions, 2, 'one tool call and one synthesis; no duplicate execution')
    console.log(`PASS real compatible-provider/tool loop: Guard in Core, chart body in Freya pid=${freya.pid}, artifact in the existing renderer contract`)
  }
  assert.equal((await submit('security.stopAll')).ok, true)
  const stoppedBrowser = await browser({ op: 'open', url: browserUrl })
  assert.equal(stoppedBrowser.ok, false, 'STOP ALL must refuse native browser navigation')
  const denied = await submit('conversation.turn.submit', { conversationId, text: 'This request must not contact a provider' })
  assert.notEqual(denied.conversation?.turn.outcome, 'completed')
  console.log('PASS Core restart recovers encrypted chat without repeating inference; STOP ALL prevents a new provider call')
  console.log(`EVIDENCE profile=${profile}; Core=${core.pid}; Freya=${freya.pid}; Superapp=${ui.process().pid}`)
} finally {
  try {
    if (ui) await Promise.race([ui.close(), new Promise(resolve => setTimeout(resolve, 3_000))]).catch(() => {})
  } finally {
    try { await processes.close() }
    finally { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)) }
  }
}
