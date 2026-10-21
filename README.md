<p align="center">
  <img src="src/ui-v2/assets/freya-portrait.webp" alt="Freya" width="220" />
</p>

<h1 align="center">Freya</h1>

<p align="center"><b>A local-first personal AI agent for the desktop: one persistent intelligence with memory, voice, a browser she drives herself, and a security core that every action has to pass.</b></p>

<p align="center">TypeScript · Electron · React · SQLite/SQLCipher · Vitest · Playwright</p>

---

## What this repository is

This is **Freya v1**: the first two weeks of the project (29 Sep – 12 Oct 2026), kept public with its full history: 1,200+ commits, about 470k lines of TypeScript and 600 test files.

Freya is not a chat window around an API. She is a **Core** that owns identity, memory, missions and authority, with **replaceable bodies** (a desktop dashboard, a voice presence, a small on-screen companion) that only render what the Core decides. Everything she does in the world, from opening a page to saving a file, goes through one gate with a written ledger.

Development continues privately as **Freya v2** (see [What v2 does](#freya-v2-in-active-development) below).

## How it was built

I designed and directed Freya, and wrote her with AI coding agents. The commit history shows it plainly, with co-author lines.

That is the point of this project as much as the product itself. What it shows:

- **Architecture that survives agents.** Agents write code fast; the structure has to stop them doing the wrong thing. Freya's boundaries are enforced in code, not in comments: an architecture check (`npm run check:architecture`) that fails the build when a boundary is crossed, a Core with no UI imports, typed protocols between processes, and a Guard/Governor that every capability passes.
- **Verification as the default.** 600 test files, including red-team suites that try to break the security boundaries (prompt injection through web pages, credential exfiltration, forged approvals, path traversal) and end-to-end tests that drive the real Electron app.
- **Small, reviewable steps.** 1,200 commits in two weeks, each one a single change with a message that says what changed for the user.
- **Cost and reliability engineering on real models**, measured rather than guessed (examples under v2).

## Architecture

```
                         FREYA CORE  (no React, no DOM, no Electron)
  Identity · Mind · Memory · Missions · Work · Workforce · Guard · Governor · Event Fabric · Model Gateway
                                       │
                        typed protocol │ projections
             ┌─────────────────────────┼─────────────────────────┐
       Desktop dashboard          Voice presence            Companion
             └─────────────────────────┼─────────────────────────┘
                                       │ bounded device capabilities
                     Browser · Files · Apps · Computer (each behind Guard)
```

- **Core is Freya.** Identity, memory, missions, authority and credentials never live in a renderer.
- **Bodies are disposable.** Closing or replacing a window never changes who she is.
- **Hands are capabilities.** Browser, files and apps are scoped interfaces with an owner switch, never ambient access.
- **Sealed renderer.** Context isolation, sandboxing, no Node in the UI, a narrow preload bridge, credentials only in the main process.
- **Encrypted at rest.** SQLCipher vault and an append-only, verifiable event journal.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/FREYA-CONSTITUTION.md](docs/FREYA-CONSTITUTION.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/RED-TEAM.md](docs/RED-TEAM.md)

## What v1 includes

| Area | In v1 |
|---|---|
| Mind | Tool-using reasoning loop with bounded calls, cancellation, and a deterministic context compiler |
| Memory | Brain with admission rules (what may become a lasting memory), recall, learning records |
| Missions & work | Long-running goals with plans, steps, verification and a workforce of agents |
| Browser | A built-in browser she operates: tabs, reading, clicking, typing, with page text treated as data, never instructions |
| Voice | Speech in and out, wake word, read-aloud |
| Security | Guard, Governor, STOP ALL, per-capability owner switches, device-hands policy, sensitive-field protection |
| Desktop | Dashboard, tray, companion window, presence stage (three.js) |
| Quality | Unit, DOM, red-team and end-to-end suites; architecture boundary checks |

## Freya v2: in active development

v2 is private: it is where the product is going. What it does today, in plain terms:

- **Her own Chrome, driven like a person.** She opens her own Chrome window, sees a page as a picture with numbered marks on what can be pressed or filled, and clicks, types, scrolls, waits, uploads and downloads. A side panel in Chrome lets you chat with her and drive her from either Chrome or the desktop app.
- **Parallel workers.** She hands a large job to up to ten workers, each in its own browser window, each named and colour-coded on the tabs it works in, so you can see who is doing what.
- **A plan you can watch, a hand-off when it needs you.** Longer tasks show a live checklist. When a site needs a sign-in, captcha or code, she gives you the turn ("Done" / "Not now") and carries on afterwards. Stop ends her work instantly and withdraws any approval she was waiting for.
- **Long jobs that report back.** A goal can run across many turns while you do something else; you hear when it is done, on the desktop or on your phone.
- **Security core.** Every outward call (web, browser, files, apps, messages) passes one gate with a ledger, and the actions that need your yes ask on whichever screen you are on: desktop, Chrome or phone.
- **Real deliverables.** Reports, tables (CSV) and pages saved as files you open with one click, or receive on your phone.
- **Voice that runs locally.** On-device text-to-speech and speech recognition.
- **Sign-in and encryption.** Your data key is sealed by your password, with a recovery key, and nothing of yours leaves the machine unless you allow it.

**Engineering results from v2, measured on live runs:**

- **About 75% cheaper multi-agent work:** the workers in a ten-worker browser run on ten different sites went from about $0.06 to about $0.015 per run, by making each worker's prompt lean and stopping wasted steps.
- **About 4× cheaper agent turns:** a fixed five-task benchmark went from $0.12 to $0.03, by keeping the model's prompt cache intact between calls (it was being invalidated on most calls) and trimming resent reasoning.
- **Reliability fixes found by live testing:** a bridge that dropped large screenshots, stale extension code after updates, approvals that could outlive a Stop, and agents falling back to the wrong browser. Each was diagnosed from logs and measurements and fixed with a regression check.

**Next:** a single workspace where the companion chat controls many live browser windows, a code window and other apps side by side in chosen layouts, with each agent's panes visible.

## Running v1

```bash
npm install
npm start
```

Useful scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run verify` (all of them, in order).

To talk to a real model, copy `.env.example` to `.env` and set a provider key; nothing is spent until `FREYA_ALLOW_LIVE_MODEL=1` is set. Without it, Freya says plainly that no model is available.

The original Phase 0 launch notes are kept in [docs/PHASE-0-README.md](docs/PHASE-0-README.md); per-phase notes are in `docs/`.

## About me

I'm **M Aslam**, a senior full-stack engineer (Laravel, TypeScript, React) who builds AI agents and the guard-rails around them. Freya is how I work: clear architecture, AI agents doing the volume, and tests and measurements deciding what is true.

I'm open to **senior engineering and applied-AI roles**, permanent or contract. If you would like a walkthrough of v2, get in touch: **aslam4webz@gmail.com** · [github.com/aslamwebz](https://github.com/aslamwebz)
