// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../../../core'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import type { ModelRequest } from '../../../core/model/provider'
import { ContextIntegration } from '../../../core/context/coreIntegration'
import type { ContextScope } from '../../../core/context/types'

const SECRET = 'PRIVATE_CONTEXT_SENTINEL_47'
const KEY = new Uint8Array(32).fill(47)
const SCOPE = { scopeKind: 'conversation', scopeId: 'shared-conversation' } as const
let dir: string
let clock: Date
let core: Core
let requests: ModelRequest[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-p9-assembly-'))
  clock = new Date('2026-10-02T09:00:00Z')
  requests = []
})
afterEach(async () => {
  await core?.stop()
  await rm(dir, { recursive: true, force: true })
})

async function boot(key: Uint8Array | null = KEY): Promise<Core> {
  const provider = new FakeModelProvider()
  vi.spyOn(provider, 'complete').mockImplementation(async (request) => {
    requests.push(request)
    return { requestId: request.requestId, providerId: provider.id, model: provider.model,
      text: 'offline answer', inputTokens: 1, outputTokens: 1 }
  })
  core = createCore({ dataPath: join(dir, 'events.jsonl'), contextKey: key,
    providers: [provider], now: () => new Date(clock) } as CoreOptions)
  await core.start()
  return core
}
async function send(command: string, payload?: unknown) {
  return core.handleCommand({ command, requestId: `r-${command}`, payload } as never)
}
async function share(content = SECRET, scope: ContextScope = SCOPE, ttlMs = 60_000) {
  await send('context.scope.activate', { scope })
  const result = await send('context.admit', {
    kind: 'explicit_selection', channel: 'owner_selection', scope, content, ttlMs,
  })
  expect(result.context?.operation).toBe('admitted')
  return result.context!.contextId!
}

describe('production Context persistence', () => {
  it('pushes degraded health when a passive expiry write fails', async () => {
    await boot()
    await share(SECRET, SCOPE, 1_000)
    const seen: boolean[] = []
    core.onContext((view) => seen.push(view.persistence.durable))
    const path = join(dir, 'events.jsonl.context.enc')
    await rm(path)
    await mkdir(path)
    clock = new Date(clock.getTime() + 2_000)
    core.context()
    await vi.waitFor(() => expect(seen.at(-1)).toBe(false), { timeout: 1_000 })
    expect(core.context().persistence.reason).not.toContain(SECRET)
  })

  it('retires recovered window observations before readers see stale capture', async () => {
    await boot()
    const lane = core.contextWindowLane(SCOPE)
    expect(lane.admitHostReport({ kind: 'active_window', scope: SCOPE, originId: 'host:one',
      content: 'RECOVERED_PRIVATE_TITLE', ttlMs: 120_000 }).ok).toBe(true)
    await core.stop()
    await boot()
    await send('context.scope.activate', { scope: SCOPE })
    expect(core.context().items).toEqual([expect.objectContaining({ kind: 'active_window', state: 'revoked' })])
    expect(requests).toHaveLength(0)
  })

  it('withdraws recovered Mission context when the authoritative Mission journal is absent', async () => {
    await boot()
    const created = await send('mission.create', { title: 'Finish the document', intent: 'have it reviewed' })
    const missionId = (created.mission as { missionId: string }).missionId
    expect((await send('mission.activate', { missionId })).ok).toBe(true)
    await send('context.scope.activate', { scope: SCOPE })
    expect(core.context().items).toEqual([expect.objectContaining({ kind: 'current_mission', state: 'live' })])
    await core.stop()
    // Context is data, never a substitute for the authoritative Mission journal.
    await writeFile(join(dir, 'events.jsonl'), '')
    await boot()
    await send('context.scope.activate', { scope: SCOPE })
    expect(core.context().items).toEqual([expect.objectContaining({ kind: 'current_mission', state: 'revoked' })])
  })

  it('encrypts before acknowledging admission and restores scoped records on restart', async () => {
    await boot()
    expect(core.context().persistence).toMatchObject({ mode: 'encrypted', durable: true, reason: null })
    const id = await share()
    const bytes = await readFile(join(dir, 'events.jsonl.context.enc'), 'utf8')
    expect(bytes).not.toContain(SECRET)
    await core.stop()
    await boot()
    expect(core.context().activeScope).toBeNull()
    expect(core.context().items).toEqual([])
    await send('context.scope.activate', { scope: SCOPE })
    expect(core.context().items).toEqual([expect.objectContaining({ contextId: id, state: 'live' })])
    const resolved = await send('context.reference.read', { term: 'this' })
    expect(resolved.context).toMatchObject({ operation: 'resolved', contextId: id })
    expect(requests).toHaveLength(0)
  })

  it('recovers revocation and expiry without presenting either as live', async () => {
    await boot()
    const revoked = await share(SECRET)
    await send('context.revoke', { contextId: revoked, reason: SECRET })
    const expired = await share('EXPIRING_PRIVATE', SCOPE, 1_000)
    await core.stop()
    clock = new Date(clock.getTime() + 2_000)
    await boot()
    await send('context.scope.activate', { scope: SCOPE })
    expect(core.context().items).toHaveLength(2)
    expect(core.context().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ contextId: revoked, state: 'revoked' }),
      expect.objectContaining({ contextId: expired, state: 'expired' }),
    ]))
    expect(JSON.stringify(core.context())).not.toContain(SECRET)
    expect(core.context().counts.live).toBe(0)
  })

  it('uses explicit ephemeral mode with no plaintext fallback when no key exists', async () => {
    await boot(null)
    await share()
    expect(core.context().persistence).toMatchObject({ mode: 'ephemeral', durable: false })
    expect(core.context().persistence.reason).toMatch(/secure Context key/)
    expect(existsSync(join(dir, 'events.jsonl.context.enc'))).toBe(false)
    await core.stop()
    await boot(null)
    await send('context.scope.activate', { scope: SCOPE })
    expect(core.context().items).toEqual([])
  })

  it('keeps damaged ciphertext intact and leaves unrelated Core available', async () => {
    await boot()
    await share()
    await core.stop()
    const path = join(dir, 'events.jsonl.context.enc')
    await writeFile(path, 'damaged encrypted Context')
    await boot()
    expect(core.context().persistence.durable).toBe(false)
    expect(core.context().persistence.reason).not.toBeNull()
    await share('new process-only context')
    expect(await readFile(path, 'utf8')).toBe('damaged encrypted Context')
    expect((await send('conversation.create')).ok).toBe(true)
  })
})

