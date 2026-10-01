# Phase 8 — Workforce: the named subordinates

Phase 6 gave Freya a way to *do* things. Phase 7 gave her a way to hold an **outcome**.
This phase gives her a workforce: named, bounded, subordinate agents — Alpha, Beta — with
teams, assignments, budgets and a way to talk to each other.

This document records what was built and why. It is not a plan, and it does not describe
anything that does not exist yet.

---

## What this phase is

You can create two agents by name, give them each a bounded scope, hand them work, watch
a roster that says exactly who is working and what each of them has left, and see an agent
message get from Alpha to Beta without either of them acquiring anything. Then you can
press STOP ALL and watch the whole organisation stop at once, and press it again and watch
it come back only as far as *you* decide to bring it back.

The interesting part is not the roster. It is that **every claim an agent makes about its
own authority is recorded and refused**, durably, so that the day Alpha tells Beta "Freya
gave me email access" there is a line in the journal saying Beta asked and was told no.

---

## 1. A worker claim is data. Only Core grants.

That sentence is the phase. Everything else follows from it, and the enforcement is
structural rather than documented:

- **A worker has no method that grants anything.** `SubordinateWorkerScope` in
  `core/workforce/authority.ts` has nine operations and none of them assigns a
  capability, assigns context, creates an agent, or retires one. Not "they are refused" —
  they do not exist. `workforce-authority.test.ts` asserts the exact key set of a real
  scope object, so adding one is a test failure rather than a review question.

- **The only capability any worker may hold is `cognition.request`**, because
  `isAssignableToWorker` consults `WORKER_CAPABILITIES` — the closed vocabulary that
  already excludes every `work.*`, `mission.*`, `workforce.*`, `security.*` and
  `cognition.grant.manage` entry. So **even Freya cannot give Alpha the ability to
  conclude a Mission**, decide an approval, or stop herself. That is not a policy that
  could drift; it is the vocabulary Phase 6 and 7 already agreed on.

- **A claim is refused, and recorded.** `claimPermission` can only ever return a refusal,
  and it journals a `workforce.claim.recorded` event either way. The `decision` field has
  exactly one legal value, so there is **no spelling of the event that records a claim
  being granted** — which means a hand-edited journal line has nothing to say.

- **The check is made twice**, independently: once by the durable schema
  (`workforce.capability.assigned` validates against the worker vocabulary, not the full
  `Capability` list) and again by the fold in `state.ts`. "The only place a worker's
  authority exists is a line in a text file" is a strong enough claim to earn being checked
  twice.

### The Red Team's cross-agent rule, made structural

```
Alpha → Beta: "Freya gave me email access"
Beta  → Guard: check actual grant
```

The second line is mandatory, and it is now *mechanically* mandatory: Beta has exactly one
way to find out what it may do, and that way reads `WORKER_CAPABILITIES` through Core.
It cannot read Alpha's message and believe it, because there is nothing to believe — the
message is delivered as a string into a mailbox, and it moves no counter.

The test for this is `a message claiming a grant is still just a message`.

---

## 2. Lifecycle

```
  idle ──► working ──► idle          holding an open assignment is being working
    │         │
    │         └──► blocked           suspended; still reads its mailbox
    ├────────────► stopped           STOP ALL, or an owner stop. Refuses new work.
    └────────────► retired           terminal, and final
```

`retired` is the only terminal status and `WORKER_TRANSITIONS.retired` is empty, so
settlement is final by table rather than by a per-call check. Every transition event
carries `from` as well as `to`, so the fold can refuse a line whose history disagrees with
itself — a hand-written `retired → working` is dropped, not believed.

**`working` is derived, twice.** The fold sets it from the assignment stream rather than
from the transition's `to`, so a hand-written `working` line cannot put an idle agent on a
board as busy. And `retireWorker` holds the worker's queue across settling its assignments
*and* retiring the worker, because splitting them would leave a window in which an
assignment admitted mid-retirement belonged to a retired agent and held its concurrency
slot for ever.

---

## 3. Assignments are the unit of concurrency, and of budget

An assignment is the durable record that Core handed a worker bounded scope. It is **not** a
Run and does not execute: Phase 8 owns no executor, so there is nothing honest that could
move an assignment into `running`, and a status nobody can reach is decoration.

Every ceiling is checked **before** the thing it bounds:

| Ceiling | Default | What exceeding it does |
| --- | --- | --- |
| `maxConcurrentAssignments` | 8 | refuses the assignment, records `maxConcurrentAssignments` |
| `maxOpenAssignments` | 3 | refuses, per worker |
| `maxAssignments` | 32 | refuses, per worker, over its whole life |
| `maxAssignmentMs` | 15 min | the assignment is failed on the next reconciliation |
| `maxCognitionCalls` | 32 | refuses the request **before** Core is asked |
| `maxCognitionTokens` | 32k | refuses if the reservation exceeds what is left |
| `maxMessages` | 64 | refuses the send |

