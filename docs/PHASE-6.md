# Phase 6 — Work: the execution engine

Phase 6 gives Freya a way to *do* things. Before it, everything in the system could
record, recall, answer and stop — and nothing could execute, because there was no
layer underneath that knew what executing safely meant.

This document records what was built and why. It is not a plan, and it does not
describe anything that does not exist yet.

---

## What this phase is

At the end of it you can open the Work board, plan a run, watch it execute step by
step, be stopped and asked before a consequential step, deny it and see the run
fail with your refusal as the reason, cancel one mid-flight, and read back what
happened after a restart. Every step that reports success still has to *verify*,
and a run whose verification fails says so even though its actions all completed.

The interesting part is not the window. It is that the engine is the **least trusting**
part of the system about its own inputs: it refuses a plan it cannot execute, an
input it cannot measure, an approval it cannot attribute, and — after a crash — a
run whose plan it cannot honestly continue.

---

## 1. The five words, and why they are not interchangeable

```
  Run          one execution attempt toward an outcome
   └ Step      a meaningful unit of intended work
      └ Action an operation that was actually attempted
         └ Observation   evidence about what happened
            └ Verification whether the intent was satisfied
```

The whole file exists to protect the distinctions. Collapsing any two of them
produces the failure the architecture names out loud:

> Verification is not optional: an action is not evidence that it worked.

So in `core/work/types.ts`:

- `STEP_STATUSES` has **no** `success`. A Step reaches `verified`, and only a
  verifier can put it there.
- `OBSERVATION_KINDS` has **no** `success` either. A capability returning data has
  produced an *observation*; whether the data satisfies the intent is a separate
  question with a separate answer.
- An `Action` that `completed` is a fact about a call. It is not a verdict, and the
  board shows them as two rows for exactly that reason.
- A `Run` reaches `completed` only when **every** step is `verified`. A run with one
  failed step is `failed` even if the rest were skipped around it.

`test.unverifiable` exists in the test capabilities for one reason: to make the
alternative reachable. A capability that completes and says "did the thing", with no
verifier willing to confirm it, cannot close its step.

---

## 2. Run lifecycle

```
  queued ──► running ──► completed
     │         │  ▲
     │         │  └── paused ──► running
     │         ├────► awaiting_approval ──► running
     │         ├────► waiting ──► running
     │         ├────► failed
     │         └────► cancelled
     └──────────────► paused / failed / cancelled
```

`RUN_TRANSITIONS` in `core/work/types.ts` is the *only* thing permitted to move a
Run, and the three terminal statuses have **no outgoing edges at all**.

Two consequences are worth stating, because they are the reason several races in
this system cannot happen rather than merely being unlikely:

**Terminal is terminal.** A completed Run is never rewritten. A retry is a *new*
Run; the failed one stays failed forever, with its reason.

**Cancellation cannot be reordered by a late completion.** `cancelRun` checks the
status before it writes anything, and a completion arriving afterwards is refused by
the table — `cancelled → completed` is not an edge. That is the completion/cancellation
race closed by inspection rather than by timing, and it is tested with the two
commands in flight at once.

### The one status Phase 6 declares but does not produce

`waiting` is in the vocabulary and in the reducer, and **nothing in Phase 6 enters
it**. It is there because Phase 5 (a browser tab waiting on a person) and Phase 7
(a schedule waiting on a date) will need it, and a closed vocabulary is cheaper to
extend than to reopen. What was rejected was the alternative — quietly calling it
`paused`, which would have made a run waiting on a human indistinguishable from one
the owner paused.

---

## 3. Step lifecycle

```
  pending ──► ready ──► running ──► verified
     │          │  ▲        │
     │          │  └────────┤  (failed → ready is the retry)
     │          └──────────┤
     ▼                     ▼
  skipped / cancelled   failed / cancelled
```

