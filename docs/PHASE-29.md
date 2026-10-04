# Phase 29 — Autonomous Capability Acquisition

PLAN.md §14 row 29: *"detect capability gap → propose/build → verify → gated activation."*

This phase gives Freya the ability to notice she cannot do something, describe what would fix
it, build it, have it verified by something that named itself, and — only then — ask a person to
switch it on.

It is the first phase in the roadmap whose **subject is Freya's own competence**, and that is
the reason almost every rule below is a refusal. A system that can extend itself is a system
where the worst bug is a capability nobody chose. So the design is deliberately lopsided: the
proposal side is permissive, and the activation side is a conjunction over a closed list of
gates that nobody — not the requester, not Core, not a model — can satisfy on the owner's
behalf.

## The pipeline

```
CapabilityGap  →  AcquisitionRequest  →  GateLedger  →  ActivationDecision  →  active
a need,          what would close it     every gate,     may this become       never, and
named but        and at what cost        with a verdict  active?               never alone
never held
```

| Module | What it owns |
|---|---|
| `core/acquisition/types.ts` | vocabulary, closed tables, ceilings. No logic |
| `core/acquisition/request.ts` | gap and request construction, the lifecycle, cost |
| `core/acquisition/gates.ts` | the gate ledger, the conjunction, the owner's approval |
| `core/acquisition/rebuild.ts` | what a stored row must still satisfy to be believed |
| `core/acquisition/fold.ts` | one deterministic record → state function |
| `core/acquisition/derive.ts` | the arithmetic: counts, blockers, what awaits the owner |
| `core/acquisition/projection.ts` | the read-only views |
| `core/acquisition/store.ts` | the store contract |
| `core/acquisition/engine.ts` | every trusted pathway, and the precedence ladder |
| `core/protocol/acquisition.ts` | what a window may know |
| `core/vault/repositories/acquisition-store.ts` | the encrypted SQLCipher ledger |

## The six contracts

### 1. A generated capability starts untrusted and inactive

`GENERATED_TRUST_CLASS` is `'untrusted'` and `GENERATED_ACTIVATION` is `'inactive'`, and both
are **assigned inside `createAcquisitionRequest`**, absent from `REQUEST_INPUT_KEYS`. There is
no call shape — typed or untyped — that produces a request arriving trusted or running. A
payload adding `trustClass`, `activation` or `status` is refused by name rather than having its
value replaced.

`rebuildAcquisitionRequest` re-checks both on **read**, so the guarantee survives the round trip
through the database rather than holding only for rows this process wrote.

### 2. A gap is a need, not a permission

`CapabilityGap.wanted` is a bounded code-owned slug checked against `isAcquisitionSlug`, never
against the capability registry. `work.run.manage` is not a legal slug: a system that can *name*
the thing it wants is one refactor from holding it, and nothing downstream has to be trusted to
resist.

`GAP_KINDS` has no `missing-authority` member on purpose. A lack of authority is a correct state,
not a gap to be closed, and naming it would make "ask for more permission" look like the same
kind of problem as "there is no tool that reads this file".

### 3. Activation is a conjunction over seven gates

```
verification-passed  tests-passed  red-team-clean
no-protected-target  no-capability-widening  budget-within-limit
owner-approval
```

Split into two tables, and the split is the whole argument:

- **`LEDGER_GATE_KINDS`** (four) are recorded. Three of those require a named, bounded `verifier`
  and at least one evidence reference, and the `gate` authority may not record one at all: the
  evaluator of a gate cannot also be its evidence. `owner-approval` carries `authority: 'owner'`
  hard-set, `verifier: 'owner'` and **no** evidence refs — an approval is a decision, not a check,
  and a check-shaped owner gate would invite the reading that some verifier had cleared it.
- **`DERIVED_GATE_KINDS`** (three) are *functions of the request*, recomputed by
  `evaluateSelfGates` on every decision. `recordGateVerdict` refuses them by name, so nobody can
  hand-write "spend stayed within the bound" for a request that spent too much, and
  `rebuildGateLedger` refuses a stored ledger that holds one. That is why a hand-edited store row
  cannot widen a decision: the widest thing it can do is lie about a gate the decision never
  reads.

Two more refusals close the laundering routes around the labels themselves:

- a **reason must belong to its kind** (`GATE_REASONS_BY_KIND`), so `tests-passed` cannot be
  recorded with the reason `owner-approved-this-activation`;
- a **reason must agree with the verdict** (`GATE_REASONS_BY_VERDICT`), so `passed` cannot carry
  `tests-failed`.

### 4. Verification before activation, and a failure is terminal

`beginVerification` says "a verdict is owed"; `recordVerification` records it with a name;
`completeVerification` passes only when the **newest** `verification-passed` verdict reads
`passed`. Newest wins, including newest failing — a request that passed verification and later
failed it is refused, because the failure is the more recent fact about the artifact.

