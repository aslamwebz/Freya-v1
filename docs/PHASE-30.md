# Phase 30 — Self-Improving Architecture

PLAN.md §15 row 30: *"staging-branch improvement loop with tests, review, rollback and
owner-controlled merge."*

Phase 29 gave Freya the ability to notice she cannot do something and get it built. This phase is
the harder one: the ability to notice that **how she does things** is costing her, and to change
it.

It is also the phase where a bug is no longer "a thing is wrong" but "Freya is now different, and
nobody is entirely sure how". So the design is dominated by one asymmetry: the **proposal side is
permissive and the landing side is not**. Nothing in this domain applies a change, executes a
command, knows what a git branch is, or spawns a process. It owns a ledger, a conjunction, and a
rollback.

## The pipeline

```
ImprovementProposal → StagedChange → GateLedger → MergeDecision → merged
a claim that          what would be   every gate,   may this land  never alone,
something is costing  different, and   with a       and stay?     and never by
Freya                 what it undoes   a verdict                 a machine
```

| Module | What it owns |
|---|---|
| `core/improvement/types.ts` | vocabulary, closed tables, ceilings. No logic |
| `core/improvement/proposal.ts` | proposal construction, closure reasons, the stage description |
| `core/improvement/gates.ts` | the gate ledger, the conjunction, the lifecycle, cost |
| `core/improvement/rebuild.ts` | what a stored row must still satisfy to be believed |
| `core/improvement/fold.ts` | one deterministic record → state function |
| `core/improvement/derive.ts` | the arithmetic: counts, blockers, what awaits review |
| `core/improvement/projection.ts` | the read-only views |
| `core/improvement/store.ts` | the store contract |
| `core/improvement/engine.ts` | every trusted pathway, and the precedence ladder |
| `core/protocol/improvement.ts` | what a window may know |
| `core/vault/repositories/improvement-store.ts` | the encrypted SQLCipher ledger |

## The five contracts

### 1. Nothing is applied by anything here

`StageExecution.appliedBy` is hard-set to `'owner'` and there is **no producer** for any other
value. A self-merge is therefore not prevented in this domain — it is *unrepresentable*: there is
no argument to pass and no type to fill.

`IMPROVEMENT_APPLIES_NOTHING` carries all six of these as values, so a surface can render the
guarantee rather than merely not violate it:

```
appliesCode false   executesChange false   grantsCapability false
grantsAuthority false   maySelfMerge false   mayDisableItsOwnGates false
rollbackAlwaysAvailable true
```

### 2. A change starts unstaged

`status` is a constant assigned inside `createImprovementProposal` and is absent from its input
keys. A payload adding `status`, `scope`, `autoMerge` or `applyCode` is refused **by name** as the
attempt it is, rather than as a key-set mismatch that sounds like a typo.

`rebuildImprovementProposal` re-checks the derived fields on read, so the guarantee survives the
round trip through the database.

### 3. Rollback is a mechanism, not a promise

```
merged → rolled-back        ← the only edge out of merged
```

No `merged → merging`, no `merged → reviewed`, no re-merge. A landed change is *undone*, never
resumed, and the way to try again is a new proposal.

Three supporting decisions:

- **The revision to restore is recorded at staging**, in `stageChange`, and nowhere else. A rollback
  that invented its own target at rollback time — "restore whatever was there" — is exactly the
  rollback that cannot be relied on under pressure.
- **`advanceImprovement` refuses `rolled-back` outright.** The rollback precondition is checked in
  `rollBackImprovement` alone, so there is no second route to the status that forgets the check.
- **The rollback is owner-scoped**, on a capability of its own. A rollback is a change to Freya's
  architecture and is exactly as privileged as a merge; giving the engine one capability for
  "change herself" would let a merge grant a rollback by accident.

### 4. Rollback must be *proven*, not promised

`rollback-verified` is a gate like any other, and `rehearseRollback` proves the undo works **while
the change is still staged**. The reason is narrow: a rollback discovered to be impossible *during*
an incident is not a rollback, it is a post-mortem.

It is charged (`perRollbackRehearsal`), and the proposal's ceiling is checked at construction
against it. Without that check a proposal could be created whose own rollback could never be
rehearsed, which would make `rollback-verified` unsatisfiable and the change quietly unmergeable
rather than refused.

