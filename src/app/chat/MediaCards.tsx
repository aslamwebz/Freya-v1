import { useEffect, useMemo, useRef, useState } from 'react'

import type { MediaItem } from '../../../core/media/types'
import { hostBridge } from '../../platform/host'
import './media.css'

const images = new Map<string, string>()
const pendingImages = new Map<string, Promise<string | null>>()

async function imageFor(address: string): Promise<string | null> {
  const remembered = images.get(address)
  if (remembered !== undefined) return remembered

  const inFlight = pendingImages.get(address)
  if (inFlight !== undefined) return await inFlight

  const bridge = hostBridge()
  if (bridge === undefined) return null

  const request = bridge.mediaThumbnail(address)
    .then((reply: unknown) => {
      const outcome = reply as { ok?: unknown; dataUrl?: unknown } | null
      const dataUrl = outcome?.ok === true ? outcome.dataUrl : null
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
      images.set(address, dataUrl)
      return dataUrl
    })
    .catch(() => null)
    .finally(() => pendingImages.delete(address))

  pendingImages.set(address, request)
  return await request
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function posterAddress(item: MediaItem): string | null {
  if (item.kind === 'document') return null
  return item.thumbnailUrl ?? item.url
}

function MediaCard({ item, index, onOpen }: {
  readonly item: MediaItem
  readonly index: number
  readonly onOpen: (index: number) => void
}) {
  const address = posterAddress(item)
  const [poster, setPoster] = useState<string | null>(
    address === null ? null : (images.get(address) ?? null),
  )
  const [refused, setRefused] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    setRefused(false)

    if (item.kind === 'document' || address === null) {
      return () => { mounted.current = false }
    }

    const cached = images.get(address)
    if (cached !== undefined) {
      setPoster(cached)
      return () => { mounted.current = false }
    }

    setPoster(null)
    void imageFor(address).then((dataUrl) => {
      if (!mounted.current) return
      if (dataUrl === null) setRefused(true)
      else setPoster(dataUrl)
    })

    return () => {
      mounted.current = false
    }
  }, [address, item.kind])

  if (item.kind === 'document') {
    return (
      <button
        type="button"
        className="chats-doc-card"
        onClick={() => onOpen(index)}
        aria-label={`Preview ${item.title || 'document'}`}
      >
        <span className="chats-doc-icon" aria-hidden="true">PDF</span>
        <span className="chats-doc-text">
          <span className="chats-doc-name">{item.title || 'Document'}</span>
          <span className="chats-doc-meta">
            {[item.host || hostOf(item.page), item.pages === null ? null : `${String(item.pages)} pages`]
              .filter((part): part is string => part !== null && part !== '')
              .join(' · ')}
          </span>
        </span>
      </button>
    )
  }

  if (refused || poster === null) return null

  const video = item.kind === 'video'
  return (
    <button
      type="button"
      className={video ? 'chats-video-card' : 'chats-image-tile'}
      onClick={() => onOpen(index)}
      aria-label={video ? `Preview ${item.title || 'video'}` : `Preview ${item.title || 'image'}`}
      title={item.title || item.host || undefined}
    >
      <span className={video ? 'chats-video-shot' : 'chats-image-frame'}>
        <img src={poster} alt="" loading="lazy" />
        {video ? (
          <>
            <span className="chats-video-play" aria-hidden="true">▶</span>
            {item.duration === null ? null : <span className="chats-video-length">{item.duration}</span>}
          </>
        ) : null}
      </span>
      {video ? (
        <span className="chats-video-text">
          <span className="chats-video-name">{item.title || 'Video'}</span>
          <span className="chats-video-by">{item.host || hostOf(item.page)}</span>
        </span>
      ) : null}
    </button>
  )
}

