# Phase 47 — Mission Autonomy

A Mission becomes a thing that runs. `find 100 cat videos` is stated once, and from there
Core plans bounded work, delegates it, executes it through Work, verifies it, and either
carries on or stops and says why. The owner does not drive it step by step, and does not
have to.

Branch: `runtime/phase47-mission-autonomy`

## What was built

### The loop

`MissionAutonomyRuntime.step()` is the whole of it: **one decision per call**. There is no
loop method and no timer anywhere in Core. A Mission advances because somebody asked it to,
once, and the absence of a loop is the enforcement rather than a promise in a comment.

```
GOAL → ready → plan → delegate → execute → verify → CONTINUE / WAIT / ASK / COMPLETE
```

Twelve statuses, each naming something a person would otherwise have to infer from a
combination: `draft`, `ready`, `planning`, `active`, `waiting`, `blocked`,
`approval-required`, `verifying`, `stopped`, `completed`, `failed`, `cancelled`.

`stopped` is the panic button's landing place and is nonterminal — only its owner reopens it.
Completion is reachable only from `verifying`, behind a verifier that can say no.

### The owner correction

> "find 100 cat videos" … "in the barn"

The second sentence patches the **same** Mission: subject, quantity and media survive, the
new context is applied, compatible evidence is kept, and the journal learns only
`changedFields: ['context']`. A correction that cannot be resolved asks a question and
changes **nothing** — no field merged, no step settled, no evidence discarded.

### Approval: one gate, and it is Work's

**A Mission owns no approval.** This is the architectural decision of the phase, and it was
reached by deleting code rather than adding it.

Work's `ApprovalRecord` requires a `runId`, and Work opens gates inside `drive()` when Guard
evaluates a *running* Run. A Mission-level gate opened before the Run exists could therefore
never *be* a Work gate — it would be a parallel approval system inside Core, asking the same
person the same question twice and answering neither one. The earlier implementation did
exactly that: `mission-approval-N` ids from a private counter, a `decideMissionApproval` no
window could reach and Guard could not refuse, and a recovery pass that expired *every*
pending gate on *every* reconciliation — which made a restart silently withdraw a question
before any person had answered it.

What replaced it:

- A step that needs a signature is handed to Work with `requiresApproval`. That is a
  **request**. Work's Guard decides whether a gate opens.
- The Mission parks in `approval-required` holding a **pointer** — Work's own `approvalId`
  and the `runId` that opened it. No lifecycle, no status field, nothing to manage.
- A person answers on Work's surface through `work.approval.decide`, which evaluates
  `work.approval.decide` on the owner. It is the only door in the codebase where an approval
  can become `approved`.
- A denial or an expiry flows back as a **blocker** — the same fact, recorded once, so the
  board cannot show a Mission as still waiting on a gate that has already been answered.
- A parked Mission **polls**. It never executes again to find out what happened, because that
  would create a second Work Run for one step: two Runs, one action, budget charged twice, and
  a gate on the first Run nobody would look at again.

`mission.approval.requested` is the only approval event. There is no
`mission.approval.decided` and no `mission.approval.expired`, and their absence from the
closed type list is the enforcement.

### Privacy

The goal lives in an encrypted intent store. The journal receives ids, counts, instants,
closed codes, measured lengths and — for a correction — *field names*. Not one word the owner
wrote. Two numbers are allowed about the goal, `budget` and `requestedQuantity`, because
progress has to be computable; both are counts, which is why the board reports `40 of 100`
and never a percentage it would have to invent.

A corrected quantity is **durable**: it rides on `mission.intent.corrected` and the fold
applies it. An earlier version recorded the field name and then wrote the number into the
record, so it survived in memory and reverted on the next restart with nothing in the journal
saying why — invisible to every test that read the live engine.

## Three defects the acceptance test found

The end-to-end test (`tests/core/mission-autonomy-loop.test.ts`) drives a real `Core`, a real
`WorkEngine` and a real `WorkforceEngine`. It found three things no unit test had:

**Delegation could never succeed.** The runtime matched a worker against the step's *Work*
capability name, and Phase 8's worker vocabulary is `cognition.request` alone — a subordinate
agent can ask to think and cannot execute. Every Mission through Core blocked on
`no_capable_worker`, which read as a correct refusal because that *is* the right refusal for a
genuinely empty roster. Delegation now assigns a worker the step's **thinking** and lets Work
execute the capability as the owner.

**Assignments were never closed.** Nothing settles a `workforce` assignment when a Mission's
step completes, so after three steps the worker held its full three and the fourth delegation
was refused — again as `no_capable_worker`. `advanceMission` now releases a settled Mission's
assignments, and only a settled Mission's, so a running Mission's delegation still reads as
in flight.

**The planner picked `test.always-fails`.** It chose a verifier alphabetically, and Core's
registry deliberately contains a verifier that always fails to demonstrate that verification
*can* fail. Missions retried to their ceiling and blocked on work that never had a chance.
`WorkCapability` now carries an optional `verifier` pairing, and the planner plans only
capabilities that declare one — the conservative error being to plan less, not to plan
something nothing can check.

## The planner's honest limitation

`planner.ts` takes capability *names*, never prose, because its output goes into a journal.
So it cannot derive steps from a goal, and Core has no model call to ask which registered
capability suits "find cat videos". The rule is: **one step, the lowest-risk registered
capability that declares a verifier, tie-broken by name.**

That is admittedly blunt. It is written down here rather than dressed up: it does not narrow
what Freya may do — `planner.ts` still resolves every name against the table, `mayBeginStep`
still asks the authority port, and the executor still goes through Guard — but it means a
Mission tries one cautious thing, learns from the outcome, and replans. An earlier version
proposed every registered capability on the reasoning that over-broad was safer; it was not,
because a plan containing an unfalsifiable step cannot complete as a whole, so almost every
Mission blocked. Choosing a capability that suits a goal is the next honest piece of work, and
it wants a model call behind a budget rather than a heuristic.

## Budgets and authority

Five ceilings per Mission — actions, retries, external requests, model calls, delegations —
each refused rather than overdrawn, so "exhausted" is a state rather than a region the
counters drift past.

The gate order is `STOP ALL → sealed → budget → risk → approval`, each strictly stronger than
the next and monotone, so adding a check at the end cannot weaken one at the front.

`maySpend()` returns false unconditionally. There is no configuration that makes it true.

## Verification

```
typecheck            pass
lint                 pass
unit + integration   364 files, 7460 tests, all passing
red team             included above
build                pass
release check        pass (mainBytes 2174031, preloadBytes 126150)
desktop e2e          216/216 checks
```

Release budgets were raised for this phase: `mainBytes` 2_250_000, `preloadBytes` 135_000.

## Files

| File | What it owns |
| --- | --- |
| `core/missions/autonomy/runtime.ts` | The loop. One `step()`, one decision. |
| `core/missions/autonomy/planner.ts` | Bounded plans. Cannot invent authority. |
| `core/missions/autonomy/authority.ts` | STOP ALL, budget, capability, spend, approval read-back. |
| `core/missions/autonomy/correction.ts` | `"in the barn"`. Ambiguity changes nothing. |
| `core/missions/autonomy/continuation.ts` | Deterministic decisions, in a fixed order. |
| `core/missions/autonomy/fold.ts` | Replay. Refuses a liar at every step. |
| `core/missions/autonomy/recovery.ts` | Interrupted effects. Nothing is retried blindly. |
| `core/missions/engine.ts` | The writer. Completion only from `verifying`. |
| `core/missions/projection.ts` | The board. Counts, never percentages. |
| `core/protocol/activity.ts` | The feed. Unworded rows are the failure mode. |
| `core/index.ts` | The wiring: ports, executor, delegation, the two public doors. |
| `src/ui/surfaces/MissionSurface.tsx` | Stop / Carry on. No approval button, deliberately. |
| `tests/core/mission-autonomy-loop.test.ts` | The acceptance test. Real Core, real Work. |
| `tests/red-team/mission-autonomy/` | Six attack families, 50 tests. |