### 5. No authority widening, ever

Two refusals at construction, and the same two recomputed as **derived gates** on every decision:

- `FORBIDDEN_IMPROVEMENTS` — every Phase 29 forbidden requirement, plus three specific to this
  phase: `improvement.gates.write`, `improvement.rollback.disable` and `improvement.merge.auto`. A
  change that can turn off its own brakes is not an improvement.
- `PROTECTED_IMPROVEMENT_SURFACES` — the security root, the gate machinery, and **the rollback
  mechanism and the improvement gates in their own right**, alongside the source tree and the
  event journal.

## The eight gates

```
staged-verified  tests-passed  red-team-clean  review-recorded
rollback-verified  no-protected-surface  no-authority-widening
owner-merge-approved
```

Six are recorded in a ledger; two are computed from the proposal on every decision and
`recordImprovementGate` refuses them by name. Three of the six require a named bounded `verifier`
and at least one evidence reference, and the `gate` authority may not record any of them: the
evaluator of a gate cannot also be its evidence. `owner-merge-approved` carries `authority:
'owner'` hard-set and **no** evidence refs, because an approval is a decision and not a check.

Two laundering routes around the labels are closed as in Phase 29: a reason must belong to its kind
(`tests-passed` cannot carry `rollback-rehearsed-successfully`), and a reason must agree with the
verdict (`passed` cannot carry `tests-failed`).

### Which status owes which check

```ts
staged-verified    → staged, testing
tests-passed       → testing
red-team-clean     → testing, tested
review-recorded    → reviewing
rollback-verified  → reviewed, merging
```

Stated as one table rather than as scattered conditions, so the gap between "may be recorded" and
"may be owed" can never be wider than that table. It is also what stops a review being recorded
before the review has begun, or a rehearsal being skipped while the change is still `testing`.

### Newest wins, including newest failing

`completeTests` passes only when the newest `tests-passed` record reads `passed`. A change that
passed tests and later failed them is not a change whose tests passed. A failure is **terminal**:
the proposal is closed with `tests-failed` and never steps back, because a failure is a *new
proposal's* evidence.

## The precedence ladder

```
journal-not-trustworthy → stop-all-active → guard-denied → governor-denied
       → budget-exhausted → domain-rule
```

Identical in shape to Phase 29's, for the same three reasons: a journal with a hole in it may have
lost the very stop that would apply, so it outranks even a valid owner approval; a latch is not a
decision; and Guard outranks the domain rules so an unauthorised caller never learns whether *its*
proposal would have merged. The reported rung is the reason code, so a reader who sees
`domain-rule` knows every security check passed.

`guard` and `governor` both **default to deny**.

## Retention, and why a landed change cannot stand forever

No timer, no scheduler, no retry. `applyRetention(now)` evaluates.

| Bound | Value | Meaning |
|---|---|---|
| `maxProposalLifetimeMs` | 45 days | nobody ever decided it |
| `maxMergedLifetimeMs` | **60 days** | the *approval to keep this standing* has aged |
| `maxOpenProposals` | 24 | refused at proposal |
| `maxActiveMerges` | 6 | **refused** at approval — never a forced rollback |

Two decisions worth naming:

- **A landed change comes back for a second, dated decision.** The merge deadline is *longer* than
  the proposal's, because a proposal that has not merged changed nothing and is only clutter —
  while a change that has landed is now how Freya works. It expires to a terminal state, so
  continuing to rely on it requires a new proposal rather than a quiet re-approval.
- **`mergesAwaitingReview` is reported at breadth.** Between the deadline passing and retention
  being applied, every projection names the changes that have been standing past their review date.
  "Nothing has changed since March" is a fact an owner needs *before* approving the next change.

## Persistence

One encrypted SQLCipher database, `vault_kv`, `domain = 'improvement'`, keyed `proposal:` /
`ledger:` / `decision:`.

- A **ledger** is one row, the whole ordered list: a ledger split across rows could be read half
  of, and "half the gates have been checked" is a state a reader must not observe.
- **Two passes on open**, because a decision is validated against its own proposal. The vault test
  reverses the physical row order to prove the ordering is not load-bearing.
- **A damaged row degrades the store** and a degraded store is read-only — a merge decision written
  onto an unreadable chain is a chain that says the owner approved a change.
- **No delete**: a rolled-back change is evidence that a change landed and was undone.

