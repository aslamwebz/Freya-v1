# Phase 23 — Runtime Integration

**Status:** integrated on `integration/phase23-runtime`. The domain that was
committed unwired in `94d5fa3` is now owned by Core, driven by authoritative
events and the host's existing tick, and reads only through the Governor and the
Gateway.

The domain is `core/lifeloop/{types,wake,prefilter,decide,machine,deadlines,state,recovery,assertions}.ts`.
It is unchanged in spirit: still pure, still closed-vocabulary, still the place
where every decision about money and attention is made. Two files join it —
`ports.ts` and `runtime.ts` — and `projection.ts` beside them.

This document records what the wiring added, what it had to change in the domain
to be expressible, and what is deliberately not wired.

---

## 1. What Core does with it

| Step | Where | What happens |
| --- | --- | --- |
| Construction | `core/index.ts` `start()` | `new LifeLoopRuntime({ ports, limits })` after every subsystem it reads. Free: no store, no timer, no provider, nothing scheduled. |
| Recovery | `start()`, before `core.ready` | `await lifeLoopRuntime.open()` — folds the journal, reconciles, runs the eight zero-idle assertions once. |
| Event wakes | the fabric subscription | `observeLifeLoopSource(event)` — a closed table over event *types*, fire-and-forget. |
| Heartbeat | `attentionTick(now)` | `await lifeLoopTick()` **before** `attentionEngine.tick(now)`. One wake per tick, at most. |
| Owner pre-emption | `conversation.create` | `preemptByOwner()` in the same synchronous turn, awaited before the command answers. |
| STOP ALL | `security.stopAll` | `stop()` called synchronously, awaited before the latch is written. |
| Lift | `security.resume` | `await lift()` — the only caller of `lifeloop.unstopped` in the system. |
| Shutdown | `stop(reason)` | `close()` — stops taking work, and deliberately does *not* latch. |
| Reads | `lifeLoop()` / `onLifeLoop()` | A content-free projection and its mirror. No write verb exists. |

### Why the heartbeat runs before Attention's tick

A schedule the loop is going to be offered has to still be *pending*, and
`AttentionEngine.tick` settles every due schedule as it fires. A loop that looked
afterwards would find an empty list — a heartbeat that is wired, bounded, tested,
and never fires. That is worse than one that does not exist, so the order is
load-bearing and is commented where it happens.

### Why `attentionTick`'s return value is unchanged

It is the number of Attention schedules that fired. The host reads it and three
existing tests pin it. The life loop's count is deliberately **not** added to it:
one number meaning two things is how a heartbeat's cost stops being visible.

---

## 2. The ports, and what is missing from them

`core/lifeloop/ports.ts` is the whole integration surface. There is no port that
returns a gateway, a provider, a permit, a principal, a capability or a grant
store — so there is nothing for the loop to reach authority through, at compile
time rather than by convention.

Two ports carry the phase's weight:

- **`requestCognition`** is the only route to a model. Core fills it with the
  Governor, the Gateway and an *owner-created grant*. The loop picks a category
  (`scheduled_task`); Core derives the origin, cause and background flag; the
  Governor still judges. A refusal costs nothing because nothing was contacted.
- **`raiseEscalation`** does not decide anything. It asks Attention — already
  Core's authority over the owner's attention, with its own budgets, cooldowns and
  focus rule — to consider something, and returns whether Attention escalated or
  suppressed. Two authorities over one human's attention is how a system ends up
  interrupting somebody twice.

The escalation is raised under the *wake's own domain* (`mission`, `work`, …),
never `system`, because `system` carries the highest importance cap in the
attention policy and a loop raising itself as `system` could buy an importance it
never earned.

---

## 3. What the domain had to be taught

Nine places where the journal vocabulary could not express something the runtime
has to journal. Each is additive and closed; the ordinary transition table is
untouched.

1. **`lifeloop.reconciled`** — a restart, the owner pre-empting, and the owner
   clearing a stop are moves no continuation signal points at, because none of
   them is a step. Adding a fake signal would put an entry in the table that is not
   a step, and the table's whole value is that every entry is one.
2. **`lifeloop.unstopped`** — the one lift of a stop that exists. Gated on
   `FoldContext.ownerClearedStop`, which `reduceLifeLoopState` derives from
   `security.stop_all.cleared`. Without that second fact, one hand-written line in
   the journal lifts the panic button.
