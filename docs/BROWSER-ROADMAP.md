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

## Phase 5 — Browser Service

A managed, isolated browser that Freya owns and launches.

- **Browser intents** — declarative, typed requests: navigate, read, extract,
  click, fill. Not a script, not arbitrary JavaScript, not "run this at the page".
- **Browser actions** — the operations the service will perform, each one mapped
  to an intent and each one requiring authorisation.
- **Browser observations** — structured results. Text, links, form fields,
  navigation events. An observation is data, not a DOM handle and not a code
  fragment to be evaluated later.
- **Execution-target abstraction** — the interface that lets the same intent run
  against either target. Phase 5 ships the managed browser implementing it.

Isolation is the point of the managed browser: a profile Freya created, a process
she started, cookies and storage that are hers rather than the user's. It is the
reason to prefer it when the task does not need the user's session.

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
