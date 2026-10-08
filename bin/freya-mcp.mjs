#!/usr/bin/env node
/**
 * The Freya MCP adapter.
 *
 * Reads MCP requests on stdin, writes MCP responses on stdout, and is a thin
 * adapter over the same authenticated local channel the CLI uses. There is no
 * second authority: every MCP tool is one round-trip to the control service,
 * and the service enforces the same STOP ALL gate the renderer would.
 *
 * The advertised tools mirror the CLI subcommands one-to-one, so a host that
 * learns the CLI does not need a second vocabulary to drive Freya from MCP.
 * Tools that are read-only and non-sensitive are also exposed as resources
 * (the same shape the MCP Apps spec uses), so a host that prefers resources
 * over tools can use those.
 *
 * Configuration for an MCP host:
 *
 *   {
 *     "mcpServers": {
 *       "freya": {
 *         "command": "node",
 *         "args": ["C:/path/to/Freya-ui/bin/freya-mcp.mjs"]
 *       }
 *     }
 *   }
 */

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/* --------------------------------------------------------------- locations */

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
    return {
      endpoint: parsed.endpoint,
      socketPath: process.platform === 'win32' ? undefined : parsed.endpoint.replace(/^unix:/, ''),
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

/* --------------------------------------------------------------- transport */

class FreyaClient {
  constructor() {
    this.socket = null
    this.buffer = ''
    this.waiters = new Map()
    this.nextId = 1
    this.greeted = false
  }

  async connect() {
    const endpoint = readEndpoint()
    if (endpoint === null) throw new Error('Freya is not running')
    const token = readToken()
    if (token === null) throw new Error('Freya has no control token file in its user-data directory')
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
        socket.write(`AUTH ${token} mcp\n`)
      })
      socket.on('data', (chunk) => this.onData(chunk))
      socket.on('error', (err) => {
        process.stderr.write(`[freya-mcp] socket error: ${err.message}\n`)
      })
      const onGreeting = (chunk) => {
        const firstLine = chunk.split('\n', 1)[0] ?? ''
        if (firstLine === 'OK') {
          socket.off('data', onGreeting)
          this.greeted = true
          resolve()
          return
        }
        try {
          const parsed = JSON.parse(firstLine)
          if (parsed.error) {
            reject(new Error(`auth: ${parsed.error.code} ${parsed.error.message}`))
            socket.destroy()
            return
          }
        } catch {
          // not OK, not JSON error
        }
        reject(new Error(`unexpected server greeting: ${chunk.slice(0, 80)}`))
        socket.destroy()
      }
      socket.on('data', onGreeting)
    })
  }

  onData(chunk) {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.length === 0) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const obj = parsed
      if (obj.id === undefined) continue
      const waiter = this.waiters.get(String(obj.id))
      if (waiter === undefined) continue
      this.waiters.delete(String(obj.id))
      waiter({ jsonrpc: '2.0', id: String(obj.id), result: obj.result, error: obj.error })
    }
  }

  async request(method, params = {}, timeoutMs = 10_000) {
    const id = String(this.nextId++)
    const wire = { jsonrpc: '2.0', id, method, params }
    if (this.socket === null) {
      return { jsonrpc: '2.0', id, error: { code: 'INTERNAL', message: 'not connected' } }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        resolve({ jsonrpc: '2.0', id, error: { code: 'TIMEOUT', message: `${method} timed out after ${timeoutMs}ms` } })
      }, timeoutMs)
      this.waiters.set(id, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
      this.socket.write(JSON.stringify(wire) + '\n')
    })
  }
}

/* --------------------------------------------------------------- tool table */

