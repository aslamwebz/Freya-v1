# Phase 2 — the Command Center

Status: **complete**. The dashboard, the Presence, the Surface Manager and the
system panel are all projections of the Core that Phase 1 built. Nothing here adds
a second intelligence, and nothing here calls a model.

---

## What Phase 2 is for

Phase 0 built a shell. Phase 1 built the thing the shell is a view of. Phase 2
makes the shell *truthful* about that thing.

The shell it inherited looked finished and was not: the dashboard was a set of
fictional fixtures — three milestones with progress bars, four named agents, a
row of activity that never happened — rendered behind a `DEMO` badge, and
Presence was driven by a set of chips rather than by anything the system had
done. Every one of those badges was an admission that the underlying thing did
not exist.

The Phase 2 rule is narrow and absolute:

> **A UI action must not claim work that Core did not perform.**

So the fixtures are gone, not relabelled. `src/demo/fixtures.ts` is deleted, the
`Dashboard` type is deleted, and the panels that showed invented content now show
the real thing or say plainly that there is none.

---

## The projection

```
CoreStatus ──┐
             ├──► projectDesktop() ──► DesktopProjection ──► panels
CoreActivity ┤      (pure)                                 Presence
Shell facts ─┘
```

`src/core/desktopProjection.ts`. One pure function. No React, no state, no
globals, no clock beyond the `now` passed in — which is what makes it testable
against a table of cases rather than by looking at a window.

It exists because the alternative was already visible: four panels each
subscribed to Core and interpreted `governor.status: 'deny_all'` for themselves,
which is three chances to be wrong and nowhere to check the answer.

What it derives:

| Fact | Where it comes from |
| --- | --- |
| presence state and sentence | `derivePresence` |
| attention level | `deriveAttention` over real attention items |
| system rows (Core, Security, Journal, Governor, Models) | `systemFacts` |
| provider lines | `providerFact` |
| session and durable usage | `usageFact` |
| work | genuinely empty in Phase 2 |
| headline | one sentence for the header |

`grantsActive` is exposed as a **number** rather than parsed back out of the
Governor row's sentence. A panel that has to regex prose to render a count breaks
the moment the wording improves, and that is how a real bug got written during
this phase.

### Usage is never presented as exact when it is not

`usageFact` carries an `exact` flag that drives the label, not a tooltip:

- nothing unaccounted → `2 calls · 30 tokens reported`
- one call unreported → `2 calls · at least 30 tokens · 1 unaccounted`
- nothing ever reported → `0 calls · nothing reported`

The UI dims the row and renders the caveat inline whenever `exact` is false. The
moment that matters is the moment someone reads a number and believes it, and a
caveat behind a hover is not present at that moment.

---

## Core-aware Presence

```
CoreStatus.integrity          ──┐
CoreStatus.lifecycle          ──┤
CoreStatus.stopAll            ──┤
CoreStatus.governor.status    ──┼──► derivePresence ──► PresenceState
CoreStatus.activeProviderCalls┤
listening (local)             ──┘
```

Ordered by how much the condition matters, not by how likely it is:

| Condition | Presence |
| --- | --- |
| no Core status yet | `idle`, "Starting Freya." |
| integrity corrupt, or lifecycle degraded | `error` |
| STOP ALL latched | `locked` |
| Governor refusing everything | `locked` |
| Core booting | `idle`, "Core is starting." |
| a provider call genuinely in flight | `working` |
| local microphone open | `listening` |
| otherwise | `idle` |

A journal that cannot be trusted outranks a microphone that is switched on. That
ordering is the fail-closed property arriving in the UI layer: the same rule Core
applies before it will reach a provider is applied before the shell will show a
listening indicator.

Running model work sits **above** the microphone. A request that is executing is
spending money whether or not anyone is speaking, and it is the one fact a person
cannot otherwise see. Reporting it as merely "listening" would understate it.

**`thinking` and `working` have one door each.** `working` requires
`CoreStatus.activeProviderCalls > 0`, and nothing else. `thinking` has no door at
all, and a test enumerates the reachable states to prove it.

So a submitted command cannot make Freya look busy. That invariant existed in
Phase 1 and is now structural rather than a matter of which components dispatch
what.

### Live provider work is counted, not inferred

`activeProviderCalls` comes from the Model Gateway's active request registry — an
in-process count of requests executing this instant. It is not reconstructed from
the journal.

This replaced a string-prefix replay of the activity feed, which counted
`model.request.started` against `completed`/`failed`. That was a history, not a
process registry, and it failed in both directions: a Core that died mid-call
leaves a start with no finish in the log forever, so an idle Freya claimed to be
working indefinitely, and a completion with no matching start drove the counter
negative. The activity feed is still there, and is still what it is for — audit
and history. There is now one source of live truth rather than two competing
ones.

### The microphone is refused, not overridden

Setting `listening: true` is only accepted if the derived presence would actually
become `listening`. A locked, degraded or journal-faulted Core refuses the toggle
outright, leaving `state.listening === false`.

