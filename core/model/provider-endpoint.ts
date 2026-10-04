/**
 * The canonical provider endpoint policy.
 *
 * ## Why this file exists
 *
 * A provider base URL is the one setting that decides **where a stored API key is
 * sent**. Every other setting changes what Freya says or does; this one changes
 * who receives a credential. That makes it the single highest-consequence value a
 * renderer can influence, because the renderer is explicitly the untrusted half of
 * this system (`docs/ARCHITECTURE.md` §2) and it may legitimately ask for a base URL
 * to change.
 *
 * Before this existed the base URL was checked for **length only**, in three places
 * that all agreed to check nothing:
 *
 *   - `electron/preload.ts` bounded the string length;
 *   - `electron/providerConfig.ts` persisted whatever string it was handed;
 *   - `core/model/nanogpt-provider.ts` trimmed it and stripped trailing slashes.
 *
 * `readNanoGptConfig` then handed the result straight to `fetch` with
 * `authorization: Bearer <key>`. So a renderer that could never read the key could
 * still have it **exfiltrated**: save `baseUrl = https://attacker.example`, submit a
 * turn, and the key arrives at a host chosen by the renderer. The same primitive
 * reached `http://` (a transport downgrade) and `169.254.169.254` (a metadata
 * service). This module closes that.
 *
 * ## The rule
 *
 * A provider endpoint is **an exact, enumerated origin**. It is not a URL the
 * renderer composes. If a host is not named in {@link PROVIDER_ENDPOINT_POLICY} it
 * is refused, with no wildcard, no suffix match and no "starts with".
 *
 * A host allowlist rather than a blocklist is the deliberate choice. A blocklist has
 * to enumerate every bad host, and the list of hosts that are not the provider is
 * unbounded — new cloud metadata endpoints, new private ranges, new reserved TLDs.
 * An allowlist has to enumerate the good ones, and there is exactly one.
 *
 * The IP and special-name checks below are therefore *defence in depth*: the
 * allowlist already rejects every address. They are kept because a future policy
 * entry must not be able to widen this into something unsafe, and because they give a
 * specific refusal reason where "not approved" alone would be a confusing thing to
 * read.
 *
 * ## Where it is enforced
 *
 * Four boundaries, because a check at only one of them is a check that can be
 * routed around:
 *
 *   1. `electron/preload.ts` — the renderer boundary, before a value crosses.
 *   2. `electron/providerConfig.ts` — before a value is persisted to disk.
 *   3. `core/model/nanogpt-provider.ts` — when configuration is loaded into a provider.
 *   4. `core/model/nanogpt-provider.ts` again, per hop, on the transport — including
 *      every redirect, immediately before the `Authorization` header is attached.
 *
 * (4) is the one that actually matters. The others are early refusals that produce a
 * better message; this one is the property.
 */

/** A refusal, as a closed code plus a sentence a surface can show verbatim. */
export interface ProviderEndpointRefusal {
  readonly code: ProviderEndpointRefusalCode
  readonly reason: string
}

export type ProviderEndpointRefusalCode =
  | 'not-a-string'
  | 'empty'
  | 'too-long'
  | 'control-character'
  | 'not-absolute-url'
  | 'not-https'
  | 'credentials-in-url'
  | 'query-or-fragment'
  | 'explicit-port'
  | 'address-literal'
  | 'loopback'
  | 'link-local'
  | 'private-network'
  | 'metadata-service'
  | 'special-use-name'
  | 'host-not-approved'
  | 'redirect-not-allowed'
  | 'https-downgrade'

/**
 * Thrown when an endpoint fails the policy.
 *
 * A named error rather than a bare `Error` so a caller can distinguish "this URL is
 * not permitted" from "the network is down" — the first is a refusal to report, the
 * second is an operational failure. Collapsing them would let a refusal be logged as
 * a fault and a fault be reported as a refusal.
 */
export class ProviderEndpointRefused extends Error {
  readonly code: ProviderEndpointRefusalCode
  readonly reason: string

  constructor(refusal: ProviderEndpointRefusal) {
    super(`provider endpoint refused: ${refusal.reason}`)
    this.name = 'ProviderEndpointRefused'
    this.code = refusal.code
    this.reason = refusal.reason
  }
}

/** The maximum length of a provider base URL. Generous over any real endpoint. */
export const MAX_PROVIDER_BASE_URL_CHARS = 2_048

