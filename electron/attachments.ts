import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

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
 * ## Three outcomes, because three things are true
 *
 *  - **text** — the bytes decoded as UTF-8 and handed back, capped. This is the
 *    only outcome whose content leaves this process, and it is bounded twice: once
 *    here, once again by the turn's own character ceiling in Core.
 *  - **image** — the shape is real and the *pixels are not sent*. A vision model
 *    is not something this build has, so handing Freya a JPEG's bytes would cost
 *    real tokens to say nothing. The name, type and size cross; the content does
 *    not, and the renderer says so rather than implying Freya can see it.
 *  - **unsupported** — anything else is named as unsupported. There is no
 *    best-effort decode of a PDF into "probably text", because a wrong guess here
 *    becomes a turn full of replacement characters the owner did not write.
 *
 * The binary check is a real one, not an extension guess: a `.txt` full of NUL
 * bytes is binary, and a `.bin` of ASCII is text. Extensions pick the *default*;
 * the bytes decide.
 */

/** The largest file this will read at all. */
export const ATTACHMENT_MAX_BYTES = 1_000_000

/** How much of a text file crosses into the renderer. */
export const ATTACHMENT_MAX_TEXT_CHARS = 20_000

/** How many files one pick may return. */
export const ATTACHMENT_MAX_FILES = 5

export type AttachmentKind = 'text' | 'image' | 'unsupported'

export interface AttachmentResult {
  readonly name: string
  readonly path: string
  readonly kind: AttachmentKind
  readonly contentType: string
  readonly sizeBytes: number
  /** Decoded text, truncated with an explicit marker. Text attachments only. */
  readonly text: string | null
  /** True when `text` was cut at the ceiling. Never silently false. */
  readonly truncated: boolean
  /** Why an unsupported file is unsupported, in words. */
  readonly detail: string | null
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
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

function contentTypeFor(path: string): { kind: AttachmentKind; contentType: string } {
  const extension = extname(path).toLowerCase()
  const image = IMAGE_TYPES[extension]
  if (image !== undefined) return { kind: 'image', contentType: image }
  const text = TEXT_TYPES[extension]
  if (text !== undefined) return { kind: 'text', contentType: text }
  return { kind: 'unsupported', contentType: 'application/octet-stream' }
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
      return {
        name, path, kind: 'unsupported', contentType: identified.contentType, sizeBytes: 0,
        text: null, truncated: false,
        detail: 'That is not a file, so there is nothing to attach.',
      }
    }
    size = info.size
  } catch (error) {
    return {
      name, path, kind: 'unsupported', contentType: identified.contentType, sizeBytes: 0,
      text: null, truncated: false,
      detail: `Freya could not read that file — ${error instanceof Error ? error.message : 'the reason was not reported'}.`,
    }
  }

  if (size > ATTACHMENT_MAX_BYTES) {
    return {
      name, path, kind: 'unsupported', contentType: identified.contentType, sizeBytes: size,
      text: null, truncated: false,
      detail: `That file is ${Math.round(size / 1000)} KB. Freya reads files up to ${Math.round(ATTACHMENT_MAX_BYTES / 1000)} KB.`,
    }
  }

  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (error) {
    return {
      name, path, kind: 'unsupported', contentType: identified.contentType, sizeBytes: size,
      text: null, truncated: false,
      detail: `Freya could not open that file — ${error instanceof Error ? error.message : 'the reason was not reported'}.`,
    }
  }

  if (identified.kind === 'image') {
    return {
      name, path, kind: 'image', contentType: identified.contentType, sizeBytes: size,
      text: null, truncated: false,
      detail: 'Freya can see that an image is attached, but this build cannot read image content.',
    }
  }

  if (!looksTextual(bytes)) {
    return {
      name, path, kind: 'unsupported', contentType: identified.contentType, sizeBytes: size,
      text: null, truncated: false,
      detail: 'That file is binary, so Freya cannot read it as text.',
    }
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
  }
}

/** Read a pick, capped at {@link ATTACHMENT_MAX_FILES} files. */
export async function readAttachments(paths: readonly string[]): Promise<AttachmentResult[]> {
  const chosen = paths.slice(0, ATTACHMENT_MAX_FILES)
  return Promise.all(chosen.map((path) => readAttachment(path)))
}