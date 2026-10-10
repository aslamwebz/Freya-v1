# Freya

**A secure, voice-first personal intelligence environment, centred on one
persistent intelligence, with transparent work surfaces.**

The README below is a deliberate archival copy of the Phase 0 launch
notes — kept because it records what was decided at the time, and the
audit brief asks that historical docs be marked archival rather than
rewritten. The current state of Freya is described in `docs/ROADMAP.md`
and the per-phase notes in `docs/PHASE-*.md`; the production surface
at this commit (4453563) is a Mind, Brain, Learning, Missions, Work,
LifeLoop, Workforce, encrypted Vault, EventFabric, application/chat,
browser, voice, tray, Adult/Chibi modes, and the Guard/Governor that
keeps each surface in its lane.

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

## Chat with a real model (`.env` setup)

Freya talks to NanoGPT through its OpenAI-compatible API only when you tell it
to, and nothing about the configuration ever reaches the window:

1. Copy `.env.example` to `.env` (git-ignored) in the repository root.
2. Set `NANOGPT_API_KEY` to your key, keep
   `NANOGPT_BASE_URL=https://nano-gpt.com/api/v1`, and set `NANOGPT_MODEL` to a
   callable text model id.
3. Set `FREYA_ALLOW_LIVE_MODEL=1` — the separate, deliberate decision to spend.
   Without it the provider reports `disabled` and chat refuses truthfully.

`.env` is read by the Electron **main process only**. The renderer cannot see
it, the preload bridge forwards named commands and bounded payloads instead of
environment values, and the key appears exactly once anywhere: the
`Authorization` header of a provider call. It is never in the event journal, a
projection, a log line, or the chat transcript.

With the provider configured, the Chat surface's model selector can list the
text models NanoGPT reports (`GET /models` — on demand, never on boot, never
while idle) and the model you choose becomes what the *next* turn asks the
provider for. A selection carries no power: Guard, the Governor, per-turn
budgets, cancellation, STOP ALL and the compiled turn context all apply exactly
as they did without it. To check the endpoint without the app, run
`npm run core:model-probe` with the same variables set — one small, capped
request, through the same Gateway.

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
  denied. (The original copy repeated "a four-function preload bridge" at
  the end of the sentence; that was a transcription error and is fixed here.)

## Documentation

| Document | What it answers |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | what Freya is, and what the first principles imply |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the process boundary, the four renderer seams, how future systems attach |
| [docs/ROADMAP.md](docs/ROADMAP.md) | the current phase and the road to the next one |
| [docs/CORE-EVENTS.md](docs/CORE-EVENTS.md) | the durable event model every subsystem reads from |
| [docs/DECISIONS.md](docs/DECISIONS.md) | the stack, and every significant choice including the ones that were reversed |
| [docs/REFERENCE-ANALYSIS.md](docs/REFERENCE-ANALYSIS.md) | the design language extracted from `References/`, and what was deliberately not copied |
| [docs/PHASE-*.md](docs/) | per-phase work notes; the canonical record of what was built, why, and how it was tested |
| [docs/superpowers/](docs/superpowers/) | the design and implementation plans the owner has signed off on; treated as archival, never rewritten |

## Phase 0 boundaries

Not implemented, and not stubbed: any model provider, agents, swarms, missions,
search, the vault, terminals, browser automation, connectors, the cognition
governor, or the security engine. There are no placeholder classes for them —
only the boundaries they will connect through.
