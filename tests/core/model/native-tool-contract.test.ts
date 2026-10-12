// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { CompatibleModelProvider } from '../../../core/model/compatible-provider'
import type { ModelRequest } from '../../../core/model/provider'

describe('native tool transport', () => {
  it('carries definitions and native-only replies with correlated call IDs', async () => {
    let body: Record<string, unknown> = {}
    const provider = new CompatibleModelProvider('minimax', {
      apiKey: 'test-key', baseUrl: 'https://api.minimax.io', model: 'MiniMax-M3', liveEnabled: true, vision: false,
    }, async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: 'reasoning', tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'measure', arguments: '{"item":"bolt"}' } },
      ] }, finish_reason: 'tool_calls' }] }))
    })
    const request = { requestId: 'r', model: null, prompt: 'Measure', maxOutputTokens: 128,
      messages: [{ role: 'user', content: 'Measure' }],
      tools: [{ name: 'measure', description: 'Measure an item', parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } }],
    } as ModelRequest
    const result = await provider.complete(request, { signal: new AbortController().signal })
    expect(body.tools).toEqual([{ type: 'function', function: request.tools![0] }])
    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'measure', arguments: '{"item":"bolt"}' }])
    expect(result.reasoningContent).toBe('reasoning')
  })

  it('replays assistant reasoning and structured tool results without losing correlation', async () => {
    let body: { messages: unknown[] } | undefined
    const provider = new CompatibleModelProvider('minimax', {
      apiKey: 'test-key', baseUrl: 'https://api.minimax.io', model: 'MiniMax-M3', liveEnabled: true, vision: false,
    }, async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Measured' }, finish_reason: 'stop' }] }))
    })
    await provider.complete({ requestId: 'r', model: null, prompt: '', maxOutputTokens: 128, messages: [
      { role: 'assistant', content: '', reasoningContent: 'kept', toolCalls: [{ id: 'a', name: 'measure', arguments: '{}' }] },
      { role: 'tool', content: '{"kind":"failed"}', toolCallId: 'a' },
    ] } as ModelRequest, { signal: new AbortController().signal })
    expect(body?.messages).toEqual([
      { role: 'assistant', content: '', reasoning_content: 'kept', tool_calls: [{ id: 'a', type: 'function', function: { name: 'measure', arguments: '{}' } }] },
      { role: 'tool', content: '{"kind":"failed"}', tool_call_id: 'a' },
    ])
  })

  it('reports malformed native calls rather than treating empty content as completion', async () => {
    const provider = new CompatibleModelProvider('openai', {
      apiKey: 'test-key', baseUrl: 'https://api.openai.com', model: 'test-model', liveEnabled: true, vision: false,
    }, async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'measure' } }] }, finish_reason: 'tool_calls' }] })))
    const result = await provider.complete({ requestId: 'r', model: null, prompt: '', maxOutputTokens: 128, messages: [] }, { signal: new AbortController().signal })
    expect(result.toolCallError).toBeTruthy()
    expect(result.toolCalls).toBeUndefined()
  })
})
