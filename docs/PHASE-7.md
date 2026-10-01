# Phase 7 — Missions: the persistent outcome

Phase 6 gave Freya a way to *do* things, and every one of them ended. A run completes,
fails or is cancelled, and what remains is a record. Nothing in the system could hold
an **outcome** — something that is still true tomorrow, across restarts, and that can
be concluded by something other than whoever started it.

This document records what was built and why. It is not a plan, and it does not
describe anything that does not exist yet.

---

## What this phase is

At the end of it you can write down what you want accomplished, in your own words,
activate it, watch the Runs underneath it, pause the lot, ask whether it is finished,
and be told honestly that nothing established it yet. Then later — after a renderer
reload, or after quitting the application entirely — it is still there, still
encrypted, still not concluded, because concluding it is a verifier's decision and not
yours to click.

The interesting part is not the board. It is that a Mission is the **most distrustful**
thing in the system about being declared finished, and about what it is allowed to
know: the words you wrote are yours, so they never reach the journal, never reach an
event, and never reach a standing feed on a window that happens to be open.

---

## 1. A Mission is not a Run

The distinction is the whole phase, so it is worth stating as a table rather than a
slogan:

| | Mission | Run |
| --- | --- | --- |
| lifetime | outlives the process | one attempt |
| ends when | a verifier establishes the outcome | a step settles |
| a failure means | nothing on its own | the run stops |
| may be numerous | no — one Mission, many Runs | many per Mission |
| privacy | encrypted, its own key | no content to protect |
| who concludes it | a code-owned verifier | the run's own last step |

Two consequences follow, and both are enforced rather than documented:

- **A failed Run does not fail a Mission.** One bad day is not a failed outcome, and
  Freya making that inference would end a Mission on its first bad day. The board
  marks a Mission needing attention and leaves it active.
- **A completed Run does not complete a Mission.** "The Run finished" and "the thing
  you wanted was achieved" are different facts, and the gap between them is where
  Phase 6's verification boundary would otherwise leak.

---

## 2. Lifecycle

```
  draft     → active | cancelled
  active    → paused | completed | failed | cancelled
  paused    → active | failed | cancelled
  completed · failed · cancelled   (no outgoing edges)
```

The table is closed and lives in one place (`core/missions/types.ts`). `canTransition`
is the only thing that decides an edge, and settlement is final because a terminal
status has nowhere to go — which is also the answer to every race in §7.

`draft` is separate from `active` because writing something down and starting it are
different acts. A draft Mission has attached no Work, so there is nothing that could
have been attempted, and concluding it would be concluding a plan.

---

## 3. The words are yours, and they stay yours

A Mission's title, intent and success criteria are what a person told Freya they
wanted. That is as private as a conversation, so:

- they are written to an **AES-256-GCM store with its own 256-bit key**, wrapped
  separately by the OS secure storage, because D20's argument applies unchanged — a
  root key would turn "the conversation key leaked" into "everything leaked";
- they appear in **no event, no journal line, no projection, no activity row and no
  log**. The journal carries `missionId`, statuses, timestamps, the code-owned
  ceilings and closed reason codes, and nothing else;
- the board receives the **projection** — ids, statuses, counts, `persistence` — and
  the text is available only through an explicit read of one Mission.

When the store cannot authenticate its records it says so and **refuses writes**
rather than rewriting the file from the readable prefix, which would delete the
Missions after the break. That refusal also refuses Mission creation, because the
engine writes the private text before it records the Mission: a Mission whose words
could not be kept is not a Mission, and a half-created one is worse than none.

That last point is a real cost, stated rather than hidden: you cannot read a Mission
back out of its window. `Core.missionDetail()` decrypts one Mission for the owner, and
no standing feed exists, so a window that is merely open does not accumulate a copy of
everything you have ever asked for.

The journal payloads are validated by a rule that **rejects an unexpected key**, for
the reason D25 gives: a payload with the right fields *plus* an `intent` would pass
every field check and quietly keep it.

---

## 4. Progress is counts, or it is nothing

There is no percentage anywhere in this subsystem, and its absence is a decision
rather than an omission.

A Mission has no denominator. It is not a fraction of anything — it is an outcome that
either was established or was not. A percentage would require inventing a denominator
and then watching it move as child Runs were attached, which produces exactly the
number a person remembers and is later contradicted by.

What the projection offers instead is factual and countable: total child Runs, and
how many are queued, running, waiting, awaiting approval, paused, completed, failed or
cancelled, plus how many had **every** step verified. `needsAttention` is derived, not
declared.

The board offers exactly the actions Core says are available (`availableActions`), and
a settled Mission offers none at all. A control Core would refuse teaches its user that
buttons lie.

---

## 5. Completion requires evidence

`requestCompletion` is not a status setter, and the difference is the phase's main
claim. It asks a code-owned verifier whether the outcome was established, and the
Mission becomes `completed` **only if the verifier says so**.