Execution is strictly in planned order, which is what `deterministic` means and the
whole reason a dependency graph is not needed yet. Step identity is `stepId` +
`key`, so adding `dependsOn` later is a field and a selection rule rather than a
replacement of the model.

**`failed → ready` is the only backward edge in the system, and it is deliberate.**
A Step retries; a Run does not. Retrying a Step is a new attempt *within* one Run,
and each attempt writes its own `work.action.*`, `work.observation.recorded` and
`work.verification.*` — so a flapping capability's history stays whole rather than
collapsing into one error. A Run that failed stays failed, and starting another is an
explicit new command.

`awaiting_approval` has two ways out and both are real. `ready` is the gate
reopening after a grant: the step re-enters the same ordered selection everything
else goes through, so an approved step is not privileged by skipping the queue.
`running` is a step that was already executing when the request arrived — the shape
Phase 5's browser and terminal steps will need.

---

## 4. Approval is a state, not a boolean

```
  Step wants a consequential action
        ↓
  Guard is asked about the capability the CAPABILITY declared
        ↓
  approval.requested  ── the Run and its Step stop, here
        ↓
  you approve ──► step → ready ──► the capability is called
           deny  ──► step → failed ──► Run failed, reason = your refusal
```

`work.approval.requested` is itself the transition, and that is deliberate: one
event, one fact. It is also what makes "nothing ran yet" checkable, because the
record exists strictly before any `work.action.started` could.

Four properties are structural rather than checked in a payload:

- **Risk lives on the capability, in code.** `capability.risk === 'consequential'`
  always requires an approval. A Step plan *may* additionally ask for a gate; it can
  never lower one. A capability cannot lower its own risk either, because it is not
  the thing that reads the field.
- **Only the owner may decide.** `work.approval.decide` is a separate capability
  from `work.run.manage` precisely so it can be withheld or re-gated alone, and
  `WORKER_CAPABILITIES` excludes **every** `work.*` capability. A Run executing
  under a worker principal therefore cannot approve its own request by any route.
- **`decidedBy` is not a field a caller can supply.** The engine's function takes it
  as a parameter Core supplies, and the preload contract rebuilds the payload from
  named fields with no such key. A window that appends one is not overruled — it
  never crosses the boundary.
- **A grant authorises one attempt.** `grantedApproval` requires `attempts === 0`,
  so a step that fails and retries must ask again. That is "retries cannot bypass
  approval" as code rather than as a convention.
- **A decision is serialized per approval.** Approve, deny, expiry and cancellation
  all use the same approval queue, so two callers cannot both observe `pending`
  and append contradictory terminal decisions.
- **Pending approvals really expire.** A bounded, unref'd timer settles the approval,
  its Step and its Run after `approvalTtlMs`; expiry is not merely discovered when
  somebody clicks an already-stale button. The timer is cleared on every terminal
  decision and on shutdown.

`proposal` exists so a person has a subject to decide on, and it is written by the
capability's own `describe()` — a bounded sentence about the *effect*, never the
input. A plan cannot write a flattering proposal for the work it is asking to do.

---

## 5. The capability boundary

```
  Work Step
     ↓  plan names a registered capability
  WorkCapability.capability ──► Guard.evaluate ──► allow | deny | approval_required
     ↓
  execute(request, { signal, now })
     ↓
  Observation  ──►  WorkVerifier.verify(observation)  ──►  verified | failed
```

`core/work/capability.ts` names no subsystem. Search, a browser, a terminal, an
agent and a Phase 7 Mission are all just a `WorkCapability` here, and the engine
cannot tell the difference — which is the point, because a Work engine demonstrated
with a `child_process` would be demonstrating the one thing this phase must not
build.

The three rules the shapes enforce:

1. **The capability is asked; it does not decide.** `capability` is the vocabulary
   entry Guard evaluates, and a plan names a registered capability rather than a
   capability directly.