export function MediaGrid({ items, onOpenBrowserUrl }: {
  readonly items: readonly MediaItem[]
  readonly onOpenBrowserUrl?: (url: string, kind?: 'video' | 'image' | 'pdf' | 'document' | 'page') => void
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  if (items.length === 0) return null

  return (
    <>
      <div className="chats-media" data-kind={items[0]?.kind}>
        {items.map((item, index) => (
          <MediaCard
            key={`${item.kind}:${item.url}:${String(index)}`}
            item={item}
            index={index}
            onOpen={(selected) => { const found = items[selected]; if (onOpenBrowserUrl && found) onOpenBrowserUrl(found.page || found.url, found.kind === 'document' ? 'document' : found.kind); else setOpenIndex(selected) }}
          />
        ))}
      </div>
      {openIndex === null ? null : (
        <MediaOverlay
          items={items}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      )}
    </>
  )
}

/**
 * The hosted player's box, measured for the main process.
 *
 * The player itself is a main-process view layered over this box's bounds: a
 * `file://` transcript cannot iframe a hosted player (the frame origin reads as
 * `null` and the player refuses it), so the box here is only the placeholder the
 * view is drawn over. When no bridge exists — tests, a plain browser — the box
 * degrades to a plain sandboxed iframe, which is where that path is acceptable.
 */
function MediaOverlay({ items, index, onIndex, onClose, onOpenBrowserUrl }: {
  readonly items: readonly MediaItem[]
  readonly index: number
  readonly onIndex: (next: number) => void
  readonly onClose: () => void
  readonly onOpenBrowserUrl?: (url: string, kind?: 'video' | 'image' | 'pdf' | 'document' | 'page') => void
}) {
  const item = items[index] ?? items[0]!
  const many = items.length > 1
  const bridge = hostBridge()

  const [imageData, setImageData] = useState<string | null>(null)
  const [videoData, setVideoData] = useState<string | null>(null)
  const [documentData, setDocumentData] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reason, setReason] = useState<string | null>(null)

  // The renderer cannot revoke the object URL in the effect's cleanup through a
  // state field, so it is remembered here instead: one per mounted overlay item.
  const documentUrlRef = useRef<string | null>(null)
  const revokeDocument = (): void => {
    if (documentUrlRef.current !== null) {
      URL.revokeObjectURL(documentUrlRef.current)
      documentUrlRef.current = null
    }
  }

  const fallbackPoster = useMemo(() => {
    const address = posterAddress(item)
    return address === null ? null : images.get(address) ?? null
  }, [item])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && many) onIndex((index + 1) % items.length)
      else if (event.key === 'ArrowLeft' && many) onIndex((index - 1 + items.length) % items.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, many, onClose, onIndex])

  useEffect(() => {
    let alive = true
    setImageData(null)
    setVideoData(null)
    setDocumentData(null)
    setReason(null)
    setLoading(true)
    revokeDocument()

    const load = async (): Promise<void> => {
      if (bridge === undefined) {
        if (alive) {
          setReason('Preview is unavailable because the Freya host bridge is not connected.')
          setLoading(false)
        }
        return
      }

      if (item.kind === 'image') {
        const full = await imageFor(item.url)
        const shown = full ?? fallbackPoster
        if (!alive) return
        setImageData(shown)
        if (shown === null) setReason('This image could not be fetched safely for preview.')
        setLoading(false)
        return
      }

      if (item.kind === 'video') {
        if (item.embedUrl) {
          if (!alive) return
          setLoading(false)
          return
        }
        if (!item.playable) {
          if (!alive) return
          setReason('This video has no safe in-app player. Freya will keep the result here instead of opening a browser automatically.')
          setLoading(false)
          return
        }
        const reply = await bridge.mediaVideo(item.url).catch(() => null) as {
          ok?: unknown
          dataUrl?: unknown
          reason?: unknown
        } | null
        if (!alive) return
        if (reply?.ok === true && typeof reply.dataUrl === 'string' && reply.dataUrl.startsWith('data:video/')) {
          setVideoData(reply.dataUrl)
        } else {
          setReason(typeof reply?.reason === 'string' ? reply.reason : 'This video could not be fetched safely for preview.')
        }
        setLoading(false)
        return
      }

      const reply = await bridge.mediaDocument(item.url).catch(() => null) as {
        ok?: unknown
        base64?: unknown
        reason?: unknown
      } | null
      if (!alive) return
      if (reply?.ok === true && typeof reply.base64 === 'string' && reply.base64.length > 0) {
        // A blob: URL, not the raw base64 data: URL. Chromium's built-in PDF viewer
        // (pdf.js in Electron) refuses to render data: application/pdf frames, and the
        // document's CSP does not carry `data:` in `frame-src` — a blob: URL is same-origin
        // to this window, renders in the viewer, and dies with the modal.
        const bytes = Uint8Array.from(atob(reply.base64), (char) => char.charCodeAt(0))
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        documentUrlRef.current = objectUrl
        setDocumentData(objectUrl)
      } else {
        setReason(typeof reply?.reason === 'string' ? reply.reason : 'This PDF could not be fetched safely for preview.')
      }
      setLoading(false)
    }

    void load()
    return () => {
      alive = false
      revokeDocument()
    }
  }, [bridge, fallbackPoster, item])

  return (
    <div className="chats-overlay" role="dialog" aria-modal="true" aria-label="Media preview" onClick={onClose}>
      <div className="chats-overlay-panel" onClick={(event) => event.stopPropagation()}>
        <header className="chats-overlay-bar">
          <span className="chats-overlay-name">{item.title || 'Preview'}</span>
          <span className="chats-overlay-host">{item.host || hostOf(item.page)}</span>
          <span className="chats-overlay-count">{String(index + 1)} / {String(items.length)}</span>
          {/* Always offer the in-app browser as a real fallback — several hosted
              providers refuse to play inside a `file://` transcript's iframe, and
              the user expects the preview to keep working rather than a black
              rectangle. */}
          {onOpenBrowserUrl && item.page && item.page !== '' ? (
            <button
              type="button"
              className="chats-overlay-open"
              aria-label="Open this page in Freya's browser"
              onClick={() => onOpenBrowserUrl(item.page, item.kind === 'document' ? 'pdf' : item.kind)}
            >
              Open in browser
            </button>
          ) : null}
          <button type="button" className="chats-overlay-close" onClick={onClose} aria-label="Close preview">×</button>
        </header>
        <div className="chats-overlay-stage">
          {many ? (
            <button type="button" className="chats-overlay-nav prev" onClick={() => onIndex((index - 1 + items.length) % items.length)} aria-label="Previous">‹</button>
          ) : null}

          {loading ? <p className="chats-overlay-note">Loading preview…</p> : null}

          {!loading && item.kind === 'image' && imageData !== null ? (
            <img className="chats-overlay-image" src={imageData} alt={item.title || ''} />
          ) : null}

          {!loading && item.kind === 'video' ? (
            item.embedUrl
              ? (
                // Sandboxed iframe. A `file://` transcript document has a null
                // origin, and several providers (YouTube most visibly) refuse to
                // play under that — the parent calls the host's BrowserWorkspace
                // through `openBrowserRequested` so the user can keep watching in
                // Freya's own browser. The iframe here is the best honest attempt
                // inside the modal and degrades to a poster + an open-in-browser
                // button if the provider rejects the embed.
                <iframe
                  className="chats-overlay-video-embed"
                  src={item.embedUrl}
                  title={item.title || 'Video preview'}
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  sandbox="allow-scripts allow-same-origin allow-presentation"
                  allowFullScreen
                />
              )
              : videoData !== null
                ? <video className="chats-overlay-video" src={videoData} controls autoPlay playsInline />
                : (
                  <div className="chats-overlay-video-fallback">
                    {fallbackPoster === null ? null : <img src={fallbackPoster} alt="" />}
                    {reason === null ? null : <p className="chats-overlay-note">{reason}</p>}
                  </div>
                )
          ) : null}

          {!loading && item.kind === 'document' && documentData !== null ? (
            <iframe className="chats-overlay-pdf" src={documentData} title={item.title || 'PDF preview'} />
          ) : null}

          {!loading && item.kind !== 'video' && (
            (item.kind === 'image' && imageData === null) ||
            (item.kind === 'document' && documentData === null)
          ) && reason !== null ? (
            <p className="chats-overlay-note">{reason}</p>
          ) : null}

          {many ? (
            <button type="button" className="chats-overlay-nav next" onClick={() => onIndex((index + 1) % items.length)} aria-label="Next">›</button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
