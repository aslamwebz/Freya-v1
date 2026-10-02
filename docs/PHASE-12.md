# Phase 12 — Events and Attention

Authorized event ingestion, code-owned importance and urgency, interruption
budgets, cooldowns, focus awareness, scheduled and conditional attention, and five
closed outcomes: **do-nothing**, **remember**, **subtle-cue**, **speak**,
**interrupt**. "Do nothing" is a first-class, well-tested outcome.

The governing rule is the one in [PRODUCT.md](PRODUCT.md): *models decide, code
controls*. Attention is the subsystem where that rule is easiest to violate — a
"smart notifications" feature naturally drifts toward a model scoring every event —
so Phase 12 is written the other way: the score, the budget, the cooldown and the
outcome are closed tables in Core, and an event's own text is data that the policy
never reads.

## Core ownership

`core/attention/` is Core's, and it is Electron-free and renderer-free.

| File | Owns |
| --- | --- |
| `types.ts` | The closed vocabularies, limits, shapes and sanitization. |
| `policy.ts` | Deterministic importance/urgency scoring and the outcome ladder. |
| `ingest.ts` | The authorized door: source assignment, payload validation, bounding. |
| `state.ts` | The fold of `attention.*` events — dedupe keys, decisions, budgets, schedules. |
| `projection.ts` | The only route from domain facts to a window. |
| `engine.ts` | The one impure piece: it appends to the journal. |

The engine holds no gateway, no provider, no authority object and no capability.
It cannot spend money, mint a capability, clear STOP ALL or widen a permission,
because none of those exists on any type it holds. That is asserted structurally by
a red-team test that reads the domain's source and refuses any import of a model,
cognition or authority module.

## Authorized ingestion

Events enter only through an **authorized source**, and the source is assigned by
Core, never read from a payload:

```
owner · mission · work · research · context · system
```

The renderer's only route is the `attention.event.ingest` command, where Core fixes
the source to `owner` and the bridge rebuilds the payload from named fields so a
forged `source` never reaches the main process. Internal subsystems are issued a
narrow `AttentionSourceScope` (`core/testing.ts` exposes it for tests) that can
ingest and nothing else — no decide, no schedule, no budget.

An event's **text is data**. It is sanitized (control characters stripped,
whitespace collapsed, truncated to `maxEventTextChars`), retained in process memory,
and never written to the journal, a projection or the activity feed. It comes back
only from an explicit `attention.inbox.read` for one event, and it does not survive
a restart — Core refuses rather than returning a stale copy.

## Deterministic scoring

Importance and urgency are closed ladders, not numbers:

```
importance  trivial < low < normal < high < critical
urgency     background < normal < elevated < urgent
```

`scoreImportance` reads a per-kind table, raises by at most one level for a
`severityHint`, and **caps the result by the source class**: `owner` can reach
`high`, `research` only `normal`, and only `system` can reach `critical`.
`scoreUrgency` reads a per-kind table and a due-time window. A source's own
"urgent" claim cannot, by itself, produce an interruption.

The outcome is chosen by a fixed precedence and then **demoted** (never raised) by:

1. **STOP ALL** → `do-nothing`, reason `stop-all`.
2. **per-source ingest rate** → `do-nothing`, reason `rate-limit`.
3. **focus** — a `focused` person is not interrupted for anything short of
   genuinely urgent; `interrupt` becomes `speak`, `speak` becomes `subtle-cue`.
4. **cooldown** — after an interrupt, the source is capped at `remember` for
   `cooldownAfterInterruptMs`; after a speak, at `subtle-cue`. Absolute: urgency
   cannot jump it.
5. **budgets** — interrupts are bounded across all sources, per source and per
   goal; speaks are bounded per source. Exceeding one demotes and journals
   `attention.budget.exceeded`.

## Focus awareness, from state that already exists

There is no new surveillance primitive. `focused` means Core is spending on the
owner's behalf right now (a provider call is in flight) or a Run is executing —
facts Core already holds. Nothing reads a screen, a keystroke, an accessibility
tree or a model. `away` is in the vocabulary for a future authorized signal; this
phase never produces it.

## Scheduled and conditional attention

