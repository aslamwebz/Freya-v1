# Architecture

Freya is a local desktop application. This document covers only the boundaries
that Phase 0 must get right. Everything else is deferred.

---

## 1. The shape of the system

```
┌───────────────────────────────────────────────────────────────────────┐
│  Desktop Shell  (Electron main process — "Freya Desktop")             │
│  • owns the BrowserWindow, the app lifecycle, the window registry     │
│  • owns the workspace file on disk                                    │
│  • exposes a narrow, typed preload bridge                            │
└───────────────────────────────┬───────────────────────────────────────┘
                                │  contextBridge (preload.ts)
                    ┌───────────▼───────────┐
                    │  Renderer  (React UI) │
                    │  ┌─────────────────┐  │
                    │  │ Shell chrome    │  │   header / nav / dock
                    │  │ Surface Manager │  │   one windowing model
                    │  │ Presence        │  │   one canvas renderer
                    │  │ Dashboard cards │  │   read-only projections
                    │  └────────���────────┘  │
                    │        ▲              │
                    │        │ subscribe    │
                    │   ┌────┴─────┐        │
                    │   │  Store   │        │  one reducer, one event log
                    │   └────┬─────┘        │
                    └────────┼──────────────┘
                             │  (boundary — not implemented)
              ┌──────────────▼──────────────┐
              │  RPC / event client          │
              │  "Freya Core" — Phase 1+     │
              └──────────────────────────────┘
```

The renderer **never** touches the filesystem, the network, or a model. It has
no `fs`, no `child_process`, no outbound HTTP. Everything privileged happens in
the main process, and everything the future Core owns is reached through one
interface.

---

## 2. Process boundary

**Main process** (`electron/`) is the durable half:

- creates and owns the shell window;
- reads/writes `workspace.json` in the OS app-data directory;
- survives renderer reloads, crashes and `Cmd/Ctrl+R`.

**Renderer** (`src/`) is the disposable half:

- React + the presence canvas + the surface layer;
- is reconstructible from `(runtime info, workspace.json)` alone;
- can be thrown away and rebuilt without touching long-running work.

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload
script exposes four functions and one flag — `getRuntimeInfo`,
`loadWorkspace`, `saveWorkspace`, `onCollect`, `isDesktop` — and nothing else. No
remote module, no `ipcRenderer` passthrough, no eval.

**Why the UI can be disposable.** Long-running Freya work (missions, agent
sessions, PTYs) will live in the *main* process, keyed by `surface.id` and
`context.id` — not in the renderer. The renderer only ever holds a *projection*
of that state. Reloading the renderer re-reads the projection; the work keeps
running. This is why the surface id is a durable, stable identifier and not a
React key.

---

## 3. Inside the renderer — four seams, not one

The renderer is deliberately split so that Phase 1+ can attach without a rewrite.

### 3.1 Store (state, not components)

A single reducer over a single event union.

```
dispatch(event) → reduce(state, event) → notify → React re-renders
```

Components read state and dispatch events. **No component calls another
component.** No context-based cross-talk, no imperative DOM mutation outside
the presence canvas and the window-drag controller (both of which are
`ref`-scoped leaves). This is what makes the shell "reacting to state" rather
than "wiring".

State shape (`src/core/events.ts`):

```ts
ShellState = {
  presence:   { state, since, activity, detail }
  surfaces:   { open, minimized, focused }   // a summary, not a second copy
  nav:        string
  listening:  boolean
  commandDraft: string
  lastCommand: string | null
  core:       CoreStatus | null          // Core's projection, verbatim
  activity:   CoreActivityEvent[]        // Core's feed, verbatim
  desktop:    DesktopProjection          // everything derived, computed below
  runtime:    { version, platform, userData, workspaceFile, dev }
  attention:  { requested, lastNote }
  runtime:   { version, platform, userData, workspaceFile, dev }
  attention: { requested, lastNote }
  notices:   Notice[]
}
```

The conversation transcript itself is **not** in this state. It lives in Core's
conversation projection, reaches the renderer over its own channel, and the store
holds only which pane was open — an id, which is not authority, because Core
re-reads the transcript from its own store and a stale one resolves to nothing.

`dashboard` is gone. The `demo: true` fixtures it carried were removed in Phase 2
rather than relabelled — see §3.5.

