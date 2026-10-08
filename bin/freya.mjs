#!/usr/bin/env node
/**
 * The Freya external CLI.
 *
 * A small, single-file client that talks to a running Freya over the
 * authenticated local channel. Reads `protocol.version`, formats responses for
 * humans by default and JSON with `--json`, and the only side effects it
 * performs are the ones the user named on the command line.
 *
 * The audience is the same one Athena's `athena` script reaches: a coding
 * agent that can run shell commands and that should not need an SDK. Every
 * subcommand here is one round-trip; nothing is cached, nothing is paged, and
 * there is no second process to spawn.
 *
 * Examples:
 *   freya status
 *   freya health
 *   freya focus
 *   freya chats
 *   freya chat new "My new chat"
 *   freya send <conversationId> "What is the weather?"
 *   freya browser status
 *   freya browser tabs
 *   freya browser open https://example.com
 *   freya browser activate <tabId>
 *   freya missions
 *   freya agents
 *   freya notify "build finished"
 *   freya stop-status
 */

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/* --------------------------------------------------------------- locations */

const ARGV = process.argv.slice(2)
const AS_JSON = ARGV.includes('--json')
const FILTERED = ARGV.filter((a) => a !== '--json')
const COMMAND = FILTERED[0] ?? 'help'

function userDataDir() {
  if (process.env.FREYA_USER_DATA) return process.env.FREYA_USER_DATA
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'freya')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'freya')
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(xdg, 'freya')
}

function readEndpoint() {
  const file = join(userDataDir(), 'control.endpoint')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed.endpoint !== 'string') return null
    const isWindows = process.platform === 'win32'
    return {
      endpoint: parsed.endpoint,
      socketPath: isWindows ? undefined : parsed.endpoint.replace(/^unix:/, ''),
      pid: parsed.pid,
    }
  } catch {
    return null
  }
}

function readToken() {
  const file = join(userDataDir(), 'control.token')
  if (!existsSync(file)) return null
  try {
    const value = readFileSync(file, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(value) ? value : null
  } catch {
    return null
  }
}

function clientTag() {
  if (process.env.FREYA_CLIENT) return process.env.FREYA_CLIENT.slice(0, 64)
  return 'cli'
}

/* --------------------------------------------------------------- transport */

class Client {
  constructor() {
    this.socket = null
    this.buffer = ''
    this.waiters = new Map()
    this.eventListeners = new Set()
    this.nextId = 1
    this.greeted = false
  }

  connect(endpoint, token) {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint.socketPath ?? endpoint.endpoint)
      this.socket = socket
      socket.setEncoding('utf8')
      const onError = (err) => {
        socket.off('error', onError)
        reject(err)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.write(`AUTH ${token} ${clientTag()}\n`)
      })
      // Single data handler: the first complete line is the greeting. Anything
      // after it is a regular response or event.
      socket.on('data', (chunk) => this.onData(chunk, resolve, reject))
      socket.on('error', (err) => this.onClose(err))
      socket.on('close', () => this.onClose())
    })
  }

  onData(chunk, resolveConnect, rejectConnect) {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.length === 0) continue
      if (!this.greeted) {
        this.greeted = true
        if (line === 'OK') {
          if (resolveConnect) resolveConnect()
          continue
        }
        // Error greeting.
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          if (rejectConnect) rejectConnect(new Error(`unexpected server greeting: ${line.slice(0, 80)}`))
          if (this.socket) this.socket.destroy()
          return
        }
        if (parsed.error && rejectConnect) {
          rejectConnect(new Error(`auth: ${parsed.error.code} ${parsed.error.message}`))
        }
        if (this.socket) this.socket.destroy()
        return
      }
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        process.stderr.write(`freya: malformed response: ${line}\n`)
        continue
      }
      const obj = parsed
      if (obj.method === 'event') {
        for (const listener of this.eventListeners) {
          listener({ method: obj.method, params: obj.params })
        }
        continue
      }
      if (obj.id === undefined) continue
      const waiter = this.waiters.get(String(obj.id))
      if (waiter === undefined) continue
      this.waiters.delete(String(obj.id))
      waiter({ jsonrpc: '2.0', id: String(obj.id), result: obj.result, error: obj.error })
    }
  }

  onClose(err) {
    if (err) process.stderr.write(`freya: connection closed: ${err.message}\n`)
    for (const waiter of this.waiters.values()) {
      waiter({ jsonrpc: '2.0', id: '?', error: { code: 'INTERNAL', message: 'connection closed' } })
    }
    this.waiters.clear()
    this.socket = null
  }

  request(method, params = {}, timeoutMs = 10_000) {
    const id = String(this.nextId++)
    const wire = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      if (this.socket === null) {
        reject(new Error('not connected'))
        return
      }
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`request timed out after ${timeoutMs}ms: ${method}`))
      }, timeoutMs)
      this.waiters.set(id, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
      this.socket.write(JSON.stringify(wire) + '\n')
    })
  }

  onEvent(listener) {
    this.eventListeners.add(listener)
  }
}

