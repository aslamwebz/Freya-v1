import { describe, expect, it } from 'vitest'
import {
  checkProviderBaseUrl,
  checkProviderRedirectTarget,
  assertProviderBaseUrl,
  ProviderEndpointRefused,
  PROVIDER_ENDPOINT_POLICY,
  MAX_PROVIDER_BASE_URL_CHARS,
} from '../../core/model/provider-endpoint'
import { NanoGptProvider, readNanoGptConfig } from '../../core/model/nanogpt-provider'
import type { ModelRequest } from '../../core/model/provider'

/**
 * The provider endpoint policy, and the property it exists to hold.
 *
 * The property, stated once so every case below can be read against it:
 *
 * > An API key is sent only to an origin named in {@link PROVIDER_ENDPOINT_POLICY},
 * > over HTTPS, and never as a consequence of a value a renderer supplied.
 *
 * These are adversarial cases, not configuration cases. Each one is an attempt to
 * make a stored credential arrive somewhere it must not, expressed as a `baseUrl` or
 * as a redirect the provider might return.
 */

const APPROVED = 'https://nano-gpt.com/api/v1'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    NANOGPT_API_KEY: 'sk-secret-value',
    NANOGPT_BASE_URL: APPROVED,
    NANOGPT_MODEL: 'openai/gpt-4.1-nano',
    FREYA_ALLOW_LIVE_MODEL: '1',
    ...overrides,
  }
}

describe('the policy itself', () => {
  it('names only https origins with an explicit port', () => {
    // A policy entry that could match a plain-http or odd-port origin would weaken
    // every check below, so the shape of the policy is asserted rather than trusted.
    for (const entry of PROVIDER_ENDPOINT_POLICY) {
      const url = new URL(entry)
      expect(url.protocol).toBe('https:')
      // 'https' default port is normalised away by URL, so 443 is asserted against the policy text.
      expect(entry.endsWith(':443')).toBe(true)
      expect(url.pathname).toBe('/')
      expect(url.username).toBe('')
      expect(url.password).toBe('')
    }
  })

  it('accepts the documented default', () => {
    expect(checkProviderBaseUrl(APPROVED).ok).toBe(true)
    expect(checkProviderBaseUrl('https://nano-gpt.com/api/v1/').ok).toBe(true)
    expect(checkProviderBaseUrl('https://www.nano-gpt.com/api/v1').ok).toBe(true)
    // The version segment is optional; the provider adds it when absent.
    expect(checkProviderBaseUrl('https://nano-gpt.com').ok).toBe(true)
  })
})