Ownership is disjoint and explicit. The **Surface Manager owns surfaces**; the
store owns everything else. Every manager lifecycle change is dispatched onto
the same bus as every other event and carries a `SurfaceSummary` — the three
facts the shell needs — computed by the manager at commit time. The reducer is
pure, so it stores the summary without needing to reach into the manager.

That single path is what the shell subscribes to. There is no second
subscription on the manager, and no component calls another.

### 3.1b Presence is derived, and one path can still move it by hand

**Revised in Phase 2.** Presence used to be a stored value that events could
transition. It is now a function of Core's status, recomputed in `project()` on
every Core push:

```
CoreStatus.integrity / lifecycle / stopAll / governor
CoreStatus.activeProviderCalls      ← the Model Gateway's live registry
        + listening (local)
        ↓
   derivePresence()  →  PresenceState
```

Ordered by how much the condition matters: a corrupt journal outranks an open
microphone, which is fail-closed arriving in the UI layer. Running model work
outranks the microphone, because a request that is executing is spending money
whether or not anyone is speaking.

Consequences, all of them tested:

- **No ungated setter.** `presence.set` is gone. `presence.simulate` is the only
  way to move presence without Core, and the reducer ignores it unless
  `runtime.dev`. `runtime.dev` defaults to `false` and is set only by the host, so
  a window whose hydration failed cannot come up with the simulator enabled. The
  Development Lab and its chips are additionally not rendered unless `runtime.dev`.
- **The microphone is refused, not overridden.** Setting `listening: true` is
  accepted only if the derived presence would actually become `listening`. A
  locked, degraded or journal-faulted Core refuses the toggle outright, so
  `state.listening` is never true while the window says `locked`.
- **`working` requires real work.** It has exactly one door:
  `CoreStatus.activeProviderCalls > 0`, read from the Model Gateway's active
  request registry. `thinking` has none. The count is not reconstructed from the
  journal — a journal is history, and a request it records as started may have
  been abandoned by a process that died. See §6.1.
- **A workspace restores layout, not presence.** `ShellStore.hydrate` is narrowed
  to the runtime identity alone so it cannot smuggle state in at boot.

`withPresence` and the transition table remain, governing the one path that can
still set a state directly: the development override.

### 3.2 Surface Manager (`src/core/surfaces/`)

The single most important abstraction in Phase 0.

```
Surface = { id, type, title, context, state, layout }

layout   = { x, y, width, height, minimized, maximized, pinned, z }
```

The manager is a **pure TypeScript class with no React and no DOM**. It receives
a *frame* (the workspace bounds) so it can clamp and maximise without measuring
anything itself. It exposes exactly:

```
open · close · focus · move · resize · minimize · unminimize
     · maximize · unmaximize · togglePin · cycle · serialize · restore
```

and emits `surface.opened/closed/focused/moved/resized/state.changed`.

Two names that are easy to confuse and are not:

- `unminimize(id)` — bring one surface back. Added in Phase 2, because the spec
  listed `restore` as a per-surface operation and only the workspace-wide
  `restore(array)` existed.
- `restore(persisted)` — replace the whole layout from a saved file. A launcher
  click calling the other one would wipe the arrangement of every window.

Consequences that matter:

- `SurfaceWindow` is written **once**. Any future surface type gets move, resize,
  minimise, maximise, focus-order, clamping, restore and persistence for free by
  being registered. No per-feature window component will be written.
- The manager is unit-testable without a browser. Most of the Phase 0 test suite
  is aimed at it.
- The persisted file is a *serialisation of the manager*, not of the DOM, so a
  schema change is a version bump in one place.

Surface **types** are declared as data (`surfaceTypes.ts`): id, title, icon,
default size, minimum size, status, and an **instance policy**. Adding
Vault-as-a-surface is one entry there plus one body component.

```ts
instance: 'singleton' | { keyedBy: 'missionId' }
```

`open()` consults that policy instead of branching on type, so a future
multi-instance surface needs a descriptor field and no manager edit. Opening an
already-open singleton **restores and focuses** it rather than duplicating it —
two Security windows would be two ways to stop Freya. A keyed type opened without
its key behaves as a singleton, because two unkeyed windows of a keyed type are
indistinguishable to a person.

