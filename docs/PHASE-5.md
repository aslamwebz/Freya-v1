# Phase 5 — Research: search, a managed browser, and cited answers

Phase 5 gives Freya the ability to look things up. Not to act, not to decide, not
to remember on her own — to read public web pages inside a sandbox and report what
they say, with the sources shown.

This document records what was built, why, and what it deliberately does not do. The
last part is not a formality: the tempting failure in a research subsystem is to
present it as intelligence when it is retrieval.

---

## What this phase is

You can ask Freya a question in the Research window. She plans a bounded search,
reads a handful of public pages in a locked-down browser, and answers with findings
that each name the source they came from. Where two sources disagree, she shows
the disagreement instead of picking a side. Where she does not know, she says so.

She cannot run anything a page asks her to run, cannot reach your network, and
cannot raise her own limits.

---

## 1. The three subsystems, and what separates them

```
  Renderer                     asks a question. Holds no limits, no provider, no keys.
     ↓  research.start { question }
  Core                         Guard, budgets, grants, cancellation, events
     ↓
  ResearchCoordinator          plan → search → select → read → gap → synthesise
     ├── Searcher ──→ SearchProvider        provider-neutral
     ├── ManagedBrowserService ──→ BrowserTarget
     └── ResearchModel ──→ CognitionService ──→ Governor ──→ Gateway ──→ provider
```

The coordinator is provider- and target-agnostic. It knows nothing about Guard,
grants or the Model Gateway. `core/research/coreIntegration.ts` is the single place
that binds it to Core's existing authority machinery, so the binding can be read in
one place.

That separation is the reason the plan could be staged at all: the coordinator was
built and unit-tested before Core knew it existed.

---

## 2. Search: provider-neutral, with one replaceable adapter

`Searcher` validates and bounds queries, normalises results, and deduplicates by
canonical URL. It exposes **fixed public failure codes** — `unconfigured`,
`disabled`, `rate_limited`, `provider_error` — and never a vendor's message.

`BraveSearchProvider` is the initial adapter and the only place Brave's JSON shape
exists. Its credential:

- is read only by main-process configuration, from `BRAVE_SEARCH_API_KEY`;
- lives in a `#private` field, so it is not reachable by reflection, not by a
  projection, and not by anything that can read an object;
- is sent only as `X-Subscription-Token` to a hard-coded host;
- **cannot follow a redirect at all** — any request carrying a non-allowlisted
  header is refused the moment a redirect appears;
- is stripped from results if the API echoes it back into a URL or a description.

`FREYA_ALLOW_WEB_SEARCH=1` is a **separate** gate. A machine that happens to have a
key in its environment does not call anything until somebody asked for it. Missing
or disabled search fails with a stated reason and **zero request calls**.

---

## 3. The public-network policy, and why DNS is pinned

The transport will only fetch public HTTP(S) on default ports, and it is written so
that "the URL looked fine" is never the reason something was reached.

```
  URL syntax ──► scheme is http/https ──► no userinfo ──► default port
      ──► resolve ALL DNS answers ──► reject if ANY is private/reserved
      ──► PIN the vetted address to the connection
      ──► repeat every check at every redirect
```

**Private, reserved and non-public is a long list**, and it is enforced after
normalisation rather than by pattern-matching the text: decimal, octal, hexadecimal
and short-form IPv4, IPv4-mapped IPv6, IPv6 loopback, link-local, unique-local,
multicast and `0.0.0.0` are all rejected because WHATWG URL parsing canonicalises
them first and the policy sees the real address.

**DNS is pinned.** Every answer is validated, one vetted address is chosen, and that
address is handed to the HTTP layer through a `lookup` override — so the connection
cannot resolve the name a second time and land somewhere else. That is the
DNS-rebinding defence, and it is structural rather than a check-then-hope.

Also refused: a downgrade from https to http on a redirect (an on-path attacker
could otherwise choose what Freya reads), cookies, `Host` and `Proxy-Authorization`
headers, CRLF in header values, more than three redirects, and bodies over the
limit **enforced while streaming** so a slow huge response cannot exhaust memory.

