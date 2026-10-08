// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeDiagnostics } from '../../core/runtime/diagnostics'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'freya-diagnostics-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('redacts credentials in exception summaries and structured details', async () => {
  const path = join(dir, 'runtime.jsonl')
  const diagnostics = new RuntimeDiagnostics(path)
  diagnostics.recordError('provider', 'failed', new Error('Authorization: Bearer private-token'), 'provider failed',
    { apiKey: 'private-key', nested: { token: 'private-nested' }, prompt: 'private prompt', requestId: 'r1' })
  const raw = await readFile(path, 'utf8')
  expect(raw).not.toContain('private-token')
  expect(raw).not.toContain('private-key')
  expect(raw).not.toContain('private-nested')
  expect(raw).not.toContain('private prompt')
  expect(JSON.parse(raw)).toMatchObject({ component: 'provider', event: 'failed', detail: { requestId: 'r1' } })
  diagnostics.recordError('provider', 'response_failed', new Error('reflected private response and unlabeled-key'), 'provider response failed')
  expect(await readFile(path, 'utf8')).not.toContain('reflected private response')
  expect(await readFile(path, 'utf8')).not.toContain('unlabeled-key')
  diagnostics.recordError('provider', 'multiline_failed', new Error('failed\n    at PRIVATE_PROMPT'), 'provider failed')
  const injected = new Error('failed')
  injected.stack = 'Error: failed\n    at PRIVATE_RESPONSE'
  injected.name = 'PRIVATE_NAMEError'
  diagnostics.recordError('provider', 'custom_stack_failed', injected, 'provider failed')
  expect(await readFile(path, 'utf8')).not.toContain('PRIVATE_PROMPT')
  expect(await readFile(path, 'utf8')).not.toContain('PRIVATE_RESPONSE')
  expect(await readFile(path, 'utf8')).not.toContain('PRIVATE_NAME')
})

it('reports diagnostics initialization failures without throwing', async () => {
  const blocked = join(dir, 'file')
  await writeFile(blocked, 'occupied')
  const diagnostics = new RuntimeDiagnostics(join(blocked, 'nested', 'runtime.jsonl'))
  diagnostics.recordError('core', 'failed', new Error('failure'), 'failure')
  expect(diagnostics.failureCount).toBeGreaterThan(0)
})