`registry.tsx` combines that data with a body component into one catalog
(`SURFACES`), and the launcher, the placeholders and the manager all read from it.
The launcher was a hand-written array beside `ChatBar` and had already drifted —
**Security was missing from it**, so the surface with the stop button was the one
you could not launch.

### 3.3 Presence (`src/presence/`)

One scene, one `requestAnimationFrame` loop, no React re-render per frame.
React owns *which state* the presence is in; the stage owns *how it looks*
given that state, interpolated.

```
Presence.tsx        binds store state + voice envelope + design lab
  ├── PresenceView.tsx  the two canvases, one clock, lazy import
  │     ├── stage/PresenceStage.ts   scene, pieces, HUD, beam, pedestal, loop
  │     └── stage/RingLayer.ts       the full-window background rings
  ├── pieces/*      one module per centrepiece; brain.ts carries four styles
  ├── voiceEnvelope.ts  the level signal (simulated in Phase 0)
  └── DesignLab.tsx   background / centrepiece / style / extras / rings
```

Three properties matter:

- **One loop.** The stage's clock drives the ring layer through an `onFrame`
  hook. Two rAF loops would drift.
- **It hard-stops.** Hidden window or `prefers-reduced-motion` means no loop at
  all; reduced motion paints one static frame.
- **It is code-split.** three.js is behind a dynamic import, so a shell that
  never reaches the presence does not pay for it. A failed WebGL context
  degrades to a stated still frame.

Presentation preferences (the design lab) live in their own module and their own
`localStorage` namespace, separate from the workspace file, because they are
local, disposable, and not workspace state.

### 3.4 Platform adapters (`src/platform/`)

`workspaceStore` is an interface with two implementations:

- `createIpcWorkspaceStore()` — production, main-process file;
- `createLocalWorkspaceStore()` — browser dev only, `localStorage`.

The renderer picks one at boot. This exists so the UI can be developed and
screenshotted in a plain browser without weakening the desktop boundary.

---

### 3.5 Projection — one interpretation, no interpretation in panels

`src/core/desktopProjection.ts` is a pure function:

```
CoreStatus + CoreActivityEvent[] + local shell facts
        ↓  projectDesktop()
   DesktopProjection
        ↓
panels, Presence, the system area
```

Panels do not read `CoreStatus` fields. They read a `DesktopProjection`, which is
why four panels cannot disagree about what `governor.status: 'deny_all'` means —
there is one function that decided, and it is unit-tested against a table of cases
rather than by looking at a window.

The reducer recomputes it in one place (`project()` in `src/core/events.ts`) on
every `core.status` or `core.activity` event. It is deterministic given the same
input: no globals, no randomness, no clock beyond the `now` passed in.

**Presence is derived from it, not stored alongside it.** There is no ungated
`presence.set` event; the only way to move presence without Core is
`presence.simulate`, which the reducer ignores unless `runtime.dev` — and
`runtime.dev` itself defaults to `false` and is set only by the host, which knows
how it was launched.

### 3.6 Activity is a projection of the journal, and the journal stays in Core

The renderer receives `CoreActivityEvent[]`: `{ id, kind, type, sequence, at,
text, tone }`.

**There is no payload field.** That is the whole security property, and it is
structural: `command.received` maps to `Command received (42 characters)`, a
hostile payload cannot reach the row because the row is built from named fields,
and adding a field to an event does not add it here. The journal has never held
command text and neither does the feed.

`Core.start()` folds the log once, deriving state and activity from the same
events in the same order, and a subscriber gets the whole feed on attach — so a
window opening on day seven agrees with one that never left. There is no
renderer-side activity database.

The preload bridge exposes `coreActivity()` and `onCoreActivity()` and
deliberately **no generic event reader**: a window can have rows, not the journal.

## 4. Persistence

`workspace.json` lives in Electron's `app.getPath('userData')`:

```jsonc
{
  "schema": 1,
  "surfaces": [ /* Surface[] in z-order */ ],
  "presence": "idle",
  "nav": "home"
}
```

`presence` is **written but not restored**, and that is intentional rather than an
oversight: presence is derived from Core's live status, so a saved `thinking` from
a crashed session is not a fact about the current one. The field is kept so the
on-disk shape of files people already have does not change under them. The e2e
asserts the stronger version of this — after a relaunch with STOP ALL latched,
presence reads `locked`, read from Core's durable latch rather than from disk.

