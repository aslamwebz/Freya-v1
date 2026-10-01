import { isIP } from 'node:net'
import { ResearchError } from './errors'

const ipv4Reserved: readonly [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
]

/** Reject special/reserved ranges, including IPv4-mapped and transition IPv6. */
export function assertPublicAddress(address: string): void {
  const kind = isIP(address)
  if (kind === 4) {
    const value = address.split('.').reduce((number, octet) => (number * 256 + Number(octet)) >>> 0, 0)
    if (!ipv4Reserved.some(([network, bits]) => (value >>> (32 - bits)) === (network >>> (32 - bits)))) return
  } else if (kind === 6 && !address.includes('.') && !address.includes('%')) {
    const [left = '', right = ''] = address.toLowerCase().split('::')
    const head = left ? left.split(':') : []
    const tail = right ? right.split(':') : []
    const words = address.includes('::') ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head
    const first = Number.parseInt(words[0] ?? '0', 16)
    const second = Number.parseInt(words[1] ?? '0', 16)
    // Only global-unicast 2000::/3, excluding special 2001::/23,
    // documentation, deprecated 6to4 and documentation 3fff::/20.
    if ((first & 0xe000) === 0x2000 && !(first === 0x2001 && second < 0x0200) &&
      !(first === 0x2001 && second === 0x0db8) && first !== 0x2002 &&
      !(first === 0x3fff && second < 0x1000)) return
  }
  throw new ResearchError('unsafe_url')
}

export function assertPublicUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > 8192 || [...input].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new ResearchError('invalid_url')
  let url: URL
  try { url = new URL(input) } catch { throw new ResearchError('invalid_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new ResearchError('unsafe_url')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (isIP(host)) assertPublicAddress(host)
  else {
    if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-')) ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion)$/.test(host)) throw new ResearchError('unsafe_url')
  }
  return url
}

export function normalizeSourceUrl(input: string): string {
  const url = assertPublicUrl(input)
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(?:fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key)
  }
  return url.href
}
