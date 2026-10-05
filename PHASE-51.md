# Phase 51 — Dual Browser Runtime

**Status:** IMPLEMENTED AND ACTIVATED — FAIL-CLOSED BY DEFAULT
**Branch:** `runtime/phase51-dual-browser`
**Baseline:** `f7d5436` (Phase 43 browser extension, activated against the real Device Hands)
**Required outcome:** Freya has two browsers — an embedded credential-free one and the
paired Chrome extension — with one authority behind both, a routing policy that picks
between them, and a handoff layer that never merges them.

---

## 1. What this document is

Phase 43 shipped the Chrome extension. Phase 42 shipped the Device Hands activation that
gave the browser surfaces a real authority. `docs/BROWSER-ROADMAP.md` promised, before
either existed:

> One intent type. One policy point. One service. Two possible execution targets.

Phase 51 is the second execution target, and the routing layer that chooses between them.

What it did **not** do is the thing that would have been easy: give the new browser its own
gates. There is one Device Hands runtime, one grant source, one hash-chained journal, one
STOP ALL latch, and one set of ten gates, and both browsers are two *doors* onto it.

---

## 2. The two targets

| | **public** | **authenticated** |
| --- | --- | --- |
| what it is | the embedded **Freya Browser**: a window Freya owns | the Phase 43 Chrome extension |
| whose state | nobody's — an empty in-memory partition | the person's: their logins, their MFA, their tabs |
| scripts | runs them; it is a real browser | runs them; it is their browser |
| for | public reading, research, previews, agent-controlled work | anything that needs the person |
| acts | `navigate`, `read`, `describe`, `click`, `type` — all through Device Hands | the same four, via the bridge |
| gated by | the same `browser.*` action keys, the same grant, the same ten gates | identical |

The vocabulary is closed at two (`core/browser/types.ts`). There is no `any`, no `default`,
no third target, and no way to name a cookie jar, a profile or a session as a target. A test
asserts all of that, because "two targets" is a claim a later phase could quietly widen.

---

## 3. Architecture

```
                 BrowserRequest  {command, target, sessionId, url, ref, text, handoffId}
                        |
                        v
  +---------------------------------------------------------------+
  |  core/browser                                                 |
  |                                                               |
  |   halted()          STOP ALL, then the subsystem switch        |
  |   routeBrowserIntent()   public | authenticated | refused      |
  |   RefTable          a reference belongs to one (page, revision)|
  |   describePage      bounded elements, stable refs             |
  |   HandoffLedger     offer / accept / cancel, credential-free  |
  |   MediaOfferLog     download metadata, never bytes            |
  |   browserRecoveryReport()   what a restart will not replay     |
  +---------------------------------------------------------------+
                        |
        BROWSER_COMMAND_ACTION: the only route to a page
                        |
                        v
        Phase 35 Device Hands runtime  (ONE runtime, ONE journal)
        journal-trustworthy -> stop-all -> enabled -> replay ->
        surface -> grant -> deadline -> budget -> policy -> approval
                        |
        ports.performBrowser(request)         <-- THE EXISTING PORT
                        |
        +---------------+----------------+
        |                                |
   inPage === null                 inPage: the window
   -> Phase 5 managed              -> the Freya Browser
      research target                 (non-persistent
      (read only; a click               partition, every
       is `browser-action-              permission denied,
       unsupported`)                    no private address)
        |
        v
   BrowserObservation  {revision, url, title, elements, text, changed}
                        |
        back through the same runtime, which journals it as `hands.*`
```

### The one wiring change this phase needed

`electron/devicehands/effects.ts` gained **two optional members** on interfaces it already
had:

```ts
interface DeviceBrowserSession {
  act?(request: BrowserPortRequest): Promise<BrowserPortOutcome>   // new, optional
  // navigate / readText / close unchanged
}

interface DeviceBrowserFactory {
  open(): Promise<DeviceBrowserSession>                           // unchanged
  openInPage?(request): Promise<DeviceBrowserSession | null>      // new, optional
}
```

