import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { FileMimeType, ImageMimeType, ModelAttachment } from '../core/model/provider'
import { validateModelAttachments } from '../core/model/provider'
import { ATTACHMENT_MAX_TEXT_CHARS, hasPdfSignature, extractPdfText } from '../shared/pdf-text'
export { ATTACHMENT_MAX_TEXT_CHARS, PDF_MAX_PAGES, PDF_SIGNATURE_SEARCH_BYTES, hasPdfSignature, extractPdfText } from '../shared/pdf-text'

/**
 * Reading a file somebody picked, for the composer.
 *
 * ## Why this lives in the main process and not the renderer
 *
 * A renderer cannot open a file dialog and cannot read a path it was handed, and
 * the gap between those two is not a detail. Everything here therefore runs on the
 * side of the bridge that already holds the filesystem, and the window receives
 * *bounded, typed* results — never a path it could then try to use for something
 * else. A file picker is the one place in this application where a person names a
 * file, so it is also the one place the host has to be careful about what it does
 * with the answer.
 *
 * ## Four outcomes, because four things are true
 *
 *  - **text** — the bytes decoded as UTF-8 and handed back, capped. This is the
 *    only outcome whose content leaves this process as *text*, and it is bounded
 *    twice: once here, once again by the turn's own character ceiling in Core.
 *  - **pdf** — signature-checked, then really decoded with pdf.js and handed back
 *    as text *and*, separately, as a validated `ModelFilePart` for the model
 *    contract. A PDF is the one format that contributes both, which is why it is
 *    its own outcome rather than a flavour of "text".
 *  - **image** — magic-byte checked and carried as base64. The bytes are meant to
 *    reach `ModelMessage.attachments` as an OpenAI `image_url` part; they are
 *    never flattened into the turn's text, because base64 inlined into a prompt
 *    is noise that costs the same as sending the picture properly. Whether they
 *    actually *arrive* at a model is a different seam and is written down at the
 *    bottom of this file rather than implied here.
 *  - **unsupported** — anything else is named as unsupported, in words. Every
 *    refusal below is a sentence a person can act on, never an empty string that
 *    reads like "the document was blank".
 *
 * The binary check is a real one, not an extension guess: a `.txt` full of NUL
 * bytes is binary, and a `.bin` of ASCII is text. Extensions pick the *default*;
 * the bytes decide. For images the bytes do not merely suggest a type, they are
 * the type: the magic number has to agree with the extension or the file is
 * refused, because a JPEG renamed to `.png` is a file whose declared type is a
 * lie and the model contract would forward that lie to the endpoint.
 *
 * ## The PDF library, and why
 *
 * `pdfjs-dist`'s legacy build. It is the one PDF text extractor that runs in a
 * plain Node process with no native module, no canvas and no worker thread to
 * babysit — which is exactly Electron's main process, and exactly what a test
 * runner is. The alternatives were rejected for concrete reasons: `pdf-parse`
 * forks a child process and offers no page-level API to bound; `pdfreader` builds
 * a DOM it expects a browser to provide; `mupdf`/`pdfium` bindings are native and
 * would need a rebuild against Electron's ABI. pdf.js is loaded lazily so a
 * window that never opens a file never parses it, and it is configured with
 * `isEvalSupported: false` so a document cannot reach `Function` on its way to
 * being read.
 *
 * ### One thing whoever wires the bridge must know
 *
 * `pdfjs-dist` has to be listed as **external** in `scripts/build-electron.mjs`,
 * beside `electron` and `better-sqlite3`. Bundling it was tried and does not work:
 * pdf.js resolves its worker module relative to `import.meta.url`, esbuild rewrites
 * that inside a CommonJS bundle, and the first attachment then fails with
 * `Cannot find module '…/pdf.worker.mjs' imported from dist-electron/main.cjs`.
 * With it external, the same extraction was verified from an esbuild-built bundle.
 *
 * ## The ceilings, and why they are here rather than in Core
 *
 * A file is read only if it is at most {@link ATTACHMENT_MAX_BYTES}, a pick
 * carries at most {@link ATTACHMENT_MAX_FILES} files, a PDF is decoded for at
 * most {@link PDF_MAX_PAGES} pages, and extracted text is cut at
 * {@link ATTACHMENT_MAX_TEXT_CHARS}. The read ceiling is deliberately *below*
 * `MAX_ATTACHMENT_BYTES` in Core's provider contract (4 MiB), which means no read
 * this module performs can produce a payload Core would later refuse: the host
 * refuses less than the protocol allows, so the bound is never a surprise at the
 * far end. Every cut is marked in the result rather than being silent.
 */