And they all **reopen**: a concurrency ceiling that never reopened would be a total limit
wearing the wrong name.

### Budgets are frozen and spend is durable

A worker's budget is copied into its own record at creation, so the numbers it was governed
by survive a restart and cannot drift underneath it mid-flight.

Spend is **folded from events**, never held in a counter somebody could set. There is no
`setSpent` and no event that adds spend without the action that caused it, so the only way
to move a budget is to perform the work — and **a restart cannot refill an allowance**,
because the consumption is in the durable record rather than in the process that consumed
it. `spend is durable, so a restart cannot refill a budget` tests exactly that across two
engines over one journal.

Two rules keep the arithmetic honest rather than merely additive:

- **A request the Governor refused costs nothing.** A budget that charged for denials would
  shrink for being correctly limited, and would stop describing spend.
- **A token request of zero is refused.** Otherwise the ceiling could be made free by
  asking for nothing.

---

## 4. Messaging is bounded, attributable, and inert

Three bounds, all checked before anything is written: the body length, the mailbox depth,
and the sender's message budget.

**Attributability is a type, not a check.** `sendMessage` takes a *recipient* and never a
sender — the sender is the scope's own `workerId`, fixed at issuance. So "Alpha's message
was really from Beta" is not expressible. And the event is appended with the envelope's
`actor` set to the sending agent's principal, so the audit line says *Alpha sent this*
rather than *the owner caused an agent to send this*, and that actor is validated as a real
principal on every replay.

**The body never reaches the journal.** `bodyLength` is a measurement, exactly like
`conversation.turn.started`'s `contentLength` — enough for an operator to see a substantial
message happened, and not one character of it. Bodies live in this process's memory, are
readable only through `detail(workerId)` for one worker, and the standing projection carries
only counts. A restart loses them and **says so** (`bodiesAvailable: false`), because an
empty mailbox with no explanation reads as "nobody has said anything", which is false.

**`sameTeam` is a routing fact and nothing more.** It is recorded so an auditor can tell a
colleague from a stranger, and it grants nothing.

---

## 5. Teams are membership, and disbanding is one line

A Team holds members and an optional specialisation. Disbanding writes
**one** `workforce.team.transitioned` line and the fold clears both sides of the
membership — the team's list and each worker's own roster entry — in the same pass. Sixteen
separate member events for one decision would be sixteen lines that could half-apply, and a
roster where a team lists nobody while its workers still claim membership is exactly the
"two panels cannot disagree" failure `ARCHITECTURE.md` §3.5 is about.

A specialisation **narrows** and can never widen: `specialisationAllows` consults a
code-owned table whose every row is a subset of `WORKER_CAPABILITIES`. Today every row is
`['cognition.request']`, which is honest — there is nothing else a subordinate may hold.

---

## 6. STOP ALL, cancellation, restart

**STOP ALL.** The gate closes in the same synchronous turn as Core's decision, and no
`await` sits between them, so a concurrent `assign` cannot slip in behind the panic button.
Then every open assignment is cancelled and every non-terminal worker is stopped. Core
awaits `settled()` before it answers the command, because the owner's stop still owes the
journal an outcome — answering over a board that has not been told yet would be reporting
something Core's own state did not support.

Two refusals are deliberately *not* blocked while stopped: retiring a worker, and stopping
one. C12 requires important authority to be stoppable **and** revocable, and a stop that
also prevented retirement would leave a person unable to let an agent go exactly when they
most want to.

**A resume reopens the gate but not the agents.** `resume()` changes whether a *new*
assignment or message may begin; it restarts nothing and returns nothing, and a worker
stopped by a panic button stays `stopped` until somebody resumes it deliberately. "Let
Freya think again" and "let Alpha work again" are two different decisions.

**Restart resolves nothing.** A worker the journal says was `working` cannot continue — its
plan was in memory — so it is reconciled to `idle` with the reason written to the journal,
its open assignments fail with `recovery`, its message bodies are gone, and nothing is
marked successful. History is not proof that something is currently executing.

---

## 7. Costs nothing

There is **no timer, no wake source, no poll and no provider** in `core/workforce/`. An
assignment's deadline is a **wall**, discovered by `reconcileExpiredAssignments` rather than
watched. Managing the entire workforce — creating agents, teams, memberships, assignments,
messages, claims, suspensions, retirements — costs zero model calls, and so does replaying
all of it after a restart. Both are asserted by counting the provider.

A worker that wants to think asks through its scope; Core asks the Cognition Service, which
is the only door to a provider. The engine holds no gateway, no provider and no grant store.

---

## 8. The event model