and `createBrowserEffect` now prefers a live page when one is serving the authorised URL:

- a **click or a keystroke** with a live page → driven by that page, with `holds: false`
  whenever the page does not visibly react;
- a **click or a keystroke** with no live page → the Phase 35 answer, `browser-action-unsupported`;
- a **read** with a live page → that page, which is both faster and more truthful than
  re-fetching into a hidden window;
- a **read** with no live page → the Phase 5 managed target, unchanged.

Nothing was removed and no existing member changed shape, so Phase 42's behaviour for every
caller that has no Freya Browser switched on is **byte-for-byte the same**. `tests/host/devicehands/browser.test.ts`
passes untouched.

`electron/browser/publicAdapter.ts` supplies `inPage`. It contains no Electron import, so every
refusal in it is testable without a display.

---

## 4. The routing policy

`core/browser/routing.ts`, in this order:

1. **Is the command one this build routes?** If not, nothing else is considered.
2. **Was a target named?** An explicit `public` or `authenticated` is honoured. `auto` resolves
   to **public** — Freya's own browser is the default because it holds no credentials, and
   "use the person's browser unless told otherwise" is the wrong default for a system that has
   one specifically in order not to.
3. **Can that target run at all?** The public browser must be activated; the extension must be
   paired *and* live. Paired-but-not-connected is not connected.
4. **Does this command need a session, and does the session match?** A page command with no
   session is `session-unknown`, not an implicit open. A session on the other browser is
   `handoff-target-mismatch`, not a silent move.
5. **Is there an escalation to propose?** Never to apply.

Four things the router deliberately refuses to do:

- **No silent fallback.** If the public browser cannot open a page, that is a refusal. Moving
  from a credential-free context into the owner's logged-in browser is a decision somebody
  should make on purpose.
- **No auto-escalation by default.** `autoEscalate` is off unless the owner turns it on, and
  even then the answer carries `escalation: {to, reason, detail}` as **data** while the route
  stays `public`.
- **No page reading to decide.** `classifyAuthenticationNeed` reads counts and status codes
  from an observation that already exists. It performs no I/O, so "route" can never become
  "fetch".
- **It cannot grant.** Every route still reaches Device Hands.

### Why a page "looks like a wall"

`classifyAuthenticationNeed` returns one of `none`, `login-required`, `session-required`,
`mfa-required`, `site-blocked`, each with the number that triggered it, most specific first:
an owner-listed host, then 401/403/407, then a one-time-code challenge, then a form with a
protected field and under 512 bytes of prose, then an account-shaped path, then a sign-in
affordance with almost no text. 512 bytes is a named constant, not a number buried in a
comparison.

---

## 5. Public browser isolation

The Freya Browser is allowed to be a real browser — a client-rendered page that yields nothing
is not a browser, and Phase 5 was honest that its managed target is a *reader*. What it is not
allowed to be is a browser that knows anything about the person using it. Four rules, enforced
in `electron/browser/freyaWindow.ts` and audited in `tests/red-team/browser`:

1. **A non-persistent partition.** `freya-public-<session>`, never `persist:`-prefixed, checked
   case-insensitively. Cleared on acquire *and* on release, so a partition whose previous close
   was interrupted cannot hand its cookies to the next session.
2. **Every permission denied.** `setPermissionCheckHandler(() => false)` and
   `setPermissionRequestHandler(..., callback(false))`. No carve-out table exists; a test asserts
   the closed list.
3. **No local or private address.** `webRequest.onBeforeRequest` cancels anything that is not a
   public `http`/`https` URL, so a page cannot use DNS rebinding, an `<img>` or a `fetch` to
   reach `192.168.0.1`, `localhost` or a metadata endpoint. The main frame is additionally held
   to the owner's host allowlist.
4. **No downloads.** `will-download` is cancelled; only the URL, file name, media type and
   declared size are kept. Fetching is a separate, already-gated `transfer.download`.

