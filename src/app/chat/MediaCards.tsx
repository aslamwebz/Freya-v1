import { useEffect, useRef, useState } from 'react'

import type { MediaItem } from '../../../core/media/types'
import { hostBridge } from '../../platform/host'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import './media.css'

/**
 * What a search found, drawn in the transcript.
 *
 * ## Posters, not players
 *
 * A video card shows a still. The alternative — a `<video>` in the transcript — starts
 * downloading and decoding the moment it renders, in a surface that may be scrolled
 * past, and half a dozen of them is a bandwidth bill nobody agreed to. The card says
 * what it is; pressing it is what costs anything.
 *
 * ## Nothing is drawn from a claim
 *
 * Every card needs a picture, and no picture is fetched by this file. The window asks
 * the main process for the bytes and receives a `data:` URL or a refusal. A card whose
 * picture cannot be fetched renders **nothing at all** rather than a grey box with a
 * title — a broken tile is a promise the search did not keep, and there is no honest
 * version of it to fall back on.
 *
 * Cards are also re-fetched per address and remembered for the life of the window, so
 * scrolling back up does not download the same picture twice.
 */

/** Posters already fetched, by address. A window is the right lifetime for this. */
const posters = new Map<string, string>()
/** Fetches in flight, so ten cards for one address make one request. */
const pending = new Map<string, Promise<string | null>>()