/**
 * The approved provider origins.
 *
 * An origin is scheme + host + optional port, and it must be matched in full. The
 * default port is written explicitly so that "no port" and "port 443" are the same
 * entry rather than two that could drift.
 *
 * **To add a provider, add an entry here and nothing else.** No renderer can widen
 * this list: `baseUrl` names a host, and a host that is not here is refused. That is
 * why this file is the whole of the policy rather than one input among several.
 */
export const PROVIDER_ENDPOINT_POLICY: readonly string[] = Object.freeze([
  'https://nano-gpt.com:443',
  'https://www.nano-gpt.com:443',
])

/** The documented default, used when nothing has been configured. */
export const DEFAULT_PROVIDER_BASE_URL = 'https://nano-gpt.com/api/v1'

function refuse(code: ProviderEndpointRefusalCode, reason: string): ProviderEndpointRefused {
  return new ProviderEndpointRefused({ code, reason })
}

/**
 * Reserved IPv4 ranges, as `[network, prefixBits]`.
 *
 * The same table shape `core/research/url-policy.ts` uses, kept separate on purpose:
 * that module answers "may a fetched *page* live here", this one answers "may a
 * *credential* be sent here". They have different threat models and will drift apart
 * deliberately.
 */
const IPV4_RESERVED: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // 0.0.0.0/8        this network
  [0x0a000000, 8], // 10.0.0.0/8       private
  [0x64400000, 10], // 100.64.0.0/10    carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8      loopback
  [0xa9fe0000, 16], // 169.254.0.0/16   link-local, and every cloud metadata service
  [0xac100000, 12], // 172.16.0.0/12    private
  [0xc0000000, 24], // 192.0.0.0/24     IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24     TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24   6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16   private
  [0xc6120000, 15], // 198.18.0.0/15    benchmarking
  [0xc6336400, 24], // 198.51.100.0/24  TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24   TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4       multicast
  [0xf0000000, 4], // 240.0.0.0/4       reserved, including 255.255.255.255
]

/** IPv4-mapped IPv6 prefix, `::ffff:0:0/96`. */
const IPV4_MAPPED = /^::ffff:/i

function parseIpv4(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    // Reject `01`, `0x7f` and `+1`: a host that only parses under a lenient parser is
    // a host whose meaning depends on who parsed it.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function inIpv4Reserved(value: number): boolean {
  return IPV4_RESERVED.some(([network, bits]) =>
    (value >>> (32 - bits)) === (network >>> (32 - bits)),
  )
}

/**
 * Whether a hostname is an address literal rather than a name.
 *
 * Deliberately conservative: anything containing `:` is treated as IPv6, and a
 * dotted quad is IPv4. A hostname cannot contain `:` in a URL authority, so this
 * cannot misclassify a real name.
 */
function isAddressLiteral(host: string): boolean {
  if (host.includes(':')) return true
  return parseIpv4(host) !== null
}

/**
 * Classify a literal address, so the refusal can say *why*.
 *
 * Returns `null` for a global unicast address, which the allowlist will then reject
 * on host grounds with a clearer message than "loopback".
 */