Plus: `sandbox: true`, `contextIsolation: true`, no node integration, **no preload at all**
(asserted by source audit), `setWindowOpenHandler(deny)`, and every `will-navigate` re-checked
against the URL policy so a page cannot navigate itself off the allowlist.

### What is deliberately not reused

`EXTRACTION_SCRIPT` from `electron/research/extract.ts` is **not** used in this window. That
script *mutates the live DOM* — it removes hidden nodes, scripts and navigation — which is
correct for a throwaway window rendered from a CSP'd internal URL and vandalism in a window
the owner may be reading. So this phase carries its own **read-only** extraction script that
computes the same thing without touching the page. "Reuse everything" is usually the wrong
instruction; reuse with the reason checked is the right one.

---

## 6. Truthful state, snapshots and stale references

### State

Every word is earned by an observation. There is no `unknown`: `BROWSER_PAGE_STATES` is
`absent | loading | ready | failed | closed`, and

- a failed load is `failed`, not `absent` — they are different facts;
- a closed session reports `closed` with its URL cleared, so a projection cannot offer a page
  that no longer exists;
- the revision only ever increases;
- the projection carries `observed: false` when a session exists but nothing has been observed,
  because a projection that says "ready" should also say how it knows.

### References

A reference belongs to exactly one `(pageId, revision)` pair and is a digest of
`(pageId, revision, ordinal, kind, selector)`. A navigation, a reload, a failed load or a
closed window advances the revision, which retires every reference from before it.

Retired references are **remembered as tombstones**, not deleted, so the refusal can name the
revision: *"that reference belongs to revision 1 and the page is now at revision 2"*. Deleting
them would give "I have never heard of that reference", which sends the caller round the loop.

The digest is two FNV-1a lanes and **is not a security primitive** — it says so itself. What
stops a forged reference is that `RefTable.resolve` only ever resolves against entries this
runtime actually minted for the current revision. A well-computed fake is `ref-unknown`.

`tests/core/browser/refs.test.ts` runs **every described locator through the real Phase 35
`normaliseDeviceAction`**, because `describePage` and the gate each keep their own copy of the
selector rule and the only way to know they still agree is to feed one to the other.

---

## 7. Acting, and what it is allowed to claim

`click` and `type` are implemented end to end and gated end to end. In a **default build they
are refused**, because `browser.click` and `browser.type-text` are approval-requiring in
Phase 35 and this architecture has no owner-approval channel. That is a Phase 35 seam, not a
Phase 51 one, and the refusal is at the *approval* gate on the *approved* action key with the
page untouched — which `tests/host/dualBrowser.test.ts` asserts against the real runtime.

When the gate does allow them, the adapter refuses to over-claim:

- a click is `holds: false` unless the page demonstrably reacted (URL, title, node count, or a
  focus change, looked for twice inside a hard bound and no longer);
- a keystroke is `holds: false` unless the field reads back **exactly** what was typed, read
  through the prototype setter a framework would actually see;
- a protected field is refused by name — `classifyProtectedField` from `core/browserext`, the
  same function the extension uses, checked twice (once in the adapter, once by Core);
- if the window has moved off the URL the authority checked, the act is refused `page-moved`.

A `passed` verdict with nothing observed is reported as a **contradiction**, not a success.

---

## 8. The handoff

A handoff is a URL, a reason, a title, an optional note, a TTL and an integrity digest. That is
the whole payload, as a **closed list** — `HANDOFF_CONTEXT_KEYS` is `['title', 'note']` and a
fifth field cannot be added by a caller that tries.

`assertCredentialFree` is run over the whole envelope — keys, values and nesting — and refuses:

- a key containing `cookie`, `token`, `auth`, `session`, `storage`, `profilepath`, `keyring`,
  `vault`, `otp`, `mfa`, `totp`, `csrf`, `webauthn`, `privatekey`, `clientsecret`, `apikey` …;