A failure ends the request with `verification-failed`. It does **not** step back to `building`.
A failure is a *new request's* evidence, and a failed request can never be edited back into a
pass. Its gap is left open, because a failed approach is not a closed need.

### 5. No self-grant

`ownerScope(principal)` issues the owner's methods to `'owner'` and returns `null` for every
other principal. Holding the object *is* the authority; there is no capability string that
acquires it. On top of that:

- `recordGateVerdict` refuses `owner-approval` from every authority, and `recordOwnerApproval` is
  the only function that produces one;
- an approval arriving while any other gate is unsatisfied is **refused, not honoured** — the
  owner cannot approve around a failed verification even in principle. The attempt is charged and
  its decision recorded, because an approval that was tried and stopped is a fact worth keeping.

The four capabilities added to `core/protocol/core-protocol.ts` follow the `work.approval.decide`
and `relay.approval.decide` split: `acquisition.status.read`, `acquisition.propose`,
`acquisition.verification.record` and `acquisition.activation.manage`. None is in
`WORKER_CAPABILITIES`, and the last one is the only one that means *a person is being trusted*.

### 6. No authority widening

`activateAcquisitionRequest(request, { now })` has no capability parameter, no scope, no registry
and no port. "Active" means *the owner approved this specific request*. What an approved
capability may actually **do** is decided by whatever runtime holds it, under its own authority —
this module imports no gateway, no authority object and no file system.

`ACQUISITION_GRANTS_NOTHING` carries all six of these as values, so a surface can render the
guarantee rather than merely not violate it.

## The precedence ladder

```
journal-not-trustworthy → stop-all-active → guard-denied → governor-denied
       → budget-exhausted → domain-rule
```

One function, in the order of `ACQUISITION_PRECEDENCE`, returning **which rung refused**. The
order is the argument:

1. **The journal outranks everything, including a valid owner approval.** A log that failed
   validation has a hole in it, and the discarded segment may have held the very stop that would
   otherwise apply. Same rule, same reason, as the Cognition Governor's.
2. **STOP ALL outranks an owner approval.** A latch is not an approval, and "the owner stopped
   Freya" must beat "the owner clicked approve twenty minutes ago".
3. **Guard outranks the domain rules**, so an unauthorised caller never learns whether *its
   particular* request would have passed.
4. **Governor**, because building is model work and it spends. The Governor decides whether
   background work may happen at all; this engine holds no opinion about allowances.
5. **The request's own ceiling**, below the authority rules, because "you have no authority" and
   "this one is too expensive" are different facts.
6. **Domain rules** last.

Reporting the rung rather than only refusing is the point. A reader who saw only "refused" would
have to guess whether Freya was held still or a proposal was rejected, and those demand different
responses.

`guard` and `governor` both **default to deny**, so an engine wired without them may read,
propose nothing and build nothing — the correct reading of a missing security module.

## Retention, and why nothing watches a clock

There is no scheduler, no timer and no retry in this phase. Expiry is a fact a caller evaluates
(`applyRetention(now)`), never something that happens while Freya is doing something else.

| Bound | Value | Lifecycle reason |
|---|---|---|
| `maxGapLifetimeMs` | 90 days | `aged-out-past-retention` |
| `maxRequestLifetimeMs` | 30 days | `stale-request-expired` |
| `maxActiveLifetimeMs` | **14 days** | `retention-bound-reached` |
| `maxLiveRequests` | 32 | refused at proposal, expired oldest-first once stale |
| `maxActiveRequests` | 4 | **refused** at approval — never a revocation |

Three decisions there worth stating:

- The activation deadline is **shorter** than the request's, because the longer a thing is
  running, the less its author should be permitted to have forgotten approving it.
- The count bounds are enforced differently on purpose. An activation inside its own retention is
  not expired, so `maxActiveRequests` is enforced by **refusing a new activation** rather than by
  revoking a standing one.
- `maxActiveLifetimeMs` is derived from the code-owned table at the moment of approval. There is
  no parameter for it, so an approval cannot be made permanent by naming its own end date — and
  cannot be permanent by omitting one. `rebuildAcquisitionRequest` re-derives the request
  deadline on read for the same reason.

## Cost

`ACQUISITION_COST_UNITS` is a code-owned currency with **no money in it**: one unit is one step,
a verification costs two, a red-team sweep three, an activation attempt four. There is no
conversion to a provider price, so nothing in this phase can be read as authorising spend.

Charges are refused **at** the ceiling rather than allowed to overshoot and be noticed later, a
terminal request cannot be charged at all, and a plan of *n* steps cannot be proposed under a
ceiling below *n* — so the plan is the floor of the spend rather than a decoration on it.