3. **`lifeloop.wake.denied` became bookkeeping** rather than a move. A wake the
   registry refused never entered the continuation, so the loop is where it was;
   consulting the table would have folded every refusal at an idle loop as
   tampering and dropped it, leaving no trace of the one outcome the owner cannot
   otherwise learn about.
4. **`deadlineExpiresAt`** is journaled on every entry that arms or holds a
   deadline. Re-deriving it from `DEADLINE_DEFAULT_MS` would widen every short hold
   into the thirty-day `wait` default, so a two-second retry backoff would survive
   a restart as a month of not trying.
5. **The `WAIT -> DENY` denial** is signalled `deadline-expired`, not
   `filter-denied`. A wait does not get refused; it runs out.
6. **Approval parking** is settled by `interrupt(…, 'approval-required')` rather
   than the ordinary table, because `ALLOW -> WAIT` is an interruption and the
   interruption table is the one allowed to override.
7. **`CLEARABLE_STOP_CODES`** decides whether a close-out may lift a stop, as a
   whitelist of the clearable. A stop whose code is missing, misspelt or invented
   is unreadable as clearable and stays latched — the direction that fails safe.
8. **A stop arriving over a completed loop** upgrades the stop code to latched
   rather than being an anomaly. Strictly one-directional, and without it the next
   close-out would unfreighten a stop the owner had just asked for.
9. **`iteration` is zero-based.** The prefilter refuses once `iterationCount` has
   reached `maxLoopIterations`, so a one-based counter refused the last permitted
   iteration — and narrowing the ceiling to `1` left the loop unable to think.

`reduceLifeLoopEntry` was exported alongside `reduceLifeLoopState` so the runtime
folds incrementally instead of re-reading the log after every append. It is the
same code path, so the running process and a later replay cannot disagree.

---

## 4. The journal payloads

Seventeen `lifeloop.*` event types, registered in `core/events/envelope.ts` and
validated in `core/events/validate.ts`.

The validator reads its vocabulary from `core/lifeloop/types.ts` rather than
re-enumerating it. That is not tidiness: a second hand-copied list could fall out
of step with the first, and the failure would be *silent* — an unknown key would
be accepted by the journal and then refused by the fold as an anomaly, so the log
would hold an entry the loop itself considers tampering.

`lifeLoopRule` additionally refuses any key in `FORBIDDEN_PAYLOAD_KEYS` and any
string over 200 characters. Authority is minted by the Guard and the Governor and
never by an event, so a payload shaped like a capability is not a new field.

**The store does not validate on the way in.** An event that fails its own
validator is written to disk and rejected on the next read, which truncates the
log at that line and takes the derived security state with it. So "the loop
journals a refusal" and "the journal stays readable afterwards" are the same
requirement, and `tests/core/lifeloop/runtime.test.ts` asserts it across every
path the loop can take.

---

## 5. What is deliberately not wired

- **`owner-message`, `owner-command` and `owner-approval` wakes.** The owner's
  own turn is the Mind's, answered through the grantless user path; routing it
  through the loop as well would spend twice for one question. The kinds stay
  declared so a future lane can raise them and be deterministically filtered.
- **`periodic-check`.** A self-raised periodic check *is* the self-running loop
  this phase exists to forbid, so there is no producer for it. The kind is
  declared, listed among the non-justifying kinds, and refused.
- **The approval producer.** `escalationApprovalRequired` is a port, and Core
  answers `false` — explicitly, in code with a comment. Phase 23's bounded actions
  reach Attention and Core's own projections, neither of which needs consent. The
  parking, the absolute `approval` deadline, the owner-approval wake that would
  lift it and the retry ceiling all exist and are tested; writing a fake producer
  to make the path look live would be the exact failure this phase is about. The
  moment an action reaches a connector or a worker's allowance, that answer
  changes and nothing else does.

---

## 6. Pre-existing failures on this branch, unrelated to Phase 23

Five tests fail identically before and after this work, and were masked before
`better-sqlite3` could be installed on this machine:

- `tests/core/life-core.test.ts` — "withdraws an entry and never silently
  reappears across restart"
- `tests/core/vault/vault-life-core.test.ts`
- `tests/core/vault/vault-world-core.test.ts` — SQLCipher reports
  `hmac check failed for pgno=1` on reopen
- `tests/core/world/persistence.test.ts`
- `tests/red-team/life/privacy-leakage.test.ts`

All five are Vault/Life/World persistence across a restart: the Vault key or its
derivation does not survive reopening the database, and two of the tests reopen a
Core without re-supplying the `vault` option the first one used. None of them
touches the life loop, and the fix belongs to the Vault lane.