2. **An action is not evidence.** `execute` returns an Observation and *never* a
   verdict. The thing that produced the evidence is structurally unable to certify
   it: the verifier is a separately registered object that receives the observation
   and nothing else.
3. **Everything is abortable.** `execute` is handed an `AbortSignal` that
   cancellation and shutdown both fire, and a capability that cannot be aborted does
   not typecheck rather than merely being discouraged.

### Input is data or it is refused

`request.input` crosses a boundary from the least trustworthy thing in the system.
Allowed shapes are **primitives only** — bounded strings, finite numbers, booleans,
`null`. Every object is refused wholesale rather than walked, and `__proto__`,
`constructor` and `prototype` are refused by name. Refused rather than repaired,
for Brain admission's reason: an input with a hole cut in it looks like valid input,
and the hole is where the capability's real behaviour would have been.

### What Phase 6 registers

Five capabilities and four verifiers, all inert:

| Capability | Risk | Demonstrates |
| --- | --- | --- |
| `test.record` | routine | the success path |
| `test.failing` | routine | bounded retry |
| `test.unverifiable` | routine | an action that succeeded and verified nothing |
| `test.slow` | routine | cancellation reaching *inside* a capability |
| `test.consequential` | **consequential** | the approval gate |

No shell, no process, no filesystem, no network. A Core built today can execute no
external operation at all, which is the correct starting posture rather than a gap.

### Are these shipped in production? Yes — deliberately, and with a date on it

This is a decision worth stating rather than leaving to be inferred, because
"inert test capabilities reachable from a production board" is the kind of thing
that gets deleted by a reader who assumes it is an oversight.

**They are intentionally shipped in Phase 6**, for one reason: they are the only
executable capabilities in the system, and the Work board and the e2e both need one
to demonstrate the mechanism. Removing them would leave the engine with nothing that
can run, which makes the approval gate, bounded retry, cancellation-from-inside and
verification-failure paths untestable through the product rather than only in unit
tests.

**They are inert by construction, not by convention:**

| | |
| --- | --- |
| filesystem | none — `test.record` writes to a returned object, nothing else |
| process | none — no `child_process`, no `spawn`, anywhere in `core/work/` |
| network | none — no fetch, no socket |
| secrets | none — input is primitives, sanitised, and bounded |
| cost | none — the engine holds no authority and cannot reach a model |
| duration | bounded — every call takes an `AbortSignal` and is raced against the Run deadline |

The one that *does* affect the outside world is `test.slow`, and it only waits.

**When they should go.** Once Phase 5 lands a real capability set, the
demonstration capabilities should become **development/test-only**, registered the
same way `developerProvider` is: behind an explicit flag, absent by default. The
switch already exists and is one line — `registerPhaseSixCapabilities(this.workRegistry)`
in `core/index.ts:start()`, and it can be made conditional on the same
`options.developerProvider` style of opt-in. That is deliberately *not* done in
Phase 6, because flipping it now would leave the e2e with no capability to drive
and would buy nothing that Phase 5 does not buy properly.

Two conditions should be met before the switch flips, and both are Phase 5's to
satisfy rather than Phase 6's:

1. At least one non-test capability exists that the board can demonstrate with.
2. The e2e has a path that exercises the engine without them — which it currently
   does not, and which is the real blocker.

Until then, "Freya can execute no external operation" is a true and reassuring
sentence about the product, and the capabilities above are what make it true.

---

## 6. Tasks

A Task is a user-visible piece of work. It is **not** a Step, and turning every
internal Step into a Task would put the engine's own mechanics on the user's board.

```
  open ⇄ in_progress ⇄ blocked ──► done | cancelled
```

One Task may contain or produce several Runs; one Run belongs to at most one Task.
A run that completes takes its Task to `done`; a run that fails verification leaves
it `blocked` rather than `done`, which is the honest outcome — the work is not
finished and it is not cancelled either. Both terminal statuses are terminal.

---

## 7. Cancellation