describe('a renderer cannot aim the credential somewhere else', () => {
  /**
   * Every one of these is a base URL a compromised window could try to save. All of
   * them are refused, and the reason is specific enough to act on.
   */
  const hostile: readonly (readonly [string, string, string])[] = [
    ['http://attacker.example', 'not-https', 'a plain-http downgrade'],
    ['https://attacker.example', 'host-not-approved', 'a different https host'],
    ['http://169.254.169.254', 'metadata-service', 'the cloud metadata service'],
    ['https://169.254.169.254', 'metadata-service', 'the metadata service over https'],
    ['http://169.254.169.254/latest/meta-data', 'metadata-service', 'a metadata path'],
    ['https://127.0.0.1', 'loopback', 'loopback'],
    ['http://127.0.0.1:8080', 'loopback', 'loopback over http'],
    ['https://127.0.0.1:8443', 'loopback', 'loopback on a custom port'],
    ['https://localhost', 'special-use-name', 'localhost by name'],
    ['https://localhost:443', 'special-use-name', 'localhost with an explicit port'],
    ['https://[::1]', 'loopback', 'IPv6 loopback'],
    ['https://[::ffff:127.0.0.1]', 'loopback', 'IPv4-mapped loopback'],
    ['https://[::ffff:169.254.169.254]', 'metadata-service', 'IPv4-mapped metadata service'],
    ['https://10.0.0.5', 'private-network', 'a private address'],
    ['https://192.168.1.1', 'private-network', 'a private address'],
    ['https://172.16.0.1', 'private-network', 'private range lower bound'],
    ['https://[fe80::1]', 'link-local', 'IPv6 link-local'],
    ['https://[fd00::1]', 'private-network', 'IPv6 unique-local'],
    ['https://nano-gpt.com.evil.test', 'host-not-approved', 'a suffix-append on the approved name'],
    ['https://evilnano-gpt.com', 'host-not-approved', 'a prefix-append on the approved name'],
    ['https://nano-gpt.com@attacker.example', 'credentials-in-url', 'userinfo carrying the approved host'],
    ['https://user:pass@nano-gpt.com', 'credentials-in-url', 'inline credentials'],
    ['https://nano-gpt.com/api/v1?x=1', 'query-or-fragment', 'a query string'],
    ['https://nano-gpt.com/api/v1#f', 'query-or-fragment', 'a fragment'],
    ['https://nano-gpt.com:8443', 'explicit-port', 'a non-default port'],
    ['https://metadata.google.internal', 'special-use-name', 'the GCP metadata name'],
    ['not-a-url', 'not-absolute-url', 'a bare word'],
    ['//nano-gpt.com', 'not-absolute-url', 'a protocol-relative URL'],
    ['ftp://nano-gpt.com', 'not-https', 'a non-http scheme'],
    ['https://nano-gpt.com\nHost: evil', 'control-character', 'a header-smuggling newline'],
    ['https://0x7f000001', 'loopback', 'a hex-encoded loopback'],
    ['https://2130706433', 'loopback', 'a decimal-encoded loopback'],
    ['https://[::]', 'loopback', 'the unspecified address'],
  ]

  for (const [url, code, description] of hostile) {
    it(`refuses ${description}: ${url}`, () => {
      const check = checkProviderBaseUrl(url)
      expect(check.ok).toBe(false)
      expect(check.refusal?.code).toBe(code)
      // A refusal that cannot be shown is a refusal that gets worked around.
      expect(check.refusal?.reason.length ?? 0).toBeGreaterThan(10)
      expect(check.refusal?.reason).not.toContain('sk-secret-value')
    })
  }

  it('refuses an over-long URL rather than truncating it', () => {
    const long = `https://nano-gpt.com/${'a'.repeat(MAX_PROVIDER_BASE_URL_CHARS)}`
    expect(checkProviderBaseUrl(long).refusal?.code).toBe('too-long')
  })

  it('refuses a non-string', () => {
    expect(checkProviderBaseUrl(undefined).refusal?.code).toBe('not-a-string')
    expect(checkProviderBaseUrl(42).refusal?.code).toBe('not-a-string')
    expect(checkProviderBaseUrl({}).refusal?.code).toBe('not-a-string')
  })
})

describe('configuration loading applies the policy', () => {
  it('yields no provider at all for a hostile base URL', () => {
    // Not a degraded provider — no provider. `readNanoGptConfig` returning null is
    // what makes the gateway unable to select this provider, so the credential is
    // never reachable in the first place.
    for (const hostile of ['https://attacker.example', 'http://nano-gpt.com', 'https://127.0.0.1']) {
      expect(readNanoGptConfig(env({ NANOGPT_BASE_URL: hostile }))).toBeNull()
    }
  })

  it('yields a provider for the approved endpoint, preserving the path', () => {
    const config = readNanoGptConfig(env())
    expect(config?.baseUrl).toBe('https://nano-gpt.com/api/v1')
    expect(config?.apiKey).toBe('sk-secret-value')
  })
})