Schedules are bounded in every dimension: the interval is clamped up to
`minScheduleIntervalMs`, repeats are capped at `maxScheduleRepeats`, the population
at `maxSchedules`, and the due time at `maxScheduleHorizonMs`. A schedule fires
only through `tick()`, and only when due **and** its condition holds against
already-authorized state (`always`, `focus-available`, `goal-open`). The wake is
driven by the composition root on a coarse interval; there is deliberately no
`attention.tick` command, so a renderer cannot make a schedule fire.

A schedule's text is process-local. A schedule recovered from the journal after a
restart cannot fire without its content, so it is **cancelled with a stated reason**
— the same honesty Work applies to an interrupted run.

## Integration through narrow ports

- **Mission / Work / Research** deliver terminal events through the internal source
  scope when the host composes `attentionObserveSources` on. The text is a fixed
  sentence Core wrote, never a capability's return value.
- **Context** is read only for the focus signal, and only from state Core already
  held before Phase 12.
- **Voice** is not reached: attention makes no model call and no synthesis call.
- **Presence** may draw at most one directive, a code-owned cue label, from the
  projection. It cannot invent an urgency, an importance or an interruption.

## Persistence and restart

There is no second store. Decisions, dedupe keys, ingest instants and schedules are
all derived from `attention.*` events in the journal, so budgets and cooldowns
survive a restart exactly. A re-delivered event is recognised by a dedupe key
derived from the source's own reference and produces **no new journal line and no
second decision**, so a replay storm cannot amplify. Event and schedule text are
process facts and do not survive; the projection reports their measured length and
the detail read truthfully returns nothing.

## Renderer

The `attention` surface is a pure mirror plus the two owner actions Core permits:
submit an event, register or cancel a schedule. It cannot decide, escalate, spend a
budget, bypass a cooldown or drive the scheduler. The status area draws at most one
attention cue, labelled from a closed table this codebase owns.

## Verification

On 2026-10-02 the full gate passed on `phase-12-events-attention`, and an
independent review on `review/phase-12-go` re-ran it at head `6a0bd88`:

- **Focused Phase 12 tests:** 61 tests in 5 files — the domain vocabulary and
  policy, the engine through the real Core boundary, the host bridge, and the
  renderer client and surface.
- **Phase 12 red-team tests:** 37 tests in 11 files, one per attack family below.
- **Full suite:** 2,777 tests in 160 files, typecheck, lint, the renderer/main/
  preload build and 190/190 offline Electron desktop checks, all under
  `npm run verify` (`EXIT=0`). The desktop suite includes three checks that open
  the Attention surface through the launcher, confirm the bridge exposes only the
  pull and the subscription, submit an owner event, and confirm the event text
  never appears — only its length.

The red-team suite covers forged urgency, notification storms, cooldown bypass,
event poisoning, replay/restart duplication, scheduler abuse, attention loops,
renderer forgery, privacy leakage, model-call amplification and STOP ALL.

The review found and fixed one containment gap: a flood of over-rate events is
still journalled as a `rate-limit` `do-nothing`, and those refusals previously
occupied the bounded decision retention, so ~260 of them evicted the cooldown and
budget history they were meant to protect and let a later schedule fire interrupt
again inside the same window (proved end-to-end against the pre-fix fold, which
counted three interruptions against a cap of two). Rate-limit refusals are now
journalled but not retained, and `maxRetainedDecisions` covers the most the six
closed sources can legitimately produce in one window. The permanent regression —
`a flood of journalled refusals cannot evict the history the budget is measured
against` in `tests/red-team/attention/notification-storm.test.ts` — feeds that
exact durable stream through the real fold and the real policy: it fails against
the pre-fix fold and passes against the fixed one.

## Deliberately deferred

- **A native/connector event source** (email, calendar, OS notifications) is Phase
  16's Relay boundary. This phase's `system` and `owner` sources exist; a connector
  would attach as a new closed source with its own validation, not by widening a
  payload.
- **OS-wide focus sensing** remains unsupported, as it has been since Phase 9. Focus
  reads only state Core already held.
- **Voice delivery of `speak`/`interrupt`** is not wired. The outcome and its cue
  label are decided and surfaced; turning a decision into audio is a Presence
  concern, and doing it here would have made a notification system into a speech
  system.