```
  mission.requestCompletion
        │
        ├─ status not active?                    → refused, nothing changes
        ├─ already verifying?                    → refused: one question, one answer
        ├─ no child Run attached?                → refused: that would conclude a plan
        │
        ▼
  verification.requested  (written durably, before the verifier runs)
        │
        ▼
  verifier(context, signal) raced against a deadline
        │
        ├─ passed              → completed   + verification.completed(passed)
        ├─ not established     → still active + verification.completed(not_established)
        ├─ threw               → still active + verification.completed(not_established)
        └─ deadline            → still active + verification.completed(timeout)
```

The verifier is an interface with one implementation this phase: `mission.work.verified`
requires every required child Run to have completed **with every step verified**. That
is a claim about the Work record, not about the world, and the module says so — it
cannot establish that a person got what they wanted, only that the bounded work behind
it verified.

Three rules make the race safe, and each exists because the alternative is a Mission
that lies:

- **Admission happens under the Mission's lock.** A cancel cannot slip between the
  status check and the request, and two callers cannot verify one Mission at once and
  emit two `requested` events for one question.
- **A late pass is discarded.** A verifier answering after the deadline is not an
  answer, so the result cannot complete a Mission the deadline already refused.
- **A verifier that throws is not a verifier that passed.** Its message is deliberately
  not recorded, because a thrown string is exactly the kind of thing that belongs in a
  log and should not be.

### Why the timeout writes an outcome at all

Phase 6 established that a deadline **fabricates no verdict**: when one lands in
verification, no `work.verification.completed` is written and the verification stays
`requested`. Missions differ deliberately, and the difference is worth naming.

At a deadline we hold positive knowledge that **no verdict arrived**. `requested`
means *nobody has answered*, which is the honest state for a request interrupted by a
crash — and that is exactly what a restart leaves behind, which the recovery test
pins. Recording `timeout` asserts only that the deadline passed with no answer, and it
asserts nothing whatsoever about the Mission's outcome. The Mission stays `active`,
which is where an unestablished Mission belongs.

---

## 6. Bounds, and what a bound actually means

Ceilings are code-owned (`DEFAULT_MISSION_LIMITS`) and a Mission's copy is frozen into
its own record at creation, so the numbers a Mission was governed by survive a restart
and cannot drift underneath it.

| Ceiling | Default | What exceeding it does |
| --- | --- | --- |
| `maxChildRuns` | 64 | refuses the attachment, records `maxChildRuns` |
| `maxConcurrentChildRuns` | 4 | refuses the attachment while children are live |
| `lifetimeMs` | 30 days | settles the Mission as failed on the next observation |
| `verificationDeadlineMs` | 60s | stops waiting; establishes nothing |
| `maxRetainedMissions` | 200 | bounds the listing only; reported as `missionsTotal` / `missionsRetained` / `missionsHidden` |

A ceiling hit is **durable** (`mission.limit.exceeded` and `limitsHit`), so a restart
cannot hide that a Mission ran out of room. That is Work's `limitsHit` argument applied
to a subsystem whose whole claim is that its bounds are real.

A ceiling is checked *before* the thing it bounds, and the concurrency ceiling
**reopens** when a child settles — a bound that never reopened would not be a
concurrency limit, it would be a total limit wearing the wrong name.

---

## 7. Races, decided rather than timed

Every Mission command is serialised per Mission, and each of these is settled by the
transition table rather than by timing:

- **Pause versus a new child Run.** A paused Mission admits none, so whichever entered
  second refuses.
- **Cancel versus completion.** Whichever enters the lock second observes a terminal
  status and refuses. A late `passed` cannot resurrect a cancelled Mission, because
  the outcome is re-read *after* the verifier is awaited.
- **Stop ALL.** Read fresh at the moment of each decision, never copied into Mission
  state, so a Mission cannot still be activated after the panic button.

---

## 7a. Four defects the adversarial pass found

This phase shipped with four real bugs, all found by attacking it rather than by
using it, and all in the same four places: a claim, a fault, a total, and a failure
path. They are recorded because the shape of them is the lesson.

**A completion could be folded that nothing had established.** `active → completed`
is a *legal* edge, so the transition table could never catch a forged outcome, and a
three-line hand-written journal folded into `status: completed, verification: null`.
The reducer now requires a verification that actually passed and whose `verifierId`
matches the transition's. Worse, the happy-path test had folded a bare `completed`
and passed — the test encoded the bug rather than catching it.

**A damaged store destroyed the Missions it could not see.** Replay stopped at the
first record that failed authentication, which is correct, but `write()` never
consulted that flag — and a write rewrites the whole file from the readable prefix.
So writing while degraded deleted everything after the break: three records in, two
out, and the next open reported the store *healthy*, because the evidence had just
been overwritten. A degraded store is read-only now, which is the Brain's rule.

**A total that was not a total.** `maxRetainedMissions` bounds the listing and
nothing else, and the per-status counts were computed after that slice — so past 200
Missions the projection said `total: 200` while 205 existed. It now reports the
triple Work has always reported.

**A journal failure stranded a Mission and could end the process.** The verification
claim was taken before the write that could fail, so one disk error wedged the Mission
behind `verification-in-progress` for the life of the process, contradicting the
comment directly above it. And `result.finally(...)` returns a new promise, so a
rejected command left an unhandled rejection — which Node treats as a process exit.