- a value that is a `__Secure-`/`__Host-` cookie, a `Bearer`/`Basic` header, a JWT, a PEM header,
  or a serialised cookie jar (`a=1; b=2` — semicolon-separated, so a URL's `&`-separated query
  does not match).

There is **no option, no flag and no owner approval** that lets a cookie cross. Doing so would
*merge the two contexts*, and their being separate is the entire reason the extension exists.

Direction matters and is asymmetric:

- `public → authenticated` — Freya found something publicly, the person finishes with their own
  session. Refused unless the extension is paired and live.
- `authenticated → public` — the trust-*downhill* direction, and narrower. The envelope carries
  the URL and nothing else, and it is offered rather than pushed.

### The destination is honest about what it can do

The Phase 43 protocol has **no "create a tab" command**, and this phase did not add one:
putting a page in front of the person without them having shared anything is exactly what the
`page.share` model forbids. So a handoff can only continue in a tab the owner has **already
shared**, via a new `BrowserExtensionHost.continueInSharedTab` that routes through the host's
existing `dispatch` — the same gates, the same session capability, the same shared-origin check.
With no shared tab it is refused `target-unavailable`, not half-served.

---

## 9. Restart recovery

From `core/browser/recovery.ts`, with the same rule Phase 35 applies to an interrupted action:

| what | after a restart |
| --- | --- |
| a read | cost nothing; nothing claimed, nothing replayed |
| a description | the references it minted died with the process; **none are handed back** |
| a navigation | the session is reported `lost`, **not reopened** |
| a click or a keystroke | `interrupted` in Phase 35's terms; **never retried** |
| an unsettled handoff | **`uncertain`**, never consumed, never retried |

`foldHandoffs` is incremental; `settleUnfinished` is what knows a run has ended and turns every
still-`open` offer into `uncertain`. `uncertain` has **no outgoing edge** in the transition
table: it can never be consumed, cancelled or retried. An offer does not survive the process at
all (the envelope is in memory), so accepting one after a restart is refused `handoff-unknown`
with the reason *an offer does not survive a restart*.

There is no timer here. Nothing can wake itself up and try.

The summary sentence never says an uncertain effect succeeded:
*"The last run ended with N uncertain effect(s). None of them were replayed; each needs a
decision again."*

---

## 10. Activation

| switch | meaning |
| --- | --- |
| `FREYA_DEVICE_HANDS=1` | Phase 42's switch. Required. |
| `FREYA_PUBLIC_BROWSER=1` | this phase's switch. Required. |

Both, and both default **off**. A public browser with no Device Hands runtime behind it would
have no gates at all, so the second switch cannot be useful without the first — the same rule
Phase 43 followed when it refused to be `active` without Phase 42.

The activation also refuses to open when the journal does not chain, and it takes the **same
journal object** `coreHost` already has (`coreHost.deviceHandsJournal()`), so there is one
writer and one integrity chain.

Wiring, in three lines of composition:

```ts
inPageFactory: () => publicBrowserAdapter?.inPage ?? null   // electron/devicehands/electronEffects.ts
perform: (request) => requireCore().performDeviceHandsAction(request)  // electron/browser/activation.ts
journal: coreHost.deviceHandsJournal()                                    // same file, one writer
```

`coreHost` gained exactly one new method, `performDeviceHandsAction`, and one accessor,
`deviceHandsJournal`. Neither can reach a grant, a policy or an approval: only `perform`.

---

## 11. Tests

