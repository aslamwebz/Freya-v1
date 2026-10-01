# Browser roadmap — architecture only

**Nothing in this document is implemented.** It records the direction so Phase 5
and the later Relay phase are designed against one intent rather than two
discoveries at the time.

Phase 2 built the command environment. Browsing is a later phase, and the reason
it is written down now is that the shape of the decision is worth stating before
anyone starts writing a browser extension.

---

## The shape

Everything, in every phase, goes through the same door:

```
        Browser Intent
              ↓
    Guard / policy / approval
              ↓
        Browser Service
              ↓
   ┌──────────┴──────────┐
   ↓                     ↓
Managed Browser      Browser Relay
(Freya's own)        (your Chrome/Edge)
```

One intent type. One policy point. One service. Two possible execution targets.

The separation that matters is between **intent** and **execution**: Freya decides
*what she wants done*, the Guard decides whether she may, and the target is
selected at the last moment. Nothing upstream knows or cares which browser will
run it, which is what makes the Relay phase an addition rather than a rewrite.

---

## Phase 5 — Browser Service (shipped, narrower than planned)

A managed, isolated browser that Freya owns and launches.

- **Browser intents** — declarative, typed requests. **Shipped: `navigate` and
  `read` only.** `click` and `fill` were in the original scope and are *not*
  implemented; see "What did not ship" below.
- **Browser actions** — each operation mapped to an intent and requiring
  authorisation. Shipped as the Guard capability `browser.read`, evaluated before
  the fetch rather than after it.
- **Browser observations** — structured results: title, headings, plain text,
  bounded links, metadata, retrieval time, length and truncation. An observation is
  data, not a DOM handle and not a code fragment to be evaluated later.
- **Execution-target abstraction** — `BrowserTarget` / `BrowserTargetFactory`,
  letting the same intent run against either target. The managed Electron target
  implements it.

Isolation is the point of the managed browser: a profile Freya created, cookies and
storage that are hers rather than the user's. It is the reason to prefer it when the
task does not need the user's session.

### What actually ships

`core/research/browser.ts` and `electron/research/managedTarget.ts`. A hidden,
sandboxed, `contextIsolation` window with no preload and no node integration; the
page fetched by the controlled transport and served on a session-owned internal URL
under a restrictive CSP; every subresource, permission, popup, download, frame and
page-initiated navigation denied; one fixed trusted extraction script run in an
isolated world. Session partitions come from a bounded leased pool of four, because
Electron cannot destroy a `Session` and one-per-read would accumulate. Full detail
in [PHASE-5.md](PHASE-5.md) §4.

### What did not ship, and why it matters

**`click` and `fill` are not implemented, and their absence is deliberate.** They
are the two intents that turn a page's text into an *action*. A page that can be
clicked is a page whose author chose what Freya does next, and the injection
containment described in [PHASE-5.md](PHASE-5.md) §10 depends on there being no
executable surface for an injected instruction to reach.

So the managed browser is a **reader**, not an agent. It cannot log in, cannot see
behind authentication, and does not render JavaScript — a client-rendered page may
yield nothing. That is a real limitation for anyone expecting a general browser, and
it is the correct trade for a research subsystem.

Anything that needs interaction belongs to a future phase, needs its own capability
and its own authorisation, and should not be bolted onto this target by widening it.

---

## Later — Browser Relay

An extension that connects Freya to the browser the person is already using, with
the sessions they are already authenticated to.

- **Freya Browser Relay extension** — Chrome/Edge extension.
- **Chrome/Edge** — the host browser. Freya does not own it.
- **Transport** — Native Messaging, or an equivalent locally authenticated
  channel. Not a public server, not an inbound port, not a websocket to anywhere.
- **Permissions** — scoped to specific **tabs and sites**. An extension with
  "read all your browsing" permission is not an acceptable price for this feature,
  and the manifest should make that structurally hard to ask for.

### Three ways control is initiated

All three are legitimate; none is a back door around the other two.

| | Who initiates | Uses the user's session? |
| --- | --- | --- |
| **User-triggered** | a person clicks in the extension | yes |
| **Event-triggered** | a page event the user chose to observe | yes |
| **Freya-triggered** | an authorised Browser Intent | yes |

Freya-triggered control still goes through the Guard, and the extension is the
one enforcing tab/site scope. A capability that arrived from Freya is not trusted
by the extension any more than a capability that arrived from a web page is.

---

## What the extension must never contain

This is the security boundary of the whole feature, stated as a list of things
that must not be true:

- **NanoGPT credentials.** No keys. The extension never sees a model credential
  and never makes a model call.
- **Vault encryption keys.** No key material of any kind. Vault keys must not be
  reachable from any component that touches a browser.
- **Broad Freya authority.** No grants, no capabilities, no command surface. It
  cannot create authority for itself and cannot delegate any it has.

The extension **receives narrowly scoped browser commands and returns
observations**. That is the entire contract. It is a remote control with a short
cable, not a participant in Freya's intelligence.

The reason is worth stating plainly: an extension runs on every page the user
visits. Anything with standing authority in it becomes the highest-value target in
the system. Keeping it incapable is stronger than keeping it well-behaved.

---

## Why the abstraction exists

The obvious implementation is to build against a browser and add the extension
later. The problem is that the extension's failure modes are different — it is
subject to the host browser's permissions model, the store's review, and the user
disabling it — and a design that assumes it can always reach the page will have
made promises the Relay path cannot keep.

Putting the abstraction between the intent and the execution makes that visible
now: an intent that cannot be honoured by the current target is refused at the
service, in Freya's own terms, rather than failing somewhere inside someone
else's browser.