The common thread is that every one of them was invisible from the success path. A
subsystem's failure handling is the code no ordinary test exercises and the code a
person meets on their worst day.

## 8. Recovery resolves nothing

A restart settles expired Missions and does three things it refuses to do:

- It does not resume a Mission whose verification was interrupted. The request stays
  `requested`, because nobody established anything and a crash is not an answer.
- It does not re-attach or restart a child Run.
- It does not conclude anything.

The journal is the Mission's only memory. `open()` replays it, folds it through the
same reducer live operation uses, and awaits expiry settlement — so a caller told Core
started is never then told about an expired Mission as though it were live.

---

## 9. The event model

```
  mission.created             missionId, createdAt, deadlineAt, limits, status
  mission.activated           missionId, from, to, reason
  mission.paused              missionId, from, to, reason
  mission.resumed             missionId, from, to, reason
  mission.cancelled           missionId, from, to, reason
  mission.failed              missionId, from, to, reason
  mission.completed           missionId, from, to, reason, verifierId
  mission.run.attached        missionId, runId
  mission.verification.requested   missionId, verifierId, runIds
  mission.verification.completed   missionId, verifierId, outcome
  mission.limit.exceeded      missionId, limit
```

`resumed` is a separate event from `activated` even though both land on `active`,
because only the origin tells them apart — and a journal that cannot answer "was this
ever paused?" cannot be audited.

### No Mission event is a security event

None of the eleven is in `SECURITY_EVENT_TYPES`, for Work's reason: a Mission event
describes Freya *working toward* something. A Mission that reached `completed` says
nothing about whether Freya may think next, and a ceiling that was hit says nothing
about the authority to reach it. Reporting either in the security stream would let an
ordinary failure masquerade as a safety posture.

---

## 10. What a window can reach

Two capabilities, split because they are different kinds of privilege:

- `mission.status.read` — render a Mission.
- `mission.manage` — create, activate, pause, resume, cancel, conclude and *ask* for
  completion.

Neither is in `WORKER_CAPABILITIES`, and that exclusion is written down rather than
left to be inferred from Work's: a Run executing under a worker principal must never
be able to conclude the Mission it belongs to. A Mission is a person's outcome, and an
agent deciding on its own that it has been achieved is the failure Missions exist to
prevent.

The preload bridge rebuilds each payload from named fields. `mission.create` forwards a
title, an intent and success criteria, and reads **no** `limits`, `status`,
`verification`, `verifierId`, `deadlineAt` or `principalId` — so a window cannot raise
a code-owned ceiling or assert an outcome, and appending such a field does not even get
it across the boundary.

`work.run.create` forwards `missionId` and **refuses `parent`**. Phase 6 read a
`{ kind, id }` pair straight off the payload, which let any window attach a Run to
anything by asserting one; `kind` is a claim about structure, and structure is Core's.
Refused rather than dropped, so code still sending the old shape is told.

---

## 11. Costs nothing

Managing a Mission reaches no model and constructs no provider. Creating, activating,
pausing, resuming, asking to complete and cancelling are all journal appends and
reductions, and the end-to-end suite asserts the call counter is unchanged after the
whole lifecycle, after a renderer reload and after an application relaunch.

This is the same rule as idle Work: there is no timer, no wake source and no poll
behind a Mission sitting on a board.

---

## 12. Where the tests are

| Claim | Test |
| --- | --- |
| The lifecycle table is closed and settlement is final | `tests/core/mission-lifecycle.test.ts` |
| Mission text never reaches the disk, and a third domain refuses to open another | `tests/core/mission-store.test.ts` |
| The engine's rules: limits, verification, races, recovery | `tests/core/mission-engine.test.ts` |
| Mission text, zero model calls, parent injection, ceilings, STOP ALL | `tests/core/mission-core.test.ts` |
| The bridge forwards words and nothing else | `tests/host/coreHost.test.ts` |
| The feed describes a Mission without describing its text | `tests/core/mission-core.test.ts` |
| A damaged store is read-only and reports itself | `tests/core/mission-store.test.ts` |
| The keyring's third domain, and the migration that adds it | `tests/host/keyring.test.ts` |
| The board, driven through the real bridge | `tests/e2e/desktop.e2e.ts` |

---

## 13. What Phase 7 deliberately does not do

- **No decomposition.** Freya does not turn a Mission into Runs by itself. A Run is
  attached when something asks for one, and `mission.run.attached` records that.
- **No planning.** Choosing how to pursue an outcome is Phase 8 and later; there is no
  planner in `core/missions/`.
- **No progress inference.** Nothing watches a Mission to guess whether it is going
  well, and no idle loop exists to do it.
- **No agent, team or swarm.** Workforce is Phase 8 and this phase creates no
  subordinate principal of any kind.
- **No unattended completion.** Only an owner's `requestCompletion` asks, and only a
  verifier concludes.

What is lost by those omissions, stated plainly: a Mission you write down does nothing
on its own. It is a durable record of an outcome, a bounded set of Runs you may attach
to it, and a conclusion only a verifier can make. The autonomy is Phase 8's, and
stubbing it here would be the fake-autonomy failure this project exists to avoid.