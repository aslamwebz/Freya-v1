import type * as PdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs'

/** Shared bounded PDF reader for the file picker and text-provider fallback. */
export const ATTACHMENT_MAX_TEXT_CHARS = 20_000
/** Longer PDFs are explicitly reported as partially read. */
export const PDF_MAX_PAGES = 20
/** Tolerate a leading banner, without accepting a PDF marker anywhere in a file. */
export const PDF_SIGNATURE_SEARCH_BYTES = 1024

const ASCII = (text: string): Uint8Array => new TextEncoder().encode(text)
function startsWith(bytes: Uint8Array, signature: Uint8Array, offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * Does this file carry a PDF header?
 *
 * Exported because "an HTML error page saved as `.pdf`" is a specific, testable
 * failure and deserves a name rather than being an inline comparison inside a
 * function no test can reach.
 */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  const needle = ASCII('%PDF-')
  const limit = Math.min(bytes.length, PDF_SIGNATURE_SEARCH_BYTES)
  for (let start = 0; start + needle.length <= limit; start += 1) {
    if (startsWith(bytes, needle, start)) return true
  }
  return false
}

/**
 * pdf.js, loaded once and lazily.
 *
 * A dynamic import rather than a top-level one for two reasons: a window that
 * never opens a file should never parse a megabyte of PDF machinery at startup,
 * and a failure to load has to become a sentence inside a result rather than a
 * rejection during module evaluation, which would take the whole host down.
 */
type PdfModule = typeof PdfjsModule
type PdfDocument = Awaited<ReturnType<PdfModule['getDocument']>['promise']>

let pdfModule: Promise<PdfModule> | null = null

function loadPdfModule(): Promise<PdfModule> {
  pdfModule ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfModule
}

interface PdfTextRun {
  readonly str?: string
  readonly hasEOL?: boolean
}

/**
 * One page's text runs, in reading order, as prose.
 *
 * pdf.js returns positioned runs rather than lines, and dropping the `hasEOL`
 * markers runs every paragraph into the next one — which is how extracted PDF
 * text becomes one unreadable line. Whitespace before a break and runs of blank
 * lines are collapsed, so a page does not spend the character budget on its own
 * layout.
 */
function joinTextRuns(items: readonly unknown[]): string {
  let text = ''
  for (const item of items) {
    const run = item as PdfTextRun
    if (typeof run.str !== 'string') continue
    text += run.str
    if (run.hasEOL === true) text += '\n'
  }
  return text.replace(/[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

type PdfExtraction =
  | {
      readonly ok: true
      readonly text: string
      readonly pages: number
      readonly pagesRead: number
      readonly textLayer: boolean
      readonly truncated: boolean
    }
  | { readonly ok: false; readonly reason: string }

function reasonFrom(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'the reader gave no reason'
}

/**
 * Really decode a PDF's text layer, or say honestly that there isn't one.
 *
 * Never throws. A malformed document is a refusal with a sentence in it, because
 * this runs behind a bridge where an escaping rejection reaches the window as an
 * opaque "Error invoking remote method" that names neither the file nor the fault.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  let pdfjs: PdfModule
  try {
    pdfjs = await loadPdfModule()
  } catch (error) {
    return { ok: false, reason: `Freya could not load its PDF reader — ${reasonFrom(error)}.` }
  }

  let document: PdfDocument
  try {
    document = await pdfjs.getDocument({
      // A copy: pdf.js takes ownership of the buffer it is handed, and these same
      // bytes are still needed for the base64 file part below.
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise
  } catch (error) {
    return {
      ok: false,
      reason: `That file has a PDF header but is not a readable PDF — ${reasonFrom(error)}.`,
    }
  }

  const pages = document.numPages
  const pagesRead = Math.min(pages, PDF_MAX_PAGES)
  try {
    const chunks: string[] = []
    let characters = 0
    let truncated = false

    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      let pageText: string
      try {
        const content = await page.getTextContent()
        pageText = joinTextRuns(content.items as readonly unknown[])
      } finally {
        page.cleanup()
      }
      if (pageText.length === 0) continue

      const remaining = ATTACHMENT_MAX_TEXT_CHARS - characters
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (pageText.length > remaining) {
        truncated = true
        pageText = pageText.slice(0, remaining)
      }
      chunks.push(pageText)
      characters += pageText.length
      if (truncated) break
    }

    const text = chunks.join('\n\n')
    return { ok: true, text, pages, pagesRead, textLayer: text.length > 0, truncated }
  } catch (error) {
    return { ok: false, reason: `Freya could not read the text in that PDF — ${reasonFrom(error)}.` }
  } finally {
    await document.destroy().catch(() => undefined)
  }
}

