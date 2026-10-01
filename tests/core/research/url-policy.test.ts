// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertPublicUrl, assertPublicAddress, normalizeSourceUrl } from '../../../core/research/url-policy'

describe('public URL policy', () => {
  it.each(['file:///etc/passwd', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com:444', 'http://localhost', 'http://x.localhost', 'http://printer.local', 'http://internal', 'http://127.1', 'http://0x7f000001', 'http://10.0.0.1', 'http://192.168.1.1', 'http://169.254.169.254', 'http://100.64.0.1', 'http://192.0.2.1', 'http://224.0.0.1', 'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[::ffff:8.8.8.8]', 'http://[2001:db8::1]'])('rejects %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow()
  })
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts globally routable %s', (ip) => {
    expect(() => assertPublicAddress(ip)).not.toThrow()
  })
  it.each(['127.0.0.1', '172.16.0.1', '198.18.0.1', '240.0.0.1', '::', '::ffff:127.0.0.1', '2002:0808:0808::1', '2001::1', 'not-ip'])('rejects reserved DNS answer %s', (ip) => {
    expect(() => assertPublicAddress(ip)).toThrow()
  })
  it('canonicalizes identity without losing meaningful query parameters', () => {
    expect(normalizeSourceUrl('https://EXAMPLE.com:443/a?x=1&utm_source=z&fbclid=abc#part')).toBe('https://example.com/a?x=1')
    expect(assertPublicUrl('https://example.com:443/x').hostname).toBe('example.com')
  })
})