/* --------------------------------------------------------------- formatter */

function asText(method, result) {
  if (result === null || result === undefined) return ''
  const obj = result
  switch (method) {
    case 'protocol.version':
      return `${obj.protocolVersion}`
    case 'freya.status':
      return `ready: ${String(obj.ready)}\nstopAllActive: ${String(obj.stopAllActive)}`
    case 'freya.health':
      return `ok: ${String(obj.ok)}\nuptimeSec: ${String(obj.uptimeSec ?? '')}`
    case 'freya.focus':
      return `focused: ${String(obj.focused)}`
    case 'conversation.list': {
      const list = obj.conversations ?? []
      if (list.length === 0) return '(no conversations)'
      return list.map((c) => `${c.conversationId}  ${c.title}`).join('\n')
    }
    case 'conversation.create': {
      const out = obj
      const conv = out.conversation?.conversation ?? out.conversation
      return `created ${conv?.conversationId ?? '?'}  ${conv?.title ?? ''}`
    }
    case 'conversation.get': {
      const out = obj
      if (!out.found) return '(not found)'
      return `title: ${out.summary?.title ?? ''}\nisActive: ${String(out.isActive ?? false)}\nmessages: ${String(out.messages?.length ?? 0)}`
    }
    case 'browser.status':
      return `available: ${String(obj.available)}\ntabCount: ${String(obj.tabCount)}\nactiveTabId: ${String(obj.activeTabId)}\nreason: ${String(obj.reason ?? '')}`
    case 'browser.tabs': {
      const tabs = obj.tabs ?? []
      if (tabs.length === 0) return '(no tabs)'
      return tabs.map((t) => `${t.tabId}  ${t.title ?? ''}  ${t.liveUrl ?? ''}`).join('\n')
    }
    case 'browser.open':
    case 'browser.activate': {
      const out = obj
      if (out.ok) return `ok${out.tabId !== undefined ? `  ${out.tabId}` : ''}`
      return `denied: ${out.reason ?? ''}`
    }
    case 'mission.list': {
      const list = obj.missions ?? []
      if (list.length === 0) return '(no missions)'
      return list.map((m) => `${m.missionId}  ${m.title}  ${m.status}`).join('\n')
    }
    case 'mission.get': {
      const out = obj
      if (!out.found) return '(not found)'
      return `${out.mission?.missionId}  ${out.mission?.title}  ${out.mission?.status}`
    }
    case 'agent.list': {
      const list = obj.agents ?? []
      if (list.length === 0) return '(no agents)'
      return list.map((a) => `${a.workerId}  ${a.role}  ${a.state}`).join('\n')
    }
    case 'system.stopStatus':
      return `stopAllActive: ${String(obj.stopAllActive)}`
    case 'notification.send':
      return 'sent'
    default:
      return JSON.stringify(result, null, 2)
  }
}

function render(method, result) {
  return AS_JSON ? JSON.stringify(result, null, 2) : asText(method, result)
}

function renderError(err) {
  if (AS_JSON) return JSON.stringify({ error: err }, null, 2)
  return `error: ${err.code}  ${err.message}${err.detail ? `  (${err.detail})` : ''}`
}