function classifyLiteral(host: string): ProviderEndpointRefusalCode | null {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()

  // A loopback value, tested against the masked network rather than a full literal.
  // 0x7f000001 is the network AND the mask; comparing the masked value against the
  // unmasked constant would never match, which is a bug this comment exists to stop
  // anyone reintroducing.
  // Both constants carry the high bit once masked, and JavaScript's bitwise operators
  // are signed 32-bit, so `value & mask` yields a *negative* number. Every comparison
  // below therefore ends in `>>> 0`; without it none of these branches can ever be
  // taken and every address falls through to the generic private-network refusal.
  const LOOPBACK_V4 = 0x7f000000
  const LINK_LOCAL_V4 = 0xa9f00000 // 169.254.0.0/16 after /16 masking

  /**
   * IPv4-mapped forms first, so `::ffff:169.254.169.254` cannot slip past the IPv4
   * checks by presenting as IPv6.
   *
   * Both spellings have to be handled. `URL` normalises `[::ffff:127.0.0.1]` to the
   * hex form `[::ffff:7f00:1]`, so the dotted tail a reader would expect is often
   * already gone by the time the string reaches here.
   */
  const mappedHex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex !== null) {
    // The two groups are the *high and low 16 bits of the 32-bit IPv4 address*, so
    // they combine as `hi << 16 | lo`. Combining them as `hi << 8 | lo` yields a
    // 24-bit value whose top byte is zero, which then fails every mask comparison
    // below and falls through to the generic "bare IP" refusal — correct outcome,
    // wrong reason, and a loopback that never reports itself as one.
    const value = ((Number.parseInt(mappedHex[1] ?? '0', 16) << 16) |
      Number.parseInt(mappedHex[2] ?? '0', 16)) >>> 0
    if (((value & 0xff000000) >>> 0) === LOOPBACK_V4) return 'loopback'
    if (((value & 0xfff00000) >>> 0) === LINK_LOCAL_V4) return 'metadata-service'
    return 'address-literal'
  }
  const mappedDotted = bare.match(IPV4_MAPPED)
  if (mappedDotted !== null) {
    const value = parseIpv4(mappedDotted[1] ?? '')
    if (value !== null) {
      if (((value & 0xff000000) >>> 0) === LOOPBACK_V4) return 'loopback'
      if (((value & 0xfff00000) >>> 0) === LINK_LOCAL_V4) return 'metadata-service'
      return 'address-literal'
    }
  }

  const value = parseIpv4(bare)
  if (value !== null) {
    if (((value & 0xff000000) >>> 0) === LOOPBACK_V4) return 'loopback'
    // 169.254.0.0/16 is link-local, and on every major cloud that is where the
    // instance metadata service — and therefore the instance role credential —
    // lives. It is named separately so the refusal explains the real risk.
    if (((value & 0xfff00000) >>> 0) === LINK_LOCAL_V4) return 'metadata-service'
    if (inIpv4Reserved(value)) return 'private-network'
    return 'address-literal'
  }

  // IPv6. Only a first group or two are needed to classify every reserved range.
  if (bare === '::' || bare === '::1') return 'loopback'
  const groups = bare.split('::')[0]?.split(':') ?? []
  const first = Number.parseInt(groups[0] ?? '', 16)
  const second = Number.parseInt(groups[1] ?? '', 16)
  if (Number.isNaN(first)) return 'address-literal'
  if ((first & 0xfe00) === 0xfc00) return 'private-network' // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return 'link-local' // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return 'private-network' // ff00::/8 multicast
  if (first === 0x2001 && second === 0x0db8) return 'private-network' // documentation
  // Everything else that is not global unicast 2000::/3 is refused as special.
  if ((first & 0xe000) !== 0x2000) return 'link-local'
  return null
}

/**
 * Names that resolve inside a machine or a private network.
 *
 * The allowlist already excludes all of these. They are listed so that a future
 * policy entry cannot accidentally name one, and so the refusal is specific when
 * somebody types `http://localhost:8080` into a settings field and is told why.
 */
const SPECIAL_USE_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
])

/** The set of checks {@link checkProviderBaseUrl} performs, in order. */
export interface ProviderUrlCheck {
  readonly ok: boolean
  readonly url?: URL
  readonly refusal?: ProviderEndpointRefusal
}

/**
 * Validate a configured provider base URL.
 *
 * This is the check for a value a human or a renderer *configured*. It requires the
 * full policy: HTTPS, no userinfo, no query or fragment, no explicit port, no
 * address literal, no special-use name, and a host named in the policy.
 *
 * Never throws. A settings screen has to render the refusal, not catch it.
 */
