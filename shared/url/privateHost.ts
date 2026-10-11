function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0]
}

/**
 * Whether a host is loopback, private, link-local or otherwise not on the public web.
 *
 * Over-matches a little on purpose (a bare single-label name is treated as internal),
 * because the cost of refusing a public page is one refusal and the cost of allowing a
 * router admin page is a different kind of failure entirely.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '' || lower === 'localhost') return true
  if (lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true
  }
  if (!lower.includes('.') && !lower.includes(':')) return true
  const v4 = parseIpv4(lower)
  if (v4 !== null) {
    const [a, b] = v4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true
  }
  return false
}
