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
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})

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
  it('opens the modal as an iframe that the in-Chat host could replace', async () => {
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
    // An iframe is the in-app default; a separate player seam can take it over
    // by exposing a `mediaEmbedAttach` on the host, but the modal must never be
    // empty in the meantime.
  })

  it('does not open browser tabs for media clicks, and only opens one preview after repeated clicks', async () => {
    const onOpenBrowserUrl = vi.fn()
    installBridge()
    render(<MediaGrid items={[item({
      kind: 'video',
      title: 'Queue tutorial',
      url: 'https://www.youtube.com/watch?v=abc',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      embedUrl: 'https://www.youtube.com/embed/abc',
      playable: false,
    })]} onOpenBrowserUrl={onOpenBrowserUrl} />)

    const button = await screen.findByRole('button', { name: 'Preview Queue tutorial' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getAllByRole('dialog', { name: 'Media preview' })).toHaveLength(1)
    expect(onOpenBrowserUrl).not.toHaveBeenCalled()
    expect(document.body.dataset.freyaMediaPreviewOpen).toBeTruthy()
    const frame = document.querySelector('.chats-overlay-video-embed')
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute('src')).toBe('https://www.youtube.com/embed/abc')
    expect(frame!.getAttribute('allow')).not.toContain('autoplay')

    fireEvent.click(screen.getByRole('button', { name: "Open this page in Freya's browser" }))
    expect(onOpenBrowserUrl).toHaveBeenCalledTimes(1)
    expect(onOpenBrowserUrl).toHaveBeenCalledWith('https://example.test/source', 'video')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.dataset.freyaMediaPreviewOpen).toBeUndefined()
  })

  it('navigates images, videos, and PDFs from this search in one modal and revokes PDF resources', async () => {
    const bridge = installBridge()
    const data = [
      item({ kind: 'image', title: 'Image A', url: 'https://cdn.example.test/a.jpg' }),
      item({ kind: 'video', title: 'Video B', url: 'https://www.youtube.com/watch?v=abc', embedUrl: 'https://www.youtube.com/embed/abc?autoplay=1', thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' }),
      item({ kind: 'document', title: 'PDF C', url: 'https://cdn.example.test/c.pdf', thumbnailUrl: null }),
    ]
    render(<MediaGrid items={data} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Image A' }))
    const dialog = screen.getByRole('dialog', { name: 'Media preview' })
    expect(dialog.textContent).toContain('1 / 3')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(dialog.textContent).toContain('2 / 3')
    const iframe = document.querySelector('.chats-overlay-video-embed')
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute('src')).toBe('https://www.youtube.com/embed/abc')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(dialog.textContent).toContain('3 / 3')
    await waitFor(() => expect(bridge.mediaDocument).toHaveBeenCalledWith('https://cdn.example.test/c.pdf'))
    expect((await screen.findByTitle('PDF C')).getAttribute('src')).toMatch(/^blob:/)
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(dialog.textContent).toContain('2 / 3')
    expect(bridge.revokeObjectURL).toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.dataset.freyaMediaPreviewOpen).toBeUndefined()
  })

  it('allows only one active preview when multiple search results exist in the transcript', async () => {
    installBridge()
    render(<>
      <MediaGrid items={[item({ kind: 'audio', title: 'Search One', url: 'https://cdn.public-fixture.org/a.mp3' })]} />
      <MediaGrid items={[item({ kind: 'audio', title: 'Search Two', url: 'https://cdn.public-fixture.org/b.mp3' })]} />
    </>)
    fireEvent.click(screen.getByRole('button', { name: 'Listen to Search One' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByLabelText('Search One').getAttribute('autoplay')).toBeNull()
    // Simulate a second click originating from another transcript result.
    fireEvent.click(screen.getByRole('button', { name: 'Listen to Search Two' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog').textContent).toContain('Search Two')
    expect(screen.getByLabelText('Search Two').getAttribute('autoplay')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not load private or local audio URLs through the media element', async () => {
    installBridge()
    render(<MediaGrid items={[item({
      kind: 'audio', title: 'Local audio', url: 'http://127.0.0.1:8080/private.mp3',
    })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Listen to Local audio' }))
    expect(screen.getByRole('dialog').textContent).toContain('refused')
    expect(document.querySelector('audio')).toBeNull()
  })

  it('refuses to embed unapproved hosted-player URLs', async () => {
    const bridge = installBridge()
    render(<MediaGrid items={[item({
      kind: 'video',
      title: 'Untrusted player',
      url: 'https://video.example.test/watch/abc',
      embedUrl: 'https://example.invalid/?autoplay=1',
      playable: false,
    })]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Untrusted player' }))
    expect(document.querySelector('.chats-overlay-video-embed')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(bridge.mediaVideo).not.toHaveBeenCalled()
  })
})