export function checkProviderBaseUrl(input: unknown): ProviderUrlCheck {
  if (typeof input !== 'string') {
    return { ok: false, refusal: { code: 'not-a-string', reason: 'The provider URL is not text.' } }
  }
  const raw = input.trim()
  if (raw.length === 0) {
    return { ok: false, refusal: { code: 'empty', reason: 'The provider URL is empty.' } }
  }
  if (raw.length > MAX_PROVIDER_BASE_URL_CHARS) {
    return {
      ok: false,
      refusal: { code: 'too-long', reason: 'The provider URL is too long to be a provider endpoint.' },
    }
  }
  // A control character in a URL is either an attempt to smuggle a header through a
  // parser that disagrees about where the URL ends, or a truncation. Both fail.
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 32 || code === 127) {
      return {
        ok: false,
        refusal: {
          code: 'control-character',
          reason: 'The provider URL contains a control character.',
        },
      }
    }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      ok: false,
      refusal: { code: 'not-absolute-url', reason: 'The provider URL is not an absolute URL.' },
    }
  }

  /**
   * The host is classified **before** the scheme is checked, and deliberately so.
   *
   * Ordering matters for what a person is told. `http://169.254.169.254` is refused
   * for two independent reasons, and reporting only "must use https" would leave the
   * reader to conclude that fixing the scheme would make it fine. Naming it as a
   * metadata address says the thing that actually matters, which is that no scheme
   * makes this URL acceptable.
   */
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === '') {
    return {
      ok: false,
      refusal: { code: 'not-absolute-url', reason: 'The provider URL has no host.' },
    }
  }
  if (isAddressLiteral(host)) {
    const classification = classifyLiteral(host) ?? 'address-literal'
    return { ok: false, refusal: literalRefusal(classification) }
  }
  if (SPECIAL_USE_NAMES.has(host)) {
    return { ok: false, refusal: literalRefusal('special-use-name') }
  }

  if (url.protocol !== 'https:') {
    // Covers plain http, and also anything exotic, because the only protocol that can
    // be approved is the one the policy names.
    return {
      ok: false,
      refusal: {
        code: 'not-https',
        reason: 'The provider URL must use https. A provider key is never sent over an unencrypted connection.',
      },
    }
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      refusal: {
        code: 'credentials-in-url',
        reason: 'The provider URL contains a username or password. Credentials belong in the API key field, never in a URL.',
      },
    }
  }
  if (url.search !== '' || url.hash !== '') {
    return {
      ok: false,
      refusal: {
        code: 'query-or-fragment',
        reason: 'The provider URL must not carry a query string or fragment.',
      },
    }
  }
  if (url.port !== '' && url.port !== '443') {
    return {
      ok: false,
      refusal: {
        code: 'explicit-port',
        reason: 'The provider URL must use the default https port.',
      },
    }
  }

  const origin = `https://${host}:443`
  if (!PROVIDER_ENDPOINT_POLICY.includes(origin)) {
    return {
      ok: false,
      refusal: {
        code: 'host-not-approved',
        reason: `${host} is not an approved Freya provider host. Approved hosts are ${PROVIDER_ENDPOINT_POLICY.map((entry) => new URL(entry).hostname).join(', ')}.`,
      },
    }
  }

  return { ok: true, url }
}

function literalRefusal(code: ProviderEndpointRefusalCode): ProviderEndpointRefusal {
  switch (code) {
    case 'loopback':
      return { code, reason: 'The provider URL points at a loopback address. A provider is a remote service.' }
    case 'link-local':
      return { code, reason: 'The provider URL points at a link-local address.' }
    case 'metadata-service':
      return {
        code,
        reason: 'The provider URL points at a link-local metadata address. Cloud instance credentials are served here and must never be reachable from a provider setting.',
      }
    case 'private-network':
      return { code, reason: 'The provider URL points inside a private network.' }
    case 'special-use-name':
      return { code, reason: 'The provider URL is a special-use name that resolves inside this machine.' }
    default:
      return {
        code: 'address-literal',
        reason: 'The provider URL is a bare IP address. An approved provider is named by host.',
      }
  }
}

/**
 * Validate a base URL, or throw.
 *
 * For the boundaries that genuinely cannot continue: loading configuration into a
 * provider, and attaching an `Authorization` header to a request.
 */
export function assertProviderBaseUrl(input: unknown): URL {
  const check = checkProviderBaseUrl(input)
  if (!check.ok) throw refuse(check.refusal!.code, check.refusal!.reason)
  return check.url!
}

/**
 * Validate one URL in a redirect chain, immediately before the key is attached.
 *
 * The distinction from {@link checkProviderBaseUrl} is deliberate. A redirect target
 * is not operator configuration and gets no benefit of the doubt: it must be an
 * **exact match against the policy**, because the whole point of following a
 * redirect is that something other than the operator chose where to go next. It must
 * additionally be HTTPS, which also covers the HTTPS→HTTP downgrade case.
 *
 * Callers must attach the `Authorization` header only after this returns.
 */
export function checkProviderRedirectTarget(target: string): ProviderUrlCheck {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return {
      ok: false,
      refusal: { code: 'not-absolute-url', reason: 'The provider redirected to something that is not a URL.' },
    }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      refusal: {
        code: 'https-downgrade',
        reason: `The provider redirected to ${url.protocol}//. An API key is never sent over an unencrypted connection.`,
      },
    }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  const origin = `https://${host}:${url.port === '' ? '443' : url.port}`
  if (!PROVIDER_ENDPOINT_POLICY.includes(origin)) {
    return {
      ok: false,
      refusal: {
        code: 'redirect-not-allowed',
        reason: `The provider redirected to ${host}, which is not an approved Freya provider host. The request was not sent.`,
      },
    }
  }
  return { ok: true, url }
}

/** Throwing form of {@link checkProviderRedirectTarget}. */
export function assertProviderRedirectTarget(target: string): URL {
  const check = checkProviderRedirectTarget(target)
  if (!check.ok) throw refuse(check.refusal!.code, check.refusal!.reason)
  return check.url!
}