```
  cancel Run
     ├─ terminal?  ──► write nothing at all, report the status that is already there
     ├─ already cancelling? ──► write nothing at all
     ├─ set the flag and abort, in the same synchronous turn, before any await
     ├─ a step loop is in flight? ──► it writes the terminal events
     └─ nothing is executing? ──► this call writes them
```

One writer per Run, whichever it turns out to be. The ordering is what makes the
properties true:

- **Idempotent.** A second cancel finds the flag and appends nothing. Asserted by
  reading the journal and counting `work.run.cancelled`.
- **A completed Run cannot become cancelled.** The check is first and writes
  nothing, so a delayed cancellation signal has no effect at all.
- **A late completion cannot resurrect a cancelled Run.** The transition table has
  no such edge.
- **It reaches inside the capability.** `test.slow` is the one capability whose
  signal has something to stop, and its Action settles as `cancelled` rather than
  `failed` — which is what distinguishes "I stopped it" from "it broke".
- **A pending approval is withdrawn.** A decision nobody can act on any more should
  not keep appearing on the board as though it could.

`work.run.cancel` does **not** latch STOP ALL, exactly as
`conversation.turn.cancel` does not: it stops one Run, and the panic button remains
the separate and much larger control.

---

## 8. Bounds, and what a bound actually means

Four ceilings apply to a Run, all from `WORK_LIMITS`, all clamped **downward** by a
caller and never upward:

| Ceiling | Default | Checked |
| --- | --- | --- |
| `maxRunSteps` | 64 | when the plan is accepted |
| `maxRunActions` | 128 | before each capability call |
| `maxRunDurationMs` | 15 min | before **and during** each capability call |
| `maxAttemptsPerStep` | 3 | before each retry of a step |

Exceeding one is a recorded outcome — `work.limits.exceeded`, visible on the board as
`limitHit` — rather than a silent stop, and the step that found the ceiling spent is
the one that *fails*. A person looking at a stopped run should be able to see which
number stopped it.

### The duration ceiling is a wall, not a check between steps

This is the one worth explaining, because the first implementation got it wrong and
the wrong version looked entirely reasonable.

Checking `now - startedAt` **before each action** is not a duration limit. A
capability could start a second before the deadline and run for an hour afterwards,
and the Run would still be allowed to continue — the ceiling bounded the gap between
actions, not the work.

What Phase 6 does instead:

```
  remaining = deadline − now            ← once, before the capability is called
  if remaining ≤ 0: fail the step on the ceiling, call nothing
  arm one timer for `remaining`
  race( capability.execute(...), timer )     ─┐
  ...observation...                          │  the same timer, the same
  race( verifier.verify(...),   timer )     ─┘  deadline
```

And four things follow from the race rather than from an `await`:

- **The deadline aborts the capability.** The reason is recorded *before* the abort,
  so anything reacting to the signal — including the capability's own handler —
  already knows why.
- **A deadline is not a cancellation.** `deadlineHit` is a different record from
  `cancelRequested`, and the Action settles as **failed** with the ceiling as its
  reason. Writing `work.action.cancelled` would put a cancellation in the audit
  trail that nobody asked for.
- **A capability that ignores its signal cannot hold the Run open.** JavaScript
  cannot forcibly terminate arbitrary code, so the engine stops *waiting* at the
  deadline and settles the Run itself. The capability's promise keeps both handlers,
  so its late resolution — or rejection — is swallowed rather than becoming an
  unhandled rejection or a resurrected Run. **This is the honest boundary: the
  engine stops believing a capability, rather than pretending it stopped it.**
- **A capability that resolves *after* the deadline is not a success.** The clock is
  re-checked after the race, because a capability can win the race microseconds
  before the timer fires. Without that check a slow capability would complete an
  Action after its budget expired and the Run would go on to `completed`.

### The ceiling covers verification too

