# Decisions

## D1 — Desktop stack: Electron + React + TypeScript + Vite

### Requirements

Native glass windows, tray, microphone, filesystem, child processes, PTYs,
multiple windows, WebGL, IPC, a background runtime that outlives the UI,
browser surfaces, local-first operation.

### Considered

| | Electron | Tauri |
| --- | --- | --- |
| Frameless / glass windows | yes | yes |
| PTY, child processes | node-pty / child_process | Rust sidecars |
| Tray, global shortcuts | mature | good |
| WebGL / 3D | Chromium, pinned by us | OS webview, varies per machine |
| Multiple windows + IPC | mature | mature |
| Language surface area | one (TypeScript) | TypeScript + Rust |
| Ship size | ~180 MB | ~10 MB |
| Background runtime | Node, in-process | Rust, in-process |

**Chose Electron.** Three reasons, in order.

1. **One language, one toolchain.** Freya's main process will own PTYs, the
   event fabric, the governor and the file layer. In Rust that is a second
   language and a rebuild step on every change.
2. **Pinned rendering.** The presence is a real-time canvas and future
   surfaces will embed browser views. A pinned Chromium means the visual
   design and backdrop-filter behaviour are identical on every machine, which
   a system webview cannot promise.
3. **It is replaceable.** The renderer reaches main through a four-function
   preload bridge. If binary size ever matters more, the same renderer
   moves to Tauri by rewriting one file.

Cost: ~180 MB of disk and higher idle RAM than a native toolkit. Accepted for
Phase 0, recorded so it stays a decision rather than an accident.

### Rendering: three.js, after all

**This reversed an earlier decision in this document.** Phase 0 first shipped the
central intelligence as a purpose-built Canvas 2D renderer: a seeded point
lattice, instrument rings, a beam and a pedestal. It was cheap, ownable, and it
worked — but it was an interpretation of the reference, not the reference.

The requirement is the reference's presence: the liquid orb with its
noise-displaced shells, the brain in four distinct render styles, the arc
reactor, the tesseract, the galaxy, the HUD scanner, the beam, the pedestal, and
the background rings that erode into particles while anyone is speaking. That is
a real-time 3D scene. Re-deriving it in 2D would have been a lookalike, and a
lookalike is the wrong answer when the brief is "the same design".

So three.js is a runtime dependency, and the port is structured rather than
dumped in:

```
src/presence/
  labState.ts      the design lab's state and its options
  voiceEnvelope.ts the voice level signal (simulated in Phase 0)
  stage/
    primitives.ts  shaders, seeded random, shared materials
    PresenceStage.ts  the scene, the loop, resize, visibility
    RingLayer.ts      the full-window background rings
  pieces/          one module per centrepiece; the brain carries its four styles
  DesignLab.tsx    the lab panel
  PresenceView.tsx React binding: two canvases, one clock
```

What that structure buys:

- one animation loop, shared by both canvases, that stops when the window is
  hidden and does not start at all under `prefers-reduced-motion`;
- point counts, tessellation and pixel ratio chosen by us, so idle cost is
  measurable and capped (the reference's flow and galaxy counts are roughly
  halved);
- the stage is code-split behind a dynamic import, so a shell that never reaches
  the presence does not pay for three.js;
- a failing WebGL context degrades to a stated still frame instead of a blank
  column.

Bloom, the composer and the output pass come from three's own addons. No other
3D library, no postprocessing package.

### State: no Redux / Zustand / Jotai

`src/core/events.ts` is one typed event union and one reducer. It is the state
container and the event bus together, which is what Phase 0 asked for and what
every future system will dispatch into. `useSyncExternalStore` gives tear-free
React subscription with no library.

### Persistence

`workspace.json` in Electron `userData`, written by the main process.
`localStorage` exists only on the browser dev path. See ARCHITECTURE section 4.

### Testing

| Layer | Tool | Reason |
| --- | --- | --- |
| Unit | Vitest | same resolver and config as Vite, no second build |
| DOM | Vitest + jsdom | jsdom over happy-dom: lower risk of masking real focus behaviour |
| E2E | Playwright, Electron driver | drives the real app, real main process, real persistence |
| Lint | ESLint flat config + typescript-eslint | the minimum that catches dead code |
| Types | tsc --noEmit | separate configs for main and renderer |

### Dependency budget

Runtime dependencies: **react, react-dom, three. Nothing else.**