Presentation only. There is no field here for a credential, a capability, a
grant, a prompt or a model response, and the parser discards anything it does not
recognise. Anything that decides *whether Freya may act* lives in the durable
journal and nowhere else: a file the renderer can write must never move it.

Rules:

- Written on a debounce (400ms) after any state-changing event, and once more on
  quit. Not on every pointer-move.
- Read once at boot, before first paint of the surface layer.
- `schema` is checked. Unknown or corrupt input falls back to defaults; a
  corrupt file is never allowed to prevent launch.
- Rehydration re-clamps every surface into the current workspace frame, so
  restoring a layout saved on a 4K display onto a 1280 window still produces a
  usable workspace.
- The workspace frame excludes the header and the navigation rail, measured
  from the DOM, so surfaces can never be dragged under the command bar or
  over the systems list.
- **The size limit is enforced before writing, not only on read.** A limit
  checked when loading protects the next launch but still lets an unbounded
  payload reach the disk. It is measured in UTF-8 bytes in **both** directions:
  measuring the write in bytes and the read in string length means a payload
  can be accepted and then silently rejected on the next launch.
- Writes are atomic (temp file + rename), serialised through a promise chain,
  and generation-stamped. A write may only publish if it is still the newest
  one, and the check and the rename happen together with nothing between them —
  otherwise a debounced write already in flight when the user quits would land
  on top of the final flush and resurrect an older layout.

**Not persisted:** dashboard demo fixtures, the presence canvas, transient
animation values. They are derived, not stored.

### 4.2 Two encrypted stores, two secrets

Everything a person tells Freya is written to disk encrypted, in **two separate
stores**, each with its own 256-bit secret and each wrapped separately by the OS
secure storage:

```
  conversation  256-bit random  ─┐
                                 ├─→ each wrapped separately
  brain         256-bit random  ─┘     (DPAPI / Keychain / libsecret)
```

Independent secrets rather than one root with derived subkeys, and that is a
deliberate trade. Deriving is tidier to manage, but recovering a root yields
*every* domain at once — so "the conversation key leaked" stops being a bounded
problem and becomes "Freya's entire memory leaked". Two secrets cost a migration
and buy back a blast radius of one. The Brain is the longest-lived, most valuable
state in the system, so it is the last thing that should be one key-compromise
away from the conversation log.

Phase 3's single `<data>.key` file is adopted **byte-identically** as the
conversation secret on first run, so existing transcripts stay readable, and then
left in place — a migration that can lose access to history on its failure path
is not one worth shipping.

When the OS secure storage is unavailable, or Electron selects the insecure
`basic_text` backend, **no key is produced**. Core falls back to ephemeral stores
that label themselves, and the Vault says `FORGETS ON QUIT` before anything can be
typed into it. There is deliberately no path that writes a key beside the data it
protects, or writes either store in the clear: a weaker store silently standing in
for an encrypted one is a worse bug than forgetting a conversation, and it is the
failure a person cannot detect.

### 4.3 The Brain log is chained; the journal is not

The Brain store appends AES-256-GCM records in which each line's header —
including the previous line's digest — is authenticated as additional data:

```
  line N   =  { version, kind, seq, prev, context, nonce, cipher, tag }
             \_____________ authenticated as AAD ____________/
  prev(N)  =  sha256(line N-1, exactly as written)
```

A tag authenticates a record. The sequence and chain detect interior deletions,
duplications and reordering. Removing a complete valid suffix cannot be detected
without an independently trusted head; the current log has no such anchor.
Owner-requested withdrawal instead appends an archive record. The security
journal has separate recovery and integrity requirements (see §6.1).

A broken sequence or chain is reported and **reading stops there** rather than
skipping the line, because continuing would let a deleted record look like it was
never there.

A degraded log is read-only: Freya can still answer, but refuses durable Brain
writes beyond a break. An authenticated final record with a missing newline stays
readable while further appends are refused. Accepted writes are flushed before
advancing the in-memory chain; a failed append degrades the store. Queued admissions
are serialized as whole operations, and close drains accepted admissions and writes.

**A Brain fault is never a security event.** It cannot grant cognition or clear a
stop, and it does not *lose* authority either — unreadable long-term knowledge is
neither permission nor lockout. `brain.degraded` is deliberately absent from
`SECURITY_EVENT_TYPES` so a disk error cannot masquerade as a safety posture.