describe('no request reaches fetch with a key and an unapproved URL', () => {
  interface Seen { url: string; authorization: string | undefined }

  function recorder(seen: Seen[], respond: (url: string) => Response) {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url, authorization: headers.authorization })
      return respond(url)
    }
  }

  const request = (): ModelRequest => ({
    requestId: 'r-1',
    model: 'm',
    // `prompt` is the gateway's flattened form of `messages`; the provider sends
    // `messages`, and both are required by the contract.
    prompt: 'hello',
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 16,
  })

  it('refuses before contacting anything when configured with a hostile URL', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: 'https://attacker.example', model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () => new Response('{}')),
    })
    await expect(provider.complete(request(), { signal: new AbortController().signal })).rejects.toThrow()
    // The load-bearing assertion: fetch was never called, so the key never left.
    expect(seen).toHaveLength(0)
  })

  it('sends the key only to the approved host', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: APPROVED, model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () =>
        Response.json({ choices: [{ message: { content: 'hi' } }], usage: {} }),
      ),
    })
    await provider.complete(request(), { signal: new AbortController().signal })
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]!.url).hostname).toBe('nano-gpt.com')
    expect(seen[0]!.authorization).toBe('Bearer sk-secret-value')
  })

  it('refuses a redirect that escapes the approved host, without resending the key', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: APPROVED, model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/api/v1/chat/completions' },
        }),
      ),
    })
    await expect(provider.complete(request(), { signal: new AbortController().signal })).rejects.toThrow(
      /not an approved Freya provider host/,
    )
    // Exactly one request — the redirect was never followed, so the key was never
    // presented to the second host.
    expect(seen).toHaveLength(1)
    expect(seen.map((entry) => new URL(entry.url).hostname)).toEqual(['nano-gpt.com'])
  })

  it('refuses an https to http downgrade redirect', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: APPROVED, model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () =>
        new Response(null, {
          status: 301,
          headers: { location: 'http://nano-gpt.com/api/v1/chat/completions' },
        }),
      ),
    })
    await expect(provider.complete(request(), { signal: new AbortController().signal })).rejects.toThrow(
      /never sent over an unencrypted connection/,
    )
    expect(seen).toHaveLength(1)
  })

  it('refuses a redirect to the metadata service', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: APPROVED, model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () =>
        new Response(null, {
          status: 307,
          headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
        }),
      ),
    })
    await expect(provider.complete(request(), { signal: new AbortController().signal })).rejects.toThrow()
    expect(seen).toHaveLength(1)
  })

  it('follows a redirect that stays on the approved host', async () => {
    // The policy is not "never redirect" — it is "never redirect off the approved
    // origin". A same-host hop is legitimate and refusing it would break a real
    // provider behaviour.
    const seen: Seen[] = []
    let call = 0
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: APPROVED, model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () => {
        call += 1
        if (call === 1) {
          return new Response(null, { status: 302, headers: { location: 'https://nano-gpt.com/api/v2/chat' } })
        }
        return Response.json({ choices: [{ message: { content: 'hi' } }], usage: {} })
      }),
    })
    await provider.complete(request(), { signal: new AbortController().signal })
    expect(seen).toHaveLength(2)
    expect(seen.every((entry) => new URL(entry.url).hostname === 'nano-gpt.com')).toBe(true)
  })

  it('stops after a bounded number of redirects', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: APPROVED, model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () =>
        new Response(null, { status: 302, headers: { location: `${APPROVED}/loop` } }),
      ),
    })
    await expect(provider.complete(request(), { signal: new AbortController().signal })).rejects.toThrow(
      /redirected too many times/,
    )
    expect(seen.length).toBeLessThanOrEqual(5)
  })

  it('refuses the catalogue request on the same terms', async () => {
    const seen: Seen[] = []
    const provider = new NanoGptProvider({
      config: { apiKey: 'sk-secret-value', baseUrl: 'https://attacker.example', model: 'm', liveEnabled: true },
      fetchImpl: recorder(seen, () => Response.json({ data: [] })),
    })
    await expect(provider.listModels({ signal: new AbortController().signal })).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })
})

describe('redirect targets are judged by the policy, not by configuration', () => {
  it('accepts only approved https origins', () => {
    expect(checkProviderRedirectTarget('https://nano-gpt.com/api/v2/x').ok).toBe(true)
    expect(checkProviderRedirectTarget('https://attacker.example/x').refusal?.code).toBe('redirect-not-allowed')
    expect(checkProviderRedirectTarget('http://nano-gpt.com/x').refusal?.code).toBe('https-downgrade')
    expect(checkProviderRedirectTarget('https://127.0.0.1/x').refusal?.code).toBe('redirect-not-allowed')
    expect(checkProviderRedirectTarget('nonsense').refusal?.code).toBe('not-absolute-url')
  })

  it('throws a named error carrying the code', () => {
    expect(() => assertProviderBaseUrl('http://nano-gpt.com')).toThrow(ProviderEndpointRefused)
    try {
      assertProviderBaseUrl('http://nano-gpt.com')
    } catch (error) {
      expect((error as ProviderEndpointRefused).code).toBe('not-https')
    }
  })
})