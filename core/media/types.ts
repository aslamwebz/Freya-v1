/**
 * What Freya found, as data rather than prose.
 *
 * A search that returns pictures does not return a paragraph about pictures. It
 * returns URLs, and those URLs are the only trustworthy part of the result: the
 * model's description of an image is a guess about a picture nobody in this process
 * has seen. So media travels beside the answer as typed items the renderer can draw,
 * never as something re-parsed out of the text afterwards.
 *
 * The split is deliberate and follows what each kind can honestly be:
 *
 *  - `image` — something to look at. Drawn from bytes this process fetched.
 *  - `video` — something to play, *shown as a still*. A video card in a transcript
 *    that starts downloading and decoding the moment it renders is a card that costs
 *    bandwidth nobody asked for, in a surface nobody is reading yet.
 *  - `document` — something to open. Not drawn inline at all: a document's first page
 *    is only a picture if the whole file has been fetched and rasterised, which is a
 *    cost worth paying when someone asks for it and not while a transcript scrolls.
 */
export type MediaKind = 'image' | 'video' | 'document'

export interface MediaItem {
  readonly kind: MediaKind
  /** The media itself. Fetched by the main process, never by the window. */
  readonly url: string
  /** The page it was found on, for provenance and for "open the source". */
  readonly page: string
  readonly title: string
  readonly host: string
  /** Runtime as the source stated it, e.g. `12:40`. Absent rather than invented. */
  readonly duration: string | null
  /** Documents only, and only when something actually measured them. */
  readonly bytes: number | null
  readonly pages: number | null
  /**
   * Whether the source offers something this process can play.
   *
   * False does not mean the video disappears. It means the card is honest about it
   * and opens the page instead, which is the difference between "here is a video" and
   * "here is a video I can show you".
   */
  readonly playable: boolean
}

/**
 * Ceilings for anything fetched to be shown.
 *
 * Every one of these is a data: URL or a base64 string that crosses into the renderer
 * and sits in a transcript, so "unbounded" is not an option and a large default is not
 * a safe one. A thumbnail larger than this is a page, not a thumbnail.
 */
export const MEDIA_LIMITS = Object.freeze({
  /** Bytes for a still image. Four megabytes is already a poster of a video. */
  thumbnailBytes: 4 * 1024 * 1024,
  /** Bytes for a document handed to the PDF renderer. */
  documentBytes: 16 * 1024 * 1024,
  /** Cards shown for one answer, across every search it made. */
  cardsPerAnswer: 12,
})