---

## 4. The managed browser, and what a page cannot do

`ManagedBrowserService` owns sessions with states `creating → ready → navigating →
reading → closed`. `readWebPage` creates a session and closes it in a `finally`, so
a read cannot leave a window alive. Close is idempotent, and a late factory result
arriving after a close is disposed of rather than admitted.

The Electron target is the real thing, and it is locked down:

| | |
| --- | --- |
| session | non-persistent, from a **bounded leased pool** of four |
| window | hidden, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload, no devtools |
| content | fetched by `SafeHttpTransport`, never by the page |
| served on | a session-owned `freya-research://` internal URL |
| CSP | `default-src 'none'`, `script-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'` |
| subresources | denied independently by `onBeforeRequest` |
| permissions, popups, downloads, frames, page navigation | denied |

`style-src 'unsafe-inline' https:` is allowed deliberately and only so the
extractor's visibility pass can exclude hidden content — see §5. It grants no
capability: `onBeforeRequest` cancels every subresource anyway, and the extractor
strips `<style>` and `<link>` before returning text.

**Why a bounded pool.** Electron offers no API to destroy a `Session`, so minting a
partition per read would accumulate one partition, its network context and its
in-memory caches for the life of the process. Four, leased exclusively and cleared
on acquire and on release, bounds it. If all four are busy the read is **refused** —
a bounded pool that silently grows is not a bounded pool.

---

## 5. Extraction, and the thing it deliberately cannot do

One fixed script, generated only from trusted code, run in an isolated world. No
script and no selector comes from the renderer, a model or a page.

It removes scripts, styles, navigation, forms, frames, inputs and common cookie
noise; prefers `article`/`main` and falls back to `body`; resolves relative links
against the **actual retrieved URL**, never the internal one; and returns only
known fields.

Computed visibility is checked **before** styles are stripped, so text hidden by an
inline rule *or* by a stylesheet is excluded. That is why the CSP allows the
stylesheet for the measurement pass.

An unreadable page — one whose only content was navigation and a cookie banner — is
**refused** as `unsupported_document`. Returning it as a successful empty read would
put an empty document in front of a person as though the page had been read, and
into research as though a source had contributed something.

Ceilings: 2 MiB response, 24 000 characters of text, 32 links, 32 headings, a
15-second page timeout, 3 redirects.

**What it cannot do.** This is a read-only service, not a general browser
automation engine. It does not click, fill, scroll, log in, wait for JavaScript, or
run a page's scripts. A JavaScript-only page may yield nothing. It cannot see behind
a login. Anyone expecting a headless browser should not read this as one.

---

## 6. Evidence, and what a citation is

Each source gets a stable source id and document id, its retrieval URL, a normalised
identity URL, title, domain, retrieval timestamp, the query that found it and a
bounded excerpt. Normalisation removes the fragment and known tracking parameters
only. Canonical identity is accepted only for a public URL **on the same host**, and
never replaces the retrieval URL.

Selection is deterministic and prefers source diversity.

**Every finding must cite a source that exists and has text. Every conflict must
cite at least two.** An unknown id is not filtered out — it **fails validation**,
and the whole synthesis is discarded and recorded as a bounded failure. A fabricated
citation cannot be displayed, and unsupported conclusions are not silently promoted
to findings.

---

## 7. Limits, and who owns them

```ts
RESEARCH_LIMITS = {
  iterations: 2, queries: 4, results: 24, pages: 6,
  evidenceChars: 48000, durationMs: 120000,
  modelTurns: 5, failures: 4, documentChars: 8000, maxOutputTokens: 2048,
}
```

These are **code-owned**. Core may configure *lower* values through a validated
override; nothing — not a renderer, not a model, not a page — may raise them, and
`researchLimits()` rejects any override above the frozen ceiling.

They are incremented **before** the operation, not after it succeeds, so a failure
cannot produce a retry that exceeds the ceiling.

The bridge forwards `question` for `research.start` and **nothing else** — not
`modelTurns`, not `durationMs`, not `maxOutputTokens`, not `limits`. A window that
could raise them would make the ceiling advisory.

