// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { attachEmbedView, detachEmbedView, type EmbedAttachRequest } from '../../electron/media'

/**
 * The window seam of the hosted player.
 *
 * The renderer names a player URL and a box; this gate re-checks the allowlist and
 * the bounds before any view exists, and only ever mounts on the asking window.
 * A search result's domain must never become an iframe, and a malformed box must
 * never become a player at the wrong size.
 */
function webContentsViewSpy() {
  const views: { bounds?: { x: number; y: number; width: number; height: number }; loaded?: string; closed?: boolean }[] = []
  const WebContentsView = vi.fn(function (this: {
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void
    webContents: { loadURL(url: string): Promise<void>; close(): void; isDestroyed(): boolean }
  }) {
    const record: { bounds?: { x: number; y: number; width: number; height: number }; loaded?: string; closed?: boolean } = {}
    views.push(record)
    this.setBounds = (bounds: { x: number; y: number; width: number; height: number }) => { record.bounds = bounds }
    this.webContents = {
      loadURL: vi.fn(async (url: string) => { record.loaded = url }),
      isDestroyed: () => record.closed === true,
      close: () => { record.closed = true },
    }
    return this
  }) as unknown as new (options: Record<string, unknown>) => {
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void
    webContents: { loadURL(url: string): Promise<void>; close(): void; isDestroyed(): boolean }
  }
  return { WebContentsView, views }
}

function fakeWindow() {
  const children: unknown[] = []
  const window = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: unknown) => { children.push(view) },
      removeChildView: (view: unknown) => {
        const at = children.indexOf(view)
        if (at >= 0) children.splice(at, 1)
      },
    },
  }
  return { window, children }
}

const attach = (over: Partial<EmbedAttachRequest> = {}): EmbedAttachRequest => ({
  url: 'https://www.youtube.com/embed/D5tr7r2_i7E',
  x: 10,
  y: 20,
  width: 640,
  height: 360,
  ...over,
})

describe('the hosted player gate', () => {
  it('mounts one sandboxed view at the given bounds for an allowlisted player', () => {
    const { WebContentsView, views } = webContentsViewSpy()
    const { window, children } = fakeWindow()

    const outcome = attachEmbedView(window, { WebContentsView }, attach())
    expect(outcome).toEqual({ ok: true, width: 640, height: 360 })
    expect(children).toHaveLength(1)
    expect(views[0]?.bounds).toEqual({ x: 10, y: 20, width: 640, height: 360 })
    expect(views[0]?.loaded).toBe('https://www.youtube.com/embed/D5tr7r2_i7E')
  })

  it('refuses a player host outside the allowlist, whatever the box', () => {
    const { WebContentsView, views } = webContentsViewSpy()
    const { window } = fakeWindow()

    const outcome = attachEmbedView(window, { WebContentsView }, attach({ url: 'https://evil.example/embed/42' }))
    expect(outcome.ok).toBe(false)
    expect(views).toHaveLength(0)
  })

  it('refuses a box that is not a bounded rectangle', () => {
    const { WebContentsView, views } = webContentsViewSpy()
    const { window } = fakeWindow()

    for (const over of [
      attach({ width: '640' as unknown as number }),
      attach({ height: Number.POSITIVE_INFINITY }),
      attach({ width: 1, height: 1 }),
    ]) {
      expect(attachEmbedView(window, { WebContentsView }, over).ok).toBe(false)
    }
    expect(views).toHaveLength(0)
  })

  it('detaches the previous player when a second one is asked, so switching stops playback', () => {
    const { WebContentsView, views } = webContentsViewSpy()
    const { window, children } = fakeWindow()

    attachEmbedView(window, { WebContentsView }, attach({ url: 'https://www.youtube.com/embed/aaa' }))
    attachEmbedView(window, { WebContentsView }, attach({ url: 'https://www.youtube.com/embed/bbb' }))
    expect(children).toHaveLength(1)
    expect(views).toHaveLength(2)
    expect(views[0]?.closed).toBe(true)
    expect(views[1]?.loaded).toBe('https://www.youtube.com/embed/bbb')
  })

  it('detaching stops playback and frees the view', () => {
    const { WebContentsView, views } = webContentsViewSpy()
    const { window, children } = fakeWindow()

    attachEmbedView(window, { WebContentsView }, attach())
    expect(detachEmbedView(window)).toBe(true)
    expect(children).toHaveLength(0)
    expect(views[0]?.closed).toBe(true)
    expect(detachEmbedView(window)).toBe(false)
  })
})
