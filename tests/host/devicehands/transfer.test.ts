import { describe, expect, it } from 'vitest'
import { hostHarness, ALLOWED_HOST, ALLOWED_ROOT } from './harness'
import type { TransferTarget } from '../../../core/devicehands'

function target(overrides: Partial<TransferTarget> = {}): TransferTarget {
  return {
    direction: 'download',
    url: `https://${ALLOWED_HOST}/file.txt`,
    mediaType: 'text/plain',
    bytes: 11,
    path: `${ALLOWED_ROOT}/file.txt`,
    fileName: 'file.txt',
    ...overrides,
  }
}

describe('transfer host adapter', () => {
  it('downloads, writes the file and observes its size at the destination', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.fetchDownload({ actionId: 'a', url: target().url, target: target() })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('observed')
    expect(outcome.bytes).toBe(11)
    expect(h.transfer.files.get(`${ALLOWED_ROOT}/file.txt`)?.byteLength).toBe(11)
  })

  it('refuses a download whose body size does not match the declared size', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.fetchDownload({ actionId: 'a', url: target().url, target: target({ bytes: 5 }) })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('transfer-size-mismatch')
    expect(h.counts.writeFile).toBe(0)
  })

  it('refuses a download whose media type does not match the declaration', async () => {
    const h = await hostHarness()
    h.transfer.getResult = { ...h.transfer.getResult, contentType: 'application/json' }
    const outcome = await h.effects.fetchDownload({ actionId: 'a', url: target().url, target: target() })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('media-type-mismatch')
    expect(h.counts.writeFile).toBe(0)
  })

  it('refuses a non-2xx response without writing anything', async () => {
    const h = await hostHarness()
    h.transfer.getResult = { ...h.transfer.getResult, status: 404 }
    const outcome = await h.effects.fetchDownload({ actionId: 'a', url: target().url, target: target() })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('http-status')
    expect(h.counts.writeFile).toBe(0)
  })

  it('uploads the file at its declared size and observes the server receipt', async () => {
    const h = await hostHarness()
    h.transfer.files.set(`${ALLOWED_ROOT}/file.txt`, new TextEncoder().encode('hello world'))
    const outcome = await h.effects.sendUpload({
      actionId: 'a',
      url: target({ direction: 'upload' }).url,
      target: target({ direction: 'upload' }),
    })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('observed')
    expect(outcome.bytes).toBe(11)
    expect(h.counts.httpPost).toBe(1)
  })

  it('refuses an upload whose source size does not match the declaration', async () => {
    const h = await hostHarness()
    h.transfer.files.set(`${ALLOWED_ROOT}/file.txt`, new TextEncoder().encode('short'))
    const outcome = await h.effects.sendUpload({
      actionId: 'a',
      url: target({ direction: 'upload' }).url,
      target: target({ direction: 'upload' }),
    })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('transfer-size-mismatch')
    expect(h.counts.httpPost).toBe(0)
  })

  it('reports a transport that throws as not held rather than as observed', async () => {
    const h = await hostHarness()
    h.transfer.getResult = { ...h.transfer.getResult, ok: false, code: 'transfer-failed' }
    const outcome = await h.effects.fetchDownload({ actionId: 'a', url: target().url, target: target() })
    expect(outcome.holds).toBe(false)
    expect(outcome.evidence).toBe('reported')
  })
})
