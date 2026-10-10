import { describe, it, expect } from 'vitest'
import { cleanProviderCompletion, CompatibleModelProvider } from '../../../core/model/compatible-provider'
import type { ModelRequest } from '../../../core/model/provider'

describe('cleanProviderCompletion', () => {
  it('preserves genuine model answers without modification', () => {
    const raw = 'Grace is a chef, and her hobby is running marathons.'
    const result = cleanProviderCompletion(raw)
    expect(result.corrupted).toBe(false)
    expect(result.text).toBe(raw)
  })

  it('redacts configured api keys from response text', () => {
    const key = 'secret-test-api-key-12345'
    const raw = `I am using ${key} to authenticate.`
    const result = cleanProviderCompletion(raw, key)
    expect(result.text).toBe('I am using [redacted] to authenticate.')
    expect(result.corrupted).toBe(false)
  })

  it('strips multimodal hallucination lines (VTTEmbedded)', () => {
    const raw = [
      "I'll open the page and then snapshot it.]<]minimax[>[",
      'VTTEmbedded_note: There are no embedded video or audio files in this turn.',
      ']<]minimax[>[',
      'VTTEmbedded_note: Video and audio files are not relevant to this game.',
      'VTTEmbedded:',
    ].join('\n')
    const result = cleanProviderCompletion(raw)
    expect(result.corrupted).toBe(false)
    expect(result.text).toBe("I'll open the page and then snapshot it.")
  })

  it('detects and truncates autoregressive repetition loops while preserving valid prefix', () => {
    const loopSegment = ']<]minimax[>[ya ism]'
    const raw = `The page is open in the tab but I can't navigate to it fresh. Let me screenshot the open tab instead.${loopSegment.repeat(20)}`
    const result = cleanProviderCompletion(raw)
    expect(result.corrupted).toBe(false)
    expect(result.text).toBe("The page is open in the tab but I can't navigate to it fresh. Let me screenshot the open tab instead.")
  })

  it('rejects completions that are purely repetitive degeneration loops', () => {
    const loopSegment = ']<]minimax[>[ya ism]'
    const raw = loopSegment.repeat(15)
    const result = cleanProviderCompletion(raw)
    expect(result.corrupted).toBe(true)
    expect(result.reason).toContain('repetitive protocol loop')
  })

  it('strips dangling delimiter tokens when no tool envelope is present', () => {
    const raw = 'Here is the summary.]<]minimax[>[ya ism]'
    const result = cleanProviderCompletion(raw)
    expect(result.corrupted).toBe(false)
    expect(result.text).toBe('Here is the summary.')
  })

  it('preserves active tool call envelopes for downstream parser', () => {
    const raw = 'I will open the tabs.]<]minimax[>[<tool_call>\n{"tool":"browser_tabs","op":"tabs"}\n</tool_call>'
    const result = cleanProviderCompletion(raw)
    expect(result.corrupted).toBe(false)
    expect(result.text).toContain('<tool_call>')
  })
})

describe('CompatibleModelProvider', () => {
  it('throws descriptive error on corrupted repetitive responses', async () => {
    const loop = ']<]minimax[>[ya ism]'.repeat(10)
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: loop }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 50 },
      }),
    }) as unknown as Response

    const provider = new CompatibleModelProvider(
      'minimax',
      { apiKey: 'test-key', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3', liveEnabled: true, vision: false },
      fetchImpl,
    )

    const request: ModelRequest = {
      requestId: 'req-1',
      model: 'MiniMax-M3',
      prompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 100,
    }

    await expect(provider.complete(request, { signal: new AbortController().signal })).rejects.toThrow(
      /Provider returned unreadable output/,
    )
  })

  it('returns cleaned text for valid responses with protocol artifacts', async () => {
    const content = `Valid analysis here.${']<]minimax[>[ya ism]'.repeat(10)}`
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    }) as unknown as Response

    const provider = new CompatibleModelProvider(
      'minimax',
      { apiKey: 'test-key', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3', liveEnabled: true, vision: false },
      fetchImpl,
    )

    const request: ModelRequest = {
      requestId: 'req-1',
      model: 'MiniMax-M3',
      prompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 100,
    }

    const outcome = await provider.complete(request, { signal: new AbortController().signal })
    expect(outcome.text).toBe('Valid analysis here.')
  })
})