The first fix raced the capability and then `await`ed the verifier. That left the
ceiling bounding the first half of a Step and not the second half — and on the final
Step, the second half *is* the Run. A verifier returning `passed` after the budget
was gone would complete it, with every limit in the system reporting that the Run
was within budget.

Two decisions, and the second is the one that matters:

**One deadline, not two.** `deadlineAt` is computed once, before the capability is
called, and verification gets the remainder of *that* window. There is no fresh
budget for the verify phase: re-arming per phase would let a single Step take the
ceiling twice and a three-step Run take it three times, which is the opposite of a
ceiling. A verification is not even requested once the budget to ask for is gone.

**A late verdict is not a verdict — and neither is a fabricated one.** The verifier
is raced against the same deadline, with both handlers attached, so a verdict that
arrives late is discarded rather than completing the Run or escaping as an unhandled
rejection. On expiry the engine writes `work.limits.exceeded`, fails the Step, and
stops — with **no `work.verification.completed` at all**. The verification stays
`requested`, meaning exactly what happened: a check was asked for and never
answered.

Writing `failed` there would be just as much a fabrication as writing `passed`. It
would put a verdict in the audit trail that the verifier never gave, and the whole
point of the record is that it can be trusted to mean what it says.

The Action is *not* rewritten as failed when the deadline lands in verification. The
capability did return, and that stays true; the Step failed for a later reason. A
false record told for tidiness is still a false record.

### Cancellation still wins

`cancelRequested` is checked before everything else, on every path — capability and
verification alike — and `cancelRun` clears any armed deadline as it goes. A person
pressing stop is a more specific fact than a budget running out, so cancellation is
what gets written. And because the terminal table has no outgoing edges, a ceiling
that fires a moment later cannot rewrite a cancellation — the loser of the race has
nowhere to go.

Cancellation is also a *third* arm of the race, separate from the deadline. Aborting
only asks a capability or verifier to stop, so a cancel that relied on the abort
alone would leave a hanging collaborator in charge: the Run would stay alive for the
rest of its budget, up to fifteen minutes after somebody pressed stop. The release
is synchronous with the flag being set, and the two are never collapsed — a
cancellation and a ceiling are different facts and get different records.

### Timers

One timer per in-flight Step — not per phase, because there is only one deadline —
cleared in a `finally` on every path: success, failure, cancellation, deadline in
either phase, a verifier that throws, or a verifier that never settles. `close()`
clears every armed timer *and* bounds its wait, so neither a leaked timer nor a
collaborator that ignores its signal can hang the shutdown or append into a closing
journal. `WorkEngine.armedDeadlines()` exists so "the timers are cleared" is
checkable rather than asserted.

A verifier that throws synchronously is caught by wrapping the *call*, not by
chaining the returned promise. `verify` may return an outcome or a promise of one,
so a synchronous throw happens before any promise exists to attach a handler to —
and left alone it would tear down the Run driver, escalating one collaborator's
failure into an engine failure.

---

## 9. Retention: a memory bound, not a deletion

`WORK_LIMITS.maxRetainedRuns` (200) bounds **what a board lists** and **what this
process keeps in memory**. It never touches history.

| Bounded | Not bounded |
| --- | --- |
| the runs the projection lists | the journal, which keeps every run for ever |
| a settled run's plan, step labels and observation summaries | `WorkState`, the in-memory fold of the journal |
| titles of tasks outside the newest 200 | counts, which describe every run |

Three rules, in the order they matter:

- **Live work is never evicted.** A queued, running, waiting or paused Run is listed
  whatever the ceiling, and so is one sitting in `awaiting_approval`. Dropping the
  run you are waiting on because 200 newer runs finished would make the one thing a
  person most needs to see the one thing they cannot see.
- **Settled runs are kept newest-first.** So the ceiling spends the volatile material
  — the part that only exists while this process does — and never spends work.
- **Deterministic.** Newest-first with the id as a tie-break *in the same
  direction*, so two runs created in the same millisecond still have one order, and
  it is the same on every machine and every launch of the same journal.