/** The largest file this will read at all. */
export const ATTACHMENT_MAX_BYTES = 1_000_000

/** How many files one pick may return. */
export const ATTACHMENT_MAX_FILES = 5
export type AttachmentKind = 'text' | 'image' | 'pdf' | 'unsupported'

/** What a PDF turned out to be. Null for every other kind. */
export interface PdfReading {
  /** Pages in the document, which is not the number read. */
  readonly pages: number
  /** Pages actually decoded, at most {@link PDF_MAX_PAGES}. */
  readonly pagesRead: number
  /**
   * False when the document has no extractable text layer at all.
   *
   * This is the honest reading of a scan: the page is full of pixels and no
   * glyphs, so there is nothing to extract and nothing was written. Reported as
   * its own fact rather than as an empty string, which would read like a blank
   * page rather than a picture of a page.
   */
  readonly textLayer: boolean
}

export interface AttachmentResult {
  readonly name: string
  readonly path: string
  readonly kind: AttachmentKind
  readonly contentType: string
  readonly sizeBytes: number
  /** Decoded text, truncated with an explicit marker. Null when there is none. */
  readonly text: string | null
  /** True when `text` was cut at the ceiling. Never silently false. */
  readonly truncated: boolean
  /** Why a file was refused, or what it did not carry, in words. */
  readonly detail: string | null
  /**
   * Bytes for `ModelMessage.attachments`, already through
   * {@link validateModelAttachments}.
   *
   * Null when nothing travels: a text file contributes text, not a content part.
   * Never a filesystem path and never a URL — bare base64 only, which is the only
   * form Core's contract admits.
   */
  readonly modelAttachment: ModelAttachment | null
  /** Present only when `kind` is `pdf`. */
  readonly pdf: PdfReading | null
}

/** One pick, or the sentence explaining why there is not one. */
export type AttachmentPickOutcome =
  | { readonly ok: true; readonly attachments: readonly AttachmentResult[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Image types this will carry as a model content part.
 *
 * Exactly the set in Core's provider contract, and for the same reason it is a
 * list there: those are the types verified to survive the endpoint's content-parts
 * parser. A GIF is a real image and would be validated as one, but forwarding it
 * would trade a local typed refusal for an opaque HTTP 400.
 */
const CARRIED_IMAGE_TYPES: Readonly<Record<string, ImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/**
 * Image types recognised but not carried, each mapped to the reason.
 *
 * "Unsupported" on its own tells a person nothing about which of their files to
 * change, so the refusal names the cause instead.
 */
const UNCARRIED_IMAGE_TYPES: Readonly<Record<string, { contentType: string; reason: string }>> = {
  '.gif': {
    contentType: 'image/gif',
    reason: 'That is a GIF. Freya can see JPEG, PNG and WebP; a GIF is not one of them.',
  },
  '.bmp': {
    contentType: 'image/bmp',
    reason: 'That is a BMP. Freya can see JPEG, PNG and WebP; a BMP is not one of them.',
  },
  '.svg': {
    contentType: 'image/svg+xml',
    reason: 'That is an SVG, which is an XML document that can carry script. Freya does not send one.',
  },
}

const TEXT_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.log': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.env': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.py': 'text/plain',
  '.rs': 'text/plain',
  '.go': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.cs': 'text/plain',
  '.rb': 'text/plain',
  '.php': 'text/plain',
  '.sh': 'text/plain',
  '.ps1': 'text/plain',
  '.sql': 'text/plain',
  '.tsconfig': 'application/json',
}

/**
 * Does this look like text?
 *
 * A NUL byte in the first 8 KiB is the same test every binary format agrees on,
 * because every one of them uses NUL for padding or a terminator. Beyond that, the
 * check is a ratio rather than a whitelist, so a file with an extension nobody
 * listed still gets read when it is plainly prose.
 */
export function looksTextual(sample: Uint8Array): boolean {
  const limit = Math.min(sample.length, 8192)
  let control = 0
  for (let index = 0; index < limit; index += 1) {
    const byte = sample[index]!
    if (byte === 0) return false
    // Tab, newline and carriage return are text. Anything else below 0x20 is not.
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) control += 1
  }
  return limit === 0 || control / limit < 0.05
}

