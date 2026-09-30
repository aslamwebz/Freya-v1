# Freya

**A secure, voice-first personal intelligence environment, centred on one
persistent intelligence, with transparent work surfaces.**

Phase 0 is a real desktop shell. It runs, it persists, it is tested end to end,
and it is honest about the fact that there is no model behind it yet.

## Running it

```bash
npm install
npm start          # build, then launch the desktop app
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server in a browser (uses `localStorage` for layout) |
| `npm run electron:dev` | build the main process and launch with dev flags |
| `npm run typecheck` | `tsc --noEmit` for the renderer and for `electron/` |
| `npm run lint` | ESLint |
| `npm test` | unit and DOM tests (Vitest) |
| `npm run test:e2e` | drives the real Electron app, including a relaunch |
| `npm run verify` | all of the above, in order |

## What is in here

- **One command centre** — header, command bar, navigation, dashboard, dock.
- **One presence** — a three.js stage with five interchangeable centrepieces
  and the full design lab: background, centrepiece, brain style, extras, outer
  rings, voice-reaction test.
- **One surface manager** — a framework-free windowing model. Open, close,
  focus, move, resize, minimise, maximise, pin, cycle. `SurfaceWindow` is
  written once; every surface type gets all of it for free.
- **Local persistence** — `workspace.json` in the OS app-data directory, written
  atomically by the main process, size-limited before it is written, and
  flushed synchronously when the window closes. No cloud, no account.
- **A typed event model** — one event union, one reducer, one store.
- **A sealed renderer** — `contextIsolation: true`, `sandbox: true`, no Node in
  the renderer, a four-function preload bridge, and every permission request
  denied, and a four-function preload bridge.

## Documentation

| Document | What it answers |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | what Freya is, and what the first principles imply |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the process boundary, the four renderer seams, how future systems attach |
| [docs/DECISIONS.md](docs/DECISIONS.md) | the stack, and every significant choice including the ones that were reversed |
| [docs/REFERENCE-ANALYSIS.md](docs/REFERENCE-ANALYSIS.md) | the design language extracted from `References/`, and what was deliberately not copied |

## Phase 0 boundaries

Not implemented, and not stubbed: any model provider, agents, swarms, missions,
search, the vault, terminals, browser automation, connectors, the cognition
governor, or the security engine. There are no placeholder classes for them —
only the boundaries they will connect through.