`WorkProjection` states `runsRetained`, `runsTotal` and `runsHidden`, and the board
renders them. A viewer that silently stopped listing runs would read as "they
finished and went away", which is the false impression a bounded viewer is most
likely to create — and it would be false, because they are all still in the journal.

`WorkEngine.volatileCounts()` exists so "the memory is bounded" is checkable. A
projection that simply refused to build detail would satisfy every count above while
the maps behind it grew without limit, which is the failure the ceiling exists to
stop.

---

## 10. Persistence and recovery

### Why Work has no store of its own

Every other durable subsystem in Core owns an encrypted file. **Work does not**, and
the reason is that the journal already is the durable record of what happened.
`work.*` events are fsynced, sequence-ordered, validated against a closed schema and
replayed on every start — and they hold only ids, counts, statuses and lengths, so
there is nothing in them for a store to protect.

A third encrypted store would have meant a third keyring secret, a third file and a
third recovery policy, for what is structurally the same information in a weaker
form. Instead the separation that matters is kept explicit:

| | Durable | Live |
| --- | --- | --- |
| what | what ran, in what order, how it ended, whether it verified, who decided each approval | which capability is executing, a step's plan and input, an observation's contents, a label you typed |
| where | the event journal | the process |
| survives | a restart | nothing |

`WorkProjection.detailAvailable` reports which half a window is looking at, and
after a restart it is `false` and a board says so rather than rendering empty fields
as though the work had nothing in it.

### What recovery does, and does not do

§10 of the Phase 6 brief asks for recovery "only to the degree that can be made
correct". This is that decision.

A Run the journal says was `running` when the process died **cannot** be continued,
because its plan was in memory. So `recoverInterruptedRuns` — called after replay
and before `core.ready` — marks it `failed` with the reason written to the journal,
settles its steps as `cancelled`, and expires any approval it was waiting on.
Nothing is retried, nothing resumes, and nothing is marked successful.

This is the same reasoning `docs/ARCHITECTURE.md` §6.1 already applies to provider
calls, and for the same reason:

> Live work is a process fact. The journal is not a substitute for this process fact.

`work.run.recovered` carries `previousStatus` **in its payload** rather than reading
it back from state, because after a restart "what this Run was doing" is exactly
the thing that is no longer knowable.

To test this honestly, `tests/core/work.test.ts` constructs a journal that says a
capability is executing by abandoning an event store without letting the engine
settle it — the only way to produce the state a crash produces, and the state a
graceful shutdown never does.

---

## 11. Progress without lying

```
  1 of 3 steps verified, 2 remaining
  1 of 2 steps verified, 1 failed
  2 of 2 steps verified
```

Counts and a sentence. `percent` is `null` unless every step is terminal **and
none failed or was cancelled** — a percentage over a run that will never progress
again, printed next to the word "progress", is the shape of a lie. The summary line
carries those cases instead, and it says more than a number would.

---

## 12. The event model

Thirty `work.*` types, metadata only. Every payload is an id, a count, a status, an
instant, a risk class or a **measured length**:

```
  work.observation.recorded   observationId, kind, summaryLength, detailLength
```

Both lengths, never the text. That is the whole reason a Work journal is safe to
keep in a backup: what a capability said stays in the process holding it. Step
labels, step inputs, task titles and observations never enter Work events, and
capability/verifier exceptions or evidence-derived verifier explanations are reduced
to fixed code-owned reasons before a durable event is written. `workRule()` goes one
step further than the older event families: it **rejects a
field the schema does not name**, so a hand-edited line cannot attach a `summary` to
an observation at all. Ignoring an undeclared key would mean the reducer never read
it; refusing it means it was never accepted. Work is new, so it starts the stronger
way — see `core/events/validate.ts` for why retro-fitting that to an older family is
a schema-version question rather than a code one.