---

## 8. Cognition: every turn through the existing path

`ResearchCoordinator` holds a `ResearchModel`. That object holds an
`OwnerAuthority` and nothing else — no provider, no gateway, no permit. So the only
route from research to a model is:

```
  ResearchModel → CognitionService → Governor → Model Gateway → provider
```

Every turn carries a grant, `research:<id>:<requestId>`, scoped to the owner,
foreground-only, bounded to 5 calls and 10 240 output tokens, expiring inside the
research deadline, and **revoked in a `finally`**. Completion, failure, refusal and
cancellation all run the same path, so no exit can leave a live allowance behind.

Normal chat is unchanged. Brain recall still costs zero extra model calls. A
conversation turn is still exactly one provider call.

---

## 9. Cancellation, including the race that is easy to miss

Cancellation covers waiting for authorisation, waiting for durable journal writes,
the search provider, browser navigation and read, the model request, gap iteration
and synthesis. A single deadline and abort signal cover the whole job.

The property worth stating plainly:

> **If cancellation lands while authorisation is still pending, the provider call
> that would have followed must not happen.**

`cancelRequest` called before a gateway request exists is not cancellation — it is
a message to nothing. The `CognitionIntent` therefore carries a **trusted
`AbortSignal`** from Core, which `ModelGateway.execute` checks *before* contact and
observes *during* it, removing its listener on settlement. An abort that lands
during the durable `cognition.allowed` write is already visible when `execute` runs,
so there is nothing to cancel and nothing is contacted.

**STOP ALL** closes research admission in the same synchronous turn it closes the
gateway. The gateway stops model turns; research also reaches the network and a
browser, and neither is behind that gate. Cancellation alone would only interrupt
what was already running — the point is that the *next* search cannot happen.

**Shutdown** refuses new research, cancels active research, closes browser
sessions, drains on a one-second bound, and only then closes the Event Fabric. The
bound exists so a wedged browser target cannot hold the application open for the
whole 120-second research ceiling.

---

## 10. Prompt injection: containment, not immunity

This is the honest position, stated plainly because the alternative is a claim the
system cannot support:

> **Prompt injection is not solved. It is contained.**

What containment actually consists of:

- **Structural roles.** The system message holds Freya's immutable identity and the
  stage instruction, both written by trusted code. The question and every retrieved
  source go in `user` messages inside explicit `UNTRUSTED REMOTE DATA` delimiters.
- **No tools in the research loop.** There is no click, no fill, no execute, no
  shell. The most an injected instruction can achieve is a bad answer.
- **Closed output schemas.** Planning and synthesis are re-parsed under schemas that
  reject unknown keys, so a page cannot smuggle a `budget`, `capability` or `limits`
  field — and would be rejected anyway, because the ceilings are frozen constants.
- **Fail-closed citation validation.** An unknown source id discards the synthesis.
- **No authority in the output.** Research output grants no capability, changes no
  identity and chooses no action. Nothing a model says can widen anything.

A page can still put text in front of a model that is trying to be helpful. What it
cannot do is obtain a capability, spend more than 5 turns, read a private address,
or make Freya act.

---

## 11. Events, and what never reaches the journal

Eleven `research.*` stage events share **one** payload shape:

```
  { operationId, sessionId, stage, counters, failureCode }
```

Ids Core issued, a closed stage enum, integer counters, and a fixed failure code.
There is **no slot** for a query, a URL, a domain, a snippet, page text, an answer,
a provider diagnostic or a filesystem path.

The validator **rejects an unexpected key**, not merely an invalid one. Reading
named fields is not enough: a payload with the right fields *plus* a query would pass
every field check and quietly keep the query. That check is what makes "no query in
a research event" a property of the validator rather than a property of everyone
remembering.

There is deliberately **no `research.recalled` event**. Recall happens constantly,
and journalling it would turn the log into a permanent record of what Freya found
interesting.

Expected failures become fixed public codes before they reach anything the renderer
can see. A provider that throws `FAKE_SECRET C:/private/key` gets reduced by
`safeResearchError` at the journal boundary *and* at the research result boundary —
and `ModelGateway`'s own recorder was already sanitising `failed` reasons.