The alternative — recording `listening: true` and letting the display say
`locked` — leaves the store asserting a thing the window is simultaneously
contradicting. That contradiction was introduced during this phase and caught by
the Phase 1 test that already said it must not be representable.

### The Development Lab cannot be mistaken for Core

There is no ungated presence setter. `presence.set` was removed; the only way to
move presence without Core is `presence.simulate`, and the reducer **ignores it
unless the runtime reports a development build**. `runtime.dev` starts `false` and
is only set `true` by the host, which knows how it was launched — defaulting it
the other way would mean a window whose hydration failed came up with the
simulator enabled.

The Design Lab and the presence chips are additionally not rendered unless
`runtime.dev`. Two locks, one for the UI and one for the store, so neither a stray
component nor a stray dispatch can simulate a state in a shipped window. The e2e
suite asserts their *absence* in a production launch.

---

## Activity

Activity is a projection of the durable journal, and the renderer never sees the
journal.

```
EventFabric ──► describeActivity() ──► CoreActivityEvent[] ──► panel
```

The renderer receives rows with **no payload field**. That is the whole security
property, and it is structural rather than a matter of care:

- `command.received` becomes `Command received (42 characters). Recorded, not yet
  acted on.` The length is metadata. The journal has never held the text and
  neither does this.
- A hostile payload that puts text in the wrong field ends up nowhere, because the
  row is built from named fields.
- Adding a field to an event does not automatically add it here.

`mergeActivity` is immutable, sorts by sequence and de-duplicates by id, because
a replayed log and a live subscription overlap and a feed that repeats itself is
worse than one that repeats nothing.

**Replay and live agree.** `Core.start()` folds the log exactly once, deriving
state and activity from the same events in the same order, and a subscriber
receives the whole feed on attach. A window that opens on day seven sees what a
window that never left would have seen. There is no renderer-side activity
database; dropping the panel loses nothing.

---

## STOP ALL cancels what is already running

The durable latch stops the **next** request. On its own that is not enough: a
provider call that has already gone out keeps going, and keeps costing, until it
finishes. So the Model Gateway owns cancellation as well as routing.

```
Core / Security
      │
      ▼
  ModelGateway
      ├── contact gate + cognition epoch
      ├── active registry  ──► activeProviderCalls
      └── AbortControllers
              │
              ▼
          Providers
```

Only the gateway holds the controllers. Core can ask for everything to stop and
Core can ask for it to start again; no provider, no model and no model-written
agent can reach either.

### Every call is abortable

`ModelProvider.complete` takes a required `ModelCallOptions` carrying an
`AbortSignal`. It is required rather than optional because a provider that cannot
be aborted is a provider that keeps spending after the owner has said stop, and
leaving that to whoever forgets is not a design.

`NanoGptProvider` composes that signal with its own timeout onto one internal
controller, so `fetch` sees a single cancellation and the reason reported is
whichever arrived first. It checks the signal before anything that costs money.
There is no retry above or below: an aborted request is finished, and a second
attempt would be a second paid call nobody asked for.

### The authorisation → contact race is closed

```
cognition authorised
      ↓
model.request.started written      ← the only await in the window
      ↓
gate checked again, then the provider is called   ← no await between
```

A request captures the **cognition generation** it was authorised under. `STOP
ALL` closes the gate and moves the generation on, so a request that has been
allowed but has not yet reached a provider finds a moved generation and is
refused. There are two refusal points, one on each side of the single await, and
marking the contact and making the call happen in the same turn means the gateway
can never be wrong about whether a provider was asked.

The provider checks the signal again at its own door. That is a second,
independent line: the first two belong to the gateway and protect the window, the
third belongs to the provider and protects the last statement before the request
leaves the process.

### Cancellation is not failure

`model.request.cancelled` joins the journal with `providerContacted` stated
explicitly, because the difference is the whole accounting question:

| | `providerContacted` | Durable effect |
| --- | --- | --- |
| refused before contact | `false` | no call; any start already written is withdrawn |
| aborted with the provider working | `true` | call counted, usage recorded as an explicit unknown |

A start is written immediately before the provider is asked, which leaves the one
window where a start exists with no call behind it. The cancellation is the only
thing that can take it back, so a request that cost nothing is not left on the
books as a call that happened. The reservation a grant already made is **not**
returned: authorisation is not refunded because the owner stopped it.

### Cancelled work does not come back

`gateway.cancelAll(reason)` aborts everything and closes the gate.
`gateway.resume()` re-opens it and does nothing else — it restarts no request,
returns no reservation and replays no result. Only an explicit owner `resume`
reaches it. Resume never restarts a cancelled request; only a new one may begin.

### Shutdown is ordered, and bounded

```
refuse new cognition
      ↓
abort active cognition
      ↓
wait (bounded) for terminal events
      ↓
append core.stopping / core.stopped
      ↓
close the Event Fabric
```

The wait is the part that is easy to get wrong. A cancelled request still owes
the journal an outcome, and closing the fabric first leaves it writing into a
closed store — recording a cancellation, then recording a failure for having
failed to record the cancellation. The wait is bounded at one second, because a
provider that ignores its signal must not be able to hang the application. Past
that bound shutdown continues, and the journal is left with a start and no finish,
which is exactly what a crash mid-call would have produced.