Every other package is dev-only and exists to build or verify. There is no
router (one route: the shell), no state library, no date library, no icon
package (18 hand-drawn 24px stroke icons in one file), no CSS framework, no
component library, no HTTP client, no speech stack, no vector database.

Rejected explicitly:

- react-router: a desktop shell has no URLs.
- react-icons / lucide: 18 icons, one small file.
- framer-motion: three CSS transitions cover every motion cue in the shell.
- zod: Phase 0 validates one small file; a hand-written guard is clearer.
- date-fns: Intl.DateTimeFormat is already there.
- node-pty: no terminal in Phase 0.
- postprocessing / a bloom library: three's own addons cover it.
- the reference's photographs and icons: see D2 and D3.

## D2 — The atmosphere is built from light, not from a photograph

The reference's default background is a blurred night-city photograph. Freya
ships **no backdrop imagery at all**. All five treatments — city, deep space,
grid lab, aurora, obsidian — are pure CSS gradient stacks.

Deep space is the default. It has no floor and no city, so the presence reads as
suspended rather than installed, and the two star layers give the composition
depth that a single saturated centrepiece cannot.

A photograph would have been easier and worse: it costs a large asset, it has to
be re-shot for any display, it fights the panels for legibility, and it makes
"local-first, nothing fetched" a claim rather than a property.

## D3 — Freya draws its own icons and its own mark

The reference's icon sprite and its brand glyph are not reused. Freya's set is
drawn in house on a shared grammar — 24-unit grid, 1.5 stroke, a plain silhouette
plus one small instrument accent — so the glyphs read as laboratory equipment
rather than as a generic icon font. The wordmark mark is an aperture: a vesica
with a nested vesica and a core dot.

Eighteen glyphs and one mark is a small file. A general icon package would have
been a dependency, a download, and sixteen shapes Freya would not have owned.

## D4 — Monogram avatars, not stock faces

The prototype shows five named agents as stock photographs. Freya's workforce is
not five stock humans, so avatars are deterministic monogram discs using the
gold ring the reference already uses. Same visual slot, no implied humans.

## D5 — The dock is the Surface Manager's launcher

The prototype's dock is a mode selector. In Freya it opens and focuses
surfaces. This makes the windowing system visible on the command screen instead
of hidden behind navigation, which is the point of Phase 0.

## D6 — Demo data is labelled, not disguised

Every demo value carries a `demo: true` flag in state and renders with a
visible DEMO marker. No fake analytics, no fake world map, no fake globe.
If a panel would need a data source that does not exist, it is not shown.

## D7 — The voice envelope is simulated, and says so

Phase 0 installs no speech stack, and the desktop host denies every permission
request — including the microphone — because granting it for a control that
cannot transcribe anything would be a capability with no purpose.

So the level signal is generated locally from a speech-shaped envelope. What is
real and exercised now: the smoothing, the ring erosion while someone speaks,
the orb's response bars, and the state machine that treats a pause as the end of
your turn. What is missing is exactly one function: reading a real analyser.
The design lab says "Test voice reaction" because that is what it does.

## D8 — Surfaces may not cover the chrome

The workspace frame excludes the header and the navigation rail, measured from
the DOM rather than hard-coded, so it stays correct across the responsive
breakpoints. Windows can be moved, resized, minimised and maximised anywhere
inside the workspace, but they can never be dragged under the command bar or
over the systems list.

A window manager that lets you lose the navigation is a window manager you will
fight. The dock sits above the surface layer for the same reason, and so does the
design lab.

---

# Phase 1 corrections

The decisions below were made during the Phase 1 correction pass. Each one
replaced something that looked right and was not.

## D9 — Identity is assigned, never accepted as a parameter

Core originally handed out a `CognitionService`, and that service's
`createGrant` took a `createdBy` while its `request` took an `actor`, an
`origin`, a `cause` and a `background` flag. Every one of those was a value the
caller chose.

That is a boundary that only works if everyone inside it is careful, and the
whole point of a boundary is that it works when someone is not. A future agent
could have called `createGrant(createdBy: 'owner')` and the journal would have
recorded the owner as having authorised it.

Replaced with authority objects whose principal is fixed at issuance and whose
methods reflect that principal. The owner's has grant governance; a worker's does
not; a worker's request type has no `user_turn` in it. A caller can name a
*kind* of intent and nothing else — Core derives the origin, the cause and
whether it is background.

## D10 — The security module exports no principal factory

