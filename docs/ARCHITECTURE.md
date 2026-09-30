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
  notices:    Notice[]
}
```

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
| Mind (conversation) | surfaces of type `chat` + a `chat.*` event family | any change to the window model |
| Searcher | a `searcher.*` event family + a surface registry entry | a second window implementation |
| Work / Missions | `work.updated` / `mission.*` events + surface context | the store to know what a "mission" is |
| Workforce | `workforce.*` events | agents running in the renderer |
| Harness | surfaces that request a PTY from the main process | the renderer owning process handles |
| Vault | a `vault.*` event family + capability-scoped file access | direct fs from the renderer |
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
- **Live work is a process fact.** `activeProviderCalls` is the size of the
  gateway's registry. It is the only in-process record of live provider work, and
  the journal is not a substitute for it.
- **Only the owner reopens the gate.** `resume()` restarts nothing and returns
  nothing; it changes whether a *new* request may begin. No provider, model or
  model-written agent can reach `cancelAll` or `resume`.

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

---

## 7. Deliberately absent

Neither Phase 1 nor Phase 2 implements: chat or conversation, streaming, speech
transcription, Searcher, web research, browser automation, Browser Relay, Vault,
Missions execution, Work, the Run engine, agents, swarms, PTYs, terminal,
Foundry, connectors/MCP, 3D Office, learning, or self-modification. There are no
stub classes for them, and no panel that implies one is running.

A surface type may exist with `status: 'placeholder'`, in which case its window
is real — movable, resizable, persisted — and its body says which system is
missing and why. That is a declared boundary, not a fake.

A submitted command reaches Core, is made durable, and stops there. The
acknowledgement says so explicitly, because a user told a command was received
will otherwise wait for a reply that is not coming.

**Idle Freya spends nothing.** No automatic model call exists anywhere in the
shell, and the e2e checks the call counters after boot, after a command, after a
renderer reload and after a relaunch.

Browser work is documented as direction only, in
[BROWSER-ROADMAP.md](BROWSER-ROADMAP.md).