### No Work event is a security event

Not in `SECURITY_EVENT_TYPES`, and none may be. A Work event describes Freya *doing
work*: planned, attempted, observed, verified, decided. A run that reached
`completed` says nothing about whether Freya may think next, and a ceiling that was
hit says nothing about the authority to reach it. Putting these in the security
stream would let an ordinary failure masquerade as a safety posture.

The genuinely security-relevant part is recorded where it already lives:
`guard.decision` is written every time Guard refuses a capability, and
`work.action.started` names the principal whose capabilities were evaluated.

---

## 13. The security boundary

A Run never grants itself anything. It can plan steps, ask Guard about a
capability, run what Guard allowed, and write its own history. It cannot reach
filesystem, network, terminal, secrets, a model, a grant, a budget, a policy, or an
approval — every one of those is a capability it either holds or does not, and Guard
is asked before each attempt.

The specifics worth naming:

- **The engine holds no principal.** `WorkEngine` receives a `WorkAuthorizer` port;
  Core closes over the owner principal when it builds it. A `Principal` never enters
  `core/work/`, which is what keeps `guard.ts`'s "no exported principal factory"
  property intact.
- **A denial is recorded and ends the step.** `work.action.started` is never written
  for a capability Guard refused, so the journal shows a refusal and a gap rather
  than a call that did not happen.
- **STOP ALL stops Work.** `stopAll` is read fresh at the moment of each decision,
  never cached into Work state, so a Run cannot be the one thing that keeps going
  after the panic button.
- **Shutdown aborts before the fabric closes.** `WorkEngine.close()` aborts every
  live capability and waits for the loops to settle, for the reason
  `Core.stop()` drains the gateway: a capability still running when the journal
  closes would try to record its own outcome into a closed store.

---

## 14. Idle Work costs nothing

There is no timer, no wake source and no poll anywhere in `core/work/`. `advance`
runs only because somebody called `start`, `resume` or `decide`, and it returns the
moment a Run reaches a resting point. A Run waiting for your approval is not slow —
it is stopped, and nothing is watching it.

The engine never touches a model. A capability that wanted cognition would have to
ask for it through `WorkerAuthority`, which the engine does not hold and cannot
obtain.

Asserted rather than assumed: `tests/core/work.test.ts` runs a task, three runs, an
approval wait, a denial, a cancellation and a restart, and asserts the provider's
call counter is still zero at the end.

---

## 15. The board

A surface in the existing registry — one entry in `surfaceTypes`, one body in
`registry.tsx`, and it inherits move, resize, minimise, maximise, focus, clamping,
restore and persistence from the manager like every other window. It is absolutely
positioned in a sibling layer, so it cannot reflow the shell grid; the orb lives in
`.presence-overlay` outside the grid and is sized from the viewport alone, and the
e2e measures that stage box before and after the board opens.

Two controls it deliberately does not have:

- **No "mark as done".** A Step closes on a verifier, in Core. A window that could
  close one would make the whole verification boundary decorative.
- **No percentage it cannot justify.** Progress is structural.

---

## 16. What Phase 6 deliberately does NOT implement

- **Mission.** No aggregate, no goals, no hierarchy, no scheduling, no
  decomposition, no autonomous continuation. `Run.parent` is an opaque
  `{ kind, id }` reference that Phase 7 fills in; Work does not know what a Mission
  is and has no field shaped like one.
- **Search, browser, terminal, workforce, foundry, relay.** The capability
  boundary names none of them.
- **A dependency graph.** Steps execute in planned order. `dependsOn` is a
  future field.
- **Resuming a run across a restart.** Not attempted, because the plan is gone.
- **Any capability that touches the outside world.**
- **`waiting` as a produced state.** Declared, reduced, never entered.
- **Streaming, partial results, or a live tail of a capability's output.**
- **Multi-window or collaborative execution.**
- **A billing system.** The ceilings are counts and durations, not money.

