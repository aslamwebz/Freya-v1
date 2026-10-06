// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCore, type Core } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import type { ModelCallOptions, ModelRequest } from '../../../core/model/provider'
import { voiceOptions } from '../voice/fixture'

class InspectProvider extends FakeModelProvider {
  requests: ModelRequest[] = []
  override async complete(request: ModelRequest, options: ModelCallOptions) {
    this.requests.push(request)
    return super.complete(request, options)
  }
}
let core: Core
let directory = ''
let provider: InspectProvider
let conversationId = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-file-turn-'))
  provider = new InspectProvider()
  core = createCore(voiceOptions(directory, { providers: [provider] }))
  await core.start()
  const created = await core.handleCommand({ command: 'conversation.create', requestId: 'new' })
  if (created.conversation?.operation !== 'created') throw new Error('Conversation refused')
  conversationId = created.conversation.conversation.conversationId
})
afterEach(async () => { await core.stop('test'); await rm(directory, { recursive: true, force: true }) })

it('carries the PDF bytes to the real canonical provider packet without pasting its content', async () => {
  const pdf = { type: 'file', mimeType: 'application/pdf', filename: 'fixture.pdf', data: Buffer.from('%PDF-1.4\nfixture').toString('base64') }
  await core.handleCommand({ command: 'conversation.turn.submit', requestId: 'file', payload: { conversationId, text: 'Read this PDF.', attachments: [pdf] } })
  expect(provider.requests).toHaveLength(1)
  const message = provider.requests[0]!.messages.find(m => m.content === 'Read this PDF.')
  expect(message?.attachments).toEqual([pdf])
  expect(provider.requests[0]!.prompt).not.toContain(pdf.data)
  expect((await core.conversation()).messages[0]?.content).toBe('Read this PDF.')
})

it('refuses malformed attachments before a provider call or stored user message', async () => {
  const result = await core.handleCommand({ command: 'conversation.turn.submit', requestId: 'bad', payload: { conversationId, text: 'Read this.', attachments: [{ type: 'file', mimeType: 'application/pdf', filename: 'bad.pdf', data: 'not base64!' }] } })
  expect(result.ok).toBe(false)
  expect(provider.requests).toHaveLength(0)
  expect((await core.conversation()).messages).toEqual([])
})