const ASCII = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index)
  return bytes
}

function startsWith(bytes: Uint8Array, signature: Uint8Array, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false
  }
  return true
}

/**
 * The image type the bytes actually are, or null.
 *
 * Magic numbers, not extensions. Every entry is the format's own signature as its
 * specification defines it, which is what makes "is this really a PNG" a question
 * with an answer. WebP additionally checks the `WEBP` form type at offset 8,
 * because a bare `RIFF` is an AVI or a WAV wearing the same first four bytes.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (startsWith(bytes, new Uint8Array([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (startsWith(bytes, ASCII('GIF87a')) || startsWith(bytes, ASCII('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ASCII('RIFF')) && startsWith(bytes, ASCII('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, ASCII('BM'))) return 'image/bmp'
  return null
}

function contentTypeFor(path: string): { kind: AttachmentKind; contentType: string } {
  const extension = extname(path).toLowerCase()
  if (extension === '.pdf') return { kind: 'pdf', contentType: 'application/pdf' }
  const carried = CARRIED_IMAGE_TYPES[extension]
  if (carried !== undefined) return { kind: 'image', contentType: carried }
  const uncarried = UNCARRIED_IMAGE_TYPES[extension]
  if (uncarried !== undefined) return { kind: 'unsupported', contentType: uncarried.contentType }
  const text = TEXT_TYPES[extension]
  if (text !== undefined) return { kind: 'text', contentType: text }
  return { kind: 'unsupported', contentType: 'application/octet-stream' }
}

/**
 * Build the base64 content part for these bytes, or null.
 *
 * Checked with Core's own validator before it leaves this process, so a payload
 * that reaches the window is one the protocol has already agreed to accept — the
 * main process is the last place where a mistake is still cheap and local.
 */
function carriedPart(candidate: ModelAttachment): ModelAttachment | null {
  try {
    return validateModelAttachments([candidate])[0] ?? null
  } catch {
    return null
  }
}

function refusal(
  name: string,
  path: string,
  contentType: string,
  sizeBytes: number,
  detail: string,
): AttachmentResult {
  return {
    name,
    path,
    kind: 'unsupported',
    contentType,
    sizeBytes,
    text: null,
    truncated: false,
    detail,
    modelAttachment: null,
    pdf: null,
  }
}

/**
 * Read one file into a bounded attachment result.
 *
 * Never throws: every failure is a result with a sentence in it, because the
 * composer's job is to show a person what happened to the file they picked, and a
 * rejected promise reaches them as nothing at all.
 */
export async function readAttachment(path: string): Promise<AttachmentResult> {
  const name = basename(path)
  const identified = contentTypeFor(path)

  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      return refusal(name, path, identified.contentType, 0, 'That is not a file, so there is nothing to attach.')
    }
    size = info.size
  } catch (error) {
    return refusal(name, path, identified.contentType, 0, `Freya could not read that file — ${reasonFrom(error)}.`)
  }

  if (size > ATTACHMENT_MAX_BYTES) {
    return refusal(
      name,
      path,
      identified.contentType,
      size,
      `That file is ${Math.round(size / 1000)} KB. Freya reads files up to ${Math.round(ATTACHMENT_MAX_BYTES / 1000)} KB.`,
    )
  }

  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (error) {
    return refusal(name, path, identified.contentType, size, `Freya could not open that file — ${reasonFrom(error)}.`)
  }

  if (identified.kind === 'pdf') return readPdf(name, path, bytes, size)

  if (identified.kind === 'image') return readImage(name, path, bytes, size, identified.contentType)

  if (identified.kind === 'unsupported') {
    const uncarried = UNCARRIED_IMAGE_TYPES[extname(path).toLowerCase()]
    return refusal(name, path, identified.contentType, size, uncarried?.reason ?? 'Freya cannot read that file type.')
  }

  if (!looksTextual(bytes)) {
    return refusal(name, path, identified.contentType, size, 'That file is binary, so Freya cannot read it as text.')
  }

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const truncated = decoded.length > ATTACHMENT_MAX_TEXT_CHARS
  const body = truncated ? decoded.slice(0, ATTACHMENT_MAX_TEXT_CHARS) : decoded
  return {
    name,
    path,
    kind: 'text',
    // A file with no listed extension that turned out to be text is reported as
    // text/plain, which is what it is — rather than keeping the octet-stream type
    // its extension implied.
    contentType: identified.kind === 'text' ? identified.contentType : 'text/plain',
    sizeBytes: size,
    text: truncated ? `${body}\n\n[truncated at ${ATTACHMENT_MAX_TEXT_CHARS} characters]` : body,
    truncated,
    detail: null,
    modelAttachment: null,
    pdf: null,
  }
}