**There is no delete.** Withdrawing a memory archives it: the record stays, its
status changes, and retrieval stops returning it. The Vault lists what Freya holds
and counts what was withdrawn, so it is visible that a memory went somewhere rather
nowhere.

### 4.4 The public network, and a browser that only reads

Phase 5 adds the only subsystem in Freya that reaches the internet, and it is
structured so that "the URL looked fine" is never the reason something was reached.

**Public-network policy.** HTTP(S) on default ports only; no userinfo; no private,
reserved, loopback, link-local, unique-local or multicast address in any
normalised form (decimal, octal, hexadecimal, IPv4-mapped IPv6 included); every DNS
answer validated; **the vetted address pinned to the connection** through a
`lookup` override so the name cannot be resolved twice; every check repeated at
each redirect; no https→http downgrade; cookies, `Host`, `Proxy-Authorization` and
CRLF in header values refused; three redirects maximum; bodies bounded *while
streaming*. Full detail in [PHASE-5.md](PHASE-5.md) §3.

**The managed browser reads.** A hidden, sandboxed, `contextIsolation` window with
no preload and no node integration. The page is fetched by the controlled transport
— never by the page — and served on a session-owned internal URL under
`default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'`. Every
subresource, permission, popup, download, frame and page-initiated navigation is
denied independently. One fixed trusted extraction script runs in an isolated
world; no script or selector comes from the renderer, a model or a page.

Session partitions come from a **bounded leased pool of four**, cleared on acquire
and release, because Electron cannot destroy a `Session` and one per read would
accumulate for the life of the process.

**It has no `click` and no `fill`.** Those were in scope and are deliberately
absent: a page that can be clicked is a page whose author chose what Freya does
next, and the injection containment depends on there being no executable surface
for an injected instruction to reach. See D22.

**A Brain fault is still not a security event**, and research does not change that.
A research failure cannot grant cognition or clear a stop; it is a data fault
reported with a fixed public code. Research results are ephemeral and are never
written to the encrypted Brain — see D23.

### 4.1 Surviving an immediate quit

A renderer cannot push its final layout at quit time — an IPC sent during
teardown is dropped. This is not theoretical; it was measured before the fix.

So the host asks. Both the window's `close` event and `app.quit()` route
through one `collectAndThen`, which:

1. holds the close (`event.preventDefault()`),
2. sends `freya:workspace:collect` to the still-live renderer,
3. waits for the renderer's reply, which arrives as an ordinary
   `workspace:save` call,
4. writes the payload **synchronously**,
5. releases the close.

A 750ms timeout guarantees the app can always be quit even if the renderer is
wedged. The preload bridge is the whole of it: the host can ask, and the
renderer can answer with something only it knows.

---

## 5. How future systems attach

The intended shape, stated so the seams can be checked against it:

| System | Attaches by | Does **not** require |
| --- | --- | --- |
| Mind (conversation) | **built in Phase 3** — a `conversation.*` event family + a `chat` surface | any change to the window model |
| Brain (memory, identity, self) | **built in Phase 4** — a `brain.*` event family + a `vault` surface | a second window implementation |
| Searcher | a `searcher.*` event family + a surface registry entry | a second window implementation |
| Work / Missions | `work.updated` / `mission.*` events + surface context | the store to know what a "mission" is |
| Workforce | `workforce.*` events | agents running in the renderer |
| Harness | surfaces that request a PTY from the main process | the renderer owning process handles |
| Vault (files, Obsidian-compatible import) | **the `vault` surface is now the Brain**; a file-backed vault is a *future* capability-scoped access path | direct fs from the renderer |
| Guard | every privileged call routed through main | the UI holding secrets |
| Governor | budgets enforced in main | the UI being able to raise a budget |

The test of this architecture: **a new system adds events, a surface entry, and
a component.** It does not add a window manager, a store, or a persistence path.

---

## 6. The Core layer

Phase 1 added a process that exists outside the renderer and outside React:

```
electron/main.ts          owns one Core, for the life of the process
  └ core/                 Electron-free. No React, no browser globals.
      index.ts            the facade: lifecycle, and the command surface
      authority.ts        what a caller may say — no identity fields anywhere
      state.ts            the one pure reducer every projection is built from
      events/             envelope, validation, JSONL store, serialised fabric
      security/guard.ts   the policy. It judges a principal; it mints none.
      cognition/          grants, the Governor, the service that owns both
      model/              the provider contract, NanoGPT, the gateway
      mind/               the Mind, and the deterministic context compiler
      conversation/       conversation entities, stores, and the service
      identity/           the Identity Kernel: who Freya is, outside any model
      brain/              identity root, self-model, world, memory, experience
      research/           search, URL policy, transport, browser, evidence,
                          schemas, prompts, coordinator, Core integration
      voice/              local-only voice abstractions and bounds
      projections/        Core's account of itself, derived from the log
```

Three properties worth stating, because they are enforced rather than intended:

- **Core's public interface has no cognition surface.** No service, no gateway,
  no grant store, no policy object. Cognition is reachable only through an
  authority object with a principal already baked in, whose methods match the
  authority it was issued. See [COGNITION-POLICY.md](COGNITION-POLICY.md).
- **Core belongs to the process, not the window.** Closing a window flushes the
  workspace and nothing else. Only `app.quit()` stops Core, so a new window
  reconnects to the same instance with the same event sequence and the same
  latched security state.
- **The renderer holds a mirror, never a copy.** Every value it shows came over
  IPC, and Core overwrites it whenever its own state moves. With no Core the
  panels say so rather than showing a healthy-looking zero.

The bridge declares its whole surface once, in `src/platform/host.ts`. Adding a
function to `electron/preload.ts` without adding it there is a type error, which
is the point: the bridge should not be able to grow unnoticed.

### 6.1 Cancellation, and where live work is known

The Model Gateway is the only path to a provider, and it is also the only place
that can stop one. `ModelProvider.complete` takes a required
`ModelCallOptions.signal`, so a provider that cannot be aborted does not typecheck
rather than merely being discouraged.

```
Core / Security
      │  cancelAll(reason) · resume()
      ▼
  ModelGateway
      ├── contact gate + cognition epoch
      ├── active registry ──► activeProviderCalls (CoreStatus)
      └── AbortControllers ──► ModelCallOptions.signal
```

Four properties, each of which is load-bearing:

- **The gate is closed before the latch is written.** `security.stopAll` closes
  the gateway and only then appends `security.stop_all.activated`, in the same
  synchronous turn as the decision to stop. The other order leaves a window where
  a request was authorised, the stop was on its way to disk, and a provider could
  still be contacted. A latch replayed from the journal also closes the gate at
  start-up, so a restarted, stopped Core is not one field away from spending.
- **The race is closed by a generation, not by timing.** A request captures the
  cognition generation it was authorised under and may contact a provider only
  while that is still current. Two refusal points bracket the single `await` in
  the window, and there is deliberately no `await` between marking the contact
  and making the call.
- **Live work is a process fact.** `activeProviderCalls` counts only registry
  entries whose provider call is actually unresolved. Requests waiting before
  provider contact remain tracked for cancellation/race safety but do not make
  Presence claim paid work is running. The journal is not a substitute for this
  process fact.
- **Only the owner reopens the gate.** `resume()` restarts nothing and returns
  nothing; it changes whether a *new* request may begin. No provider, model or
  model-written agent can reach `cancelAll` or `resume`.
- **A failed STOP write fails closed.** The contact gate is closed before the
  durable STOP event is written. If that append fails, Core does **not** reopen
  the gateway. The closed runtime gate is projected as Governor `deny_all`,
  new cognition is refused before provider selection, and only a later explicit
  owner `security.resume` may reopen the session gate. Shutdown and degraded
  Core cannot be reopened through this path.

Cancellation is journalled as `model.request.cancelled` with `providerContacted`
stated, never inferred: a request refused at the door is not a call and any start
already written is withdrawn, while one aborted with the provider working stays
an explicit unknown so the totals remain a lower bound. A cancelled request's
grant reservation is not returned.

`Core.stop()` refuses new work, aborts what is running, waits up to a second for
those requests to write their terminal events, and only then closes the fabric.
The wait is bounded because a provider that ignores its signal must not be able to
hang the application; past the bound the journal is left with a start and no
finish, which is what a crash would have left too.

