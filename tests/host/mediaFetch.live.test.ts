import { describe, expect, it } from 'vitest'

import { fetchDocumentBytes, fetchThumbnail } from '../../electron/media'

/**
 * The fetch path, against the internet rather than a fixture.
 *
 * A stubbed transport would prove the plumbing and nothing about the thing that
 * actually goes wrong: real image hosts answer with redirects, with webp when you ask
 * for webp, with a 403 and an HTML body when they do not like you, and with a
 * 200-and-an-error-page more often than anyone admits. Those are the cases that decide
 * whether a card is honest, so they are the cases worth testing here.
 *
 * Skipped unless `FREYA_MEDIA_LIVE=1`, so the ordinary suite stays offline and
 * deterministic.
 */
const live = process.env.FREYA_MEDIA_LIVE === '1'

describe.skipIf(!live)('fetching media bytes, live', () => {
  it('returns a real image as a data URL, sniffed from its bytes', async () => {
    const result = await fetchThumbnail('https://images-assets.nasa.gov/image/PIA12348/PIA12348~thumb.jpg')
    expect(result.reason, `refused: ${String(result.reason)}`).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.format).toBe('image/jpeg')
  })

  it('follows a redirect, because that is how most picture hosts serve a picture', async () => {
    // A thumbnail CDN that answers `302` and nothing else is the normal case, not the
    // edge case. A card that only works for hosts serving bytes directly would be a
    // card that is empty most of the time.
    const result = await fetchThumbnail('https://picsum.photos/200')
    expect(result.reason, `refused: ${String(result.reason)}`).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.dataUrl).toMatch(/^data:image\//)
  })

  it('refuses a body that is not an image, however it was addressed', async () => {
    // An HTML page, fetched as though it were a picture. The server is happy; the bytes
    // are the evidence.
    const result = await fetchThumbnail('https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf')
    expect(result.ok).toBe(false)
    expect(result.dataUrl).toBeNull()
    expect(result.format).toBeNull()
    expect(result.reason).toMatch(/not a recognised image|not an image|text/)
  })

  it('refuses an address that is not a public destination', async () => {
    // SSRF, the reason this lives in the main process at all.
    const result = await fetchThumbnail('http://127.0.0.1:8899/search?q=x')
    expect(result.ok).toBe(false)
    // The transport's own wording, asserted rather than paraphrased: this is the
    // refusal that must never be softened into a retry.
    expect(result.reason).toMatch(/not a public/i)
  })

  it('refuses a PDF request aimed at something that is not a PDF', async () => {
    const result = await fetchDocumentBytes('https://images-assets.nasa.gov/image/PIA12348/PIA12348~thumb.jpg')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/not a PDF/)
  })

  it('fetches a real PDF and returns bytes, not a path', async () => {
    const result = await fetchDocumentBytes(
      'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    )
    expect(result.ok, `refused: ${JSON.stringify(result)}`).toBe(true)
    if (result.ok) {
      expect(result.base64.startsWith('JVBER')).toBe(true)
      expect(result.bytes).toBeGreaterThan(500)
    }
  })
})