---

## The renderer/Core boundary

```
preload (typed, named functions)  →  ElectronCoreHost  →  Core
        ▲                                                   │
        └──────── onCoreStatus / onCoreActivity ───────────┘
```

Added in this phase, without widening anything:

- `coreActivity()` — the current feed
- `onCoreActivity(handler)` — a push, with a disposer

There is deliberately **no generic event reader**. A window can have rows; it
cannot have the journal, an event id, a principal id or a payload. Activity and
status are separate channels because status is a projection that changes rarely
and activity is a stream — one window that wants only status should not pay for
the feed.

Attaching happens once in `boot()`, before anything reads, so the first render
already has real facts and the subscription outlives every component. The Phase 1
invariants are unchanged: a renderer reload re-attaches to the running Core, and
closing the window does not restart it.

---

## Surface lifecycle

The Surface Manager was already the right shape; Phase 2 closed the gaps.

**Instance policy is data.** `SurfaceTypeDescriptor.instance` is either
`'singleton'` or `{ keyedBy: 'contextField' }`:

| Type | Policy | Why |
| --- | --- | --- |
| chat, search, work, vault, foundry, relay, team, office | `singleton` | one of each |
| security, settings | `singleton` | two Security windows would give two ways to stop Freya and no way to tell which is authoritative |
| mission | `{ keyedBy: 'missionId' }` | one window per mission, later |
| harness | `{ keyedBy: 'sessionId' }` | multi-instance capability, later |

`manager.open()` consults the policy instead of branching on type. A future
keyed type needs one descriptor field, not a manager edit, and there is no switch
statement to forget to update. A keyed type opened *without* its key behaves as a
singleton, because two unkeyed windows of a keyed type would be indistinguishable
to a person.

**`unminimize(id)` was added.** The spec listed `restore` as a required
per-surface operation and it did not exist — only `restore(array)`, which replaces
the whole workspace. Confusing the two would let a launcher click wipe the
arrangement of every other window. Opening an already-open singleton now restores
*and* focuses it: "open this again" means "show me that".

**The registry is one catalog.** `surfaceTypes` (data) plus `registry.tsx`
(the body component) produce `SURFACES`, and the launcher, placeholders and the
manager all read from it.

The launcher was previously a hand-written array beside `ChatBar`, and it had
already drifted: **Security was missing from it**, so the one surface with a stop
button was the one you could not launch. It is now derived, filtered to
non-placeholder types so the launcher does not advertise systems that do not
exist.

---

## Workspace vs Core

Workspace is presentation. It is not Freya's memory.

Persisted: open surfaces, positions, dimensions, minimised and pinned state,
z-order, rail collapsed state, nav selection, and the Development Lab's design
choice (via `labState`, local storage only).

Never persisted: credentials, prompts, model responses, grants, capabilities,
security state, or anything else that decides whether Freya may act.

`WorkspaceSnapshot.presence` is **written but not restored**. That is deliberate
and commented in the type: a saved `thinking` from a crashed session is not a fact
about the current one. The field stays so the on-disk shape of files people
already have does not change under them.

The e2e asserts this where it is strongest: after a relaunch with STOP ALL
latched, presence reads `locked` — read from Core's durable latch across a process
restart, not from a file.

Atomic writes and stale-write protection in `workspaceFile.ts` are unchanged.

---

## System and attention area

Six rows, in the order a person reads them: is it running, is it safe, can it
trust its own history, will it let me act, could it spend money, and has it.

Tone is a 2px rule on the left edge rather than a tinted panel, because a dashboard
that glows red everywhere has a red that means nothing.

Attention is the *highest* severity of things that genuinely need a person, not a
count of notifications. A badge counting "things that happened" is a badge that
gets ignored.

---

## What is intentionally not built

None of the following exists, and the window says so rather than implying
otherwise: Chat intelligence, STT/TTS, Searcher, web research, browser
automation, Browser Relay, Vault/Obsidian, Missions execution, Agents/Workforce,
Harness/PTYs, Foundry, Relay/connectors/MCP, 3D Office, autonomous background
model use.

There is **no approval workflow**. The Security surface says so rather than
showing a control that does nothing.

Idle Freya spends **zero** paid model credits. The e2e checks this after boot,
after a command, after a reload and after a relaunch, against Core's own counters
rather than a hard-coded zero.

---

## Browser roadmap

Recorded, not implemented. See [BROWSER-ROADMAP.md](BROWSER-ROADMAP.md).

---

## Verification

`npm run verify`: typecheck, lint, unit, build, e2e. The live NanoGPT probe is not
part of it and is never run by CI.

The cancellation guarantees are in `tests/core/cancellation.test.ts`, with fake
and blocking providers only. One of those tests puts a real NanoGPT provider
behind a transport counter and asserts the counter never moves, on the stop, the
cancel and the shutdown path alike — so "tests never contact a provider" is
asserted rather than assumed.