function readImage(
  name: string,
  path: string,
  bytes: Uint8Array,
  size: number,
  declared: string,
): AttachmentResult {
  const sniffed = sniffImageType(bytes)
  if (sniffed === null) {
    return refusal(
      name,
      path,
      declared,
      size,
      'Those bytes are not a picture, so the name on that file is not true of it.',
    )
  }
  if (sniffed !== declared) {
    return refusal(
      name,
      path,
      declared,
      size,
      `That file is really a ${sniffed.replace('image/', '').toUpperCase()}, not a ${declared.replace('image/', '').toUpperCase()}. Rename it to match the bytes.`,
    )
  }

  const modelAttachment = carriedPart({
    type: 'image',
    mimeType: declared as ImageMimeType,
    data: Buffer.from(bytes).toString('base64'),
    filename: name,
  })
  if (modelAttachment === null) {
    return refusal(name, path, declared, size, 'Freya could not prepare that picture for the model, so it is not being attached.')
  }

  return {
    name,
    path,
    kind: 'image',
    contentType: declared,
    sizeBytes: size,
    text: null,
    truncated: false,
    detail: null,
    modelAttachment,
    pdf: null,
  }
}

async function readPdf(name: string, path: string, bytes: Uint8Array, size: number): Promise<AttachmentResult> {
  if (!hasPdfSignature(bytes)) {
    return refusal(
      name,
      path,
      'application/pdf',
      size,
      'That file does not start with the %PDF- header, so it is not a PDF — usually a web page saved with a .pdf name.',
    )
  }

  // The whole document travels as the file part whether or not its pages have
  // text: a scan is still a PDF a model can be given, and refusing it here would
  // discard something the endpoint has been verified to read.
  const modelAttachment = carriedPart({
    type: 'file',
    mimeType: 'application/pdf' satisfies FileMimeType,
    data: Buffer.from(bytes).toString('base64'),
    filename: name,
  })

  const extraction = await extractPdfText(bytes)
  if (!extraction.ok) return refusal(name, path, 'application/pdf', size, extraction.reason)

  const notes: string[] = []
  if (!extraction.textLayer) {
    notes.push('That PDF has no text layer — its pages are pictures of pages, so Freya extracted no words from it.')
  }
  if (extraction.pages > extraction.pagesRead) {
    notes.push(
      `Freya read the first ${extraction.pagesRead} of ${extraction.pages} pages; the rest was not decoded.`,
    )
  }
  if (extraction.truncated) {
    notes.push(`The text was cut at ${ATTACHMENT_MAX_TEXT_CHARS} characters.`)
  }

  return {
    name,
    path,
    kind: 'pdf',
    contentType: 'application/pdf',
    sizeBytes: size,
    text: extraction.textLayer
      ? extraction.truncated
        ? `${extraction.text}\n\n[truncated at ${ATTACHMENT_MAX_TEXT_CHARS} characters]`
        : extraction.text
      : null,
    truncated: extraction.truncated,
    detail: notes.length === 0 ? null : notes.join(' '),
    modelAttachment,
    pdf: { pages: extraction.pages, pagesRead: extraction.pagesRead, textLayer: extraction.textLayer },
  }
}