function fail(message, code = 2) {
  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ error: { code: 'CLI', message } }, null, 2) + '\n')
  } else {
    process.stderr.write(`freya: ${message}\n`)
  }
  process.exit(code)
}

const USAGE = `freya — control the Freya you are looking at

  status                                  show the current core status
  health                                  short health summary
  focus                                   focus the Freya window
  chats     | conversation list          list conversations
  chat      | conversation get <id>      show a conversation
  chat new  | conversation create <title> create a conversation
  send      | conversation send <id> <text>  send a turn to a conversation
  browser status                          browser service status
  browser tabs                            list open tabs
  browser open <url>                      open a tab
  browser activate <tabId>                focus a tab
  missions   | mission list               list missions
  mission    | mission get <id>           show a mission
  agents                                  list running agents
  notify <text>                          surface a notification in the shell
  stop-status                            is STOP ALL latched?
  --json                                 emit machine-readable JSON
`

/* --------------------------------------------------------------- dispatcher */

async function main() {
  if (COMMAND === 'help' || COMMAND === '--help' || COMMAND === '-h') {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const endpoint = readEndpoint()
  if (endpoint === null) {
    fail('Freya is not running (no control.endpoint file in the user-data directory)', 3)
  }
  const token = readToken()
  if (token === null) {
    fail('Freya is running but no control token file was found in the user-data directory', 3)
  }

  const client = new Client()
  try {
    await client.connect(endpoint, token)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    fail(`could not connect to ${endpoint.endpoint}: ${message}`, 4)
  }

  try {
    const method = resolveMethod(COMMAND, FILTERED)
    if (method === null) {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    const params = resolveParams(method, FILTERED)
    const response = await client.request(method, params)
    if (response.error !== undefined) {
      process.stderr.write(renderError(response.error) + '\n')
      process.exit(response.error.code === 'STOP_ALL_ACTIVE' ? 0 : 5)
    }
    process.stdout.write(render(method, response.result) + '\n')
  } finally {
    process.exit(0)
  }
}

function resolveMethod(command, argv) {
  switch (command) {
    case 'status':
      return 'freya.status'
    case 'health':
      return 'freya.health'
    case 'focus':
      return 'freya.focus'
    case 'chats':
    case 'conversations':
    case 'conversation':
    case 'chat': {
      const sub = argv[1]
      if (sub === 'list' || sub === undefined) return 'conversation.list'
      if (sub === 'get') return 'conversation.get'
      if (sub === 'new' || sub === 'create') return 'conversation.create'
      return null
    }
    case 'send':
      return 'conversation.send'
    case 'browser': {
      const sub = argv[1]
      if (sub === 'status' || sub === undefined) return 'browser.status'
      if (sub === 'tabs') return 'browser.tabs'
      if (sub === 'open') return 'browser.open'
      if (sub === 'activate') return 'browser.activate'
      return null
    }
    case 'missions':
    case 'mission': {
      const sub = argv[1]
      if (sub === 'list' || sub === undefined) return 'mission.list'
      if (sub === 'get') return 'mission.get'
      return null
    }
    case 'agents':
    case 'agent':
      return 'agent.list'
    case 'notify':
    case 'notification':
      return 'notification.send'
    case 'stop-status':
    case 'stopStatus':
    case 'stop':
      return 'system.stopStatus'
    default:
      return null
  }
}

function resolveParams(method, argv) {
  switch (method) {
    case 'conversation.create':
      return { title: argv[2] ?? 'New conversation' }
    case 'conversation.get':
      return { conversationId: argv[2] ?? '' }
    case 'conversation.send': {
      const idIndex = argv[1] === 'conversation' || argv[1] === 'conv' ? 2 : 1
      const id = argv[idIndex]
      const text = argv.slice(idIndex + 1).join(' ')
      return { conversationId: id ?? '', text }
    }
    case 'browser.open':
      return { url: argv[2] ?? '' }
    case 'browser.activate':
      return { tabId: argv[2] ?? '' }
    case 'mission.get':
      return { missionId: argv[2] ?? '' }
    case 'notification.send':
      return { text: argv.slice(1).join(' ') }
    default:
      return {}
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  fail(message, 1)
})