---

## 17. The Phase 5 seam

Phase 5 (Searcher / managed browser / deep research) attaches by registering
capabilities. Nothing else changes.

```ts
// A Searcher capability, once Phase 5 exists.
const SEARCH: WorkCapability = {
  name: 'searcher.query',
  capability: 'searcher.execute',      // a Phase 5 vocabulary addition
  risk: 'routine',
  describe: (request) => `search ${request.input.terms} and read the top results`,
  execute: async (request, context) => { /* … */ },
}

// And it is registered in core/index.ts. That is the whole integration.
options.workCapabilities: [SEARCH]
```

Deep research then arrives as a Run:

```
  research request
     ↓  Run (kind: 'research' — added to RUN_KINDS)
     ↓  search Step
     ↓  read-source Steps
     ↓  synthesis Step
     ↓  Verification
```

with no Work-side branch, no engine edit, and no second execution path. Phase 5's
`Step → waiting` cases are already reduced; only the producer is missing.

**Merge note.** The two branches touch disjoint files except `core/events/*` and
`core/protocol/*`, where `work.*` and `searcher.*` are additive. The conflicts to
expect are the `CAPABILITIES` and `CORE_EVENT_TYPES` arrays, which are ordered
lists — take both sides.

---

## 18. The Phase 7 seam

Missions sit *above* Runs, not inside this engine. What Phase 7 needs, and has:

- `Run.parent` — an opaque reference, so a Mission can attach without a schema
  change.
- A bounded Run. A Mission that decomposes into work gets the ceilings for free, and
  **cannot** grow forever by asking for more steps — which is the invariant a
  self-continuing Mission most needs and least wants.
- Approval as a first-class blocking state, so a Mission can stop for a person and
  be resumed by a decision rather than by polling.
- History in the journal, so a Mission's outcome is reconstructible after a restart
  even though its plan was not.

What Phase 7 must build: the Mission aggregate, its own event family, its own
surface, and — the interesting part — the rule for when a Mission may start *another*
Run. The one thing it must not do is reach past the ceilings, because the ceiling is
what stops a goal that never terminates.

---

## 19. Test map

| File | What it holds |
| --- | --- |
| `tests/core/work.test.ts` | the engine end to end over a real Core and journal: ordering, actions, observations, verification, tasks, approvals, cancellation races, bounded retry, ceilings, the projection, reload, recovery, event sanitisation, idle cost; plus the duration deadline and retention |
| `tests/core/work-lifecycle.test.ts` | the state tables over the whole vocabulary, the input boundary, the event schema, the reducer's refusal of impossible transitions |
| `tests/unit/workSurface.test.tsx` | the board renders Core's values, offers no control that closes a step, and shows refusals as refusals |
| `tests/host/coreHost.test.ts` | the Work mirror belongs to the process; the bridge exposes no capability, verifier or `decidedBy` |
| `tests/e2e/desktop.e2e.ts` | Phase 6 section: the orb does not move, approval gates before execution, approval and denial and cancellation, a reload that changes nothing, a relaunch that reconciles honestly, and zero model calls throughout |

The duration ceiling is proved by seven tests that each fail against the earlier
implementation: a capability that overruns cannot complete its Run, no next Action
starts, `limitHit` is `'duration'`, the Run is `failed` and not `cancelled`, a
capability that ignores its signal does not hold the Run open, a late clean
resolution cannot resurrect it, and `armedDeadlines()` is zero once anything
settles.

Retention is proved at two levels: `work-lifecycle.test.ts` checks the selection
arithmetic over the reducer — live and approval-blocked Runs never hidden, newest
settled Runs kept, order deterministic, the durable record untouched — and
`work.test.ts` runs five hundred finished runs through an engine and asserts both
the listing *and* `volatileCounts()` stop at the ceiling.

Nothing in the suite reaches a live service. Every capability is deterministic and
inert; every clock and id is injected.