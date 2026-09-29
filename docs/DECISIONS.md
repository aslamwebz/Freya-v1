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
   preload bridge. If binary size ever matters more, the same renderer moves to
   Tauri by rewriting one file.

Cost: ~180 MB of disk and higher idle RAM than a native toolkit. Accepted for
Phase 0, recorded so it stays a decision rather than an accident.

### Rendering: no Three.js

The reference's central intelligence is re-implemented as a purpose-built
Canvas 2D renderer in `src/ui/presence/`: a seeded neural point lattice,
instrument rings, a beam, a pedestal and HUD labels.

- the reference *look* is preserved: luminous lattice, gold core, cyan
  structure, tick rings, a scanning band;
- zero dependency instead of roughly 600 KB;
- point counts and draw calls are ours, so idle cost is measurable and capped;
- a sculpted brain mesh would need WebGL plus a large shader payload for
  something that is, visually, a luminous point cloud.

WebGL is still available for the future Office surface; the presence is
isolated behind a single component.

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

Runtime dependencies: **react and react-dom. Nothing else.**

Every other package is dev-only and exists to build or verify. There is no
router (one route: the shell), no state library, no date library, no icon
package (14 hand-drawn 24px stroke icons in one file), no CSS framework, no
component library, no HTTP client, no speech stack, no vector database.

Rejected explicitly:

- react-router: a desktop shell has no URLs.
- react-icons / lucide: 14 icons, one small file.
- framer-motion: three CSS transitions cover every motion cue in the shell.
- zod: Phase 0 validates one small file; a hand-written guard is clearer.
- date-fns: Intl.DateTimeFormat is already there.
- node-pty: no terminal in Phase 0.

## D2 — The background atmosphere is an asset we vendor

The reference's atmosphere is a blurred night city photograph. Freya vendors
that one photograph into `src/assets/` and darkens it heavily. The other four
prototype backgrounds (space, grid, aurora, obsidian) are not shipped: they are
a settings curiosity, not part of the identity, and each is a large asset.

## D3 — Monogram avatars, not stock faces

The prototype shows five named agents as stock photographs. Freya's workforce is
not five stock humans, so avatars are deterministic monogram discs using the
gold ring the reference already uses. Same visual slot, no implied humans.

## D4 — The dock is the Surface Manager's launcher

The prototype's dock is a mode selector. In Freya it opens and focuses
surfaces. This makes the windowing system visible on the command screen instead
of hidden behind navigation, which is the point of Phase 0.

## D5 — Demo data is labelled, not disguised

Every demo value carries a `demo: true` flag in state and renders with a
visible DEMO marker. No fake analytics, no fake world map, no fake globe.
If a panel would need a data source that does not exist, it is not shown.