| suite | what it proves |
| --- | --- |
| `tests/core/browser/isolation.test.ts` | partition rules, URL policy, credential refusal over keys, values and nesting |
| `tests/core/browser/refs.test.ts` | references depend on the revision; every described locator passes the **real** Phase 35 gate |
| `tests/core/browser/routing.test.ts` | `auto` is public; no silent fallback; escalation is proposed, never applied |
| `tests/core/browser/handoff.test.ts` | closed context list, integrity digest, direction, target, freshness, settlement |
| `tests/core/browser/media.test.ts` | metadata only; a `.png` is honestly reported as untransferable |
| `tests/core/browser/state.test.ts` | truthful page/session words; the revision never goes backwards |
| `tests/core/browser/runtime.test.ts` | the whole runtime against the **real** adapter: gates, stale refs, protected fields, unobserved acts, STOP ALL, handoff, restart |
| `tests/host/dualBrowser.test.ts` | the activation against the **real** Phase 35 runtime, real journal, real Phase 43 host |
| `tests/red-team/browser/dual-browser-redteam.test.ts` | vocabulary and source audits, SSRF, credential boundary, stale refs, lying adapters, non-replay |

**7604 tests / 384 files pass. `typecheck`, `lint`, `build`, `test:e2e`, `test:redteam` and
`release:check` all pass.**

Note that the Core harness reaches the page through `adapter.inPage.openInPage` — the *same*
door production uses — rather than a private shortcut, so the tests exercise the real round trip.

---

## 12. Unresolved seams

Stated plainly, because the phase is not safe to integrate without them.

1. **No owner-approval channel.** `page.click` and `page.type` are implemented and gated but
   **refused in every default build** at the Phase 35 approval gate. Phase 42 found the same
   thing for the extension and this phase did not invent a way around it.
2. **An approval, if it existed, could not be pre-granted for a browser action.** Phase 35 binds
   an approval to a subject that includes the `actionId`, and the Phase 51 runtime mints that id
   *inside* `gated()`. A future approval channel would need the id surfaced, or the approval
   requested and re-checked by the runtime itself.
3. **The Freya Browser is visible and scriptable.** That is deliberate and it is the difference
   from Phase 5, but it means a page's JavaScript runs. The containment is credential
   isolation, not script isolation: the partition is empty, every permission is denied, and no
   private address is reachable. A page cannot see the person; it can still be *persuasive*.
4. **No renderer surface.** Nothing here is exposed over IPC, so there is no UI for opening a
   session, describing a page or accepting a handoff. Deliberately — "no UI redesign" — and it
   is why activation is proven by host tests rather than by a screenshot.
5. **`continueInSharedTab` cannot create a tab.** A handoff with no shared tab is refused. Adding
   a create-tab command would be a Phase 43 protocol change and would need its own threat model.
6. **Handoff context is two free-text fields.** Structural credential smuggling is refused;
   a value that is *itself* a cookie and looks like prose is not detectable by syntax. The
   guarantee is about structure, not about arbitrary text a person typed.
7. **`main.cjs` grew ~240KB** to ~2.23MB and the release budget was raised from 2.10MB to
   2.35MB with the reason recorded in `scripts/release-policy.mjs`, following the precedent
   Phase 42 set. The host is still unminified on purpose so its source can be audited in the
   shipped artifact.

---

## 13. Safe-to-integrate verdict

**Yes, with the seven seams above read as part of the verdict.**

What is genuinely true and proved:

- two browsers, **one** authority — one runtime, one journal, one grant source, one STOP ALL;
- the routing policy cannot silently move Freya from a credential-free context into the
  person's logged-in browser, and cannot apply an escalation even when asked to;
- the public browser cannot reach the owner's network, hold a credential, keep a permission or
  write a download;
- a reference cannot be replayed against a replaced page, and an unobserved act is never
  reported as done;
- nothing crosses between the contexts that could carry a credential, in any direction, under
  any field name;
- a restart replays no uncertain effect, and reports them;
- every new browser act is refused in a default build until a grant exists, and the two acts
  are refused at the approval gate even then;
- Phase 42 and Phase 43 behaviour is unchanged for every caller without the new switch on.

What is **not** true yet: an owner can approve a consequential browser action, and there is no
way to reach any of this from a window.

Recommendation: integrate. The phase is additive, off by default, and its failure mode is a
refusal. Land the seams as follow-ups rather than as conditions, because nothing here is
*enabled* without two deliberate environment switches.