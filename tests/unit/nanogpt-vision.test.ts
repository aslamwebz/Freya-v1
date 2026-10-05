// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NanoGptProvider } from '../../core/model/nanogpt-provider'
import {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  ModelAttachmentError,
  attachmentByteLength,
  flattenMessages,
  validateModelAttachments,
  type ModelAttachment,
  type ModelMessage,
  type ModelRequest,
} from '../../core/model/provider'

/**
 * Image and PDF content on the NanoGPT lane.
 *
 * Four properties, and the order of them is the order of risk:
 *
 *   1. **Text-only is untouched.** A turn with no attachment must produce the
 *      exact request body it produced before attachments existed — asserted as a
 *      literal string, not as an object, because "the array happens to deep-equal
 *      the string it replaced" is not a property anybody has. This is the guard
 *      for the whole rest of the suite, so it is the first test here.
 *   2. **A payload serialises to the shape the endpoint was verified to accept**,
 *      and to no other: images as `image_url`, documents as `file`, in the order
 *      they were attached.
 *   3. **A bad attachment is refused locally, typed, and for nothing.** Every
 *      refusal happens before the transport is reached, so an over-large or
 *      disallowed attachment costs no money and produces no vague HTTP 400.
 *   4. **The provider's error body is no longer discarded** — and carrying a
 *      server's words into a thrown error is exactly where a reflected
 *      credential would leak, so that is asserted too.
 *
 * The transport is a recording fake in the style of `tests/core/nanogpt-chat.test.ts`
 * — same shape, same deliberate omission of `text()` on the fake `Response` — so
 * the provider is exercised exactly as the production path exercises it.
 */

const SECRET = 'sk-test-never-echoed-8f2b'
const BASE_URL = 'https://nano-gpt.com/api/v1'
const VISION_MODEL = 'meta/muse-spark-1.2-contributor'

/** A real 1x1 PNG, so the fixture is a genuine image and not the word "png". */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** What that PNG weighs once decoded — the number a flattened prompt reports. */
const PNG_BYTES = attachmentByteLength({ type: 'image', mimeType: 'image/png', data: PNG_1X1 })

/** A minimal PDF, base64'd. Only its shape matters to the validator. */
const PDF_STUB =
  'JVBERi0xLjQKJcTl8uXrCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCjAgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDMgMCBSL01lZGlhQm94IFswIDAgNTk1LjI3IDc5NS44MDBdL0NvbnRlbnRzIDQgMCBSL0NvdW50IDE+PgovUGFnaXMgMiAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQ+PnN0cmVhbQp4nQo0NyA3MiAKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4+CnN0YXJ0eHJlZgo0NzIKJUVSCg=='

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  /** The body exactly as it went out, so byte-identity is testable. */
  raw: string | undefined
}

interface Reply {
  ok: boolean
  status: number
  json: unknown
}

function reply(json: unknown, ok = true, status = 200): Reply {
  return { ok, status, json }
}

/**
 * A transport that records what left the process and answers as directed.
 *
 * The body is kept as a raw string as well as being parseable, because the
 * central claim of this file is about bytes and `JSON.parse` throws that away.
 * The fake `Response` deliberately offers `json` and not `text`, exactly as the
 * one in `nanogpt-chat.test.ts` does, so the provider cannot come to depend on a
 * `text()` that the established fakes do not have.
 */
