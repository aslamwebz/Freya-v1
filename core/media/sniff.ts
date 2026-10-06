/**
 * Deciding what a downloaded body actually is.
 *
 * By bytes, never by the `Content-Type` header and never by the extension. Both of
 * those are claims by the server, and a server that serves an HTML error page from a
 * `.jpg` URL with `image/jpeg` in the header is not exotic — it is what a rate limit,
 * a login wall and a CDN hiccup all look like. Only the leading bytes are evidence.
 *
 * The failure this prevents is concrete: a card that renders a browser error page as
 * though it were the picture Freya found, or a "PDF" that is a login form.
 */

/** The image formats a card can actually draw. */
export type ImageFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/** ASCII prefix, compared as text so the signatures read as the spec writes them. */
function asciiPrefix(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/**
 * The image format these bytes are, or `null` if they are not an image.
 *
 * WebP and GIF are matched on their container plus a discriminator, because both
 * have signatures that other formats also start with: `RIFF` is a container, and
 * `GIF` sits at a fixed offset in a header whose first bytes are shared.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (asciiPrefix(bytes, 'RIFF') && asciiPrefix(bytes, 'WEBP', 8)) return 'image/webp'
  if (asciiPrefix(bytes, 'GIF87a') || asciiPrefix(bytes, 'GIF89a')) return 'image/gif'
  return null
}

/**
 * Whether these bytes are a PDF.
 *
 * `%PDF-` only. The specification's own header, checked at the start, which is where a
 * conforming file puts it.
 */
export function isPdf(bytes: Uint8Array): boolean {
  return asciiPrefix(bytes, '%PDF-')
}

/**
 * The kind of media these bytes are, for a card that was promised to be something.
 *
 * Returns `null` when the body is not what the card claims. The caller shows nothing
 * in that case, which is the honest outcome: a card is a claim about the world, and a
 * body that contradicts it should take the card with it rather than be drawn.
 */
export function sniffMediaKind(bytes: Uint8Array): ImageFormat | 'application/pdf' | null {
  const image = sniffImageFormat(bytes)
  if (image !== null) return image
  return isPdf(bytes) ? 'application/pdf' : null
}