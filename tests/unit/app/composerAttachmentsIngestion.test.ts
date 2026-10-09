// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachmentTray,
  ingestBrowserFiles,
  ingestClipboardData,
  ATTACHMENT_MAX_BYTES,
  PER_ATTACHMENT_MAX_CHARS,
} from '../../../src/app/chat/attachments'

afterEach(() => {
  attachmentTray.clear()
})

describe('Composer Attachments Ingestion', () => {
  it('ingests text files and respects character limits', async () => {
    const textContent = 'Hello world, this is a code sample'
    const file = new File([textContent], 'sample.ts', { type: 'text/typescript' })

    const outcome = await ingestBrowserFiles([file])
    expect(outcome.added).toBe(1)
    expect(outcome.notices).toHaveLength(0)

    const drafts = attachmentTray.getSnapshot()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.name).toBe('sample.ts')
    expect(drafts[0]?.kind).toBe('text')
    expect(drafts[0]?.text).toBe(textContent)
  })

  it('truncates text files exceeding per-attachment character ceiling', async () => {
    const longContent = 'A'.repeat(PER_ATTACHMENT_MAX_CHARS + 500)
    const file = new File([longContent], 'large.txt', { type: 'text/plain' })

    const outcome = await ingestBrowserFiles([file])
    expect(outcome.added).toBe(1)

    const drafts = attachmentTray.getSnapshot()
    expect(drafts[0]?.name).toBe('large.txt')
    expect(drafts[0]?.kind).toBe('text')
    expect(drafts[0]?.text).toContain(`[truncated at ${PER_ATTACHMENT_MAX_CHARS} characters]`)
    expect(drafts[0]?.detail).toContain('truncated')
  })

  it('ingests image files and constructs valid ModelAttachment payload', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) // PNG header
    const file = new File([imageBytes], 'diagram.png', { type: 'image/png' })

    const outcome = await ingestBrowserFiles([file])
    expect(outcome.added).toBe(1)

    const drafts = attachmentTray.getSnapshot()
    expect(drafts[0]?.name).toBe('diagram.png')
    expect(drafts[0]?.kind).toBe('image')
    expect(drafts[0]?.modelAttachment).toBeDefined()
    expect(drafts[0]?.modelAttachment?.type).toBe('image')
    expect(drafts[0]?.modelAttachment?.mimeType).toBe('image/png')
    expect(drafts[0]?.modelAttachment?.filename).toBe('diagram.png')
  })

  it('ingests PDF files and constructs valid ModelAttachment payload', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]) // %PDF-1.4
    const file = new File([pdfBytes], 'specification.pdf', { type: 'application/pdf' })

    const outcome = await ingestBrowserFiles([file])
    expect(outcome.added).toBe(1)

    const drafts = attachmentTray.getSnapshot()
    expect(drafts[0]?.name).toBe('specification.pdf')
    expect(drafts[0]?.kind).toBe('pdf')
    expect(drafts[0]?.modelAttachment?.type).toBe('file')
    expect(drafts[0]?.modelAttachment?.mimeType).toBe('application/pdf')
  })

  it('refuses files exceeding the maximum byte size', async () => {
    const oversizeBytes = new Uint8Array(ATTACHMENT_MAX_BYTES + 1000)
    const file = new File([oversizeBytes], 'huge-video.mp4', { type: 'video/mp4' })

    const outcome = await ingestBrowserFiles([file])
    expect(outcome.added).toBe(0)
    expect(outcome.notices).toHaveLength(1)
    expect(outcome.notices[0]).toContain('Freya reads files up to')

    expect(attachmentTray.getSnapshot()).toHaveLength(0)
  })

  it('ingests clipboard data containing image items', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71])
    const file = new File([imageBytes], 'screenshot.png', { type: 'image/png' })

    const mockItem = {
      kind: 'file',
      type: 'image/png',
      getAsFile: () => file,
    } as unknown as DataTransferItem

    const mockDataTransfer = {
      files: [] as unknown as FileList,
      items: [mockItem] as unknown as DataTransferItemList,
    } as DataTransfer

    const outcome = await ingestClipboardData(mockDataTransfer)
    expect(outcome.handled).toBe(true)
    expect(outcome.notices).toContain('Picture attached from clipboard.')

    const drafts = attachmentTray.getSnapshot()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.kind).toBe('image')
  })
})