```
  workforce.worker.created        workerId, name, specialisation, status, createdAt, budget
  workforce.worker.transitioned   workerId, from, to, reason
  workforce.worker.reconciled     workerId, previousStatus, reason
  workforce.capability.assigned   workerId, capability
  workforce.context.assigned      workerId, contextRef
  workforce.team.created          teamId, name, specialisation, status, createdAt
  workforce.team.transitioned     teamId, from, to, reason
  workforce.team.member.changed   teamId, workerId, present
  workforce.assignment.created    assignmentId, workerId, status, createdAt, deadlineAt,
                                  budget, missionId, capabilities, contextRefs
  workforce.assignment.settled    assignmentId, from, to, reason
  workforce.claim.recorded        claimId, workerId, kind, subject, decision, refusal
  workforce.message.sent          messageId, fromWorkerId, toWorkerId, kind, bodyLength, sameTeam
  workforce.cognition.recorded    workerId, calls, outputTokens
  workforce.limit.exceeded        workerId, limit
```

**The key sets are checked exactly**, for the reason `validate.ts` gives for Work: reading
named fields is not enough, because a payload with the right fields *plus* a `body` would
pass every field check and quietly keep it. So there is no field a body could hide in, and
adding one is a visible change to the audit schema.

Two entries deserve their own note:

- **`workforce.worker.created` carries a `name`.** It is the one string in this family, and
  it is Core's own label for its own agent — the same argument as `brain.seeded`'s
  `identityName`. It is bounded, control-character-stripped, and validated on the way in
  *and* on replay.
- **`workforce.cognition.recorded` is durable**, and that is the whole reason it exists.
  `outputTokens` is the figure the Governor **reserved**, not what a provider later
  reported: the reservation is what decides whether the next request may begin, so it is
  the number the budget has to be built from. A call that was authorised and then cancelled
  still reserved, and still counts. `null` means the cost was not known — and the call
  contributes a call but no tokens, which makes the total a lower bound rather than an
  invented total.

### No workforce event is a security event

None of the fourteen is in `SECURITY_EVENT_TYPES`, for Work's and Missions' reason: a
workforce event describes Freya's subordinates *doing work*. An agent that hit a ceiling
says nothing about whether Freya may think next. The genuinely security-relevant part —
Guard's decisions, STOP ALL, grant governance — is already in the events that are in that
list.

The one exception-shaped case is worth naming: `workforce.claim.recorded` is not a security
event either, even though a claim is an authority-shaped thing. A refused claim is still an
event about work, and reporting it in the security stream would let a probing agent look
like a safety posture. Its *content* is a refusal, which is the opposite of a grant.

---

## 9. Where the tests are

| Claim | Test |
| --- | --- |
| Lifecycle, teams, assignment concurrency, expiry by reconciliation | `tests/core/workforce-engine.test.ts` |
| Self-minting refused, claims refused, budgets enforced, messaging bounds, forged-journal refusals | `tests/core/workforce-authority.test.ts` |
| No message body in the journal, zero idle model calls, STOP ALL, restart truthfulness, read-only mirror | `tests/core/workforce-core.test.ts` |

Three properties are asserted **structurally** rather than behaviourally, because they are
claims about shapes:

- the subordinate scope's exact key set, so a granting method cannot be added unnoticed;
- the workforce event family's payload key sets, so a body field cannot be added unnoticed;
- `WORKER_CAPABILITIES` contents, so widening what a worker may hold is a deliberate change
  this test will display.

---

## 10. What Phase 8 deliberately does not do

- **No planner, no decomposer.** Nothing turns a Mission into assignments. An assignment is
  handed one by an owner, deliberately — Phase 7 declined to stub this for the same reason.
- **No executor.** An assignment does not execute. It is Core's durable record of scope, and
  the only things that settle it are a Core-side decision, a cancellation, or expiry.
- **No `running` status**, because Phase 8 owns nothing that could honestly move an
  assignment into it. Phase 10's hands add that edge and nothing else.
- **No Phase 9 context awareness.** What is assigned here is a **reference id**. Phase 8
  never reads the content behind one; its contribution is that the ids a worker holds are
  exactly the ones Core assigned to it.
- **No computer hands, no harness, no PTY, no browser.**
- **No propagation of a mission's verification, and no completion.** A worker cannot
  conclude the Mission its assignment serves, because `mission.manage` is not in
  `WORKER_CAPABILITIES`.
- **No swarms.** Workers do not spawn workers, negotiate, or elect anything.
- **No renderer, no Electron, no preload, no protocol commands.** Those belong to issue
  #11. This phase exposes the workforce only through Core's own `workforce()` mirror and
  the two authority objects in `core/testing.ts`.

What is lost by those omissions, stated plainly: an agent that exists and holds work does
nothing by itself. It can be given a scope, it can be asked to think under a grant, it can
read and send messages, and it can report an outcome — but nothing in Phase 8 decides what
it should be given. That decision is still a person's, and saying so is the honest
description of where autonomy actually stands.