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
script exposes exactly five functions (`getRuntimeInfo`, `loadWorkspace`,
`saveWorkspace`, `onCollect`) and nothing else. No remote module, no
`ipcRenderer` passthrough, no eval.

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
  dashboard:  { focus, work[], attention[], workforce[], activity[] }
  runtime:    { version, platform, userData, workspaceFile, dev }
  attention:  { requested, lastNote }
  notices:    Notice[]
}
```

Ownership is disjoint and explicit. The **Surface Manager owns surfaces**; the
store owns everything else. Every manager lifecycle change is dispatched onto
the same bus as every other event and carries a `SurfaceSummary` — the three
facts the shell needs — computed by the manager at commit time. The reducer is
pure, so it stores the summary without needing to reach into the manager.

That single path is what the shell subscribes to. There is no second
subscription on the manager, and no component calls another.

The dashboard collections are **demo fixtures**, marked `demo: true` in state and
rendered with a visible DEMO marker. They are not pretending to be live data.

### 3.1b Presence changes are validated in one place

Every event that wants a new presence — `presence.set`, `voice.toggle`,
`command.submit`, `workspace.restored` — goes through a single
`withPresence` helper that consults the transition table. There is no second
assignment path, and `ShellStore.hydrate` is narrowed to the runtime identity
alone so that it cannot be used to smuggle state in at boot.

The consequence that matters: a locked or errored Freya cannot be talked out of
it. The microphone button does not go live, a submitted command is recorded but
does not start work, and a restored workspace applies its navigation but not its
presence.

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
open · close · focus · move · resize · minimize · restore · maximize · pin · cycle
```

and emits `surface.opened/closed/focused/moved/resized/state.changed`.

Consequences that matter:

- `SurfaceWindow` is written **once**. Any future surface type gets move, resize,
  minimise, maximise, focus-order, clamping, restore and persistence for free by
  being registered. No per-feature window component will be written.
- The manager is unit-testable without a browser. Most of the Phase 0 test suite
  is aimed at it.
- The persisted file is a *serialisation of the manager*, not of the DOM, so a
  schema change is a version bump in one place.

Surface **types** are declared as data (`surfaceTypes.ts`): id, title, icon,
default size, minimum size. Adding Vault-as-a-surface is one entry.

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
  payload reach the disk. The measurement is in UTF-8 bytes, not string
  length, because a layout with non-ASCII titles is larger on disk than
  `.length` suggests.
- Writes are atomic (temp file + rename) and serialised through a promise
  chain, so two overlapping debounced writes cannot publish each other's
  half-written file.

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
wedged. The five preload functions are the whole of it: the host can ask, and
the renderer can answer with something only it knows.

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

## 6. Deliberately absent

`Phase 0 does not implement`: any model provider, agents, missions, search,
vault, PTYs, browser automation, connectors, the cognition governor, or the
security engine. There are no stub classes for them. The only thing present is
the boundary they will connect through.