## Persistence

One encrypted SQLCipher database, generic `vault_kv`, `domain = 'acquisition'`, keyed
`gap:` / `request:` / `ledger:` / `decision:`.

- A **ledger** is stored as the whole ordered list under one key. Verdicts are appends to one
  decision, so the list is the unit of meaning — a ledger split across rows could be read half
  of, and "half the gates have been checked" is a state a reader must not be able to observe.
- **Two passes on open.** A decision is validated *against its own request*, so gaps and requests
  fold first and ledgers and decisions second. A single `ORDER BY rowid` pass would validate a
  decision before the request it talks about existed; the vault test reverses the physical row
  order to prove the ordering is not load-bearing.
- **A damaged row degrades the store** rather than being skipped, and a degraded store becomes
  read-only. A gate ledger written onto an unreadable chain is a chain that says a capability was
  verified by somebody.
- **No delete.** A failed request is evidence that a build was attempted and refused; if the row
  could be removed, the next run of the same proposal would look like a first attempt.

## Reads

No `acquisition.*` command exists on the Core surface, so there is no write verb a window can
reach — the same rule `work.approval.decide` exists to protect. `ABSENT_ACQUISITION_PROJECTION`
is the fixed shape for a build with no acquisition domain, and none is simulated.

A broad read carries ids, closed labels, counts, provenance metadata and the **measured length**
of every text-bearing field. No symptom text and no intent text cross in any broad read; the one
way to read a request's own words is the explicit single-record `readRequest`, which is what the
owner needs in order to review an activation, and which carries `grantsCapability: false` and
`authority: 'none'` beside the words.

## Test plan

| File | What it pins |
|---|---|
| `tests/core/acquisition-domain.test.ts` (61) | the contract without an engine: construction, the closed transition table, the gate ledger, retention, derivation determinism, every rebuild refusal |
| `tests/core/acquisition-engine.test.ts` (29) | the pipeline, provenance, no self-grant, the ladder in order, expiry, the count bounds |
| `tests/core/vault/vault-acquisition-core.test.ts` (9) | restart rebuild, degradation, the two-pass ordering, wrong key, no plaintext sentinel |
| `tests/red-team/acquisition/acquisition-redteam.test.ts` (29) | five attack families, below |

### The red-team families

- **`self-grant`** — payloads declaring themselves trusted or running; grant-, scope- and
  permission-shaped fields under any of their names; an owner approval from every non-owner
  authority; a non-owner principal reaching an approval with a Guard that allows everything; an
  approval offered in place of a failed gate.
- **`authority-widening`** — every forbidden requirement and every protected target, refused at
  construction; a gap whose `wanted` is a capability id; the widening gate recomputed from a
  hand-widened request, with the stored-row check refusing it independently.
- **`precedence-spoofing`** — the stop reported as the stop; the journal reported above the stop;
  a decision recording which rung stopped it rather than implying the gates did.
- **`ledger-forgery`** — a hand-written computed gate; a reason from another gate; a verdict
  contradicting its own label; the evaluator reporting its own evidence; `not-applicable` treated
  as unsatisfied; a later failure overriding an earlier pass; stored rows with an edited trust
  class, deadline, activation, confidence or spend; a decision claiming an approval its own gates
  contradict; an owner-approval row relabelled by hand.
- **`untrusted-build`** — secret-shaped symptom and intent; a subject phrased as an instruction;
  extra fields refused rather than dropped.

## Two findings the tests produced

Recorded because both were real gaps in the first draft, not test problems:

1. **`rebuildAcquisitionRequest` did not re-check `FORBIDDEN_REQUIREMENTS`.** Construction
   refuses them, so a stored row carrying one meant a hand-edit — and the derived
   `no-capability-widening` gate reads exactly that field. Now refused on read too, independently
   of the gate.
2. **`status` and `scope` were absent from `ACQUISITION_FORBIDDEN_FIELDS`**, so
   `{ status: 'active' }` was reported as a key-set mismatch — which sounds like a typo rather
   than the attempt to hand a request a running lifecycle that it is. Both are now refused by
   name, with a comment explaining why they are legitimate on a *stored* record and not on an
   *input*.

## Known limits, stated rather than hidden

- **A `code`-owned cost currency is not a budget.** The real spend guard is the Cognition
  Governor's grant, checked at rung 4. Phase 29 meters work in units; it does not meter money.
- **There is no artifact here.** `markBuilt` asserts that a described plan was paid for. What was
  actually produced, and whether it is any good, is Foundry's and the verifier's business; this
  domain holds no artifact and inspects none.
- **Activation is local.** An active request means the owner approved it. Nothing in this phase
  installs, registers or executes anything, and no other domain reads this ledger to widen itself.
  Wiring a runtime to it is a later, separate decision with its own gates.