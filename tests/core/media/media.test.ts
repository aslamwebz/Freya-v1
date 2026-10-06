import { describe, expect, it } from 'vitest'

import { isPdf, sniffImageFormat, sniffMediaKind } from '../../../core/media/sniff'
import { MEDIA_LIMITS, type MediaItem } from '../../../core/media/types'

/**
 * The bodies these have to survive.
 *
 * Every case below is something that actually comes back from the internet when you ask
 * it for a picture: an error page dressed as a JPEG, a login wall dressed as a PDF, a
 * tracking pixel, an empty body, a redirect stub. The function is small; the reason it
 * exists is that it is the only thing standing between those and a card in a transcript
 * that lies.
 */
describe('sniffing a downloaded body', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
  const webp = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')])
  const gif = Uint8Array.from(Buffer.from('GIF89a....'))

  it('recognises the formats a card can draw', () => {
    expect(sniffImageFormat(jpeg)).toBe('image/jpeg')
    expect(sniffImageFormat(png)).toBe('image/png')
    expect(sniffImageFormat(webp)).toBe('image/webp')
    expect(sniffImageFormat(gif)).toBe('image/gif')
  })

  it('rejects the things a server sends when it will not give you the picture', () => {
    const errorPage = Uint8Array.from(Buffer.from('<!doctype html><title>429 Too Many Requests'))
    const loginWall = Uint8Array.from(Buffer.from('<html><body>Please sign in to continue'))
    const empty = new Uint8Array(0)
    const truncated = Uint8Array.from([0xff, 0xd8])

    expect(sniffImageFormat(errorPage)).toBeNull()
    expect(sniffImageFormat(loginWall)).toBeNull()
    expect(sniffImageFormat(empty)).toBeNull()
    expect(sniffImageFormat(truncated)).toBeNull()
  })

  it('does not mistake a bare RIFF container for a picture', () => {
    // `RIFF` is a container several formats share; only the `WEBP` fourcc makes it one.
    const wav = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVEfmt ')])
    expect(sniffImageFormat(wav)).toBeNull()
  })

  it('identifies a PDF by its own header, not by a filename', () => {
    expect(isPdf(Uint8Array.from(Buffer.from('%PDF-1.7\n1 0 obj')))).toBe(true)
    expect(isPdf(Uint8Array.from(Buffer.from('%PDX-1.7')))).toBe(false)
    expect(sniffMediaKind(Uint8Array.from(Buffer.from('%PDF-1.7')))).toBe('application/pdf')
  })

  it('says nothing at all about an HTML body served from a .jpg URL', () => {
    // The whole reason for this module: the URL, the extension and the header would all
    // have said "image". Only the bytes do not.
    const bytes = Uint8Array.from(Buffer.from('<!doctype html><html>not found</html>'))
    expect(sniffMediaKind(bytes)).toBeNull()
  })

  it('holds to a bounded set of formats rather than trusting the server', () => {
    // An SVG is an image to most people and an active document to a renderer. It is not
    // on the list, and being absent is the safe answer.
    const svg = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))
    expect(sniffImageFormat(svg)).toBeNull()
    expect(MEDIA_LIMITS.thumbnailBytes).toBeLessThan(MEDIA_LIMITS.documentBytes)
  })
})

describe('a media item', () => {
  const base: MediaItem = {
    kind: 'image',
    url: 'https://cdn.example/a.jpg',
    page: 'https://example.org/page',
    title: 'A real picture',
    host: 'example.org',
    duration: null,
    bytes: null,
    pages: null,
    playable: false,
  }

  it('carries provenance, so a card can say where it came from', () => {
    expect(base.host).toBe('example.org')
    expect(base.page).toMatch(/^https:\/\//)
  })

  it('says "not playable" rather than pretending', () => {
    // A video the source will not let us play is still worth showing as a card with a
    // poster; what it must not do is imply a player exists.
    const video: MediaItem = { ...base, kind: 'video', playable: false, duration: null }
    expect(video.playable).toBe(false)
    expect(video.duration).toBeNull()
  })
})