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

  window.freyaHost = {
    isDesktop: true,
    mediaThumbnail,
    mediaDocument,
    mediaVideo,
  } as unknown as FreyaHostBridge

  return { mediaThumbnail, mediaDocument, mediaVideo }
}

afterEach(() => {
  cleanup()
  delete window.freyaHost
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

  it('loads a PDF into an in-app preview frame', async () => {
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
    expect(frame.getAttribute('src')).toMatch(/^data:application\/pdf;base64,/)
    expect(screen.getByRole('dialog', { name: 'Media preview' })).toBeTruthy()
  })
})