describe('production Context in the actual Mind packet', () => {
  it('uses the actual conversation scope even when another scope is active', async () => {
    await boot()
    const created = await send('conversation.create')
    const conversationId = (created.conversation as { conversation: { conversationId: string } }).conversation.conversationId
    const actual = { scopeKind: 'conversation', scopeId: conversationId } as const
    await share(SECRET, actual)
    await share('FOREIGN_PRIVATE_CONTEXT', SCOPE)
    expect(requests).toHaveLength(0)
    await send('conversation.turn.submit', { conversationId, text: 'Explain this.' })
    expect(requests).toHaveLength(1)
    const packet = requests[0]!
    const block = packet.messages.find((m) => m.content.includes(SECRET))
    expect(block?.role).toBe('user')
    expect(JSON.stringify(packet)).not.toContain('FOREIGN_PRIVATE_CONTEXT')
    expect(packet.messages.filter((m) => m.role === 'system').map((m) => m.content).join('')).not.toContain(SECRET)
    expect(JSON.stringify(core.context())).not.toContain(SECRET)
    expect(JSON.stringify(core.activity())).not.toContain(SECRET)
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain(SECRET)
  })

  it('preserves ambiguity and excludes revoked and expired words on real turns', async () => {
    await boot()
    const created = await send('conversation.create')
    const conversationId = (created.conversation as { conversation: { conversationId: string } }).conversation.conversationId
    const scope = { scopeKind: 'conversation', scopeId: conversationId } as const
    const first = await share('REVOKED_PRIVATE', scope)
    await send('context.revoke', { contextId: first, reason: 'withdrawn' })
    await share('EXPIRED_PRIVATE', scope, 1_000)
    clock = new Date(clock.getTime() + 2_000)
    await share('live one', scope)
    await share('live two', scope)
    await send('conversation.turn.submit', { conversationId, text: 'Explain this.' })
    const packet = JSON.stringify(requests[0])
    expect(packet).toContain('is unresolved:')
    expect(packet).not.toContain('resolves to shared context')
    expect(packet).not.toContain('REVOKED_PRIVATE')
    expect(packet).not.toContain('EXPIRED_PRIVATE')
    expect(requests).toHaveLength(1)
  })
})


describe('scoped Context reader boundary', () => {
  it('cannot list private records from a different scope before compilation', () => {
    const integration = new ContextIntegration({ now: () => clock })
    const foreign = { scopeKind: 'conversation', scopeId: 'foreign' } as const
    for (const scope of [SCOPE, foreign]) {
      integration.activateScope(scope)
      integration.admit({ kind: 'explicit_selection', channel: 'owner_selection', scope,
        content: scope === foreign ? 'FOREIGN_PRIVATE_READER' : SECRET })
    }
    const source = integration.turnSource(SCOPE)
    expect(source.list(clock)).toHaveLength(1)
    expect(JSON.stringify(source.list(clock))).not.toContain('FOREIGN_PRIVATE_READER')
  })
})
