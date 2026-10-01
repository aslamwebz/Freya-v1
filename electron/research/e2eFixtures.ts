import {
  SafeHttpTransport,
  type TransportRequest,
  type TransportResponse,
} from '../../core/research/transport'
import type { SearchProvider } from '../../core/research/types'

/**
 * Offline research fixtures for the Electron end-to-end suite.
 *
 * ## Why this file exists and why it is gated
 *
 * The Phase 5 E2E has to prove that the **real** Electron target loads, extracts and
 * cleans up correctly — mocked target behaviour proves nothing about window
 * security, CSP enforcement or subresource denial. But it must also not touch the
 * network, must not call a paid search API, and must not be reachable in a
 * production build.
 *
 * So the fixture is *only* assembled when both of these are set:
 *
 * ```
 *   FREYA_E2E=1
 *   FREYA_E2E_RESEARCH=fixtures
 * ```
 *
 * There is no permissive mode, no local/private-network bypass and no way to point
 * the real transport at localhost. A fixture that loosened the URL policy would stop
 * testing the URL policy, which is most of what this subsystem is for.
 *
 * ## How it stays honest
 *
 * The fixture replaces the transport's **DNS resolver and socket request**, not the
 * URL policy, the bounds, the redirect handling or the browser target. Every public
 * URL rule still runs; only the name resolution and the bytes change. Fixture hosts
 * are `fixture.example.com`, which is a normal-looking public hostname and passes
 * `assertPublicUrl` for exactly the same reason a real site would.
 *
 * `example.com` and `example.org` are reserved for documentation, so a *literal*
 * `https://example.com` is used in several places as a "should be blocked or absent"
 * case. These fixtures avoid relying on that either way, and assert on behaviour
 * rather than on hostnames.
 */

/** A public-looking address. Never dialled: the request seam is replaced too. */
const FIXTURE_ADDRESS = { address: '93.184.216.34', family: 4 as const }

const ARTICLE = `<!doctype html>
<html><head>
<title>Encrypted storage for a local assistant</title>
<link rel="canonical" href="https://fixture.example.com/relative-canonical">
<meta name="description" content="A fixture article about how a local assistant keeps state.">
<meta name="author" content="Fixture Author">
</head>
<body>
<nav><a href="/">Home</a><a href="/about">About</a><a href="/cookie-settings">Cookie settings</a></nav>
<header><h1>Site header that is not the article</h1></header>
<article>
<h1>Encrypted storage for a local assistant</h1>
<h2>What is stored</h2>
<p>A local assistant that expects to be useful for years has to keep things somewhere durable.
That storage is encrypted with a key the operating system holds, and the records are chained
so that a deleted record can be detected rather than being indistinguishable from one that
was never written.</p>
<h2>What is not stored</h2>
<p>The key itself is never written beside the data it protects. On a machine with no secure
storage available, a durable assistant would be a lie, so the honest answer is to keep
nothing and say so.</p>
<p style="display:none">HIDDEN BY INLINE CSS THIS TEXT SHOULD NOT APPEAR</p>
</article>
<footer>Copyright nobody</footer>
<div id="cookie-consent">Accept all cookies to continue browsing</div>
<script>window.__freyaFixtureScriptRan = true; document.body.setAttribute('data-scripted','yes');</script>
</body></html>`

/**
 * A page whose entire purpose is to try to execute.
 *
 * Every vector here is one the sandbox has to refuse, and the E2E asserts on the
 * *absence* of the effects rather than on a return value, because a page cannot be
 * made to report its own failure.
 */
const HOSTILE = `<!doctype html>
<html><head>
<title>Hostile fixture page</title>
<style>.hidden-by-stylesheet { visibility: hidden; }</style>
</head>
<body>
<h1>Hostile fixture page</h1>
<p>VISIBLE_TEXT_MARKER The visible half of a hostile page survives extraction.</p>
<p class="hidden-by-stylesheet">STYLESHEET_HIDDEN_MARKER This text is hidden by a stylesheet rule.</p>
<div style="display:none">INLINE_HIDDEN_MARKER This text is hidden inline.</div>
<p>CLICKJACK_MARKER
<a href="https://fixture.example.com/phishing">a link that exists in the text</a></p>
<script>window.__hostileRan = true</script>
<script src="https://fixture.example.com/evil.js"></script>
<img src="https://fixture.example.com/tracker.gif" onerror="window.__hostileRan=true">
<iframe src="https://fixture.example.com/frame"></iframe>
<form action="https://fixture.example.com/steal"><input name="secret"></form>
<style>.x{background:url(https://fixture.example.com/pixel.png)}</style>
</body></html>`

const SECOND_SOURCE = `<!doctype html>
<html><head><title>A second source that disagrees</title></head>
<body>
<main>
<h1>A second source that disagrees</h1>
<p>CONFLICT_MARKER This second source disagrees about the retention period, which is exactly the
kind of disagreement the research window is supposed to show rather than resolve.</p>
</main>
</body></html>`