const TOOLS = [
  { name: 'freya_status', description: 'Read the current Core status, browser status, and STOP-ALL latch.', method: 'freya.status', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'freya_health', description: 'Short health summary: ok flag, uptime, and Core lifecycle.', method: 'freya.health', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'freya_focus', description: 'Focus the Freya main window. Returns true on success.', method: 'freya.focus', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'conversation_list', description: 'List conversations in the workspace.', method: 'conversation.list', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'conversation_get', description: 'Get one conversation by id, including the active transcript.', method: 'conversation.get', inputSchema: { type: 'object', properties: { conversationId: { type: 'string' } }, required: ['conversationId'], additionalProperties: false } },
  { name: 'conversation_create', description: 'Create a new conversation with a title. Returns the new id.', method: 'conversation.create', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: [], additionalProperties: false } },
  { name: 'conversation_send', description: 'Send a user turn to a conversation. Subject to STOP ALL.', method: 'conversation.send', inputSchema: { type: 'object', properties: { conversationId: { type: 'string' }, text: { type: 'string' } }, required: ['conversationId', 'text'], additionalProperties: false } },
  { name: 'browser_status', description: 'Browser Service status: available, tab count, active tab.', method: 'browser.status', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_tabs', description: 'List the browser tabs Freya currently has open.', method: 'browser.tabs', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_open', description: 'Open a new tab. Subject to STOP ALL and to the same URL policy Freya uses internally.', method: 'browser.open', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_activate', description: 'Bring a tab to the front. Subject to STOP ALL.', method: 'browser.activate', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'], additionalProperties: false } },
  { name: 'mission_list', description: 'List missions in the workspace.', method: 'mission.list', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'mission_get', description: 'Get a mission by id.', method: 'mission.get', inputSchema: { type: 'object', properties: { missionId: { type: 'string' } }, required: ['missionId'], additionalProperties: false } },
  { name: 'agent_list', description: 'List running agents (workforce projection).', method: 'agent.list', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'notification_send', description: 'Surface a notification in the Freya shell. Subject to STOP ALL.', method: 'notification.send', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'stop_status', description: 'Is STOP ALL latched right now? Always readable, even during STOP ALL.', method: 'system.stopStatus', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]

/* --------------------------------------------------------------- MCP I/O */

function writeMcp(response) {
  process.stdout.write(JSON.stringify(response) + '\n')
}

const client = new FreyaClient()

async function handleInitialize(req) {
  try {
    await client.connect()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32000, message: `cannot reach Freya: ${message}` } }
  }
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'freya', version: '0.1.0' },
    },
  }
}

function handleListTools(req) {
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
  }
}

async function handleCallTool(req) {
  const params = req.params ?? {}
  const name = params.name
  const args = params.arguments ?? {}
  const tool = TOOLS.find((t) => t.name === name)
  if (tool === undefined) {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: `unknown tool: ${name ?? ''}` } }
  }
  const response = await client.request(tool.method, args)
  if (response.error !== undefined) {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: { isError: true, content: [{ type: 'text', text: `${response.error.code}: ${response.error.message}` }] },
    }
  }
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    result: { content: [{ type: 'text', text: JSON.stringify(response.result, null, 2) }] },
  }
}

function handleListResources(req) {
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    result: {
      resources: [
        { uri: 'freya://status', name: 'Freya status', description: 'Core status, browser status, STOP-ALL latch', mimeType: 'application/json' },
        { uri: 'freya://health', name: 'Freya health', description: 'Short health summary', mimeType: 'application/json' },
        { uri: 'freya://chats', name: 'Freya conversations', description: 'List of conversations', mimeType: 'application/json' },
        { uri: 'freya://browser/tabs', name: 'Freya browser tabs', description: 'Open browser tabs', mimeType: 'application/json' },
        { uri: 'freya://stop', name: 'STOP ALL status', description: 'Whether STOP ALL is latched', mimeType: 'application/json' },
      ],
    },
  }
}

async function handleReadResource(req) {
  const params = req.params ?? {}
  const uri = params.uri
  const map = {
    'freya://status': 'freya.status',
    'freya://health': 'freya.health',
    'freya://chats': 'conversation.list',
    'freya://browser/tabs': 'browser.tabs',
    'freya://stop': 'system.stopStatus',
  }
  const method = uri === undefined ? undefined : map[uri]
  if (method === undefined) {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: `unknown resource: ${uri ?? ''}` } }
  }
  const response = await client.request(method)
  if (response.error !== undefined) {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32000, message: `${response.error.code}: ${response.error.message}` } }
  }
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    result: { contents: [{ uri: uri, mimeType: 'application/json', text: JSON.stringify(response.result, null, 2) }] },
  }
}

async function handle(req) {
  switch (req.method) {
    case 'initialize':
      return await handleInitialize(req)
    case 'notifications/initialized':
      return null
    case 'tools/list':
      return handleListTools(req)
    case 'tools/call':
      return await handleCallTool(req)
    case 'resources/list':
      return handleListResources(req)
    case 'resources/read':
      return await handleReadResource(req)
    case 'ping':
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} }
    default:
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `unknown method: ${req.method}` } }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (line.trim().length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      writeMcp({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    void handle(parsed).then((response) => {
      if (response !== null) writeMcp(response)
    })
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