---

## 12. The two windows

**Search** is web query plus read-a-source. It renders a fetched page as bounded
plain text.

**Research** is a separate window, not a tab, because the two cost wildly different
amounts: Search is one query and no model, Research is a bounded multi-stage run that
spends model calls. Merging them would make a free action look like an expensive one.

Three properties the UI holds:

- **Remote and model text render as React children.** There is no
  `dangerouslySetInnerHTML`. A page or an answer can contain `<script>`, and React
  renders it as characters. This is the one place where a rendering mistake would be
  remote code execution.
- **The limits are shown before anything is asked for**, not after. A person
  deciding whether to spend a research run is entitled to know what it costs.
- **Partial is styled differently from complete**, conflicts are shown rather than
  resolved, and **nothing is badged verified**. Research is retrieval; Phase 4
  already established that a stored claim is not proof, and this window does not
  quietly reverse that.

No search, read or research happens on mount. Orb, sidebar, Brain placement and
`--freya-display` monitor numbering are untouched.

---

## 13. Dependencies

None added. The browser is the Electron runtime that was already a dependency; no
Playwright Chromium download, no headless-browser package, no embedding SDK. The
transport is `node:https`. The fixture seam is two injected functions.

---

## 14. Verification

```
  typecheck   3 projects (renderer, electron, core)
  lint        clean
  unit        918 passing across 48 files
  e2e         129/129, including the real sandboxed Electron target
  verify      npm run typecheck && npm run lint && npm run test && npm run build && npm run test:e2e
```

The E2E runs against offline fixtures gated on `FREYA_E2E=1` **and**
`FREYA_E2E_RESEARCH=fixtures`, read in main rather than accepted from a window. It
replaces the transport's DNS resolver and socket request — **not** the URL policy,
the byte bounds, the redirect handling or the browser target. Every live credential
path is explicitly blanked before launch, and both provider-enable flags are set to
`0`, so an inherited developer credential cannot produce a paid call.

What it proves, against the real target: a page is fetched and extracted into real
text; navigation and cookie junk are stripped; content hidden by CSS is excluded;
hostile script, external script, `img onerror`, iframe, form and CSS `url()`
content **do not execute and create no nodes**; a link-local URL is refused; an
unreadable page is refused; research produces cited findings with a visible
disagreement and visible unknowns; citations point at sources actually gathered;
an unconfigured provider invents nothing; and research does not move or resize the
orb.

**Not verified, and honestly so:** no live Brave search, no live NanoGPT synthesis,
no access-controlled or JavaScript-only page, and no Linux/Xvfb run on this machine.
Those need credentials or a different host and were not faked.

---

## 15. Known limitations

- Retrieval is lexical plus entity reference. There are no embeddings and no
  reranking, and `README`/`docs` pages that share vocabulary can tie.
- Conflict detection is literal — same kind, same normalised subject, shared entity,
  different content — or an explicit declaration. It cannot find contradictions in
  prose, and a semantic-looking rule would suppress true memories.
- No login, no cookies, no JavaScript rendering, no clicking, no PDF text extraction.
- One research job at a time; a second `research.start` is refused rather than queued.
- Snippets come from the provider and are not verified against the page.
- Prompt injection is contained, not solved (§10).
- `isDurable`-style guarantees do not apply here: research results are **ephemeral**
  and are never written to the encrypted Brain. Nothing research finds is admitted
  to memory automatically.

---

## 16. The Phase 6 seam

Phase 6 Work will call **these same high-level services** — `searchWeb`,
`readWebPage`, `research` — with an `AbortSignal`, and subscribe to these same
metadata-only events. Phase 5 deliberately introduces **no** Runs, Steps, Actions,
Tasks, Missions or Work approval machinery.

The capabilities a future Work step would need already exist and are already
guarded: `search.web`, `browser.read`, `research.start`. Worker principals hold
none of them — a worker can ask for cognition under a grant, and cannot reach the
network or a browser. If a future phase grants one to a worker, that is a decision
worth making deliberately and writing down.