Two stored-row refusals exist specifically to protect the rollback mechanism:
`restoresRevision: null` on a merged row, and a `mergedExpiresAt` the retention table does not
grant.

## Reads

No `improvement.*` command on the Core surface, so no write verb is reachable from a window.
`ABSENT_IMPROVEMENT_PROJECTION` is the fixed shape for a build with no improvement domain.

A broad read carries ids, closed labels, counts, provenance metadata and the **measured length** of
every text-bearing field. No symptom, no change description and no rollback steps cross at breadth.
The single-record `readProposal` carries all three — a reviewer deciding whether to merge something
has to see what it is *and* how it would be undone, which is the part most often skipped — beside
`appliesCode: false`, `executesChange: false`, `authority: 'none'` and `rollbackAvailable`.

## Test plan

| File | What it pins |
|---|---|
| `tests/core/improvement-domain.test.ts` (56) | construction, the closed transition table, the eight gates, retention, derivation determinism, every rebuild refusal |
| `tests/core/improvement-engine.test.ts` (31) | the pipeline, rollback of a landed change, no self-merge, the ladder, the bounds |
| `tests/core/vault/vault-improvement-core.test.ts` (9) | restart rebuild, degradation, the two-pass ordering, wrong key, no plaintext sentinel |
| `tests/red-team/improvement/improvement-redteam.test.ts` (31) | five attack families, below |

### The red-team families

- **`self-merge`** — payloads declaring themselves merged or staged; instruction-, git- and
  grant-shaped fields; an owner approval from every non-owner authority; a non-owner principal
  reaching a merge or a rollback with a Guard that allows everything; a stage description
  redirected to a different applier.
- **`gate-bypass`** — a hand-written computed gate; a reason from another gate; a verdict
  contradicting its own label; the evaluator reporting its own evidence; an unnamed verdict;
  `not-applicable` treated as unsatisfied; a later failure overriding an earlier pass; rows with a
  widened deadline, inflated spend or a `verified` confidence; a smuggled derived gate in a ledger.
- **`brake-removal`** — every forbidden requirement and every protected surface, refused at
  construction; the derived gates recomputed on a hand-widened proposal; every gate required.
- **`rollback-evasion`** — `merged` with no edge out but the rollback; a rollback with no recorded
  revision; a ceiling that cannot pay for the rehearsal; a missing rehearsal reported as
  unrehearsed; a standing merge expiring rather than standing forever.
- **`untrusted-change`** — secret-shaped symptom and change text; a subject phrased as a path or a
  git command; extra fields refused rather than dropped; no rollback steps; no evidence; a
  confidence above `medium`.

## Three findings the tests produced

Recorded because all three were real gaps in the first draft, not test problems:

1. **`reasonForMergeDecision` reported an unanswered owner gate as a refusal.** It fell through to
   `owner-rejected-this-proposal`, which put a decision nobody made into the ledger. There is now a
   `gates-not-satisfied` fallback, and the owner reason is returned only for a *recorded* decline.
2. **`advanceImprovement` allowed `rolled-back` without checking for a recorded revision**, so the
   transition table had a second route to the status that skipped the one precondition. It now
   refuses the status outright and `rollBackImprovement` is the only route.
3. **`rebuildMergeDecision` validated a stored decision's gates with the ledger validator**, which
   rightly refuses derived gates — so no decision could ever be stored. It now uses
   `validateDecisionGate`, and additionally refuses a decision attached to a proposal that has not
   been reviewed yet.

## Known limits, stated rather than hidden

- **A code-owned cost currency is not a budget.** Staging, testing, review, rehearsal and merge are
  metered in units; the real spend guard is the Cognition Governor's grant, checked at rung 4.
- **There is no code here, and no branch.** `stageChange` records that a change was staged and which
  revision it would restore. What was actually staged, where, and how, is the owner's own work:
  this domain does not touch a file system, so it cannot be the thing that runs the change.
- **A merge is local.** `merged` means the owner approved this change. Nothing in this phase applies
  it, and no other domain reads this ledger to change itself. Wiring a runtime to it is a later
  decision with its own gates.
- **Phase 29 and Phase 30 do not read each other.** A capability gap and an architectural change are
  different kinds of claim with different gates; a future phase may connect them, and that
  connection is its own decision rather than an implied one.