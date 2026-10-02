# Phase 14 — Office

A truthful spatial view of real Work/Workforce/Core state. The Office is not a
simulation, a game board or a decorative dashboard: it is a read-only
projection of what Core actually owns, arranged in space so a person can see
the whole picture at a glance.

The governing rule is the one in [PRODUCT.md](PRODUCT.md): *models decide, code
controls*. The Office is the surface where that rule is easiest to violate — a
"spatial office" naturally drifts toward animated agents, fake progress and
decorative activity — so Phase 14 is written the other way: every station
corresponds to one real thing Core owns, and every field of a station is the
real state of that thing.

## Core ownership

`core/office/` is Core's, and it is Electron-free and renderer-free.

| File | Owns |
| --- | --- |
| `types.ts` | The closed vocabularies: zones, station kinds, presence states, reasons, limits, geometry. |
| `layout.ts` | Deterministic placement of stations on a fixed virtual floor. |
| `projection.ts` | The pure function deriving the Office from Work + Workforce + status. |
| `state.ts` | The bounded fold of `office.presence.requested` events. |

The Office owns almost no state. Its stations, history and layout are pure
functions of the Work, Workforce and status projections, which are themselves
folds over the journal. The one thing the Office owns is the set of pending
presence requests — the bounded record that the owner asked for an agent to
join the desktop Presence.

## The one rule

> **Nothing in the Office is invented.** A station exists because a real Run,
> worker, approval or piece of history exists in Core. A station's state is the
> real state of the thing it represents. There is no idle animation, no fake
> progress, no phantom worker and no decorative activity.

## Spatial zones

The office is divided into zones, each with a closed vocabulary of what may
appear there:

```
freya      Freya's own station — always present, shows her real Core state
floor      Live runs — one station per non-terminal Run, capped
workforce  Workers — one station per worker with real state, capped
approvals  Pending approvals — one station per open request, capped
history    Settled runs — a timeline of journaled metadata, capped
```

A zone is a region of the office floor with a deterministic grid. Stations
are placed in the order Core reports them, so the same state always produces
the same layout on every machine and every launch.

## Freya's station

Freya's state is derived from Core's own status, never invented:

- `error` when the journal is corrupt or Core is degraded — she cannot vouch
  for her own history, and the office says so.
- `locked` when STOP ALL is latched or the Governor is refusing everything —
  she cannot act, and the office says why.
- `working` when a model request is in flight or a Run is live — the two facts
  Core already holds that mean she is spending on the owner's behalf.
- `idle` otherwise. Idle is the honest default: it means nothing is executing,
  not that she is broken.

## What crosses, and what deliberately does not

Crosses: ids, statuses, kinds, counts, measured lengths, instants, closed
labels, and the deterministic layout positions derived from them. Worker
stations use a code-owned label derived only from the worker specialisation;
pending approvals use the fixed `waiting for your approval` detail.

Does **not** cross:

- **Step input, observation contents, message bodies, task titles, mission
  text, worker display names, approval proposals and approval justifications.**
  The Office shows structure and state, never substance.
- **Any authority object, capability instance or policy.** The Office is a
  viewer. It has no method that grants, decides, cancels or redirects.
- **Any model call.** The Office is a pure function of Core state.

## Presence requests

`office.presence.request` asks that an agent join the desktop Presence. It
takes a `workerId` and nothing else — no principal, no authority, no
capability, no expression. Preload and Core exact-key check that payload and
require the same bounded journal-safe id grammar used by durable event ids.
Core then validates the worker exists, journals the request as
`office.presence.requested`, and the Office reports it as pending.
Whether and how the agent actually appears on the desktop is a Presence
concern (Phase 13), not the Office's — the Office can ask, and it can show that
it asked, and it can do nothing else.

The request is bounded: one pending request per worker, a worker that must
exist, and a request set capped at `OFFICE_LIMITS.maxPresenceRequests`. A
request is refused while STOP ALL is latched.

## Integration through narrow ports

- **Work** provides the run stations, approval stations and history. A run
  gets a station exactly while it is not terminal; a completed run leaves the
  floor and enters the history.
- **Workforce** provides the worker stations. A worker gets a station exactly
  when Core's Workforce says they exist, and their state is the workforce's
  own status.
- **Core status** provides Freya's station. Her state is derived from the
  same facts the desktop projection already uses: `activeProviderCalls`,
  `stopAll`, `governor`, `lifecycle` and `integrity`.
- **Presence** (Phase 13) consumes the journaled `office.presence.requested`
  event. The Office does not assume any Phase 13 implementation detail; it
  records the request and reports it as pending.

## Persistence and restart

The Office has no second store. Stations, history and layout are derived from
the Work and Workforce projections, which are themselves derived from the
journal. The one piece of Office state — the set of pending presence requests
— is journalled as `office.presence.requested` and replayed on every start, so
a request survives a restart exactly like every other durable fact in Core.

## Performance bounds

- **Capped stations.** At most 8 floor stations, 12 workforce stations, 6
  approval stations and 20 history entries. A zone that holds more states how
  many are hidden.
- **Deterministic layout.** A fixed grid, not a force simulation. A station
  moves only when the state it represents changes.
- **No unbounded subscriptions.** The Office is published on every state
  change through the same `notify()` path as every other projection, and the
  renderer's mirror follows the same subscribe-then-read pattern.
- **No model calls.** The Office is a pure function of Core state.

## Red team

The Office is the most user-facing surface in the system, and the one where
the temptation to invent activity is strongest. The red-team attacks are in
`tests/red-team/office-redteam.test.ts`:

1. **Forged run state.** A hand-written `work.run.started` for a run that does
   not exist must not put a station on the floor.
2. **Phantom workers.** A forged `workforce.worker.created` must not put a
   worker on the floor unless Core's own fold accepts it.
3. **Stale replay.** A redelivered `work.run.completed` must not resurrect a
   run that has already left the floor.
4. **Renderer mutation.** The projection is frozen and read-only.
5. **Cancel/redirect bypass.** The Office owns no action authority.
6. **Fake progress.** A forged `work.step.verified` for a step that never ran
   must not inflate a run's progress.
7. **Private journal leakage.** Sentinels in step input, worker display names,
   approval proposals or approval justifications must not reach the Office
   projection.
8. **Window/event storms.** A flood of events must not grow the office without
   bound.
9. **Agent impersonation.** A worker cannot request presence as another worker.
10. **STOP ALL bypass.** A presence request is refused while STOP ALL is latched.
11. **Model-call amplification.** The Office is a pure function; no code path
    here can reach a provider.