const EMPTY = `<!doctype html>
<html><head><title>A page with nothing readable</title></head>
<body><nav>nav only</nav><footer>footer only</footer></body></html>`

const HUGE = `<!doctype html>
<html><head><title>A page longer than Freya reads</title></head><body><article>
${'FILLER_MARKER this paragraph exists only to make the page longer than the extraction limit. '.repeat(900)}
</article></body></html>`

const FIXTURES: Record<string, { type: string; body: string }> = {
  '/article': { type: 'text/html; charset=utf-8', body: ARTICLE },
  '/hostile': { type: 'text/html; charset=utf-8', body: HOSTILE },
  '/second': { type: 'text/html; charset=utf-8', body: SECOND_SOURCE },
  '/empty': { type: 'text/html; charset=utf-8', body: EMPTY },
  '/huge': { type: 'text/html; charset=utf-8', body: HUGE },
  // A PDF, so the extractor can be shown refusing an unsupported format.
  '/document.pdf': { type: 'application/pdf', body: '%PDF-1.4 not really a pdf' },
}

function fixtureFor(url: URL): { type: string; body: string } | null {
  return FIXTURES[url.pathname] ?? null
}

/**
 * A transport that serves fixture documents without a network.
 *
 * Built through the real `SafeHttpTransport` by replacing only its resolver and
 * request seams, so DNS validation, public-address checks, byte bounds, redirect
 * limits and abort handling all still run. Redirects are honoured, including one
 * that points at a private address, so the redirect refusal can be exercised.
 */
export function fixtureTransport(): SafeHttpTransport {
  return new SafeHttpTransport({
    resolver: async (hostname: string) => {
      if (!hostname.endsWith('example.com') && !hostname.endsWith('example.org')) {
        // Not a fixture host: fail resolution the way a real lookup would, so a
        // request to anything else cannot quietly succeed.
        const error = Object.assign(new Error('fixture host not found'), { code: 'ENOTFOUND' })
        throw error
      }
      return [FIXTURE_ADDRESS]
    },
    request: async (request: TransportRequest): Promise<TransportResponse> => {
      const url = new URL(request.url.href)
      if (url.hostname === 'blocked.example.com') {
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: (async function* () {})(),
        }
      }
      if (url.hostname === 'redirect.example.com') {
        return {
          status: 302,
          headers: { location: 'https://fixture.example.com/article' },
          body: (async function* () {})(),
        }
      }
      const fixture = fixtureFor(url)
      if (fixture === null) {
        return { status: 404, headers: {}, body: (async function* () { yield Buffer.from('not found') })() }
      }
      return {
        status: 200,
        headers: { 'content-type': fixture.type, 'content-length': String(Buffer.byteLength(fixture.body)) },
        body: (async function* () {
          // Two chunks, so the streaming byte bound is exercised rather than a
          // single body that happens to be under the limit.
          const bytes = Buffer.from(fixture.body)
          const half = Math.floor(bytes.length / 2)
          yield bytes.subarray(0, half)
          yield bytes.subarray(half)
        })(),
      }
    },
  })
}

/**
 * A search provider that answers from fixtures.
 *
 * Deterministic and ordered, so a test can name which source it expects to be
 * read. Never claims to be Brave and is only ever reachable behind both gate flags.
 */
export function fixtureSearchProvider(): SearchProvider {
  return {
    id: 'fixture',
    status: () => ({ ready: true, reason: 'fixture provider' }),
    async search(query: string) {
      const all = [
        {
          title: 'Encrypted storage for a local assistant',
          url: 'https://fixture.example.com/article',
          snippet: 'A fixture article about how a local assistant keeps state.',
          sourceDomain: 'fixture.example.com',
          rank: 0,
          publishedAt: null,
          retrievedAt: '2026-10-01T00:00:00.000Z',
        },
        {
          title: 'A second source that disagrees',
          url: 'https://fixture.example.com/second',
          snippet: 'This second source disagrees about the retention period.',
          sourceDomain: 'fixture.example.com',
          rank: 1,
          publishedAt: null,
          retrievedAt: '2026-10-01T00:00:00.000Z',
        },
        {
          title: 'A page with nothing readable',
          url: 'https://fixture.example.com/empty',
          snippet: 'A fixture that yields no readable text.',
          sourceDomain: 'fixture.example.com',
          rank: 2,
          publishedAt: null,
          retrievedAt: '2026-10-01T00:00:00.000Z',
        },
      ]
      const wanted = /second|disagree/i.test(query)
      return (wanted ? all.slice(1) : all).slice(0, 10)
    },
  }
}

/** True only when both gate variables are present. */
export function researchFixturesEnabled(env: Record<string, string | undefined>): boolean {
  return env.FREYA_E2E === '1' && env.FREYA_E2E_RESEARCH === 'fixtures'
}