`gateway.cancelRequest(requestId, reason)` is the *scoped* path, and it is
deliberately nothing like `cancelAll`: the contact gate stays open, the cognition
generation does not move, nothing durable is latched, no other request is touched,
and an already-spent reservation stays spent. STOP ALL stops Freya's authority to
think; this stops one answer. A button that latched a security stop would make the
security control unusable, and one that refunded the call would make it dishonest.

### 6.2 The Mind, and why the model is not Freya

```
  Renderer
     ↓  conversation.turn.submit        text, and nothing else
  Core command surface
     ↓
  ConversationService                    commands + projection
     ↓
  Mind                                   one turn, one grant, one call
     ↓
  Context Compiler                       identity + history + this turn
     ↓
  Governor → Model Gateway → Provider    exactly one request
     ↓
  Mind                                   stores the answer
     ↓
  Conversation Store (encrypted) ──► projection ──► Renderer
```

The renderer has no line to the Model Gateway. It cannot name a grant, choose a
model, raise a token ceiling, pick a turn id or select a provider, and
`cognition.request` is not a name the preload bridge will accept. The only route
from a window to a model is a conversation turn.

"Model ≠ Freya" is two independent mechanisms, because either alone would be a
promise rather than a property:

- **The Identity Kernel** (`core/identity/identity.ts`) is typed, frozen data in
  Core. The Context Compiler *serialises* it for a provider; the provider receives
  a rendering of it rather than being the thing that defines it.
- **The Mind never imports a provider.** It reaches cognition only through an
  `OwnerAuthority` it is handed, so `Mind → NanoGptProvider` is not a line in this
  codebase.

No security authority is encoded in the kernel. Guard, the Governor, the contact
gate and STOP ALL are code, and a prompt that described a real boundary would be a
lie about where that boundary lives.

Prompts are therefore a **serialisation**, not the definition:

```
canonical Freya state → Context Compiler → provider-specific shape → model
```

`ModelRequest.messages` is canonical; `prompt` is the flattened form the gateway
derives from it, so the two cannot drift.

A turn performs **at most one** provider request — no retry, no critic, no
planner, no summarisation, no follow-up — and that is structural rather than a
convention: `runTurn` contains exactly one call into the cognition service. The
grant it spends is built from constants, issued through owner authority, and
bounded at one call, foreground only, with a short expiry. Full detail in
[PHASE-3.md](PHASE-3.md).

Recalled memory enters the same packet, and the rule about it is worth stating
here rather than only in the phase document: it goes in **below the transcript, as
its own labelled message**, never appended to the system message. Anything in a
system message is instruction by construction, and a remembered fact is not an
instruction. Each item carries its source class and confidence *in the rendered
text*, because a note from a web page and a note from the owner are otherwise
indistinguishable by the time they are flattened into "notes". Full detail in
[PHASE-4.md](PHASE-4.md).

### 6.3 Conversation bodies are not journal events

Two stores with opposite rules, in separate modules, and nothing in
`core/events/` imports from `core/conversation/`.

**The Conversation Store** holds what was said, encrypted at rest with
AES-256-GCM: unique nonce per record, the record header authenticated as AAD so a
record cannot be re-labelled between kinds, a per-store context id, versioned
records. A decryption failure is reported and the record skipped — never accepted,
never guessed at, never turned into a message that was never said.

**The Event Fabric** holds metadata only: ids, sizes, provider, model, outcome.
There is no field a body could hide in, so adding one is a visible change to the
audit schema rather than something that quietly starts retaining text.

The keys live in the main process (`electron/keyring.ts`), wrapped by the OS
secure storage, and are injected into Core as bytes. Neither ever enters the
renderer, a model request, the journal, a log line, or a projection. No secure
storage means **no key for either domain**, which means ephemeral in-memory stores
that label themselves — never a plaintext file and never a key stored beside the
data it protects. See §4.2 for why there are two.

Corrupt conversation data is a **conversation-data fault**. It cannot grant
cognition, clear a stop, or widen a budget, and it does not lock Freya either:
unreadable history is neither. The same is true of a corrupt Brain — see §4.3.

### 6.4 Local voice is a surface, not a second intelligence

`VoiceTranscriber` and `VoiceSynthesizer` declare `local: true` as a **literal
type**, so a remote engine does not compile. There is no cloud endpoint, no
fallback, and no automatic download.