function recordingFetch(
  replyWith: (call: RecordedCall, index: number) => Reply,
): { calls: RecordedCall[]; impl: typeof fetch } {
  const calls: RecordedCall[] = []
  const impl = (async (url: unknown, init?: RequestInit) => {
    const record: RecordedCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      raw: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(record)
    const answer = replyWith(record, calls.length - 1)
    return {
      ok: answer.ok,
      status: answer.status,
      json: async () => answer.json,
      headers: new Headers(),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { calls, impl }
}

function provider(fetchImpl: typeof fetch): NanoGptProvider {
  return new NanoGptProvider({
    config: { apiKey: SECRET, baseUrl: BASE_URL, model: VISION_MODEL, liveEnabled: true },
    fetchImpl,
  })
}

function requestOf(messages: readonly ModelMessage[]): ModelRequest {
  return {
    requestId: 'req-vision',
    messages,
    prompt: flattenMessages(messages),
    maxOutputTokens: 256,
    model: VISION_MODEL,
  }
}

/**
 * A request whose `prompt` is stated rather than derived.
 *
 * `flattenMessages` validates attachments too, so a request built through
 * `requestOf` would be refused by the flattener before `complete` ever ran — and
 * a test asserting "the provider refuses this" would then be passing on the
 * flattener's validation while appearing to test the provider's. This helper
 * removes that ambiguity so the provider's own boundary is what is under test.
 */
function requestWithPrompt(messages: readonly ModelMessage[]): ModelRequest {
  return { ...requestOf([{ role: 'user', content: 'a stated prompt' }]), messages }
}

/**
 * Send `messages` and report what came back, whether it was a rejection or a
 * synchronous throw.
 *
 * Capturing both matters here: a refusal raised while *building* the request is
 * still a refusal that spent nothing, and the interesting claim is always
 * `calls: 0`, not which of the two mechanisms reported it.
 */
async function attempt(messages: readonly ModelMessage[]): Promise<{
  error: unknown
  calls: RecordedCall[]
}> {
  const fake = recordingFetch(() => reply({}))
  let error: unknown = null
  try {
    await provider(fake.impl).complete(requestWithPrompt(messages), LIVE)
  } catch (thrown) {
    error = thrown
  }
  return { error, calls: fake.calls }
}

/** Never aborted, so a refusal under test is the code's, not the runner's. */
const LIVE = { signal: new AbortController().signal }

function bodyOf(call: RecordedCall): { messages: { role: string; content: unknown }[] } {
  return JSON.parse(call.raw ?? '{}') as { messages: { role: string; content: unknown }[] }
}

async function send(messages: readonly ModelMessage[]): Promise<RecordedCall> {
  const fake = recordingFetch(() => reply({ model: VISION_MODEL, choices: [{ message: { content: 'ok' } }] }))
  await provider(fake.impl).complete(requestOf(messages), LIVE)
  expect(fake.calls).toHaveLength(1)
  return fake.calls[0]!
}

function image(data = PNG_1X1, filename?: string): ModelAttachment {
  return {
    type: 'image',
    mimeType: 'image/png',
    data,
    ...(filename === undefined ? {} : { filename }),
  }
}

function pdf(data = PDF_STUB, filename = 'report.pdf'): ModelAttachment {
  return { type: 'file', mimeType: 'application/pdf', data, filename }
}

function user(text: string, attachments?: readonly ModelAttachment[]): ModelMessage {
  return { role: 'user', content: text, ...(attachments === undefined ? {} : { attachments }) }
}

// ---------------------------------------------------------------------------------------------
// 1. Text-only turns are byte-identical to before this existed.
// ---------------------------------------------------------------------------------------------

describe('a text-only turn is untouched', () => {
  it('serialises to the exact bytes the provider sent before attachments existed', async () => {
    const call = await send([
      { role: 'system', content: 'You are Freya.' },
      { role: 'user', content: 'what is in this?' },
      { role: 'assistant', content: 'a diagram' },
    ])

    // Written out by hand, not built from the parts under test. This is the
    // pre-change body: same keys, same order, same strings.
    expect(call.raw).toBe(
      '{"model":"meta/muse-spark-1.2-contributor","max_tokens":256,"messages":[' +
        '{"role":"system","content":"You are Freya."},' +
        '{"role":"user","content":"what is in this?"},' +
        '{"role":"assistant","content":"a diagram"}]}',
    )
  })

  it('keeps content a bare string rather than a one-element content-parts array', async () => {
    // The tempting implementation is to always build the array. It would pass the
    // test above — `JSON.parse` round-trips both — and still change every request
    // body in the suite, so the type of the field is asserted directly.
    const call = await send([{ role: 'user', content: 'hello' }])
    const messages = bodyOf(call).messages
    expect(messages).toHaveLength(1)
    expect(typeof messages[0]!.content).toBe('string')
    expect(messages[0]!.content).toBe('hello')
  })

  it('adds no key to the request body', async () => {
    const call = await send([{ role: 'user', content: 'hello' }])
    expect(Object.keys(JSON.parse(call.raw!) as object).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
    ])
    // An empty attachment list is absence, not a request for a blank turn.
    const explicit = await send([user('hello', [])])
    expect(explicit.raw).toBe(call.raw)
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Payloads serialise to the verified wire shapes, in order.
// ---------------------------------------------------------------------------------------------

describe('an image part', () => {
  it('serialises to an image_url content part carrying a base64 data URL', async () => {
    const call = await send([user('what is this?', [image()])])
    expect(bodyOf(call).messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
    ])
  })

  it('carries the declared MIME type in the data URL, per allowlisted type', async () => {
    const call = await send([
      user('', [
        { type: 'image', mimeType: 'image/jpeg', data: PNG_1X1 },
        { type: 'image', mimeType: 'image/webp', data: PNG_1X1 },
      ]),
    ])
    const content = bodyOf(call).messages[0]!.content as { image_url: { url: string } }[]
    expect(content.map((part) => part.image_url.url)).toEqual([
      `data:image/jpeg;base64,${PNG_1X1}`,
      `data:image/webp;base64,${PNG_1X1}`,
    ])
  })

  it('never puts a document into an image_url, which this endpoint rejects', async () => {
    // `invalid_image_input` with a PDF in a data URL is the confirmed failure.
    // The PDF must arrive as a `file` part or not at all.
    const call = await send([user('read this', [pdf()])])
    const content = bodyOf(call).messages[0]!.content as { type: string }[]
    expect(content.some((part) => part.type === 'image_url')).toBe(false)
    expect(content.some((part) => part.type === 'file')).toBe(true)
  })

  it('omits an empty text part so an attachment-only turn is a clean array', async () => {
    const call = await send([user('', [image()])])
    expect(bodyOf(call).messages[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
    ])
  })
})

describe('a PDF part', () => {
  it('serialises to a file part with a filename and a data: file_data', async () => {
    const call = await send([user('summarise this', [pdf()])])
    expect(bodyOf(call).messages[0]!.content).toEqual([
      { type: 'text', text: 'summarise this' },
      {
        type: 'file',
        file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF_STUB}` },
      },
    ])
  })

  it('keeps the filename the caller gave, including a name with a path in it', async () => {
    // The filename is a label the endpoint shows back. It is never opened, so it
    // is passed through rather than normalised into something "safe" that is
    // then displayed as if it were the real name.
    const call = await send([user('read', [pdf(PDF_STUB, 'q3 statements (final).pdf')])])
    const content = bodyOf(call).messages[0]!.content as { file: { filename: string } }[]
    expect(content[1]!.file.filename).toBe('q3 statements (final).pdf')
  })
})

describe('part order', () => {
  it('preserves text first, then attachments in the order they were attached', async () => {
    const call = await send([
      user('compare these', [
        image(PNG_1X1, 'a.png'),
        pdf(PDF_STUB, 'b.pdf'),
        image(PNG_1X1, 'c.png'),
      ]),
    ])
    const content = bodyOf(call).messages[0]!.content as {
      type: string
      image_url?: { url: string }
      file?: { filename: string }
    }[]
    expect(content.map((part) => part.type)).toEqual([
      'text',
      'image_url',
      'file',
      'image_url',
    ])
    expect(content[1]!.image_url!.url).toBe(`data:image/png;base64,${PNG_1X1}`)
    expect(content[2]!.file!.filename).toBe('b.pdf')
    expect(content[3]!.image_url!.url).toBe(`data:image/png;base64,${PNG_1X1}`)
  })

  it('leaves one message multi-part without touching the messages around it', async () => {
    const call = await send([
      { role: 'system', content: 'You are Freya.' },
      user('and this one', [image()]),
      { role: 'assistant', content: 'a small transparent square' },
    ])
    const messages = bodyOf(call).messages
    expect(typeof messages[0]!.content).toBe('string')
    expect(Array.isArray(messages[1]!.content)).toBe(true)
    expect(typeof messages[2]!.content).toBe('string')
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Bounds and the MIME allowlist, refused locally and for nothing.
// ---------------------------------------------------------------------------------------------

describe('attachments are bounded', () => {
  it('refuses an oversized image with a typed size error and never contacts the endpoint', async () => {
    const huge = 'A'.repeat(5_592_412) // 4 MiB + 5 decoded bytes
    const { error, calls } = await attempt([user('look', [image(huge)])])
    expect(error).toMatchObject({ name: 'ModelAttachmentError', code: 'payload_too_large' })
    // A refusal that costs a request would be a refusal that costs money.
    expect(calls).toHaveLength(0)
  })

  it('refuses an oversized document too, and bounds the message as a whole', async () => {
    expect(() => validateModelAttachments([pdf('A'.repeat(5_592_412))])).toThrow(
      ModelAttachmentError,
    )
    // Each part is legal; together they are not. The per-part bound alone does
    // not bound a request, so the per-message bound is the real one.
    const third = 'A'.repeat(4_000_000) // 3 MB decoded: legal alone, illegal three times over
    expect(() =>
      validateModelAttachments([image(third, 'a.png'), image(third, 'b.png'), image(third, 'c.png')]),
    ).toThrowError(
      expect.objectContaining({ code: 'message_payload_too_large' }),
    )
    expect(MAX_MESSAGE_ATTACHMENT_BYTES).toBeGreaterThan(MAX_ATTACHMENT_BYTES)
  })

  it('admits a payload just under the ceiling and refuses the next size up', () => {
    // The bound is stated in decoded bytes, so the boundary has to be a fact
    // rather than an approximation: these two strings differ by four base64
    // characters, which is three decoded bytes, and they straddle the limit.
    const under = 'A'.repeat(5_592_404) // 4 MiB - 1 decoded byte
    const over = 'A'.repeat(5_592_408) // 4 MiB + 2 decoded bytes
    expect(attachmentByteLength(image(under))).toBe(MAX_ATTACHMENT_BYTES - 1)
    expect(attachmentByteLength(image(over))).toBeGreaterThan(MAX_ATTACHMENT_BYTES)
    expect(() => validateModelAttachments([image(under)])).not.toThrow()
    expect(() => validateModelAttachments([image(over)])).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    )
  })

  it('bounds how many attachments one message may carry', () => {
    const one = image()
    expect(() =>
      validateModelAttachments(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) => ({ ...one, filename: `${i}.png` }))),
    ).not.toThrow()
    expect(() =>
      validateModelAttachments(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => one)),
    ).toThrowError(expect.objectContaining({ code: 'too_many_attachments' }))
  })
})

describe('the MIME allowlist', () => {
  it('is exactly the verified set, and SVG is not in it', () => {
    expect([...IMAGE_MIME_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp'])
    expect(() => validateModelAttachments([image()])).not.toThrow()
  })

  it('refuses text/html as an image, at the provider boundary and for nothing', async () => {
    const { error, calls } = await attempt([
      // `as never` because this is the whole point of the test: the type system
    // already forbids `text/html`, so the runtime guard is what is under test.
      user('render', [{ type: 'image', mimeType: 'text/html' as never, data: PNG_1X1 }]),
    ])
    expect(error).toMatchObject({ name: 'ModelAttachmentError', code: 'mime_not_allowed' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a MIME type that is on no list at all, and names the list it wanted', () => {
    // Asserting the refusal *names the allowlist* is what keeps the allowlist
    // honest: a set that silently grew would still refuse these types, and the
    // only place the growth would show is the message.
    const failure = (() => {
      try {
        validateModelAttachments([{ type: 'image', mimeType: 'image', data: PNG_1X1 }])
        return null
      } catch (error) {
        return error as ModelAttachmentError
      }
    })()
    expect(failure).toMatchObject({ code: 'mime_not_allowed', mimeType: 'image' })
    expect(failure!.message).toContain('image/jpeg')
    expect(failure!.message).toContain('image/png')
    expect(failure!.message).toContain('image/webp')
  })

it('refuses application/x-msdownload as a document', () => {
    expect(() =>
      validateModelAttachments([
        { type: 'file', mimeType: 'application/x-msdownload', data: PDF_STUB, filename: 'a.exe' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'mime_not_allowed' }))
  })

  it('refuses a document that claims to be an image type, and an image that claims to be a document', () => {
    // Allowlists are per part kind, not one flat list of "types we accept": a PDF
    // wearing an image MIME type must not be forwarded for the model to decode.
    expect(() =>
      validateModelAttachments([{ type: 'file', mimeType: 'image/png', data: PDF_STUB, filename: 'x.pdf' }]),
    ).toThrowError(expect.objectContaining({ code: 'mime_not_allowed' }))
    expect(() =>
      validateModelAttachments([{ type: 'image', mimeType: 'application/pdf', data: PNG_1X1 }]),
    ).toThrowError(expect.objectContaining({ code: 'mime_not_allowed' }))
  })
})

// ---------------------------------------------------------------------------------------------
// Unknown and malformed parts: refused, never silently dropped.
// ---------------------------------------------------------------------------------------------

describe('a part Freya does not recognise is refused, not skipped', () => {
  it('refuses an unknown part type', async () => {
    const { error, calls } = await attempt([
      user('look', [
        image(),
        { type: 'video', mimeType: 'video/mp4', data: PNG_1X1 } as unknown as ModelAttachment,
      ]),
    ])
    expect(error).toMatchObject({ name: 'ModelAttachmentError', code: 'unknown_part_type' })
    // And the legal image before it is not sent alone, which is how a silent
    // drop would look from the outside.
    expect(calls).toHaveLength(0)
  })

  it('refuses a part with no type at all, and one with a non-string type', () => {
    expect(() => validateModelAttachments([{ mimeType: 'image/png', data: PNG_1X1 }])).toThrowError(
      expect.objectContaining({ code: 'unknown_part_type' }),
    )
    expect(() => validateModelAttachments([{ type: 7, mimeType: 'image/png', data: PNG_1X1 }])).toThrowError(
      expect.objectContaining({ code: 'unknown_part_type' }),
    )
  })
})

describe('a malformed part is refused, not repaired', () => {
  const malformed: readonly [string, unknown, string][] = [
    ['a missing payload', { type: 'image', mimeType: 'image/png' }, 'malformed_part'],
    ['a non-string payload', { type: 'image', mimeType: 'image/png', data: 42 }, 'malformed_part'],
    ['a null payload', { type: 'image', mimeType: 'image/png', data: null }, 'malformed_part'],
    ['an empty payload', { type: 'image', mimeType: 'image/png', data: '' }, 'malformed_part'],
    ['a payload that is not base64', { type: 'image', mimeType: 'image/png', data: 'not base64!!' }, 'malformed_part'],
    ['base64 of the wrong length', { type: 'image', mimeType: 'image/png', data: 'QUJD Q' }, 'malformed_part'],
    ['a missing mimeType', { type: 'image', data: PNG_1X1 }, 'malformed_part'],
    ['a non-string mimeType', { type: 'image', mimeType: 5, data: PNG_1X1 }, 'malformed_part'],
    ['a non-string filename', { type: 'image', mimeType: 'image/png', data: PNG_1X1, filename: 9 }, 'malformed_part'],
    ['a document with no filename', { type: 'file', mimeType: 'application/pdf', data: PDF_STUB }, 'malformed_part'],
    ['a bare string instead of a part', 'image', 'malformed_part'],
    ['null instead of a part', null, 'malformed_part'],
    ['an array instead of a part', [PNG_1X1], 'malformed_part'],
  ]

  for (const [label, part, code] of malformed) {
    it(`refuses ${label}`, () => {
      expect(() => validateModelAttachments([part])).toThrowError(
        expect.objectContaining({ name: 'ModelAttachmentError', code }),
      )
    })
  }

  it('refuses attachments that are not a list', () => {
    expect(() => validateModelAttachments('image')).toThrowError(
      expect.objectContaining({ code: 'malformed_part' }),
    )
    expect(() => validateModelAttachments({ type: 'image' })).toThrowError(
      expect.objectContaining({ code: 'malformed_part' }),
    )
  })

  it('treats absent attachments as no attachments', () => {
    expect(validateModelAttachments(undefined)).toEqual([])
    expect(validateModelAttachments(null)).toEqual([])
  })

  it('reports which part failed, so the refusal names a part rather than a message', () => {
    try {
      validateModelAttachments([image(), { type: 'image', mimeType: 'image/gif', data: PNG_1X1 }])
      expect.unreachable('a disallowed type must not validate')
    } catch (error) {
      expect(error).toBeInstanceOf(ModelAttachmentError)
      const failure = error as ModelAttachmentError
      expect(failure.partIndex).toBe(1)
      expect(failure.mimeType).toBe('image/gif')
      expect(failure.message).toContain('image/gif')
    }
  })
})

// ---------------------------------------------------------------------------------------------
// 4. The provider's error body is surfaced, and carries no credential.
// ---------------------------------------------------------------------------------------------

describe('a provider error body reaches the thrown error', () => {
  async function failing(body: unknown, status = 400): Promise<unknown> {
    const fake = recordingFetch(() => reply(body, false, status))
    try {
      await provider(fake.impl).complete(requestOf([user('hi')]), LIVE)
      return null
    } catch (error) {
      return error
    }
  }

  it('names the parameter a model rejected, where "responded 400" named nothing', async () => {
    const error = (await failing({
      error: {
        message: 'This model only supports tool_choice="auto".',
        code: 'unsupported_parameter',
        param: 'tool_choice',
      },
    })) as Error & { code: string | null; param: string | null }

    expect(error.message).toContain('400')
    expect(error.message).toContain('This model only supports tool_choice="auto".')
    expect(error.message).toContain('code=unsupported_parameter')
    expect(error.message).toContain('param=tool_choice')
    expect(error.code).toBe('unsupported_parameter')
    expect(error.param).toBe('tool_choice')
  })

  it('surfaces an image rejection as a fact about messages, not a generic failure', async () => {
    const error = (await failing(
      { error: { message: 'Invalid image input.', code: 'invalid_image_input', param: 'messages' } },
      400,
    )) as Error & { code: string | null }

    expect(error.message).toContain('Invalid image input.')
    expect(error.message).toContain('param=messages')
    expect(error.code).toBe('invalid_image_input')
  })

  it('never carries the API key, even when the server echoes it back', async () => {
    const error = (await failing(
      {
        error: {
          message: `Invalid API key: Bearer ${SECRET} was rejected (sk-test-never-echoed-8f2b)`,
          code: 'invalid_api_key',
          param: 'authorization',
        },
      },
      401,
    )) as Error & { code: string | null }

    expect(error.message).toContain('401')
    expect(error.message).toContain('[redacted]')
    expect(error.message).not.toContain(SECRET)
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain(SECRET)
  })

  it('truncates a hostile or enormous body rather than pasting it into a turn record', async () => {
    const error = (await failing({
      error: { message: `line one\nline two\u0000\u001b${'x'.repeat(50_000)}` },
    })) as Error

    expect(error.message.length).toBeLessThan(400)
    // Control characters would let a remote body forge a line in a journal, so
    // this asserts on code points rather than on a character class.
    const codePoints = [...error.message].map((character) => character.codePointAt(0) ?? 0)
    expect(codePoints.filter((code) => code < 0x20 || code === 0x7f)).toEqual([])
  })

  it('falls back to the bare status when the body explains nothing', async () => {
    const error = (await failing({ nothing: 'useful' })) as Error & { code: string | null }
    expect(error.message).toBe('nanogpt responded 400')
    expect(error.code).toBeNull()
  })

  it('survives a body that is not JSON, and one that is a bare string', async () => {
    const unparseable = (await failing('<html>502 Bad Gateway</html>', 502)) as Error
    expect(unparseable.message).toBe('nanogpt responded 502')

    const bare = (await failing({ error: 'model is overloaded' }, 503)) as Error
    expect(bare.message).toBe('nanogpt responded 503: model is overloaded')
  })
})

// ---------------------------------------------------------------------------------------------
// 5. Prompt flattening.
// ---------------------------------------------------------------------------------------------

describe('flattening a message that carries a payload', () => {
  it('contributes a placeholder that names the part and denies having carried it', () => {
    const prompt = flattenMessages([user('what is this?', [image(PNG_1X1)])])
    // The bytes are not inlined, and the prompt says so — a marker that merely
    // reported a size would leave a model believing it had seen the picture.
    expect(prompt).toContain(`[image content not included: image/png, ${PNG_BYTES} bytes]`)
    expect(prompt).not.toContain(PNG_1X1)
    expect(prompt).not.toContain('base64')
  })

  it('names a document, its filename and its size', () => {
    expect(flattenMessages([user('read', [pdf(PDF_STUB, 'q3.pdf')])])).toContain(
      `[file content not included: application/pdf, q3.pdf, ${attachmentByteLength(pdf())} bytes]`,
    )
  })

  it('lists every attachment when a message has several', () => {
    const prompt = flattenMessages([user('compare', [image(PNG_1X1), pdf(PDF_STUB, 'b.pdf')])])
    expect(prompt.match(/content not included/g)).toHaveLength(2)
  })

  it('keeps role prefixes and blank-line separation exactly as before', () => {
    expect(
      flattenMessages([
        { role: 'system', content: 'You are Freya.' },
        user('first', [image()]),
        { role: 'assistant', content: 'a square' },
      ]),
    ).toBe(
      '[system] You are Freya.\n\n' +
        `first\n[image content not included: image/png, ${PNG_BYTES} bytes]\n\n` +
        '[assistant] a square',
    )
  })

  it('is byte-identical for a message with no attachments', () => {
    const messages: readonly ModelMessage[] = [
      { role: 'system', content: 'You are Freya.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    expect(flattenMessages(messages)).toBe(
      '[system] You are Freya.\n\nhello\n\n[assistant] hi',
    )
  })

  it('produces no leading newline for an attachment-only turn', () => {
    expect(flattenMessages([user('', [image()])])).toBe(
      `[image content not included: image/png, ${PNG_BYTES} bytes]`,
    )
  })

  it('refuses to flatten a malformed attachment rather than dropping it silently', () => {
    expect(() =>
      flattenMessages([user('look', [{ type: 'image', mimeType: 'text/html', data: PNG_1X1 } as unknown as ModelAttachment])]),
    ).toThrowError(expect.objectContaining({ code: 'mime_not_allowed' }))
  })
})