`core/security/guard.ts` exported `ownerPrincipal(capabilities)`. That was a hole
with a tidy signature: any module inside Core could call it and be the owner, and
the code doing it would have looked like ordinary use of the security module
rather than an escalation.

Trusted principals are now built in one place — the Cognition Service — and the
guard exports only the policy that judges a principal it is handed. A `Principal`
is still a plain interface, so a determined caller can write the literal; what is
gone is the official-looking constructor. That is the difference between an
escalation that reads like normal code and one that does not, and in a codebase
whose security depends on review, it is the difference that matters.

## D11 — A grant's token budget is reserved before the call, and never refunded

The budget was measured against `usage.outputTokens` — what the provider
*reported*. Two failures followed. A provider that reported nothing looked free,
and the ceiling never actually moved, because reporting usage is not spending
it.

The service now durably reserves the requested allowance **before** the provider
is called, and never refunds it. A crash or a missing usage report must not hand
it back, because a refund is how a finite budget becomes an infinite one.
Reported usage is recorded separately, because a report is not a correction.

## D12 — Authorisation and reservation are one indivisible step

Found by the adversarial pass, not by reading the code. Ten concurrent requests
of 300 tokens against a 1000-token grant were all allowed, and the grant finished
3000 tokens over.

"How much is left?" and "take that much" were two steps, and every caller read
the same remaining figure before any of them had reserved. Serialising the event
log did not help and never would: the fabric guarantees unique sequences, not a
correct decision.

The fix is a lock **per grant**, held across the Governor's evaluation and the
reservation, released before the provider is called so inference is not
serialised. Different grants proceed in parallel.

## D13 — Event appends are serialised

Related to D12 and independently wrong. Concurrent callers all computed
`sequence + 1` before any of them had written, so the log could be handed a
duplicate and reject a write that had already partly happened.

The whole body of `append` — assignment, durable write, publication — now runs
one at a time. The queue never rejects, so one failed append gives its number
back and the append behind it still lands.

## D14 — The journal is validated, not pattern-matched

Recovery accepted anything that vaguely resembled an envelope. A security journal
is only as trustworthy as its least validated byte, so every line is now checked
against the event vocabulary, the schema version, a positive strictly
increasing sequence, a real principal id, well-formed correlation ids, and a
payload matching its own type.

The principal check is the one that matters: it is what stops a hand-written
line from acting as `owner`.

A damaged line truncates the log from that point, including valid events after
it. That is deliberate — a journal with a hole in it cannot be replayed into
security state, because the gap could hide the revocation that followed.

## D15 — The journal does not contain command text

`command.received` stored the user's command verbatim. It now stores the command
id, its length, and where it came from.

A security journal is read by people, shipped in backups, and kept far longer
than a conversation. The journal needs only enough to answer "did this happen,
and was it this long". Conversation content belongs in conversation storage,
which will have its own retention rules.

## D16 — The echo provider is not a model

Core registered a `FakeModelProvider` unconditionally, so a build with no
credentials answered from a canned string of the user's own prompt and looked
like it was working. That is the worst possible failure for this system: it
looks like intelligence and is an echo.

Production registers NanoGPT and nothing else. Absent or disabled means no
configured provider, and a request fails with that reason rather than falling
back. The echo provider is opt-in under a name that says what it is, is listed
last so it cannot shadow a real provider, and prefixes its output so a
screenshot cannot be mistaken for a reply.

## D17 — Core belongs to the process, not the window

Closing a window ran the same path as quitting, so a closed window stopped Core.
On macOS, where the app outlives its last window, the next window got a brand new
Core over a replayed log — which quietly undoes the point of a durable one.

Window close now flushes the workspace and nothing else. Only `app.quit()`
reaches the Core shutdown.

## D18 — STOP ALL takes two presses

A single button next to a resume button is one stray click from halting every
inference Freya can do, and the latch is durable, so a misclick does not wear
off.

The first press arms, the second confirms, and the armed state expires on its own
after a few seconds so a loaded trigger cannot sit on screen unattended. Resuming
is one explicit press, because refusing to restart is the safe failure and being
unable to is not.

## D19 — A command is not a presence transition

Submitting a command used to move Freya into `working`, which spun the presence
ring for a command that did no work. Nothing about a submission is a reason to
change state, so it no longer is one.

The same pass removed the local acknowledgement. The command bar now waits for
Core's reply and reports what Core said — including when Core refused it, or could
not be reached. An acknowledgement the UI writes itself is one the user cannot
check.