A capture becomes **text in a composer**, not a turn. There is no call to the
Governor, the Gateway or a provider anywhere in `core/voice/`, and the Send that
follows is the only thing that authorises cognition. Speech recognition and
thinking are different systems, and that boundary is where an automatic send would
end up.

Capture is explicit: the device opens on a press and releases on the lift, on every
path including errors and unmount. The microphone permission is granted only while
Core reports a capture open, only for audio, and only in answer to the button —
the host follows Core's verdict rather than the renderer's claim. Audio is dropped
after transcription and never becomes memory.

The level is a mutable number outside React, read by the presence's existing
animation loop, so a frame of audio cannot cause a re-render. The envelope prefers
a real level when a device is open and does not simulate a reply from it.

---

## 7. Deliberately absent

Phase 5 adds provider-neutral web search, a managed read-only Electron browser, and
bounded cited research over public pages. Phase 4 added the Brain; phase 3 the
conversation, Mind and Identity Kernel; phase 2 the local voice seam.

No phase 1–5 implements: streaming, automatic summarisation, embeddings, vector or
semantic retrieval, self-modification, learning from conversation, **browser
automation** (`click`/`fill` — see §4.4), Browser Relay, Missions execution, Work,
the Run engine, agents, swarms, PTYs, terminal, Foundry, Relay, connectors/MCP, 3D
Office, an Obsidian-compatible file vault, or a local speech-engine binary adapter.
There are no stub classes for them, and no panel that implies one is running.

### 7.1 Absences inside the Brain that are decisions, not gaps

The Brain is the subsystem most likely to be mistaken for a finished one, because
it *looks* like a memory system and returns results. So the things it deliberately
does not do are listed where they are hardest to rediscover:

- **No fact-checking.** Admission decides how much a source class is worth, not
  whether a claim is true. Nothing in Phase 4 verifies anything, so nothing is
  stored as `verified`.
- **No semantic retrieval.** Recall is a named sum of signals with a total order.
  Conflict *detection* is correspondingly literal — same slot and a shared entity,
  or an explicit declaration — because a rule that looked semantic would mark
  unrelated memories as conflicting and suppress true ones.
- **A turn never writes memory.** It reads only what was already admitted. This is
  what stops a prompt injection from becoming a durable fact just by being sent.
- **No deletion, ever.** Withdrawal archives.
- **No `working` memory.** It is the Mind's volatile state, and a second copy would
  go stale.
- **No credentials.** The Brain may record *that* a key exists and where it is
  kept. Guard and a future Vault own secrets.
- **No model call anywhere in `core/brain/` or in the recall path.** Recall has to
  be free, offline and reproducible; a score that drifts with a model's mood cannot
  be audited or corrected.

### 7.2 The four separations that matter most

Each of these is enforced by types and tests rather than by convention:

- **Model output is data, never instruction.** Recalled memory enters the compiled
  packet *below the transcript*, as its own labelled message, never appended to the
  system message — anything in a system message is instruction by construction.
- **Content cannot classify itself.** The trust label is assigned by the admitting
  pathway, which knew where the bytes came from. A window likewise cannot name a
  source class: a renderer that could assert `owner-assertion` for itself could
  launder a web page's contents in as something the owner said.
- **Live authority is never duplicated into durable state.** Budgets, stop state
  and grants are Guard's and Governor's truth, read fresh. A writable copy of the
  most security-relevant facts in the system would go stale and then be believed.
- **A Brain fault is not a security event.** See §4.3.

A surface type may exist with `status: 'placeholder'`, in which case its window is
real — movable, resizable, persisted — and its body says which system is missing
and why. That is a declared boundary, not a fake.

A submitted **command** reaches Core, is made durable, and stops there. The
acknowledgement says so explicitly, because a user told a command was received
will otherwise wait for a reply that is not coming. A conversation **message** is
the other thing: it becomes a turn, and a turn is the only path from a window to a
model. The two are separate, explicit modes in the shell, because a sentence must
never become a privileged command by accident.

**Idle Freya spends nothing.** No automatic model call exists anywhere in the
shell. There is no always-on microphone, no wake word, and no path from captured
audio to cognition without an explicit Send. The e2e checks the call counters
after boot, after a command, after a conversation, after a renderer reload and
after a relaunch.

Browser work is documented as direction only, in
[BROWSER-ROADMAP.md](BROWSER-ROADMAP.md).
