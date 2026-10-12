// @vitest-environment node
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
  it('lets text-only MiniMax read a PDF attachment without sending binary file parts', async () => {
    let body = ''
    const provider = new CompatibleModelProvider('minimax', {
      apiKey: 'test-key', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3', liveEnabled: true, vision: false,
    }, async (_url, init) => {
      body = String(init?.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Read the CV.' } }] }))
    })
    const data = pdfFixture('SQL analyst with five years of experience').toString('base64')
    await provider.complete({ requestId: 'pdf', model: 'MiniMax-M3', prompt: 'Read my CV', maxOutputTokens: 100,
      messages: [{ role: 'user', content: 'Read my CV', attachments: [{ type: 'file', mimeType: 'application/pdf', data, filename: 'cv.pdf' }] }],
    }, { signal: new AbortController().signal })
    expect(body).toContain('SQL analyst with five years of experience')
    expect(body).toContain('cv.pdf')
    expect(body).not.toContain(data)
    expect(body).not.toContain('image_url')
  })

  it('reports a PDF without readable text before contacting MiniMax', async () => {
    let contacted = false
    const provider = new CompatibleModelProvider('minimax', {
      apiKey: 'test-key', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3', liveEnabled: true, vision: false,
    }, async () => { contacted = true; return new Response('{}') })
    await expect(provider.complete({ requestId: 'scan', model: 'MiniMax-M3', prompt: 'Read my CV', maxOutputTokens: 100,
      messages: [{ role: 'user', content: 'Read my CV', attachments: [{ type: 'file', mimeType: 'application/pdf', data: pdfFixture(null).toString('base64'), filename: 'scan.pdf' }] }],
    }, { signal: new AbortController().signal })).rejects.toThrow(/no readable text layer/i)
    expect(contacted).toBe(false)
  })

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

  it('sends reasoning_split for minimax and wraps reasoning_content into think tags', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Paris is the capital of France.',
                reasoning_content: 'The user is asking about the capital of France. That is Paris.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 35 },
        }),
      } as unknown as Response
    }

    const provider = new CompatibleModelProvider(
      'minimax',
      { apiKey: 'test-key', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3', liveEnabled: true, vision: false },
      fetchImpl,
    )

    const request: ModelRequest = {
      requestId: 'req-2',
      model: 'MiniMax-M3',
      prompt: 'Capital of France?',
      messages: [{ role: 'user', content: 'Capital of France?' }],
      maxOutputTokens: 200,
    }

    const outcome = await provider.complete(request, { signal: new AbortController().signal })
    expect(capturedBody.reasoning_split).toBe(true)
    // The provider cannot override the output token ceiling approved by Core.
    expect(capturedBody.max_tokens).toBe(request.maxOutputTokens)
    expect(outcome.text).toContain('<think>\nThe user is asking about the capital of France. That is Paris.\n</think>')
    expect(outcome.text).toContain('Paris is the capital of France.')
    expect(outcome.finishReason).toBe('stop')
  })
})

/** Small valid PDF with either text or a drawn rectangle, independent of private user files. */
function pdfFixture(text: string | null): Buffer {
  const stream = text === null ? '72 72 100 100 re f' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
