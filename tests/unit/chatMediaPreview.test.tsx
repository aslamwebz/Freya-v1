// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { MediaItem } from '../../core/media/types'
import type { FreyaHostBridge } from '../../src/platform/host'
import { MediaGrid } from '../../src/app/chat/MediaCards'

function item(over: Partial<MediaItem>): MediaItem {
  return {
    kind: 'image',
    url: 'https://cdn.example.test/full.jpg',
    thumbnailUrl: 'https://cdn.example.test/thumb.jpg',
    page: 'https://example.test/source',
    title: 'Result',
    host: 'example.test',
    duration: null,
    bytes: null,
    pages: null,
    playable: false,
    ...over,
  }
}

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
let objectUrlCounter = 0

function installBridge() {
  const mediaThumbnail = vi.fn(async () => ({
    ok: true,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    bytes: 8,
    format: 'image/png',
    claimedType: 'image/png',
    reason: null,
  }))
  const mediaDocument = vi.fn(async () => ({
    ok: true,
    base64: 'JVBERi0xLjQK',
    bytes: 9,
  }))
  const mediaVideo = vi.fn(async () => ({
    ok: true,
    dataUrl: 'data:video/mp4;base64,AAAA',
    bytes: 4,
    format: 'video/mp4',
    claimedType: 'video/mp4',
    reason: null,
  }))

  // jsdom has no `URL.createObjectURL`, so the PDF blob path is stubbed here for
  // every test rather than reaching into a single case and leaking its stub.
  const createObjectURL = vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`)
  const revokeObjectURL = vi.fn()
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL

  window.freyaHost = {
    isDesktop: true,
    mediaThumbnail,
    mediaDocument,
    mediaVideo,
  } as unknown as FreyaHostBridge

  return { mediaThumbnail, mediaDocument, mediaVideo, createObjectURL, revokeObjectURL }
}

afterEach(() => {
  cleanup()
  delete window.freyaHost
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
  vi.restoreAllMocks()
})

describe('Chat media preview', () => {
  it('opens an image inside a modal using host-fetched bytes', async () => {
    const bridge = installBridge()
    render(<MediaGrid items={[item({ title: 'Nebula' })]} />)

    const card = await screen.findByRole('button', { name: 'Preview Nebula' })
    fireEvent.click(card)

    expect(await screen.findByRole('dialog', { name: 'Media preview' })).toBeTruthy()
    const image = await screen.findByRole('img', { name: 'Nebula' })
    expect(image.getAttribute('src')).toMatch(/^data:image\//)
    expect(bridge.mediaThumbnail).toHaveBeenCalled()
  })

  it('plays an allowlisted hosted video inside the modal instead of opening a browser', async () => {
    installBridge()
    render(<MediaGrid items={[item({
      kind: 'video',
      title: 'Queue tutorial',
      url: 'https://www.youtube.com/watch?v=abc',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      embedUrl: 'https://www.youtube.com/embed/abc',
      playable: false,
    })]} />)

    const card = await screen.findByRole('button', { name: 'Preview Queue tutorial' })
    fireEvent.click(card)

    const frame = (await screen.findAllByTitle('Queue tutorial')).find((node) => node.tagName === 'IFRAME')
    expect(frame).toBeDefined()
    expect(frame?.getAttribute('src')).toBe('https://www.youtube.com/embed/abc')
    expect(screen.getByRole('dialog', { name: 'Media preview' })).toBeTruthy()
  })

  it('loads a PDF into an in-app preview frame as a blob URL', async () => {
    const bridge = installBridge()
    render(<MediaGrid items={[item({
      kind: 'document',
      title: 'EU AI Act',
      url: 'https://example.test/act.pdf',
      thumbnailUrl: null,
      playable: false,
    })]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview EU AI Act' }))

    await waitFor(() => expect(bridge.mediaDocument).toHaveBeenCalledWith('https://example.test/act.pdf'))
    const frame = await screen.findByTitle('EU AI Act')
    expect(frame.tagName).toBe('IFRAME')
    // A blob: URL, not the base64 data: URL. Chromium's built-in PDF viewer (pdf.js in
    // Electron) does not render `data:application/pdf` frames, and the document CSP
    // carries no `data:` in `frame-src` — so a data-URL modal was a modal that showed
    // nothing at all.
    expect(frame.getAttribute('src')).toMatch(/^blob:/)
    expect(screen.getByRole('dialog', { name: 'Media preview' })).toBeTruthy()
  })

  it('releases the PDF blob URL when the modal closes', async () => {
    const bridge = installBridge()
    render(<MediaGrid items={[item({
      kind: 'document',
      title: 'EU AI Act',
      url: 'https://example.test/act.pdf',
      thumbnailUrl: null,
      playable: false,
    })]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview EU AI Act' }))
    await screen.findByRole('dialog', { name: 'Media preview' })
    await waitFor(() => expect(bridge.createObjectURL).toHaveBeenCalled())
    const created = (bridge.createObjectURL.mock.results[0]?.value as string) ?? ''
    expect(created).toMatch(/^blob:/)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Media preview' })).toBeNull())
    // The blob URL of a closed preview is revoked, so a transcript full of previews
    // never accumulates object URLs nobody will ever use again.
    expect(bridge.revokeObjectURL).toHaveBeenCalledWith(created)
  })

  it('releases the previous PDF blob URL when switching to another item', async () => {
    const bridge = installBridge()
    render(<MediaGrid items={[
      item({ kind: 'document', title: 'EU AI Act', url: 'https://example.test/act.pdf', thumbnailUrl: null, playable: false }),
      item({ kind: 'document', title: 'Second Act', url: 'https://example.test/second.pdf', thumbnailUrl: null, playable: false }),
    ]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview EU AI Act' }))
    await screen.findByRole('dialog', { name: 'Media preview' })
    await waitFor(() => expect(bridge.createObjectURL).toHaveBeenCalledTimes(1))
    const first = bridge.createObjectURL.mock.results[0]?.value as string

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(bridge.createObjectURL).toHaveBeenCalledTimes(2))
    const second = bridge.createObjectURL.mock.results[1]?.value as string

    // The first document's URL is dead the moment the second document takes the stage.
    expect(bridge.revokeObjectURL).toHaveBeenCalledWith(first)
    expect(second).not.toBe(first)
  })
})

describe('the hosted player view', () => {
  it('mounts the player over the box when the host can draw it, and detaches on close', async () => {
    const mediaEmbedAttach = vi.fn(async () => ({ ok: true, width: 640, height: 360 }))
    const mediaEmbedDetach = vi.fn(async () => ({ ok: true }))
    installBridge()
    window.freyaHost = {
      ...window.freyaHost,
      mediaEmbedAttach,
      mediaEmbedDetach,
    } as unknown as FreyaHostBridge

    render(<MediaGrid items={[item({
      kind: 'video',
      title: 'Queue tutorial',
      url: 'https://www.youtube.com/watch?v=abc',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      embedUrl: 'https://www.youtube.com/embed/abc',
      playable: false,
    })]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview Queue tutorial' }))
    const dialog = await screen.findByRole('dialog', { name: 'Media preview' })
    await waitFor(() => expect(mediaEmbedAttach).toHaveBeenCalled())
    const request = (mediaEmbedAttach as unknown as { mock: { calls: Array<Array<{ url: string }>> } }).mock.calls[0]?.[0]
    expect(request?.url).toBe('https://www.youtube.com/embed/abc')
    // No iframe in the transcript: the player lives in the main process.
    expect((await screen.findAllByTitle('Queue tutorial')).find((node) => node.tagName === 'IFRAME')).toBeUndefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(mediaEmbedDetach).toHaveBeenCalled()
  })

  it('keeps the sandboxed iframe when the host has no player seam', async () => {
    installBridge()
    render(<MediaGrid items={[item({
      kind: 'video',
      title: 'Queue tutorial',
      url: 'https://www.youtube.com/watch?v=abc',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      embedUrl: 'https://www.youtube.com/embed/abc',
      playable: false,
    })]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview Queue tutorial' }))
    const frame = (await screen.findAllByTitle('Queue tutorial')).find((node) => node.tagName === 'IFRAME')
    expect(frame).toBeDefined()
  })
})
