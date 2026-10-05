import { describe, expect, it } from 'vitest'
import { MediaOfferLog, auditMediaOffers, normaliseMediaOffer } from '../../../core/browser'

const AT = '2026-01-01T00:00:00.000Z'

function offer(raw: Record<string, unknown>) {
  return normaliseMediaOffer(raw, { sessionId: 'freya-0001', observedAt: AT })
}

describe('media metadata', () => {
  it('passes its own audit', () => {
    expect(auditMediaOffers()).toEqual([])
  })

  it('describes a download without ever carrying its bytes', () => {
    const reading = offer({
      mediaId: 'media-0001',
      url: 'https://example.com/invoice.pdf',
      fileName: 'invoice.pdf',
      mediaType: 'application/pdf',
      bytes: 24_000,
    })
    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    expect(reading.offer.fileName).toBe('invoice.pdf')
    expect(reading.offer.bytes).toBe(24_000)
    expect(reading.offer.transferable).toBe(true)
    // The declared size is metadata about a request, never a count of bytes read.
    expect(Object.keys(reading.offer).sort()).toEqual([
      'bytes',
      'fileName',
      'mediaId',
      'mediaType',
      'observedAt',
      'sessionId',
      'transferable',
      'url',
    ])
  })

  it('says plainly that an image cannot be transferred, because the transfer allowlist forbids it', () => {
    const reading = offer({
      mediaId: 'media-0001',
      url: 'https://example.com/a.png',
      fileName: 'a.png',
      mediaType: 'image/png',
      bytes: 4_096,
    })
    expect(reading.ok).toBe(true)
    if (reading.ok) expect(reading.offer.transferable).toBe(false)
  })

  it('refuses a file name that is a path, rather than reducing it to one', () => {
    for (const fileName of ['../../etc/passwd', 'a/b.pdf', 'a\\b.pdf', 'x'.repeat(200), '']) {
      const reading = offer({ mediaId: 'media-0001', url: 'https://example.com/a', fileName })
      expect(reading.ok, fileName).toBe(false)
    }
  })

  it('refuses a control character in a file name or a line break in a URL', () => {
    expect(offer({ mediaId: 'media-0001', url: 'https://example.com/a', fileName: 'a\u0000.pdf' }).ok).toBe(false)
    expect(offer({ mediaId: 'media-0001', url: 'https://example.com/a\nb', fileName: 'a.pdf' }).ok).toBe(false)
  })

  it('refuses an observation that is not an object, or has no usable identity', () => {
    for (const raw of [null, [], 'x', 42, {}, { mediaId: 'short', url: 'https://example.com/', fileName: 'a' }]) {
      expect(offer(raw as Record<string, unknown>).ok, JSON.stringify(raw)).toBe(false)
    }
  })

  it('treats an unknown size as unknown rather than as zero', () => {
    for (const bytes of [undefined, null, 0, -1, Number.NaN, 'lots']) {
      const reading = offer({ mediaId: 'media-0001', url: 'https://example.com/a', fileName: 'a.pdf', bytes })
      expect(reading.ok).toBe(true)
      if (reading.ok) expect(reading.offer.bytes, String(bytes)).toBeNull()
    }
  })
})

describe('the media log', () => {
  it('keeps the newest offers and forgets the oldest', () => {
    const log = new MediaOfferLog(2)
    for (const index of [1, 2, 3]) {
      const reading = offer({ mediaId: `media-000${String(index)}`, url: 'https://example.com/a', fileName: 'a.pdf' })
      if (!reading.ok) throw new Error('setup failed')
      log.record(reading.offer)
    }
    expect(log.size).toBe(2)
    expect(log.get('media-0001')).toBeNull()
    expect(log.get('media-0003')).not.toBeNull()
  })

  it('is emptied on close, so a closed session offers nothing', () => {
    const log = new MediaOfferLog()
    const reading = offer({ mediaId: 'media-0001', url: 'https://example.com/a', fileName: 'a.pdf' })
    if (!reading.ok) throw new Error('setup failed')
    log.record(reading.offer)
    log.clear()
    expect(log.list()).toEqual([])
    expect(log.get('media-0001')).toBeNull()
  })
})