async function posterFor(item: MediaItem): Promise<string | null> {
  const address = item.url
  const remembered = posters.get(address)
  if (remembered !== undefined) return remembered

  const inFlight = pending.get(address)
  if (inFlight !== undefined) return await inFlight

  const bridge = hostBridge()
  if (bridge === undefined) return null

  const request = bridge.mediaThumbnail(address)
    .then((reply: unknown) => {
      const outcome = reply as { ok?: unknown; dataUrl?: unknown } | null
      // A refusal is a normal answer here. `ok: false` means the main process decided
      // this may not be fetched, or the bytes were not a picture — and both mean the
      // card draws nothing.
      if (outcome === null || outcome.ok !== true) return null
      const dataUrl = outcome.dataUrl
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
      posters.set(address, dataUrl)
      return dataUrl
    })
    .catch(() => null)
    .finally(() => {
      pending.delete(address)
    })

  pending.set(address, request)
  return await request
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** One card. Returns `null` when there is no picture to draw, which is most honest. */
function MediaCard({ item, all, index, onOpen }: {
  readonly item: MediaItem
  readonly onOpen: (item: MediaItem, all: readonly MediaItem[], index: number) => void
  readonly all: readonly MediaItem[]
  readonly index: number
}) {
  const [poster, setPoster] = useState<string | null>(posters.get(item.url) ?? null)
  const [refused, setRefused] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (poster !== null || item.kind === 'document') return undefined
    void posterFor(item).then((dataUrl) => {
      if (!mounted.current) return
      // No picture, no card. Not a placeholder, not a broken image icon.
      if (dataUrl === null) setRefused(true)
      else setPoster(dataUrl)
    })
    return () => {
      mounted.current = false
    }
  }, [item, poster])

  // A document has no poster to fetch: drawing its first page means fetching the whole
  // file, which is a cost worth paying when someone presses it and not while a
  // transcript scrolls. So the card is a label, and the label is the whole truth.
  if (item.kind === 'document') {
    return (
      <button
        type="button"
        className="chats-doc-card"
        onClick={() => onOpen(item, all, index)}
        aria-label={`Open ${item.title || 'document'}`}
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
      onClick={() => onOpen(item, all, index)}
      aria-label={video ? `Play ${item.title || 'video'}` : `Open ${item.title || 'picture'}`}
      title={item.page}
    >
      <span className={video ? 'chats-video-shot' : 'chats-image-frame'}>
        <img src={poster} alt="" loading="lazy" />
        {video ? (
          <>
            {/* The badge says what pressing it will do, and which: a play glyph for a
                file this process can play, an arrow for one it cannot. */}
            <span className="chats-video-play" aria-hidden="true">{item.playable ? '▶' : '↗'}</span>
            {item.duration === null ? null : (
              <span className="chats-video-length">{item.duration}</span>
            )}
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

/**
 * The grid, and the overlay that shows one of them properly.
 *
 * The overlay steps between the cards in this answer rather than opening a window per
 * picture, so "show me the next one" is a keypress instead of a hunt.
 */
export function MediaGrid({ items, onOpenPage }: {
  readonly items: readonly MediaItem[]
  readonly onOpenPage: (url: string) => void
}) {
  const [open, setOpen] = useState<{ item: MediaItem; index: number } | null>(null)

  if (items.length === 0) return null

  return (
    <>
      <div className="chats-media" data-kind={items[0]?.kind}>
        {items.map((item, index) => (
          <MediaCard
            key={item.url}
            item={item}
            all={items}
            index={index}
            onOpen={(chosen, _siblings, at) => setOpen({ item: chosen, index: at })}
          />
        ))}
      </div>
      {open === null ? null : (
        <MediaOverlay
          items={items}
          index={open.index}
          onIndex={(next) => setOpen({ item: items[next] ?? items[0]!, index: next })}
          onOpenPage={onOpenPage}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

/** One picture or document, large, with the rest of the answer a keypress away. */
function MediaOverlay({ items, index, onIndex, onOpenPage, onClose }: {
  readonly items: readonly MediaItem[]
  readonly index: number
  readonly onIndex: (next: number) => void
  readonly onOpenPage: (url: string) => void
  readonly onClose: () => void
}) {
  const item = items[index]
  const many = items.length > 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && many) onIndex((index + 1) % items.length)
      else if (event.key === 'ArrowLeft' && many) onIndex((index - 1 + items.length) % items.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, many, onClose, onIndex])

  if (item === undefined) return null
  const [full, setFull] = useState<string | null>(null)

  useEffect(() => {
    // A document's bytes are fetched only now, because this is the moment somebody
    // asked for it.
    if (item.kind !== 'document') return
    const bridge = hostBridge()
    if (bridge === undefined) return
    void bridge.mediaDocument(item.url).then((reply: unknown) => {
      const outcome = reply as { ok?: unknown } | null
      setFull(outcome?.ok === true ? item.url : null)
    }).catch(() => setFull(null))
  }, [item])

  return (
    <div className="chats-overlay" role="dialog" aria-label="Media" onClick={onClose}>
      <div className="chats-overlay-panel" onClick={(event) => event.stopPropagation()}>
        <header className="chats-overlay-bar">
          <span className="chats-overlay-name">{item.title || 'Preview'}</span>
          <span className="chats-overlay-host">{item.host || hostOf(item.page)}</span>
          <span className="chats-overlay-count">{String(index + 1)} / {String(items.length)}</span>
          <button type="button" className="chats-overlay-open" onClick={() => onOpenPage(item.page)}>
            <Glyph name="external" size={15} />
            <span>Open page</span>
          </button>
          <button type="button" className="chats-overlay-close" onClick={onClose} aria-label="Close preview">×</button>
        </header>
        <div className="chats-overlay-stage">
          {many ? (
            <button type="button" className="chats-overlay-nav prev" onClick={() => onIndex((index - 1 + items.length) % items.length)} aria-label="Previous">‹</button>
          ) : null}
          {item.kind === 'video' && item.playable ? (
            <video className="chats-overlay-video" src={item.url} controls playsInline />
          ) : item.kind === 'document' ? (
            <p className="chats-overlay-note">
              {full === null
                ? 'This document could not be opened here. The page it came from can still show it.'
                : 'Opened outside the transcript — the page has the document.'}
            </p>
          ) : (
            <img className="chats-overlay-image" src={item.url} alt={item.title || ''} />
          )}
          {many ? (
            <button type="button" className="chats-overlay-nav next" onClick={() => onIndex((index + 1) % items.length)} aria-label="Next">›</button>
          ) : null}
        </div>
      </div>
    </div>
  )
}