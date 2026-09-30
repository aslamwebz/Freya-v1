# Phase 1 — the first real Freya Core

Status: in progress. This document is the plan, and it is updated as decisions
become real rather than left as an aspiration.

---

## What Phase 1 is for

Phase 0 built the shell. Phase 1 builds the thing the shell is a *view of*: a
durable Core that lives outside React, with a real event fabric, a security
root, a cognition authorization system, and exactly one path to a model
provider.

The deliverable is not a chat assistant. It is the machinery that makes a chat
assistant safe to build later.

## The invariant this phase exists to establish

**Capability and autonomous model activity are different things.** Freya can be
extremely capable and consume zero model credits, because no model call can
happen unless deterministic code first establishes that cognition is *required*
and *authorized*.

Time passing, a timer firing, the app launching, a file changing, an event
arriving, a surface opening, a heartbeat — none of these are causes. They are
inputs. Cognition requires an explicit, authorized request, and the only place
a provider can be reached is behind that request.

This is enforced structurally, not by convention: see *No-bypass*.

---

## Layout

```
core/                    Electron-free. No React, no Electron, no browser globals.
  index.ts                the Core facade: lifecycle and the command surface
  state.ts                the one pure reducer every projection is built from
  protocol/               types shared with the renderer (import type only)
  events/                 envelope, store interface, JSONL store, fabric
  security/               principals, capabilities, policy
  cognition/              grants, governor, service
  model/                  provider contract, fake, NanoGPT, gateway
  projections/            Core status derived from durable state

electron/coreHost.ts      owns the Core instance, exposes the typed RPC
src/platform/host.ts      the bridge's shape, declared once for the renderer
src/platform/coreClient.ts  the renderer's mirror, with a real disposer
src/ui/dashboard/CorePanel.tsx  the only place Core is shown
```

`core/` has its own tsconfig with `lib: ES2023` and no DOM, so a browser global
in Core is a type error rather than a runtime surprise.

---

## Decisions made

### Event storage: append-only JSONL, not `node:sqlite`

Measured, not assumed:

| | Electron 44.5.0 (ships Freya) | System Node 24.6.0 (runs the tests) |
| --- | --- | --- |
| `node:sqlite` present | yes | yes |
| experimental warning | none | `SQLite is an experimental feature` |

The API is flagged experimental in one of the two runtimes we control, and the
guidance is that it "might change at any time". A durable security audit log is
the wrong place to depend on that. So Phase 1 writes its own append-only store.

Concretely: one line of JSON per event, `fsync` on the write, and a torn tail
line is detected and discarded on load rather than being fatal. It is behind an
interface (`EventStore`) so SQLite or anything else can replace it later.

The audit log stays human-readable, which for a security journal is worth more
than query speed at Phase 1 volumes.

### One process, one Core

The Core starts once per Electron main process. A renderer reload is a renderer
concern and must not create a second Core; the renderer subscribes and receives
the current projection on reconnect.

### STOP ALL is derived, not stored twice

The latch is a projection of `security.stop_all.*` events. It survives restart
because it is rebuilt by replay, and it cannot drift out of sync with the log
because there is nothing to drift.

### Grants are finite and their usage is durable

A grant records `maxCalls` and `maxOutputTokens`. Consumption is appended as
events, so replay restores exact usage rather than starting from zero. A future
child worker divides a parent's finite budget; it never receives a new one.

### No-bypass

The export surface of Core is the facade. `CognitionService` owns the
`CognitionGovernor` and the `ModelGateway`; the gateway owns the providers and
never exposes them. There is no exported provider instance, and no path from a
timer, a replay, a status read, or an IPC handler to a provider call that does
not pass through `CognitionService.request`.

---

## What is explicitly not built

No chat, streaming, speech, Searcher, Vault, Missions, Work, Run engine,
agents, swarms, PTYs, terminal, Foundry, connectors, Office, learning or
self-modification. No fake versions of any of them.

The command bar becomes real in exactly one sense: the text reaches Core, Core
appends a durable event, and the UI acknowledges that. It does not reach a
model.

---

## Status

Everything in the table below is built, wired and verified.

| Area | State | Where |
| --- | --- | --- |
| Event fabric | done | `core/events/`, 20 tests |
| State + projection | done | `core/state.ts`, `core/projections/` |
| Guard | done | `core/security/guard.ts`, 14 tests |
| STOP ALL | done | durable latch, proven across a relaunch in e2e |
| Governor + grants | done | `core/cognition/`, 26 tests |
| Cognition service | done | `core/cognition/service.ts`, 19 tests |
| Gateway + providers | done | `core/model/` |
| RPC + UI | done | `electron/coreHost.ts`, `src/platform/`, CorePanel |
| E2E | done | 31 checks, including Core state after a relaunch |

`npm run verify` is green: typecheck, lint, 219 unit tests, build, 31/31 e2e.

---

## Two things that changed while building it

### A caller cannot claim a grant, and cannot claim a human is waiting

The first version of `CognitionCall` extended the Governor's own request type,
so a caller supplied `authorization.grantId` and `background` for itself. That
is a request for permission presented as a fact. The service now nominates a
grant and derives those fields, and every way a caller can influence the outcome
errs towards denial.

Deriving `background` from `origin` alone was not enough, either. `origin` is a
label the caller supplies, so an agent could put `user` in it and buy the
grantless path. A request counts as user-initiated only when its `actor` is the
owner, because identity is assigned by the bridge while origin is self-declared.

### The centre column was already a stacking context

Adding a panel to the right column made the e2e fail, and the cause was not the
panel. The dock is wider than the centre column and deliberately floats over its
neighbours, but `.column-center` inherited `position: relative` and a
`z-index: 5` from `.column`, putting it in the same stacking level as the
right column — which comes later in the DOM and therefore painted over the
dock. Taller content made the collision visible.

The column is now one step above its neighbours, which is still below the
surface layer and the header chrome, so nothing else moved.