/**
 * Read a pick.
 *
 * Over the file count is a refusal rather than a silent truncation: a person who
 * picked nine files and sees three of them attached has been misled by omission,
 * and the count is the one fact they can act on.
 */
export async function readAttachments(paths: readonly string[]): Promise<AttachmentPickOutcome> {
  if (paths.length > ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      reason: `Freya attaches at most ${ATTACHMENT_MAX_FILES} files at a time; ${paths.length} were picked.`,
    }
  }
  return { ok: true, attachments: await Promise.all(paths.map((path) => readAttachment(path))) }
}

/**
 * What a file picker hands this module.
 *
 * Injected rather than imported so this file never pulls in `electron`: the
 * reader stays runnable — and testable — in a plain Node process, and the dialog
 * stays a parameter with no privileged default.
 */
/**
 * What a picker asks for, described without importing Electron.
 *
 * The property and filter shapes mirror `OpenDialogOptions` exactly so the host
 * can forward them straight into `dialog.showOpenDialog` without inventing a
 * translation, and `properties` is the closed union rather than `string[]` so an
 * unsupported value is a type error here instead of being silently dropped by the
 * dialog at runtime.
 */
export type AttachmentDialogProperty =
  | 'openFile'
  | 'openDirectory'
  | 'multiSelections'
  | 'showHiddenFiles'
  | 'createDirectory'
  | 'promptToCreate'
  | 'noResolveAliases'
  | 'treatPackageAsDirectory'
  | 'dontAddToRecent'

export interface AttachmentDialogFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

export interface AttachmentDialogRequest {
  readonly title: string
  readonly properties: readonly AttachmentDialogProperty[]
  readonly filters: readonly AttachmentDialogFilter[]
}

export interface AttachmentDialogOutcome {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

export interface AttachmentPickerOptions {
  /** Electron's `dialog.showOpenDialog`, bound to the window that asked. */
  readonly showOpenDialog: (request: AttachmentDialogRequest) => Promise<AttachmentDialogOutcome>
  readonly title?: string
}

/**
 * Open the picker and read what came back.
 *
 * The whole privileged act of "attach a file": a dialog in the main process, a
 * bounded read behind it, and a typed outcome in front of it. The renderer never
 * learns a path it could ask to have read — it receives the bounded result and a
 * sentence.
 */
export async function pickAttachments(options: AttachmentPickerOptions): Promise<AttachmentPickOutcome> {
  let outcome: AttachmentDialogOutcome
  try {
    outcome = await options.showOpenDialog({
      title: options.title ?? 'Attach to Freya',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents Freya can read', extensions: ['txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml', 'pdf'] },
        { name: 'Pictures Freya can see', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'Everything', extensions: ['*'] },
      ],
    })
  } catch (error) {
    return { ok: false, reason: `The file picker could not be opened — ${reasonFrom(error)}.` }
  }

  if (outcome.canceled) return { ok: true, attachments: [] }
  return readAttachments(outcome.filePaths)
}

/**
 * ## Where the bytes stop, and where they have to start again
 *
 * A `modelAttachment` on a result above is exactly the shape
 * `ModelMessage.attachments` takes in `core/model/provider.ts`, and the renderer
 * re-validates these results at the bridge before turning them into that array.
 * What is **not** wired yet is the last hop: `conversation.turn.submit` accepts
 * text and nothing else, its payload is rebuilt in `electron/preload.ts` as
 * `{ conversationId, text }`, and `src/platform/conversationClient.ts` offers
 * `submitTurn(conversationId, text)`. So today the bytes are composed, validated
 * and held, and no turn carries them.
 *
 * Closing that is a protocol change in files this module does not own: the
 * `conversation.turn.submit` payload contract in preload and Core, the Core turn
 * that would hold the parts, and the Context Compiler placing them on the user
 * `ModelMessage`. The text path above stays correct either way — a content part
 * must never be inlined into a turn's text, which is why the composed turn
 * carries a *sentence* about the picture rather than its base64.
 */
function reasonFrom(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'the reader gave no reason'
}
